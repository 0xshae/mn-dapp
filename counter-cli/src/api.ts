// This file is part of midnightntwrk/example-counter.
// Copyright (C) 2025 Midnight Foundation
// SPDX-License-Identifier: Apache-2.0
// Licensed under the Apache License, Version 2.0 (the "License");
// You may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
// http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import { type ContractAddress } from '@midnight-ntwrk/compact-runtime';
import { Counter, type CounterPrivateState, witnesses } from '@midnight-ntwrk/counter-contract';
import * as ledger from '@midnight-ntwrk/ledger-v6';
import { deployContract, findDeployedContract } from '@midnight-ntwrk/midnight-js-contracts';
import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import {
  type BalancedProvingRecipe,
  type FinalizedTxData,
  type MidnightProvider,
  type WalletProvider,
} from '@midnight-ntwrk/midnight-js-types';
import { webcrypto } from 'crypto';
import { type Logger } from 'pino';
import * as Rx from 'rxjs';
import { WebSocket } from 'ws';
import {
  type CounterContract,
  type CounterPrivateStateId,
  type CounterProviders,
  type DeployedCounterContract,
} from './common-types';
import { type Config, type NetworkIdType, contractConfig } from './config';
import { levelPrivateStateProvider } from '@midnight-ntwrk/midnight-js-level-private-state-provider';
import { assertIsContractAddress, toHex } from '@midnight-ntwrk/midnight-js-utils';

// New wallet SDK imports
import { WalletFacade, type FacadeState } from '@midnight-ntwrk/wallet-sdk-facade';
import { HDWallet, Roles } from '@midnight-ntwrk/wallet-sdk-hd';
import { ShieldedWallet } from '@midnight-ntwrk/wallet-sdk-shielded';
import { DustWallet } from '@midnight-ntwrk/wallet-sdk-dust-wallet';
import {
  createKeystore,
  InMemoryTransactionHistoryStorage,
  PublicKey as UnshieldedPublicKey,
  type UnshieldedKeystore,
  UnshieldedWallet,
} from '@midnight-ntwrk/wallet-sdk-unshielded-wallet';
import { MidnightBech32m } from '@midnight-ntwrk/wallet-sdk-address-format';
import * as bip39 from 'bip39';

let logger: Logger;

// @ts-expect-error: It's needed to enable WebSocket usage through apollo
globalThis.WebSocket = WebSocket;

// Configuration type for wallet SDK
interface WalletSDKConfig {
  networkId: NetworkIdType;
  costParameters: {
    additionalFeeOverhead: bigint;
    feeBlocksMargin: number;
  };
  relayURL: URL;
  provingServerUrl: URL;
  indexerClientConnection: {
    indexerHttpUrl: string;
    indexerWsUrl: string;
  };
  indexerUrl: string;
}

// Wallet facade and related types
export interface WalletInstance {
  wallet: WalletFacade;
  shieldedSecretKeys: ledger.ZswapSecretKeys;
  dustSecretKey: ledger.DustSecretKey;
  unshieldedKeystore: UnshieldedKeystore;
  config: Config;
}

export const getCounterLedgerState = async (
  providers: CounterProviders,
  contractAddress: ContractAddress,
): Promise<bigint | null> => {
  assertIsContractAddress(contractAddress);
  logger.info('Checking contract ledger state...');
  const contractState = await providers.publicDataProvider.queryContractState(contractAddress);
  if (contractState === null) {
    return null;
  }
  // Type assertion needed due to SDK type differences between ChargedState and StateValue
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const state = Counter.ledger(contractState.data as any).round;
  logger.info(`Ledger state: ${state}`);
  return state;
};

export const counterContractInstance: CounterContract = new Counter.Contract(witnesses);

