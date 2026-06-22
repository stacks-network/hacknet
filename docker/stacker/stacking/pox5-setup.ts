import { StackingClient } from '@stacks/stacking';
import {
  AnchorMode,
  PostConditionMode,
  TransactionVersion,
  getAddressFromPrivateKey,
  getNonce,
  makeContractDeploy,
} from '@stacks/transactions';
import { getPublicKeyFromPrivate } from '@stacks/encryption';
import { clarityHexLiteral, loadContractSource, loadContractTemplate } from './contract-fixtures';
import { logger, network, parseEnvInt } from './common';
import {
  broadcastOrThrow,
  contractExists,
  sleep,
  splitContractId,
  waitForContract as waitForContractDeployment,
} from './helpers';

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
    await sleep(3000);
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
  await broadcastOrThrow(tx, `${deployerAddress}.${contractName}`, {
    message: 'Broadcast temporary PoX-5 prerequisite deploy',
  });
}

async function waitForContract(contractName: string) {
  await waitForContractDeployment(deployerAddress, contractName, {
    attempts: 90,
    intervalMs: 2000,
    onAttempt: assertBeforeEpoch4,
  });
  logger.info({ contract: `${deployerAddress}.${contractName}` }, 'Contract deployed');
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
  const sbtcRegistrySource = loadContractTemplate('sbtc-registry.template.clar', {
    AGGREGATE_PUBKEY: clarityHexLiteral(aggregatePubkey, 'sBTC aggregate pubkey'),
  });
  let nonce = await getNonce(deployerAddress, network);

  logger.info(
    {
      deployerAddress,
      sbtcContractId,
      sbtcRegistryContractId,
      aggregatePubkey,
      epoch40Start,
    },
    'Starting temporary PoX-5 prerequisite setup'
  );

  if (
    await deployIfMissing(sbtcContract.contractName, loadContractSource('sbtc-token.clar'), nonce)
  ) {
    nonce += 1n;
  }
  if (await deployIfMissing(sbtcRegistryContract.contractName, sbtcRegistrySource, nonce)) {
    nonce += 1n;
  }

  logger.info('Temporary PoX-5 prerequisite setup complete');
}

run().catch(error => {
  logger.error({ error }, 'PoX-5 prerequisite setup failed');
  process.exit(1);
});
