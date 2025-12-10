import { IncrementalCommitSchema } from '../../shared';
import { IncrementalCommitParams } from '../lib/params';
import { deposit } from '../tx-builders/deposit';
import {
  addAssets,
  LucidEvolution,
  selectUTxOs,
  UTxO,
} from '@lucid-evolution/lucid';
import { env } from '../../config';
import _ from 'lodash';
import { TxBuiltResponse } from '../../api/schemas/response';
import { valueTuplesToAssets } from '../lib/utils';
import { logger } from '../../shared/logger';
import { HydraHandler } from '../lib/hydra';
import { DBOps } from '../../prisma/db-ops';
import { DBStatus } from '../../shared/prisma-schemas';

/**
 * Handles incremental commit operation.
 * This allows users to add more funds to an OPEN Hydra Head without closing it.
 * 
 * Flow:
 * 1. Validate head is OPEN (RUNNING status)
 * 2. Build deposit transaction to L1 smart contract
 * 3. Submit transaction to L1
 * 4. Build commit transaction
 * 5. Send commit to Hydra node via HTTP API
 * 6. Wait for commit confirmation
 * 
 * @param lucid - LucidEvolution instance for blockchain interaction
 * @param params - Parameters for incremental commit (user address, amount, etc.)
 * @returns Transaction response with CBOR hex and UTxO reference
 */
async function handleIncrementalCommit(
  lucid: LucidEvolution,
  params: IncrementalCommitSchema
): Promise<TxBuiltResponse> {
  const {
    user_address: userAddress,
    public_key: publicKey,
    amount,
    funds_utxo_ref: fundsUtxoRef,
  } = params;

  // Step 1: Check if there's an active (RUNNING) head
  const activeHead = await DBOps.getActiveHead();
  if (!activeHead) {
    throw new Error('No active Hydra Head found. Head must be OPEN to perform incremental commit.');
  }
  if (activeHead.status !== DBStatus.RUNNING) {
    throw new Error(`Cannot perform incremental commit. Head status is ${activeHead.status}, but must be RUNNING (OPEN).`);
  }

  logger.info(`Processing incremental commit for user ${userAddress} to head ${activeHead.id}`);

  const localLucid = _.cloneDeep(lucid);
  let fundsUtxo: UTxO | undefined = undefined;
  
  // If user already has a funds UTXO in L2, fetch it
  if (fundsUtxoRef) {
    const { hash: txHash, index } = fundsUtxoRef;
    [fundsUtxo] = await localLucid.utxosByOutRef([
      { txHash, outputIndex: Number(index) },
    ]);
  }

  lucid.selectWallet.fromSeed(env.SEED);
  const adminAddress = await lucid.wallet().address();
  const amountsToCommit = valueTuplesToAssets(amount);
  
  // Select UTxOs from admin wallet to cover the commit amount
  const walletUtxos = await localLucid
    .utxosAt(adminAddress)
    .then((utxos) =>
      selectUTxOs(
        utxos,
        addAssets({ ['lovelace']: 5_000_000n }, amountsToCommit)
      )
    );
  
  if (walletUtxos.length === 0) {
    throw new Error('No UTxOs found in wallet to cover the incremental commit');
  }

  const [validatorRef] = await localLucid.utxosByOutRef([
    { txHash: env.VALIDATOR_REF, outputIndex: 0 },
  ]);

  const nonEmptyPubKey =
    publicKey && publicKey.length > 0 ? publicKey : '0'.repeat(64);

  // Step 2: Build deposit transaction (same as regular deposit)
  const depositParams = {
    userAddress,
    publicKey: nonEmptyPubKey,
    amountsToDeposit: amountsToCommit,
    walletUtxos,
    validatorRef,
    fundsUtxo,
  };

  const { tx, newFundsUtxo } = await deposit(
    localLucid,
    depositParams,
    adminAddress
  );

  // Step 3: Submit deposit transaction to L1
  logger.info(`Submitting incremental commit deposit transaction with id ${tx.toHash()}`);
  lucid.selectWallet.fromSeed(env.SEED);
  const signed = await lucid.fromTx(tx.toCBOR()).sign.withWallet().complete();
  await signed.submit();
  logger.info(`Deposit transaction ${tx.toHash()} submitted to L1 successfully`);

  // Step 4: Wait for L1 confirmation
  await new Promise(resolve => setTimeout(resolve, 5000)); // Wait 5 seconds for L1 confirmation

  // Step 5: Get the deposited UTXO from L1
  const depositedUtxo = await localLucid
    .utxosByOutRef([
      { txHash: newFundsUtxo.txHash, outputIndex: newFundsUtxo.outputIndex }
    ])
    .then(utxos => utxos[0]);

  if (!depositedUtxo) {
    throw new Error('Could not find deposited UTXO on L1');
  }

  // Step 6: Send incremental commit to Hydra node
  logger.info('Sending incremental commit to Hydra node...');
  const hydra = new HydraHandler(localLucid, env.ADMIN_NODE_WS_URL);
  
  try {
    // Hydra's incremental commit uses the same /commit endpoint but with head already open
    const commitTxId = await hydra.sendCommit(
      `${env.ADMIN_NODE_API_URL}/commit`,
      [depositedUtxo],
      undefined // No blueprint tx for incremental commits
    );

    logger.info(`Incremental commit transaction submitted to Hydra! tx id: ${commitTxId}`);

    // Wait for commit confirmation
    let commitTag = '';
    logger.debug('Waiting for incremental commit to be confirmed by the hydra node');
    while (commitTag !== 'Committed') {
      commitTag = await hydra.listen('Committed');
    }

    logger.info(`Incremental commit completed successfully for user ${userAddress}`);
    await hydra.stop();

    return { 
      cborHex: tx.toCBOR(), 
      fundsUtxoRef: newFundsUtxo 
    };
  } catch (error) {
    logger.error(`Error during incremental commit: ${error}`);
    await hydra.stop();
    throw error;
  }
}

export { handleIncrementalCommit };