export const joinContract = async (
  providers: CounterProviders,
  contractAddress: string,
): Promise<DeployedCounterContract> => {
  const counterContract = await findDeployedContract(providers, {
    contractAddress,
    contract: counterContractInstance,
    privateStateId: 'counterPrivateState',
    initialPrivateState: { privateCounter: 0 },
  });
  logger.info(`Joined contract at address: ${counterContract.deployTxData.public.contractAddress}`);
  return counterContract;
};

export const deploy = async (
  providers: CounterProviders,
  privateState: CounterPrivateState,
): Promise<DeployedCounterContract> => {
  logger.info('Deploying counter contract...');
  const counterContract = await deployContract(providers, {
    contract: counterContractInstance,
    privateStateId: 'counterPrivateState',
    initialPrivateState: privateState,
  });
  logger.info(`Deployed contract at address: ${counterContract.deployTxData.public.contractAddress}`);
  return counterContract;
};

export const increment = async (counterContract: DeployedCounterContract): Promise<FinalizedTxData> => {
  logger.info('Incrementing...');
  const finalizedTxData = await counterContract.callTx.increment();
  logger.info(`Transaction ${finalizedTxData.public.txId} added in block ${finalizedTxData.public.blockHeight}`);
  return finalizedTxData.public;
};

export const displayCounterValue = async (
  providers: CounterProviders,
  counterContract: DeployedCounterContract,
): Promise<{ counterValue: bigint | null; contractAddress: string }> => {
  const contractAddress = counterContract.deployTxData.public.contractAddress;
  const counterValue = await getCounterLedgerState(providers, contractAddress);
  if (counterValue === null) {
    logger.info(`There is no counter contract deployed at ${contractAddress}.`);
  } else {
    logger.info(`Current counter value: ${Number(counterValue)}`);
  }
  return { contractAddress, counterValue };
};

/**
 * Create wallet and midnight providers from WalletFacade
 * This adapts the new wallet SDK to the WalletProvider/MidnightProvider interfaces
 */
export const createWalletAndMidnightProvider = async (
  walletInstance: WalletInstance,
): Promise<WalletProvider & MidnightProvider> => {
  const state = await Rx.firstValueFrom(
    walletInstance.wallet.state().pipe(Rx.filter((s: FacadeState) => s.isSynced)),
  );

  // Get public keys as hex strings (what the old API expected)
  const coinPublicKey = state.shielded.coinPublicKey.toString();
  const encryptionPublicKey = state.shielded.encryptionPublicKey.toString();

  return {
    getCoinPublicKey() {
      return coinPublicKey as ledger.CoinPublicKey;
    },
    getEncryptionPublicKey() {
      return encryptionPublicKey as ledger.EncPublicKey;
    },
    async balanceTx(
      tx: ledger.UnprovenTransaction,
      newCoins?: ledger.ShieldedCoinInfo[],
      ttl?: Date,
    ): Promise<BalancedProvingRecipe> {
      // Use the shielded wallet's balanceTransaction method
      const recipe = await walletInstance.wallet.shielded.balanceTransaction(
        walletInstance.shieldedSecretKeys,
        tx,
        newCoins ?? [],
      );

      // Get the transaction to sign based on recipe type
      let transactionToSign: ledger.UnprovenTransaction;
      if (recipe.type === 'TransactionToProve') {
        transactionToSign = recipe.transaction;
      } else if (recipe.type === 'BalanceTransactionToProve') {
        transactionToSign = recipe.transactionToProve;
      } else {
        // NothingToProve - transaction is already finalized
        return {
          type: 'NothingToProve',
          transaction: recipe.transaction,
        } as BalancedProvingRecipe;
      }

      // Sign the transaction
      const signedTx = await walletInstance.wallet.signTransaction(
        transactionToSign,
        (payload) => walletInstance.unshieldedKeystore.signData(payload),
      );

      // Finalize the transaction (includes proving)
      const finalizedTx = await walletInstance.wallet.finalizeTransaction({
        type: 'TransactionToProve',
        transaction: signedTx,
      });

      return {
        type: 'NothingToProve',
        transaction: finalizedTx,
      } as BalancedProvingRecipe;
    },
    async submitTx(tx: ledger.FinalizedTransaction): Promise<ledger.TransactionId> {
      const txId = await walletInstance.wallet.submitTransaction(tx);
      return txId as unknown as ledger.TransactionId;
    },
  };
};

