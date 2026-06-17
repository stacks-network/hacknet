import { PoxInfo, Pox4SignatureTopic } from '@stacks/stacking';
import { hexToBytes } from '@stacks/common';
import {
  AnchorMode,
  ClarityVersion,
  PostConditionMode,
  StacksTransaction,
  broadcastTransaction,
  bufferCV,
  callReadOnlyFunction,
  contractPrincipalCV,
  cvToString,
  getNonce,
  makeContractCall,
  makeContractDeploy,
  noneCV,
  principalCV,
  signStructuredData,
  stringAsciiCV,
  tupleCV,
  uintCV,
} from '@stacks/transactions';
import crypto from 'crypto';
import {
  Account,
  getAccounts,
  maxAmount,
  parseEnvInt,
  waitForSetup,
  logger,
  burnBlockToRewardCycle,
  isPreparePhase,
  network,
  contractsApi,
} from './common';

const randInt = () => crypto.randomInt(0, 0xffffffffffff);
const stackingInterval = parseEnvInt('STACKING_INTERVAL', true);
const postTxWait = parseEnvInt('POST_TX_WAIT', true);
const stackingCycles = parseEnvInt('STACKING_CYCLES', true);
const chainId = parseEnvInt('STACKS_CHAIN_ID', false) ?? 0x80000000;
const pox5DeployFee = parseEnvInt('POX_5_DEPLOY_FEE', false) ?? 3_000_000;
const pox5CallFee = parseEnvInt('POX_5_CALL_FEE', false) ?? 10_000;

const SLOT_MULTIPLIER = 1.1;
const DEFAULT_NUM_SLOTS = 2;
const POX5_BOOT_ADDRESS = 'ST000000000000000000002AMW42H';
const POX5_CONTRACT_NAME = 'pox-5';
const POX5_CLARITY_VERSION = 6 as ClarityVersion;

let startTxFee = 1000;
const getNextTxFee = () => startTxFee++;
let lastPoxContractId = '';

type RewardCycleId = number;
type AmountToStack = bigint;

// Map to store fixed stacking amounts per reward cycle to ensure consistent
// proportional weights based on target slots. Maps target reward cycle ID to
// fixed amount per slot for that cycle.
//
// This prevents dynamic threshold changes from causing unexpected weight
// distribution as stackers join throughout the cycle and affect the
// participation-based threshold.
const cycleStackingAmounts = new Map<RewardCycleId, AmountToStack>();

/**
 * Compute and store the fixed stacking amount for a given target reward cycle.
 * This ensures all stackers have expected weights regardless of the stacking
 * order within the cycle.
 *
 * @param targetRewardCycle The reward cycle ID for which the fixed amount is
 *                          computed
 * @param currentThreshold The current minimum threshold for the cycle
 * @param multiplier Optional multiplier for the starting threshold
 *                   (default: SLOT_MULTIPLIER)
 * @returns The fixed stacking amount for this cycle
 */
function getFixedStackingAmount(
  targetRewardCycle: number,
  currentThreshold: number,
  multiplier: number = SLOT_MULTIPLIER
): AmountToStack {
  if (cycleStackingAmounts.has(targetRewardCycle)) {
    return cycleStackingAmounts.get(targetRewardCycle)!;
  }

  // Use the threshold at the time this target cycle was first encountered.
  // Bump by multiplier to avoid getting stuck if threshold increases slightly
  // over time.
  const fixedAmount = BigInt(Math.floor(currentThreshold * multiplier));
  cycleStackingAmounts.set(targetRewardCycle, fixedAmount);

  logger.info(
    {
      targetRewardCycle: targetRewardCycle,
      currentThreshold,
      fixedAmount: fixedAmount.toString(),
      multiplier,
    },
    `Set fixed stacking amount for target reward cycle ${targetRewardCycle}`
  );

  return fixedAmount;
}

