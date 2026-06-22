import { hexToBytes } from '@stacks/common';
import {
  AnchorMode,
  ClarityVersion,
  PostConditionMode,
  bufferCV,
  contractPrincipalCV,
  getNonce,
  makeContractCall,
  makeContractDeploy,
  principalCV,
  signStructuredData,
  stringAsciiCV,
  tupleCV,
  uintCV,
} from '@stacks/transactions';
import crypto from 'crypto';
import { loadContractSource } from './contract-fixtures';
import type { Account } from './common';
import { network } from './common';
import { broadcastOrThrow, contractExists, waitForContract } from './helpers';
import type { SignerManager } from './pox5';

const POX5_CLARITY_VERSION = 6 as ClarityVersion;
const randInt = () => crypto.randomInt(0, 0xffffffffffff);

export function signerManagerName(account: Account) {
  return `pox5-signer-${account.index}`;
}

export function signerManagerForAccount(account: Account): SignerManager {
  return {
    contractAddress: account.stxAddress,
    contractName: signerManagerName(account),
  };
}

function makeGrantSignature(
  account: Account,
  signerManager: SignerManager,
  chainId: number,
  authId: number
) {
  const signerManagerPrincipal = `${signerManager.contractAddress}.${signerManager.contractName}`;
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

export async function ensurePox5Signer(
  account: Account,
  {
    chainId,
    deployFee,
    callFee,
  }: {
    chainId: number;
    deployFee: number;
    callFee: number;
  }
) {
  const signerManager = signerManagerForAccount(account);
  let nonce = await getNonce(account.stxAddress, network);

  if (!(await contractExists(signerManager.contractAddress, signerManager.contractName))) {
    const deployTx = await makeContractDeploy({
      contractName: signerManager.contractName,
      codeBody: loadContractSource('pox5-signer-manager.clar'),
      senderKey: account.privKey,
      nonce,
      fee: deployFee,
      anchorMode: AnchorMode.Any,
      network,
      clarityVersion: POX5_CLARITY_VERSION,
      postConditionMode: PostConditionMode.Allow,
    });
    await broadcastOrThrow(deployTx, `${signerManager.contractName} deploy`, {
      log: account.logger,
      message: `Broadcast ${signerManager.contractName} deploy`,
    });
    await waitForContract(signerManager.contractAddress, signerManager.contractName);
    nonce += 1n;
  }

  const authId = randInt();
  const signerSignature = makeGrantSignature(account, signerManager, chainId, authId);
  const registerTx = await makeContractCall({
    contractAddress: signerManager.contractAddress,
    contractName: signerManager.contractName,
    functionName: 'register-self',
    functionArgs: [
      contractPrincipalCV(signerManager.contractAddress, signerManager.contractName),
      bufferCV(hexToBytes(account.signerPubKey)),
      uintCV(authId),
      bufferCV(hexToBytes(signerSignature)),
    ],
    senderKey: account.privKey,
    nonce,
    fee: callFee,
    anchorMode: AnchorMode.Any,
    network,
    postConditionMode: PostConditionMode.Allow,
  });
  await broadcastOrThrow(registerTx, `${signerManager.contractName} register-self`, {
    log: account.logger,
    message: `Broadcast ${signerManager.contractName} register-self`,
  });
  return nonce + 1n;
}
