import type { PoxInfo } from '@stacks/stacking';
import {
  AnchorMode,
  ClarityType,
  type ClarityValue,
  PostConditionMode,
  type StacksTransaction,
  TransactionVersion,
  broadcastTransaction,
  bufferCV,
  callReadOnlyFunction,
  contractPrincipalCV,
  cvToString,
  getAddressFromPrivateKey,
  getNonce,
  listCV,
  makeContractCall,
  noneCV,
  principalCV,
  responseErrorCV,
  tupleCV,
  uintCV,
} from '@stacks/transactions';
import {
  type Account,
  POX_REWARD_LENGTH,
  contractsApi,
  getAccounts,
  isPreparePhase,
  logger,
  network,
  parseEnvInt,
  waitForSetup,
} from './common';

const POX5_BOOT_ADDRESS = 'ST000000000000000000002AMW42H';
const POX5_CONTRACT_NAME = 'pox-5';
const BOND_GAP_CYCLES = 2n;

const bondAdminAddress = process.env.POX_5_BOND_ADMIN!;
const bondAdminPrivateKey =
  process.env.POX_5_BOND_ADMIN_PRIVATE_KEY ?? process.env.POX_5_DEPLOYER_PRIVATE_KEY;
const sbtcContractId = process.env.POX_5_SBTC_CONTRACT!;
const participantKeys = process.env.BITCOIN_STAKING_KEYS?.split(',').filter(Boolean) ?? [];
const signerKeys = process.env.STACKING_KEYS?.split(',').filter(Boolean) ?? [];

const configuredBondIndex = parseEnvBigInt('BITCOIN_STAKING_BOND_INDEX') ?? 0n;
const amountUstx = parseEnvBigInt('BITCOIN_STAKING_AMOUNT_USTX') ?? 99_000_000_000_000n;
const amountSats = parseEnvBigInt('BITCOIN_STAKING_AMOUNT_SATS') ?? 1_000_000n;
const targetRate = parseEnvBigInt('BITCOIN_STAKING_TARGET_RATE') ?? 1_000n;
const stxValueRatio = parseEnvBigInt('BITCOIN_STAKING_STX_VALUE_RATIO') ?? 100n;
const minUstxRatio = parseEnvBigInt('BITCOIN_STAKING_MIN_USTX_RATIO') ?? 10_000n;
const setupFee = parseEnvInt('BITCOIN_STAKING_SETUP_FEE', false) ?? 3_000_000;
const callFee = parseEnvInt('BITCOIN_STAKING_CALL_FEE', false) ?? 10_000;
const pollIntervalMs = (parseEnvInt('BITCOIN_STAKING_POLL_INTERVAL', false) ?? 3) * 1000;
const mintMultiplier = BigInt(parseEnvInt('BITCOIN_STAKING_MINT_MULTIPLIER', false) ?? 2);

const sbtcContract = splitContractId(sbtcContractId);

type SignerManager = {
  contractAddress: string;
  contractName: string;
};

type BondSelection = {
  index: bigint;
  startBurnHeight: bigint;
  exists: boolean;
};

function splitContractId(contractId: string) {
  const [contractAddress, contractName, ...extra] = contractId.split('.');
  if (!contractAddress || !contractName || extra.length > 0) {
    throw new Error(`Invalid contract id: ${contractId}`);
  }
  return { contractAddress, contractName };
}

function parseEnvBigInt(envKey: string) {
  const value = process.env[envKey];
  if (typeof value === 'undefined') return undefined;
  if (!/^[0-9]+$/.test(value)) {
    throw new Error(`${envKey} must be an unsigned integer, got ${value}`);
  }
  return BigInt(value);
}

function validateConfig() {
  if (!bondAdminPrivateKey) {
    throw new Error('POX_5_BOND_ADMIN_PRIVATE_KEY or POX_5_DEPLOYER_PRIVATE_KEY must be set');
  }
  const derivedBondAdmin = getAddressFromPrivateKey(
    bondAdminPrivateKey,
    TransactionVersion.Testnet
  );
  if (derivedBondAdmin !== bondAdminAddress) {
    throw new Error(
      `POX_5_BOND_ADMIN_PRIVATE_KEY derives ${derivedBondAdmin}, expected ${bondAdminAddress}`
    );
  }
  if (participantKeys.length === 0) {
    throw new Error('No BITCOIN_STAKING_KEYS provided');
  }
  if (signerKeys.length === 0) {
    throw new Error('No STACKING_KEYS provided; cannot discover PoX-5 signer managers');
  }
  if (amountSats <= 0n || amountUstx <= 0n) {
    throw new Error('BITCOIN_STAKING_AMOUNT_SATS and BITCOIN_STAKING_AMOUNT_USTX must be > 0');
  }
  if (mintMultiplier <= 0n) {
    throw new Error('BITCOIN_STAKING_MINT_MULTIPLIER must be > 0');
  }
}