async function run(stackingKeys: string[], stackingSlotDistribution: number[]) {
  const accounts = getAccounts(stackingKeys, stackingSlotDistribution);
  const poxInfo = await accounts[0].client.getPoxInfo();

  const poxContractId = poxInfo.contract_id;
  const previousPoxContractId = lastPoxContractId;
  const poxTransitioned = previousPoxContractId !== '' && previousPoxContractId !== poxContractId;
  lastPoxContractId = poxContractId;
  const isPox4 = poxContractId.endsWith('.pox-4');
  const isPox5 = poxContractId.endsWith('.pox-5');

  if (!isPox4 && !isPox5) {
    logger.info(
      {
        poxContract: poxContractId,
      },
      `Pox contract is not .pox-4 or .pox-5, skipping stacking (contract=${poxContractId})`
    );
    return;
  }

  if (poxTransitioned) {
    logger.info(
      {
        from: previousPoxContractId,
        to: poxContractId,
      },
      `Pox contract changed, forcing fresh stacking submissions`
    );
  }

  if (isPox5 && isPreparePhase(poxInfo.current_burnchain_block_height ?? 0)) {
    logger.info(
      {
        burnHeight: poxInfo.current_burnchain_block_height,
      },
      'PoX-5 staking updates are skipped during prepare phase'
    );
    return;
  }

  const runLog = logger.child({
    burnHeight: poxInfo.current_burnchain_block_height,
    poxContract: poxContractId,
  });

  const accountInfos = await Promise.all(
    accounts.map(async a => {
      const info = await a.client.getAccountStatus();
      const unlockHeight = Number(info.unlock_height);
      const lockedAmount = BigInt(info.locked);
      const balance = BigInt(info.balance);
      return { ...a, info, unlockHeight, lockedAmount, balance };
    })
  );

  let txSubmitted = false;

  // Bump min threshold by SLOT_MULTIPLIER to avoid getting stuck if threshold
  // increases.
  const minStx = Math.floor(poxInfo.next_cycle.min_threshold_ustx * SLOT_MULTIPLIER);
  const nextCycleStx = poxInfo.next_cycle.stacked_ustx;
  if (nextCycleStx < minStx) {
    runLog.info(`Next cycle has less than min threshold.. stacking should be performed soon`);
  }

  await Promise.all(
    accountInfos.map(async account => {
      if (isPox5) {
        const hasActivePox5Stake = !poxTransitioned && (await hasPox5Stake(account));
        if (!hasActivePox5Stake) {
          runLog.info(
            {
              burnHeight: poxInfo.current_burnchain_block_height,
              unlockHeight: account.unlockHeight,
              account: account.index,
            },
            `Account ${account.index} needs fresh PoX-5 stake`
          );
          await stakePox5(poxInfo, account, account.balance + account.lockedAmount);
          txSubmitted = true;
          return;
        }

        const unlockHeightCycle = burnBlockToRewardCycle(account.unlockHeight);
        const nowCycle = burnBlockToRewardCycle(poxInfo.current_burnchain_block_height ?? 0);
        if (unlockHeightCycle === nowCycle + 1) {
          runLog.info(
            {
              burnHeight: poxInfo.current_burnchain_block_height,
              unlockHeight: account.unlockHeight,
              account: account.index,
              nowCycle,
              unlockCycle: unlockHeightCycle,
            },
            `Account ${account.index} needs PoX-5 stake-update`
          );
          await stakeUpdatePox5(account);
          txSubmitted = true;
          return;
        }
        runLog.info(
          {
            burnHeight: poxInfo.current_burnchain_block_height,
            unlockHeight: account.unlockHeight,
            account: account.index,
            nowCycle,
            unlockCycle: unlockHeightCycle,
          },
          `Account ${account.index} has active PoX-5 stake, skipping stacking`
        );
        return;
      }

      if (account.lockedAmount === 0n) {
        runLog.info(
          {
            burnHeight: poxInfo.current_burnchain_block_height,
            unlockHeight: account.unlockHeight,
            account: account.index,
          },
          `Account ${account.index} is unlocked, stack-stx required`
        );
        await stackStx(poxInfo, account, account.balance);
        txSubmitted = true;
        return;
      }
      const unlockHeightCycle = burnBlockToRewardCycle(account.unlockHeight);
      const nowCycle = burnBlockToRewardCycle(poxInfo.current_burnchain_block_height ?? 0);
      if (unlockHeightCycle === nowCycle + 1) {
        runLog.info(
          {
            burnHeight: poxInfo.current_burnchain_block_height,
            unlockHeight: account.unlockHeight,
            account: account.index,
            nowCycle,
            unlockCycle: unlockHeightCycle,
          },
          `Account ${account.index} unlocks before next cycle ${account.unlockHeight} vs ${poxInfo.current_burnchain_block_height}, stack-extend required`
        );
        await stackExtend(poxInfo, account);
        txSubmitted = true;
        return;
      }
      runLog.info(
        {
          burnHeight: poxInfo.current_burnchain_block_height,
          unlockHeight: account.unlockHeight,
          account: account.index,
          nowCycle,
          unlockCycle: unlockHeightCycle,
        },
        `Account ${account.index} is locked for next cycle, skipping stacking`
      );
    })
  );

  if (txSubmitted) {
    await new Promise(resolve => setTimeout(resolve, postTxWait * 1000));
  }
}

