import {
  AnchorMode,
  type ClarityValue,
  PostConditionMode,
  bufferCV,
  callReadOnlyFunction,
  contractPrincipalCV,
  getNonce,
  listCV,
  makeContractCall,
  noneCV,
  principalCV,
  responseErrorCV,
  tupleCV,
  uintCV,
} from '@stacks/transactions';
import type { Account } from './common';
import { POX_REWARD_LENGTH, logger, network } from './common';
import { broadcastOrThrow, isSome, optionalUintValue, sleep, uintValue } from './helpers';

export const POX5_BOOT_ADDRESS = 'ST000000000000000000002AMW42H';
export const POX5_CONTRACT_NAME = 'pox-5';

const BOND_GAP_CYCLES = 2n;
const EMPTY_BTC_LOCK_PROOF = new Uint8Array(683);

export type SignerManager = {
  contractAddress: string;
  contractName: string;
};

export type BondSelection = {
  index: bigint;
  startBurnHeight: bigint;
  exists: boolean;
};

export async function pox5ReadOnly(
  functionName: string,
  functionArgs: ClarityValue[],
  senderAddress: string
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

export async function waitForPox5(client: Account['client'], pollIntervalMs: number) {
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
    await sleep(pollIntervalMs);
  }
}

export async function hasPox5Stake(stxAddress: string) {
  const result = await pox5ReadOnly('get-staker-info', [principalCV(stxAddress)], stxAddress);
  return isSome(result);
}

export async function signerRegistered(signerManager: SignerManager, senderAddress: string) {
  const result = await pox5ReadOnly(
    'get-signer-info',
    [contractPrincipalCV(signerManager.contractAddress, signerManager.contractName)],
    senderAddress
  );
  return isSome(result);
}

export async function waitForSignerManagers(
  signerManagers: SignerManager[],
  senderAddress: string,
  pollIntervalMs: number
) {
  while (true) {
    const missing: string[] = [];
    for (const signerManager of signerManagers) {
      if (!(await signerRegistered(signerManager, senderAddress))) {
        missing.push(`${signerManager.contractAddress}.${signerManager.contractName}`);
      }
    }
    if (missing.length === 0) {
      logger.info({ signers: signerManagers.length }, 'PoX-5 signer managers are registered');
      return;
    }
    logger.info({ missing }, 'Waiting for PoX-5 signer managers to register');
    await sleep(pollIntervalMs);
  }
}

export async function bondStartBurnHeight(bondIndex: bigint, senderAddress: string) {
  return uintValue(
    await pox5ReadOnly('bond-period-to-burn-height', [uintCV(bondIndex)], senderAddress),
    'bond-period-to-burn-height'
  );
}

export async function bondExists(bondIndex: bigint, senderAddress: string) {
  return isSome(await pox5ReadOnly('get-protocol-bond', [uintCV(bondIndex)], senderAddress));
}

export async function bondAllowance(bondIndex: bigint, staker: string) {
  return optionalUintValue(
    await pox5ReadOnly('get-bond-allowance', [uintCV(bondIndex), principalCV(staker)], staker),
    'get-bond-allowance'
  );
}

export async function hasBondMembership(staker: string) {
  return isSome(await pox5ReadOnly('get-bond-membership', [principalCV(staker)], staker));
}

export function bondSetupOpenHeight(startBurnHeight: bigint) {
  const setupWindow = BOND_GAP_CYCLES * BigInt(POX_REWARD_LENGTH);
  return startBurnHeight > setupWindow ? startBurnHeight - setupWindow : 0n;
}

export async function stake({
  account,
  signerManager,
  amountUstx,
  cycles,
  startBurnHeight,
  nonce,
  fee,
}: {
  account: Account;
  signerManager: SignerManager;
  amountUstx: bigint;
  cycles: number;
  startBurnHeight: number;
  nonce: bigint;
  fee: number;
}) {
  const tx = await makeContractCall({
    contractAddress: POX5_BOOT_ADDRESS,
    contractName: POX5_CONTRACT_NAME,
    functionName: 'stake',
    functionArgs: [
      contractPrincipalCV(signerManager.contractAddress, signerManager.contractName),
      uintCV(amountUstx),
      uintCV(cycles),
      uintCV(startBurnHeight),
      noneCV(),
    ],
    senderKey: account.privKey,
    nonce,
    fee,
    anchorMode: AnchorMode.Any,
    network,
    postConditionMode: PostConditionMode.Allow,
  });
  return broadcastOrThrow(tx, 'pox-5 stake', {
    log: account.logger,
    message: 'Broadcast pox-5 stake',
  });
}