function signerManagerName(account: Account) {
  return `pox5-signer-${account.index}`;
}

function sleep(ms = pollIntervalMs) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function uintValue(value: ClarityValue, label: string) {
  if (value.type !== ClarityType.UInt) {
    throw new Error(`${label} expected uint, got ${cvToString(value)}`);
  }
  return value.value;
}

function okUintValue(value: ClarityValue, label: string) {
  if (value.type !== ClarityType.ResponseOk) {
    throw new Error(`${label} expected ok uint, got ${cvToString(value)}`);
  }
  return uintValue(value.value, label);
}

function optionalUintValue(value: ClarityValue, label: string) {
  if (value.type === ClarityType.OptionalNone) return undefined;
  if (value.type !== ClarityType.OptionalSome) {
    throw new Error(`${label} expected optional uint, got ${cvToString(value)}`);
  }
  return uintValue(value.value, label);
}

function isSome(value: ClarityValue) {
  return value.type === ClarityType.OptionalSome;
}

async function pox5ReadOnly(
  functionName: string,
  functionArgs: ClarityValue[],
  senderAddress = bondAdminAddress
) {
  return callReadOnlyFunction({
    contractAddress: POX5_BOOT_ADDRESS,
    contractName: POX5_CONTRACT_NAME,
    functionName,
    functionArgs,
    senderAddress,
    network,
  });
}

async function waitForPox5(client: Account['client']) {
  while (true) {
    const poxInfo = await client.getPoxInfo();
    const burnHeight = poxInfo.current_burnchain_block_height ?? 0;
    if (poxInfo.contract_id?.endsWith('.pox-5')) {
      logger.info(
        { burnHeight, poxContract: poxInfo.contract_id },
        'PoX-5 is active; starting Bitcoin Staking setup'
      );
      return poxInfo;
    }
    logger.info(
      { burnHeight, poxContract: poxInfo.contract_id },
      'Waiting for active PoX-5 contract'
    );
    await sleep();
  }
}

async function signerRegistered(signerManager: SignerManager) {
  const result = await pox5ReadOnly('get-signer-info', [
    contractPrincipalCV(signerManager.contractAddress, signerManager.contractName),
  ]);
  return isSome(result);
}

async function waitForSignerManagers(signerManagers: SignerManager[]) {
  while (true) {
    const missing: string[] = [];
    for (const signerManager of signerManagers) {
      if (!(await signerRegistered(signerManager))) {
        missing.push(`${signerManager.contractAddress}.${signerManager.contractName}`);
      }
    }
    if (missing.length === 0) {
      logger.info({ signers: signerManagers.length }, 'PoX-5 signer managers are registered');
      return;
    }
    logger.info({ missing }, 'Waiting for PoX-5 signer managers to register');
    await sleep();
  }
}

async function bondStartBurnHeight(bondIndex: bigint) {
  return uintValue(
    await pox5ReadOnly('bond-period-to-burn-height', [uintCV(bondIndex)]),
    'bond-period-to-burn-height'
  );
}

async function bondExists(bondIndex: bigint) {
  return isSome(await pox5ReadOnly('get-protocol-bond', [uintCV(bondIndex)]));
}

async function bondAllowance(bondIndex: bigint, staker: string) {
  return optionalUintValue(
    await pox5ReadOnly('get-bond-allowance', [uintCV(bondIndex), principalCV(staker)], staker),
    'get-bond-allowance'
  );
}

async function missingAllowances(bondIndex: bigint, participants: Account[]) {
  const missing: string[] = [];
  for (const participant of participants) {
    const allowance = await bondAllowance(bondIndex, participant.stxAddress);
    if (allowance === undefined || allowance < amountSats) {
      missing.push(participant.stxAddress);
    }
  }
  return missing;
}

async function selectBondIndex(client: Account['client'], participants: Account[]) {
  let baseIndex = configuredBondIndex;
  const setupWindow = BOND_GAP_CYCLES * BigInt(POX_REWARD_LENGTH);

  while (true) {
    const poxInfo = await client.getPoxInfo();
    const currentBurnHeight = BigInt(poxInfo.current_burnchain_block_height ?? 0);

    for (let offset = 0n; offset < 16n; offset++) {
      const bondIndex = baseIndex + offset;
      const startBurnHeight = await bondStartBurnHeight(bondIndex);

      if (currentBurnHeight >= startBurnHeight) {
        baseIndex = bondIndex + 1n;
        continue;
      }

      if (await bondExists(bondIndex)) {
        const missing = await missingAllowances(bondIndex, participants);
        if (missing.length === 0) {
          return { index: bondIndex, startBurnHeight, exists: true };
        }
        logger.warn(
          { bondIndex: bondIndex.toString(), missing },
          'Existing PoX-5 bond does not allowlist the configured participants; trying a later bond'
        );
        continue;
      }

      const setupOpenHeight = startBurnHeight > setupWindow ? startBurnHeight - setupWindow : 0n;
      if (currentBurnHeight >= setupOpenHeight) {
        return { index: bondIndex, startBurnHeight, exists: false };
      }

      logger.info(
        {
          bondIndex: bondIndex.toString(),
          currentBurnHeight: currentBurnHeight.toString(),
          setupOpenHeight: setupOpenHeight.toString(),
          startBurnHeight: startBurnHeight.toString(),
        },
        'Waiting for PoX-5 bond setup window'
      );
      break;
    }

    await sleep();
  }
}

