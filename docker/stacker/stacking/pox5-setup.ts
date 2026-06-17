import { StacksTestnet } from '@stacks/network';
import { StackingClient } from '@stacks/stacking';
import {
  AnchorMode,
  PostConditionMode,
  TransactionVersion,
  broadcastTransaction,
  getAddressFromPrivateKey,
  getNonce,
  makeContractDeploy,
  StacksTransaction,
} from '@stacks/transactions';
import { getPublicKeyFromPrivate } from '@stacks/encryption';
import { contractsApi, logger, parseEnvInt } from './common';

const nodeUrl = `http://${process.env.STACKS_CORE_RPC_HOST}:${process.env.STACKS_CORE_RPC_PORT}`;
const network = new StacksTestnet({ url: nodeUrl });
const deployerPrivateKey = process.env.POX_5_DEPLOYER_PRIVATE_KEY!;
const deployerAddress = process.env.POX_5_DEPLOYER_ADDRESS!;
const sbtcContractId = process.env.POX_5_SBTC_CONTRACT!;
const sbtcRegistryContractId = process.env.POX_5_SBTC_REGISTRY_CONTRACT!;
const epoch30Start = parseEnvInt('STACKS_30_HEIGHT', true);
const epoch40Start = parseEnvInt('STACKS_40_HEIGHT', true);
const setupSafetyBlocks = parseEnvInt('POX_5_SETUP_SAFETY_BLOCKS', false) ?? 5;
const stackerKeys = process.env.STACKING_KEYS?.split(',').filter(Boolean) ?? [];

const deployerFromPrivateKey = getAddressFromPrivateKey(
  deployerPrivateKey,
  TransactionVersion.Testnet
);
const client = new StackingClient(deployerAddress, network);

function splitContractId(contractId: string) {
  const [contractAddress, contractName, ...extra] = contractId.split('.');
  if (!contractAddress || !contractName || extra.length > 0) {
    throw new Error(`Invalid contract id: ${contractId}`);
  }
  return { contractAddress, contractName };
}

const sbtcContract = splitContractId(sbtcContractId);
const sbtcRegistryContract = splitContractId(sbtcRegistryContractId);

function validateConfig() {
  if (deployerFromPrivateKey !== deployerAddress) {
    throw new Error(
      `POX_5_DEPLOYER_PRIVATE_KEY derives ${deployerFromPrivateKey}, expected ${deployerAddress}`
    );
  }
  for (const contract of [sbtcContract, sbtcRegistryContract]) {
    if (contract.contractAddress !== deployerAddress) {
      throw new Error(
        `PoX-5 setup can only deploy ${deployerAddress} contracts, got ${contract.contractAddress}.${contract.contractName}`
      );
    }
  }
  if (stackerKeys.length === 0) {
    throw new Error('No STACKING_KEYS provided; cannot derive sBTC registry aggregate key');
  }
}

function sbtcRegistrySource(aggregatePubkey: string) {
  return `
(define-read-only (get-current-aggregate-pubkey)
  0x${aggregatePubkey}
)
`.trim();
}

function sbtcTokenSource() {
  return `
(define-fungible-token sbtc-token)

(define-public (transfer
    (amount uint)
    (sender principal)
    (recipient principal)
    (memo (optional (buff 34))))
  (begin
    (try! (ft-transfer? sbtc-token amount sender recipient))
    (ok true)))

(define-read-only (get-balance (who principal))
  (ok (ft-get-balance sbtc-token who)))

(define-public (mint (amount uint) (recipient principal))
  (ft-mint? sbtc-token amount recipient))
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

async function waitForNode() {
  while (true) {
    try {
      const poxInfo = await client.getPoxInfo();
      const burnHeight = poxInfo.current_burnchain_block_height ?? 0;
      if (burnHeight <= epoch30Start) {
        logger.info(
          { burnHeight, epoch30Start },
          'Waiting for Nakamoto before deploying PoX-5 prerequisite contracts'
        );
      } else {
        return poxInfo;
      }
    } catch (error) {
      logger.info({ error }, 'Stacks node not ready for PoX-5 setup');
    }
    await new Promise(resolve => setTimeout(resolve, 3000));
  }
}

async function assertBeforeEpoch4() {
  const poxInfo = await client.getPoxInfo();
  const burnHeight = poxInfo.current_burnchain_block_height ?? 0;
  if (burnHeight >= epoch40Start - setupSafetyBlocks) {
    throw new Error(
      `PoX-5 prerequisite setup is too close to Epoch 4.0 (burn=${burnHeight}, epoch4=${epoch40Start}, safety=${setupSafetyBlocks})`
    );
  }
}

async function broadcast(tx: StacksTransaction, label: string) {
  const result = await broadcastTransaction(tx, network);
  if (result.error) {
    throw new Error(`Error broadcasting ${label}: ${JSON.stringify(result)}`);
  }
  logger.info({ txid: result.txid, label }, 'Broadcast PoX-5 prerequisite deploy');
  return result.txid;
}

async function deployContract(contractName: string, codeBody: string, nonce: bigint) {
  await assertBeforeEpoch4();
  const tx = await makeContractDeploy({
    contractName,
    codeBody,
    senderKey: deployerPrivateKey,
    nonce,
    fee: 3_000_000,
    anchorMode: AnchorMode.Any,
    network,
    postConditionMode: PostConditionMode.Allow,
  });
  await broadcast(tx, `${deployerAddress}.${contractName}`);
}

async function waitForContract(contractName: string) {
  for (let attempt = 1; attempt <= 90; attempt++) {
    if (await contractExists(deployerAddress, contractName)) {
      logger.info({ contract: `${deployerAddress}.${contractName}` }, 'Contract deployed');
      return;
    }
    await assertBeforeEpoch4();
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  throw new Error(`Timed out waiting for ${deployerAddress}.${contractName} to deploy`);
}

async function deployIfMissing(contractName: string, codeBody: string, nonce: bigint) {
  if (await contractExists(deployerAddress, contractName)) {
    logger.info({ contract: `${deployerAddress}.${contractName}` }, 'Contract already deployed');
    return false;
  }
  await deployContract(contractName, codeBody, nonce);
  await waitForContract(contractName);
  return true;
}

async function run() {
  validateConfig();
  await waitForNode();

  const aggregatePubkey = getPublicKeyFromPrivate(stackerKeys[0]);
  let nonce = await getNonce(deployerAddress, network);

  logger.info(
    {
      deployerAddress,
      sbtcContractId,
      sbtcRegistryContractId,
      aggregatePubkey,
      epoch40Start,
    },
    'Starting PoX-5 prerequisite setup'
  );

  if (await deployIfMissing(sbtcContract.contractName, sbtcTokenSource(), nonce)) {
    nonce += 1n;
  }
  if (
    await deployIfMissing(
      sbtcRegistryContract.contractName,
      sbtcRegistrySource(aggregatePubkey),
      nonce
    )
  ) {
    nonce += 1n;
  }

  logger.info('PoX-5 prerequisite setup complete');
}

run().catch(error => {
  logger.error({ error }, 'PoX-5 prerequisite setup failed');
  process.exit(1);
});