export const waitForSync = (walletInstance: WalletInstance) =>
  Rx.firstValueFrom(
    walletInstance.wallet.state().pipe(
      Rx.throttleTime(5_000),
      Rx.tap((state: FacadeState) => {
        logger.info(`Waiting for sync. Synced: ${state.isSynced}`);
      }),
      Rx.filter((state: FacadeState) => state.isSynced),
    ),
  );

export const waitForFunds = (walletInstance: WalletInstance) =>
  Rx.firstValueFrom(
    walletInstance.wallet.state().pipe(
      Rx.throttleTime(10_000),
      Rx.tap((state: FacadeState) => {
        const balance = state.shielded.balances[ledger.nativeToken().raw] ?? 0n;
        logger.info(`Waiting for funds. Synced: ${state.isSynced}, balance: ${balance}`);
      }),
      Rx.filter((state: FacadeState) => state.isSynced),
      Rx.map((s: FacadeState) => s.shielded.balances[ledger.nativeToken().raw] ?? 0n),
      Rx.filter((balance: bigint) => balance > 0n),
    ),
  );

/**
 * Create wallet SDK configuration from app config
 */
const createWalletConfig = (config: Config): WalletSDKConfig => ({
  networkId: config.networkId,
  costParameters: {
    additionalFeeOverhead: 300_000_000_000_000_000n,
    feeBlocksMargin: 5,
  },
  relayURL: new URL(config.node.replace('http', 'ws')),
  provingServerUrl: new URL(config.proofServer),
  indexerClientConnection: {
    indexerHttpUrl: config.indexer,
    indexerWsUrl: config.indexerWS,
  },
  indexerUrl: config.indexerWS,
});

/**
 * Initialize wallet from a hex seed (32 bytes)
 */
export const initWalletFromHexSeed = async (
  config: Config,
  hexSeed: string,
): Promise<WalletInstance> => {
  const seed = Buffer.from(hexSeed, 'hex');
  return await initWalletFromSeed(config, seed);
};

/**
 * Initialize wallet from a BIP-39 mnemonic
 */
export const initWalletFromMnemonic = async (
  config: Config,
  mnemonic: string,
): Promise<WalletInstance> => {
  const seed = await bip39.mnemonicToSeed(mnemonic);
  // To match Lace Wallet derivation, take the first 32 bytes
  const takeSeed = seed.subarray(0, 32);
  return await initWalletFromSeed(config, Buffer.from(takeSeed));
};

/**
 * Initialize wallet from a seed buffer
 */
export const initWalletFromSeed = async (
  config: Config,
  seed: Buffer,
): Promise<WalletInstance> => {
  const walletConfig = createWalletConfig(config);

  const hdWallet = HDWallet.fromSeed(Uint8Array.from(seed));

  if (hdWallet.type !== 'seedOk') {
    throw new Error('Failed to initialize HDWallet');
  }

  const derivationResult = hdWallet.hdWallet
    .selectAccount(0)
    .selectRoles([Roles.Zswap, Roles.NightExternal, Roles.Dust])
    .deriveKeysAt(0);

  if (derivationResult.type !== 'keysDerived') {
    throw new Error('Failed to derive keys');
  }

  hdWallet.hdWallet.clear();

  const shieldedSecretKeys = ledger.ZswapSecretKeys.fromSeed(derivationResult.keys[Roles.Zswap]);
  const dustSecretKey = ledger.DustSecretKey.fromSeed(derivationResult.keys[Roles.Dust]);
  const unshieldedKeystore = createKeystore(derivationResult.keys[Roles.NightExternal], config.networkId);

  const shieldedWallet = ShieldedWallet(walletConfig).startWithSecretKeys(shieldedSecretKeys);
  const dustWallet = DustWallet(walletConfig).startWithSecretKey(
    dustSecretKey,
    ledger.LedgerParameters.initialParameters().dust,
  );
  const unshieldedWallet = UnshieldedWallet({
    ...walletConfig,
    txHistoryStorage: new InMemoryTransactionHistoryStorage(),
  }).startWithPublicKey(UnshieldedPublicKey.fromKeyStore(unshieldedKeystore));

  const facade = new WalletFacade(shieldedWallet, unshieldedWallet, dustWallet);
  await facade.start(shieldedSecretKeys, dustSecretKey);

  return { wallet: facade, shieldedSecretKeys, dustSecretKey, unshieldedKeystore, config };
};