async function broadcast(tx: StacksTransaction, label: string) {
  const result = await broadcastTransaction(tx, network);
  if (result.error) {
    throw new Error(`Error broadcasting ${label}: ${JSON.stringify(result)}`);
  }
  logger.info({ txid: result.txid, label }, 'Broadcast Bitcoin Staking transaction');
  return result.txid;
}

async function setupBond(selection: BondSelection, participants: Account[]) {
  if (selection.exists) {
    logger.info({ bondIndex: selection.index.toString() }, 'PoX-5 bond already configured');
    return;
  }

  const nonce = await getNonce(bondAdminAddress, network);
  const allowlist = listCV(
    participants.map(participant =>
      tupleCV({
        staker: principalCV(participant.stxAddress),
        'max-sats': uintCV(amountSats),
      })
    )
  );
  const tx = await makeContractCall({
    contractAddress: POX5_BOOT_ADDRESS,
    contractName: POX5_CONTRACT_NAME,
    functionName: 'setup-bond',
    functionArgs: [
      uintCV(selection.index),
      uintCV(targetRate),
      uintCV(stxValueRatio),
      uintCV(minUstxRatio),
      bufferCV(new Uint8Array(683)),
      allowlist,
    ],
    senderKey: bondAdminPrivateKey!,
    nonce,
    fee: setupFee,
    anchorMode: AnchorMode.Any,
    network,
    postConditionMode: PostConditionMode.Allow,
  });

  await broadcast(tx, `pox-5 setup-bond ${selection.index}`);
  await waitForBond(selection.index, participants);
}

async function waitForBond(bondIndex: bigint, participants: Account[]) {
  for (let attempt = 1; attempt <= 120; attempt++) {
    if (
      (await bondExists(bondIndex)) &&
      (await missingAllowances(bondIndex, participants)).length === 0
    ) {
      logger.info({ bondIndex: bondIndex.toString() }, 'PoX-5 bond configured');
      return;
    }
    await sleep();
  }
  throw new Error(`Timed out waiting for PoX-5 bond ${bondIndex} to be configured`);
}

async function sbtcBalance(participant: Account) {
  return okUintValue(
    await callReadOnlyFunction({
      contractAddress: sbtcContract.contractAddress,
      contractName: sbtcContract.contractName,
      functionName: 'get-balance',
      functionArgs: [principalCV(participant.stxAddress)],
      senderAddress: participant.stxAddress,
      network,
    }),
    'sbtc-token.get-balance'
  );
}

async function mintSbtcIfNeeded(participant: Account) {
  const current = await sbtcBalance(participant);
  if (current >= amountSats) {
    participant.logger.info(
      { balance: current.toString(), required: amountSats.toString() },
      'Participant already has enough mock sBTC'
    );
    return;
  }

  const targetBalance = amountSats * mintMultiplier;
  const amountToMint = targetBalance - current;
  const nonce = await getNonce(participant.stxAddress, network);
  const tx = await makeContractCall({
    contractAddress: sbtcContract.contractAddress,
    contractName: sbtcContract.contractName,
    functionName: 'mint',
    functionArgs: [uintCV(amountToMint), principalCV(participant.stxAddress)],
    senderKey: participant.privKey,
    nonce,
    fee: callFee,
    anchorMode: AnchorMode.Any,
    network,
    postConditionMode: PostConditionMode.Allow,
  });

  await broadcast(tx, `sbtc-token mint ${participant.stxAddress}`);
  for (let attempt = 1; attempt <= 120; attempt++) {
    const updated = await sbtcBalance(participant);
    if (updated >= amountSats) {
      participant.logger.info(
        { balance: updated.toString(), required: amountSats.toString() },
        'Participant mock sBTC balance is ready'
      );
      return;
    }
    await sleep();
  }
  throw new Error(`Timed out waiting for mock sBTC mint to ${participant.stxAddress}`);
}

async function hasBondMembership(participant: Account) {
  return isSome(
    await pox5ReadOnly(
      'get-bond-membership',
      [principalCV(participant.stxAddress)],
      participant.stxAddress
    )
  );
}