export async function stakeUpdate({
  account,
  signerManager,
  cycles,
  nonce,
  fee,
}: {
  account: Account;
  signerManager: SignerManager;
  cycles: number;
  nonce: bigint;
  fee: number;
}) {
  const signerManagerPrincipal = contractPrincipalCV(
    signerManager.contractAddress,
    signerManager.contractName
  );
  const tx = await makeContractCall({
    contractAddress: POX5_BOOT_ADDRESS,
    contractName: POX5_CONTRACT_NAME,
    functionName: 'stake-update',
    functionArgs: [
      signerManagerPrincipal,
      signerManagerPrincipal,
      uintCV(cycles),
      uintCV(0),
      noneCV(),
    ],
    senderKey: account.privKey,
    nonce,
    fee,
    anchorMode: AnchorMode.Any,
    network,
    postConditionMode: PostConditionMode.Allow,
  });
  return broadcastOrThrow(tx, 'pox-5 stake-update', {
    log: account.logger,
    message: 'Broadcast pox-5 stake-update',
  });
}

export async function setupBond({
  bondAdminAddress,
  bondAdminPrivateKey,
  bondIndex,
  targetRate,
  stxValueRatio,
  minUstxRatio,
  allowlist,
  fee,
}: {
  bondAdminAddress: string;
  bondAdminPrivateKey: string;
  bondIndex: bigint;
  targetRate: bigint;
  stxValueRatio: bigint;
  minUstxRatio: bigint;
  allowlist: { staker: string; maxSats: bigint }[];
  fee: number;
}) {
  const nonce = await getNonce(bondAdminAddress, network);
  const tx = await makeContractCall({
    contractAddress: POX5_BOOT_ADDRESS,
    contractName: POX5_CONTRACT_NAME,
    functionName: 'setup-bond',
    functionArgs: [
      uintCV(bondIndex),
      uintCV(targetRate),
      uintCV(stxValueRatio),
      uintCV(minUstxRatio),
      bufferCV(EMPTY_BTC_LOCK_PROOF),
      listCV(
        allowlist.map(({ staker, maxSats }) =>
          tupleCV({
            staker: principalCV(staker),
            'max-sats': uintCV(maxSats),
          })
        )
      ),
    ],
    senderKey: bondAdminPrivateKey,
    nonce,
    fee,
    anchorMode: AnchorMode.Any,
    network,
    postConditionMode: PostConditionMode.Allow,
  });
  return broadcastOrThrow(tx, `pox-5 setup-bond ${bondIndex}`, {
    message: 'Broadcast Bitcoin Staking transaction',
  });
}

export async function registerForBond({
  participant,
  signerManager,
  bondIndex,
  amountUstx,
  amountSats,
  fee,
}: {
  participant: Account;
  signerManager: SignerManager;
  bondIndex: bigint;
  amountUstx: bigint;
  amountSats: bigint;
  fee: number;
}) {
  const nonce = await getNonce(participant.stxAddress, network);
  const tx = await makeContractCall({
    contractAddress: POX5_BOOT_ADDRESS,
    contractName: POX5_CONTRACT_NAME,
    functionName: 'register-for-bond',
    functionArgs: [
      uintCV(bondIndex),
      contractPrincipalCV(signerManager.contractAddress, signerManager.contractName),
      uintCV(amountUstx),
      responseErrorCV(uintCV(amountSats)),
      noneCV(),
    ],
    senderKey: participant.privKey,
    nonce,
    fee,
    anchorMode: AnchorMode.Any,
    network,
    postConditionMode: PostConditionMode.Allow,
  });
  return broadcastOrThrow(tx, `pox-5 register-for-bond ${participant.stxAddress}`, {
    log: participant.logger,
    message: 'Broadcast Bitcoin Staking transaction',
  });
}