export const buildWalletAndWaitForFunds = async (
  config: Config,
  seed: string,
): Promise<WalletInstance> => {
  logger.info('Building wallet from seed...');

  let walletInstance: WalletInstance;

  // Check if seed is a mnemonic or hex
  if (bip39.validateMnemonic(seed)) {
    walletInstance = await initWalletFromMnemonic(config, seed);
  } else {
    walletInstance = await initWalletFromHexSeed(config, seed);
  }

  // Wait for sync first
  await waitForSync(walletInstance);

  // Get wallet state
  const state = await Rx.firstValueFrom(walletInstance.wallet.state());

  const shieldedAddress = MidnightBech32m.encode(config.networkId, state.shielded.address).toString();
  const unshieldedAddress = walletInstance.unshieldedKeystore.getBech32Address().toString();

  logger.info(`Your wallet seed is: ${seed}`);
  logger.info(`Your shielded address is: ${shieldedAddress}`);
  logger.info(`Your unshielded address is: ${unshieldedAddress}`);

  const balance = state.shielded.balances[ledger.nativeToken().raw] ?? 0n;
  if (balance === 0n) {
    logger.info(`Your wallet balance is: 0`);
    logger.info(`Waiting to receive tokens...`);
    await waitForFunds(walletInstance);
  }

  const finalState = await Rx.firstValueFrom(walletInstance.wallet.state());
  const finalBalance = finalState.shielded.balances[ledger.nativeToken().raw] ?? 0n;
  logger.info(`Your wallet balance is: ${finalBalance}`);

  return walletInstance;
};

export const randomBytes = (length: number): Uint8Array => {
  const bytes = new Uint8Array(length);
  webcrypto.getRandomValues(bytes);
  return bytes;
};

export const buildFreshWallet = async (config: Config): Promise<WalletInstance> => {
  const seed = toHex(randomBytes(32));
  return await buildWalletAndWaitForFunds(config, seed);
};

export const configureProviders = async (walletInstance: WalletInstance, config: Config) => {
  const walletAndMidnightProvider = await createWalletAndMidnightProvider(walletInstance);
  return {
    privateStateProvider: levelPrivateStateProvider<typeof CounterPrivateStateId>({
      privateStateStoreName: contractConfig.privateStateStoreName,
      signingKeyStoreName: contractConfig.signingKeyStoreName,
      walletProvider: walletAndMidnightProvider,
    }),
    publicDataProvider: indexerPublicDataProvider(config.indexer, config.indexerWS),
    zkConfigProvider: new NodeZkConfigProvider<'increment'>(contractConfig.zkConfigPath),
    proofProvider: httpClientProofProvider(config.proofServer),
    walletProvider: walletAndMidnightProvider,
    midnightProvider: walletAndMidnightProvider,
  };
};

export function setLogger(_logger: Logger) {
  logger = _logger;
}

export const closeWallet = async (walletInstance: WalletInstance): Promise<void> => {
  try {
    await walletInstance.wallet.stop();
  } catch (e) {
    logger.error(`Error closing wallet: ${e}`);
  }
};