async function stackStx(poxInfo: PoxInfo, account: Account, balance: bigint) {
  // Determine the fixed stacking amount per slot for the target reward cycle.
  // This ensures the stacked amount per slot is constant for the entire cycle,
  // regardless of potential increases in the minimum threshold.
  const baseStackingAmount = getFixedStackingAmount(
    poxInfo.next_cycle.id,
    poxInfo.next_cycle.min_threshold_ustx
  );

  // Calculate total amount needed based on target slots and fixed base amount.
  const amountToStack = baseStackingAmount * BigInt(account.targetSlots);

  // Compare with current threshold.
  const currentThreshold = poxInfo.next_cycle.min_threshold_ustx;
  const adjustedThreshold = Math.floor(currentThreshold * SLOT_MULTIPLIER);

  if (balance < baseStackingAmount) {
    throw new Error(
      `Insufficient balance to stack minimum amount (required=${baseStackingAmount}, balance=${balance})`
    );
  }

  if (balance < amountToStack) {
    throw new Error(
      `Insufficient balance to stack (required=${amountToStack}, balance=${balance}), this can lead to unexpected weight distribution.`
    );
  }
  const authId = randInt();
  const sigArgs = {
    topic: Pox4SignatureTopic.StackStx,
    rewardCycle: poxInfo.reward_cycle_id,
    poxAddress: account.btcAddr,
    period: stackingCycles,
    signerPrivateKey: account.signerPrivKey,
    authId,
    maxAmount,
  } as const;
  const signerSignature = account.client.signPoxSignature(sigArgs);
  const stackingArgs = {
    poxAddress: account.btcAddr,
    privateKey: account.privKey,
    amountMicroStx: amountToStack,
    burnBlockHeight: poxInfo.current_burnchain_block_height,
    cycles: stackingCycles,
    fee: getNextTxFee(),
    signerKey: account.signerPubKey,
    signerSignature,
    authId,
    maxAmount,
  };
  account.logger.debug(
    {
      ...stackingArgs,
      ...sigArgs,
      // The total amount to stack.
      stackedAmount: amountToStack.toString(),
      // The fixed amount per slot for the target reward cycle.
      baseStackingAmount: baseStackingAmount.toString(),
      // How many slots the account is targeting to stack. Will stack this
      // amount multiplied by a constant multiplier to avoid getting locked out
      // if the threshold increases.
      targetSlots: account.targetSlots,
      // The current minimum threshold for the cycle.
      currentThreshold,
      // The threshold after applying the multiplier.
      adjustedThreshold,
    },
    `Stack-stx with args:`
  );
  const stackResult = await account.client.stack(stackingArgs);
  account.logger.info(
    {
      ...stackResult,
    },
    `Stack-stx tx result`
  );
}

async function stackExtend(
  poxInfo: PoxInfo,
  account: Account & { lockedAmount: bigint; balance: bigint }
) {
  const authId = randInt();
  const sigArgs = {
    topic: Pox4SignatureTopic.StackExtend,
    rewardCycle: poxInfo.reward_cycle_id,
    poxAddress: account.btcAddr,
    period: stackingCycles,
    signerPrivateKey: account.signerPrivKey,
    authId,
    maxAmount,
  } as const;
  const signerSignature = account.client.signPoxSignature(sigArgs);
  const stackingArgs = {
    poxAddress: account.btcAddr,
    privateKey: account.privKey,
    extendCycles: stackingCycles,
    fee: getNextTxFee(),
    signerKey: account.signerPubKey,
    signerSignature,
    authId,
    maxAmount,
  };
  account.logger.debug(
    {
      stxAddress: account.stxAddress,
      account: account.index,
      ...stackingArgs,
      ...sigArgs,
    },
    `Stack-extend with args:`
  );
  const stackResult = await account.client.stackExtend(stackingArgs);
  account.logger.info(
    {
      stxAddress: account.stxAddress,
      account: account.index,
      ...stackResult,
    },
    `Stack-extend tx result`
  );
}

