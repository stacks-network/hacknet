import {
  ClarityType,
  type ClarityValue,
  type StacksTransaction,
  broadcastTransaction,
  cvToString,
} from '@stacks/transactions';
import type { Logger } from 'pino';
import { contractsApi, logger, network } from './common';

export type ContractId = {
  contractAddress: string;
  contractName: string;
};

export function splitContractId(contractId: string): ContractId {
  const [contractAddress, contractName, ...extra] = contractId.split('.');
  if (!contractAddress || !contractName || extra.length > 0) {
    throw new Error(`Invalid contract id: ${contractId}`);
  }
  return { contractAddress, contractName };
}

export function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function parseEnvBigInt(envKey: string) {
  const value = process.env[envKey];
  if (typeof value === 'undefined') return undefined;
  if (!/^[0-9]+$/.test(value)) {
    throw new Error(`${envKey} must be an unsigned integer, got ${value}`);
  }
  return BigInt(value);
}

export function uintValue(value: ClarityValue, label: string) {
  if (value.type !== ClarityType.UInt) {
    throw new Error(`${label} expected uint, got ${cvToString(value)}`);
  }
  return value.value;
}

export function okUintValue(value: ClarityValue, label: string) {
  if (value.type !== ClarityType.ResponseOk) {
    throw new Error(`${label} expected ok uint, got ${cvToString(value)}`);
  }
  return uintValue(value.value, label);
}

export function optionalUintValue(value: ClarityValue, label: string) {
  if (value.type === ClarityType.OptionalNone) return undefined;
  if (value.type !== ClarityType.OptionalSome) {
    throw new Error(`${label} expected optional uint, got ${cvToString(value)}`);
  }
  return uintValue(value.value, label);
}

export function isSome(value: ClarityValue) {
  return value.type === ClarityType.OptionalSome;
}

export async function contractExists(contractAddress: string, contractName: string) {
  try {
    const result = await contractsApi.getContractSource({ contractAddress, contractName });
    return !!result.source;
  } catch {
    return false;
  }
}

export async function waitForContract(
  contractAddress: string,
  contractName: string,
  {
    attempts = 90,
    intervalMs = 2000,
    onAttempt,
  }: {
    attempts?: number;
    intervalMs?: number;
    onAttempt?: () => Promise<void>;
  } = {}
) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (await contractExists(contractAddress, contractName)) return;
    await onAttempt?.();
    await sleep(intervalMs);
  }
  throw new Error(`Timed out waiting for ${contractAddress}.${contractName} to deploy`);
}

export async function broadcastOrThrow(
  tx: StacksTransaction,
  label: string,
  {
    log = logger,
    message = 'Broadcast transaction',
  }: {
    log?: Logger;
    message?: string;
  } = {}
) {
  const result = await broadcastTransaction(tx, network);
  if (result.error) {
    log.error({ ...result, label }, `Error broadcasting ${label}`);
    throw new Error(`Error broadcasting ${label}: ${JSON.stringify(result)}`);
  }
  log.info({ txid: result.txid, label }, message);
  return result.txid;
}
