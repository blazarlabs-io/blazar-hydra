import { IncrementalDecommitSchema } from '../../shared';
import { IncrementalDecommitParams } from '../lib/params';
import { withdrawMerchant } from '../tx-builders/withdraw-merchant';
import {
  Data,
  getAddressDetails,
  LucidEvolution,
  UTxO,
} from '@lucid-evolution/lucid';
import { env } from '../../config';
import _ from 'lodash';
import { TxBuiltResponse } from '../../api/schemas/response';
import { logger } from '../../shared/logger';
import { HydraHandler } from '../lib/hydra';
import { DBOps } from '../../prisma/db-ops';
import { DBStatus } from '../../shared/prisma-schemas';
import { FundsDatum, FundsDatumT } from '../lib/types';
import { dataAddressToBech32 } from '../lib/utils';

/**
 * Handles incremental decommit operation.
 * This allows users/merchants to withdraw funds from an OPEN Hydra Head without closing it.
 * 
 * Flow:
 * 1. Validate head is OPEN (RUNNING status)
 * 2. Get current L2 snapshot
 * 3. Find the user/merchant funds UTXO in L2
 * 4. Build decommit transaction
 * 5. Send decommit to Hydra node via HTTP API
 * 6. Wait for decommit finalization
 * 
 * @param lucid - LucidEvolution instance for blockchain interaction
 * @param params - Parameters for incremental decommit (address, owner, funds UTXO, etc.)
 * @returns Transaction response with CBOR hex
 */
async function handleIncrementalDecommit(
  lucid: LucidEvolution,
  params: IncrementalDecommitSchema
): Promise<TxBuiltResponse> {
  const {
    address,
    owner,
    funds_utxo_ref: fundsUtxoRef,
    signature,
  } = params;

  // Step 1: Check if there's an active (RUNNING) head
  const activeHead = await DBOps.getActiveHead();
  if (!activeHead) {
    throw new Error('No active Hydra Head found. Head must be OPEN to perform incremental decommit.');
  }
  if (activeHead.status !== DBStatus.RUNNING) {
    throw new Error(`Cannot perform incremental decommit. Head status is ${activeHead.status}, but must be RUNNING (OPEN).`);
  }

  logger.info(`Processing incremental decommit for ${owner} ${address} from head ${activeHead.id}`);

  const localLucid = _.cloneDeep(lucid);
  const { SEED: adminSeed, HYDRA_KEY: hydraKey } = env;

  lucid.selectWallet.fromSeed(adminSeed);
  const adminAddress = await lucid.wallet().address();
  const adminKey = getAddressDetails(adminAddress).paymentCredential?.hash;
  
  if (!adminKey) {
    throw new Error('Admin address does not have a valid payment credential');
  }

  // Step 2: Connect to Hydra node and get L2 snapshot
  const hydra = new HydraHandler(localLucid, env.ADMIN_NODE_WS_URL);
  const utxosInL2 = await hydra.getSnapshot();
  
  logger.debug(`Found ${utxosInL2.length} UTXOs in L2 snapshot`);

  // Step 3: Find the specific funds UTXO to decommit
  const { hash: txHash, index } = fundsUtxoRef;
  const fundUtxo = utxosInL2.find(
    (utxo) => utxo.txHash === txHash && utxo.outputIndex === Number(index)
  );

  if (!fundUtxo) {
    throw new Error(`Funds UTXO ${txHash}#${index} not found in L2`);
  }

  // Validate ownership
  if (!fundUtxo.datum) {
    throw new Error('Funds UTXO does not have a datum');
  }

  const datum = Data.from<FundsDatumT>(fundUtxo.datum, FundsDatum);
  const utxoOwnerAddress = dataAddressToBech32(localLucid, datum.addr);

  if (utxoOwnerAddress !== address) {
    throw new Error(`UTXO owner ${utxoOwnerAddress} does not match provided address ${address}`);
  }

  // Validate owner type
  const isUserUtxo = datum.funds_type === 'User';
  const isMerchantUtxo = datum.funds_type === 'Merchant';

  if (owner === 'user' && !isUserUtxo) {
    throw new Error('Provided UTXO is not a User funds UTXO');
  }
  if (owner === 'merchant' && !isMerchantUtxo) {
    throw new Error('Provided UTXO is not a Merchant funds UTXO');
  }

  // For users, signature is required
  if (owner === 'user' && !signature) {
    throw new Error('User signature is required for incremental decommit');
  }

  // Step 4: Get admin/wallet UTXOs from L2 for transaction fees
  const walletUtxos = utxosInL2.filter((utxo) => {
    return utxo.address === adminAddress;
  });

  if (walletUtxos.length === 0) {
    throw new Error('No admin UTXOs found in L2 for transaction fees');
  }

  // Step 5: Build decommit transaction
  let decommitParams: IncrementalDecommitParams;

  if (owner === 'merchant') {
    decommitParams = {
      address,
      owner: 'merchant',
      fundUtxo,
      adminKey,
      hydraKey,
      walletUtxos,
    };
  } else {
    // User decommit
    decommitParams = {
      address,
      owner: 'user',
      fundUtxo,
      signature,
      adminKey,
      hydraKey,
      walletUtxos,
    };
  }

  // Build the withdrawal transaction (same as merchant withdraw)
  const { tx } = await withdrawMerchant(localLucid, {
    kind: owner,
    withdraws: [{ fundUtxo, signature }],
    adminKey,
    hydraKey,
    walletUtxos,
  });

  // Step 6: Sign and send decommit to Hydra node
  logger.info('Signing and submitting incremental decommit transaction...');
  localLucid.selectWallet.fromSeed(env.SEED);
  const signedTx = await localLucid
    .fromTx(tx.toCBOR())
    .sign.withWallet()
    .complete()
    .then((tx) => tx.toCBOR());

  try {
    // Send decommit request to Hydra node
    await hydra.decommit(`${env.ADMIN_NODE_API_URL}/decommit`, signedTx);
    logger.info('Incremental decommit request sent to Hydra node');

    // Wait for decommit finalization
    let decommitTag = '';
    logger.debug('Waiting for incremental decommit to be finalized by the hydra node');
    
    while (decommitTag !== 'DecommitFinalized') {
      decommitTag = await hydra.listen('DecommitFinalized');
      
      if (decommitTag === 'DecommitInvalid') {
        await hydra.stop();
        throw new Error('Incremental decommit rejected by Hydra node');
      }
    }

    logger.info(`Incremental decommit completed successfully for ${owner} ${address}`);
    logger.info('Funds will be available on L1 after transaction confirmation');
    
    await hydra.stop();

    return { 
      cborHex: tx.toCBOR(), 
      fundsUtxoRef: null 
    };
  } catch (error) {
    logger.error(`Error during incremental decommit: ${error}`);
    await hydra.stop();
    throw error;
  }
}

export { handleIncrementalDecommit };