function pox5SignerManagerName(account: Account) {
  return `pox5-signer-${account.index}`;
}

function pox5SignerManagerSource() {
  return `
(impl-trait 'ST000000000000000000002AMW42H.pox-5.signer-manager-trait)
(use-trait signer-manager-trait 'ST000000000000000000002AMW42H.pox-5.signer-manager-trait)

(define-public (validate-stake!
        (staker principal)
        (first-index uint)
        (num-indexes uint)
        (amount-ustx uint)
        (amount-sats uint)
        (is-bond bool)
        (signer-calldata (optional (buff 500)))
    )
    (ok true)
)

(define-public (register-self
        (signer-manager <signer-manager-trait>)
        (signer-key (buff 33))
        (auth-id uint)
        (signer-sig (buff 65))
    )
    (as-contract? ()
        (try! (contract-call? 'ST000000000000000000002AMW42H.pox-5 grant-signer-key
            signer-key current-contract auth-id signer-sig
        ))
        (try! (contract-call? 'ST000000000000000000002AMW42H.pox-5 register-signer
            signer-manager signer-key
        ))
    )
)
`.trim();
}

async function contractExists(contractAddress: string, contractName: string) {
  try {
    const result = await contractsApi.getContractSource({ contractAddress, contractName });
    return !!result.source;
  } catch {
    return false;
  }
}