async function waitForRegistrationWindow(client: Account['client'], selection: BondSelection) {
  while (true) {
    const poxInfo: PoxInfo = await client.getPoxInfo();
    const currentBurnHeight = poxInfo.current_burnchain_block_height ?? 0;
    if (BigInt(currentBurnHeight) >= selection.startBurnHeight) {
      throw new Error(
        `PoX-5 bond ${selection.index} has already started at burn height ${selection.startBurnHeight}`
      );
    }
    if (!isPreparePhase(currentBurnHeight)) return;
    logger.info(
      {
        bondIndex: selection.index.toString(),
        currentBurnHeight,
        startBurnHeight: selection.startBurnHeight.toString(),
      },
      'Waiting for non-prepare phase before register-for-bond'
    );
    await sleep();
  }
}

async function registerForBond(
  client: Account['client'],
  selection: BondSelection,
  participant: Account,
  signerManager: SignerManager
) {
  if (await hasBondMembership(participant)) {
    participant.logger.info('Participant already has active PoX-5 bond membership');
    return;
  }

  await waitForRegistrationWindow(client, selection);
  const nonce = await getNonce(participant.stxAddress, network);
  const tx = await makeContractCall({
    contractAddress: POX5_BOOT_ADDRESS,
    contractName: POX5_CONTRACT_NAME,
    functionName: 'register-for-bond',
    functionArgs: [
      uintCV(selection.index),
      contractPrincipalCV(signerManager.contractAddress, signerManager.contractName),
      uintCV(amountUstx),
      responseErrorCV(uintCV(amountSats)),
      noneCV(),
    ],
    senderKey: participant.privKey,
    nonce,
    fee: callFee,
    anchorMode: AnchorMode.Any,
    network,
    postConditionMode: PostConditionMode.Allow,
  });

  await broadcast(tx, `pox-5 register-for-bond ${participant.stxAddress}`);
  for (let attempt = 1; attempt <= 120; attempt++) {
    if (await hasBondMembership(participant)) {
      participant.logger.info(
        {
          bondIndex: selection.index.toString(),
          amountUstx: amountUstx.toString(),
          amountSats: amountSats.toString(),
          signerManager: `${signerManager.contractAddress}.${signerManager.contractName}`,
        },
        'Participant registered for PoX-5 Bitcoin Staking bond'
      );
      return;
    }
    await sleep();
  }
  throw new Error(`Timed out waiting for PoX-5 bond membership for ${participant.stxAddress}`);
}

async function contractExists(contractAddress: string, contractName: string) {
  try {
    const result = await contractsApi.getContractSource({ contractAddress, contractName });
    return !!result.source;
  } catch {
    return false;
  }
}

async function waitForSbtcContract() {
  while (!(await contractExists(sbtcContract.contractAddress, sbtcContract.contractName))) {
    logger.info({ contract: sbtcContractId }, 'Waiting for mock sBTC contract');
    await sleep();
  }
}

async function run() {
  validateConfig();

  const participants = getAccounts(participantKeys, new Array(participantKeys.length).fill(1));
  const signerAccounts = getAccounts(signerKeys, new Array(signerKeys.length).fill(1));
  const signerManagers = signerAccounts.map(account => ({
    contractAddress: account.stxAddress,
    contractName: signerManagerName(account),
  }));

  logger.info(
    {
      participants: participants.map(account => account.stxAddress),
      signerManagers: signerManagers.map(
        signerManager => `${signerManager.contractAddress}.${signerManager.contractName}`
      ),
      configuredBondIndex: configuredBondIndex.toString(),
      amountUstx: amountUstx.toString(),
      amountSats: amountSats.toString(),
      sbtcContractId,
    },
    'Starting PoX-5 Bitcoin Staking helper'
  );

  await waitForSetup(participantKeys, new Array(participantKeys.length).fill(1));
  const poxInfo = await waitForPox5(participants[0].client);
  await waitForSbtcContract();
  await waitForSignerManagers(signerManagers);

  const selection = await selectBondIndex(participants[0].client, participants);
  logger.info(
    {
      bondIndex: selection.index.toString(),
      bondStartBurnHeight: selection.startBurnHeight.toString(),
      currentBurnHeight: poxInfo.current_burnchain_block_height,
      exists: selection.exists,
    },
    'Selected PoX-5 bond'
  );

  await setupBond(selection, participants);
  for (const participant of participants) {
    await mintSbtcIfNeeded(participant);
  }
  for (const participant of participants) {
    const signerManager = signerManagers[participant.index % signerManagers.length]!;
    await registerForBond(participants[0].client, selection, participant, signerManager);
  }

  logger.info({ bondIndex: selection.index.toString() }, 'PoX-5 Bitcoin Staking setup complete');
}

run().catch(error => {
  logger.error({ error }, 'PoX-5 Bitcoin Staking setup failed');
  process.exit(1);
});