async function waitForContract(contractAddress: string, contractName: string) {
  for (let attempt = 1; attempt <= 90; attempt++) {
    if (await contractExists(contractAddress, contractName)) return;
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  throw new Error(`Timed out waiting for ${contractAddress}.${contractName} to deploy`);
}

async function broadcastPox5Tx(tx: StacksTransaction, account: Account, label: string) {
  const result = await broadcastTransaction(tx, network);
  if (result.error) {
    account.logger.error({ ...result, label }, `Error broadcasting ${label}`);
    throw new Error(`Error broadcasting ${label}: ${JSON.stringify(result)}`);
  }
  account.logger.info({ txid: result.txid, label }, `Broadcast ${label}`);
  return result.txid;
}

function makePox5GrantSignature(account: Account, signerManagerName: string, authId: number) {
  const signerManagerPrincipal = `${account.stxAddress}.${signerManagerName}`;
  const domain = tupleCV({
    name: stringAsciiCV('pox-5-signer'),
    version: stringAsciiCV('1.0.0'),
    'chain-id': uintCV(chainId),
  });
  const message = tupleCV({
    topic: stringAsciiCV('grant-authorization'),
    'signer-manager': principalCV(signerManagerPrincipal),
    'auth-id': uintCV(authId),
  });
  return signStructuredData({
    message,
    domain,
    privateKey: account.signerPrivKey,
  }).data;
}

async function ensurePox5Signer(account: Account) {
  const contractName = pox5SignerManagerName(account);
  let nonce = await getNonce(account.stxAddress, network);

  if (!(await contractExists(account.stxAddress, contractName))) {
    const deployTx = await makeContractDeploy({
      contractName,
      codeBody: pox5SignerManagerSource(),
      senderKey: account.privKey,
      nonce,
      fee: pox5DeployFee,
      anchorMode: AnchorMode.Any,
      network,
      clarityVersion: POX5_CLARITY_VERSION,
      postConditionMode: PostConditionMode.Allow,
    });
    await broadcastPox5Tx(deployTx, account, `${contractName} deploy`);
    await waitForContract(account.stxAddress, contractName);
    nonce += 1n;
  }

  const authId = randInt();
  const signerSignature = makePox5GrantSignature(account, contractName, authId);
  const registerTx = await makeContractCall({
    contractAddress: account.stxAddress,
    contractName,
    functionName: 'register-self',
    functionArgs: [
      contractPrincipalCV(account.stxAddress, contractName),
      bufferCV(hexToBytes(account.signerPubKey)),
      uintCV(authId),
      bufferCV(hexToBytes(signerSignature)),
    ],
    senderKey: account.privKey,
    nonce,
    fee: pox5CallFee,
    anchorMode: AnchorMode.Any,
    network,
    postConditionMode: PostConditionMode.Allow,
  });
  await broadcastPox5Tx(registerTx, account, `${contractName} register-self`);
  return nonce + 1n;
}

async function hasPox5Stake(account: Account) {
  try {
    const result = await callReadOnlyFunction({
      contractAddress: POX5_BOOT_ADDRESS,
      contractName: POX5_CONTRACT_NAME,
      functionName: 'get-staker-info',
      functionArgs: [principalCV(account.stxAddress)],
      senderAddress: account.stxAddress,
      network,
    });
    return cvToString(result) !== 'none';
  } catch (error) {
    account.logger.warn({ error }, 'Could not read PoX-5 staker info');
    return false;
  }
}

async function stakePox5(poxInfo: PoxInfo, account: Account, totalBalance: bigint) {
  const baseStackingAmount = getFixedStackingAmount(
    poxInfo.next_cycle.id,
    poxInfo.next_cycle.min_threshold_ustx
  );
  const amountToStack = baseStackingAmount * BigInt(account.targetSlots);

  if (totalBalance < amountToStack) {
    throw new Error(
      `Insufficient balance to PoX-5 stake (required=${amountToStack}, total=${totalBalance})`
    );
  }

  const contractName = pox5SignerManagerName(account);
  const nonce = await ensurePox5Signer(account);
  const startBurnHeight = poxInfo.current_burnchain_block_height ?? 0;
  const stakeTx = await makeContractCall({
    contractAddress: POX5_BOOT_ADDRESS,
    contractName: POX5_CONTRACT_NAME,
    functionName: 'stake',
    functionArgs: [
      contractPrincipalCV(account.stxAddress, contractName),
      uintCV(amountToStack),
      uintCV(stackingCycles),
      uintCV(startBurnHeight),
      noneCV(),
    ],
    senderKey: account.privKey,
    nonce,
    fee: pox5CallFee,
    anchorMode: AnchorMode.Any,
    network,
    postConditionMode: PostConditionMode.Allow,
  });
  account.logger.debug(
    {
      signerManager: `${account.stxAddress}.${contractName}`,
      amountToStack: amountToStack.toString(),
      targetSlots: account.targetSlots,
      startBurnHeight,
      cycles: stackingCycles,
    },
    'PoX-5 stake with args'
  );
  await broadcastPox5Tx(stakeTx, account, 'pox-5 stake');
}

async function stakeUpdatePox5(account: Account) {
  const contractName = pox5SignerManagerName(account);
  const nonce = await ensurePox5Signer(account);
  const stakeUpdateTx = await makeContractCall({
    contractAddress: POX5_BOOT_ADDRESS,
    contractName: POX5_CONTRACT_NAME,
    functionName: 'stake-update',
    functionArgs: [
      contractPrincipalCV(account.stxAddress, contractName),
      contractPrincipalCV(account.stxAddress, contractName),
      uintCV(stackingCycles),
      uintCV(0),
      noneCV(),
    ],
    senderKey: account.privKey,
    nonce,
    fee: pox5CallFee,
    anchorMode: AnchorMode.Any,
    network,
    postConditionMode: PostConditionMode.Allow,
  });
  await broadcastPox5Tx(stakeUpdateTx, account, 'pox-5 stake-update');
}

async function loop() {
  const stackingKeys = process.env.STACKING_KEYS?.split(',') || [];

  if (stackingKeys.length === 0) {
    throw new Error('No stacking keys provided using STACKING_KEYS.');
  }

  const envStackingSlotDistribution =
    process.env.STACKING_SLOT_DISTRO?.split(',').map(Number) || [];
  const stackingSlotDistribution: number[] = Array(stackingKeys.length)
    .fill(DEFAULT_NUM_SLOTS)
    .map((defaultValue, index) => envStackingSlotDistribution[index] ?? defaultValue);

  logger.info(
    {
      stackingKeys: stackingKeys.length,
      stackingSlotDistribution,
      stackingInterval,
      postTxWait,
      stackingCycles,
    },
    `Starting stacker with configuration:`
  );

  await waitForSetup(stackingKeys, stackingSlotDistribution);

  while (true) {
    try {
      await run(stackingKeys, stackingSlotDistribution);
    } catch (e) {
      console.error('Error running stacking:', e);
    }
    await new Promise(resolve => setTimeout(resolve, stackingInterval * 1000));
  }
}
loop();
