import { Layer, WithdrawSchema } from '../../shared';
import { withdrawMerchant } from '../tx-builders/withdraw-merchant';
import { getAddressDetails, LucidEvolution } from '@lucid-evolution/lucid';
import _ from 'lodash';
import { env } from '../../config';
import { TxBuiltResponse } from '../../api/schemas/response';
import { logger } from '../../shared/logger';
import { HydraHandler } from '../lib/hydra';

/**
 * Withdraws funds from the Hydra head back to L1. A withdraw spends UTxOs that live
 * in L2 (the head snapshot), so the tx MUST be applied on L2 and submitted to the
 * hydra-node /decommit endpoint (which produces the L1 payout) — NOT submitted to L1
 * directly. Submitting to L1 fails with BadInputsUTxO because the input only exists in L2.
 */
async function handleWithdraw(
  lucid: LucidEvolution,
  params: WithdrawSchema
): Promise<TxBuiltResponse> {
  const localLucid = _.cloneDeep(lucid);
  const { address, owner, funds_utxos, network_layer } = params;
  const { SEED: adminSeed, HYDRA_KEY: hydraKey } = env;

  // A withdraw always settles L2 -> L1 via decommit.
  if (owner === 'merchant' && network_layer === Layer.L1) {
    throw new Error('Merchant cannot withdraw from L1');
  }
  if (owner === 'user' && network_layer === Layer.L2) {
    throw new Error('User cannot withdraw from L2');
  }

  localLucid.selectWallet.fromSeed(adminSeed);
  const adminAddress = await localLucid.wallet().address();
  const adminKey = getAddressDetails(adminAddress).paymentCredential?.hash;
  if (!adminKey) {
    throw new Error('Admin address does not have a valid payment credential');
  }

  const hydra = new HydraHandler(localLucid, env.ADMIN_NODE_WS_URL);
  try {
    // Funds + admin-collateral UTxOs live in L2 (the head snapshot), not on L1.
    const utxosInL2 = await hydra.getSnapshot();
    const fundsRefs = funds_utxos.map(({ ref }) => ({
      txHash: ref.hash,
      outputIndex: Number(ref.index),
    }));
    const fundsUtxos = utxosInL2.filter((u) =>
      fundsRefs.some(
        (r) => r.txHash === u.txHash && r.outputIndex === u.outputIndex
      )
    );
    if (fundsUtxos.length === 0) {
      throw new Error('Funds utxos not found in L2 snapshot');
    }
    const walletUtxos = utxosInL2.filter((u) => u.address === adminAddress);
    if (walletUtxos.length === 0) {
      throw new Error('No admin collateral UTxO found in L2');
    }

    const withdraws = fundsUtxos.map((fundUtxo) => {
      const signature = funds_utxos.find(
        (u) =>
          u.ref.hash === fundUtxo.txHash &&
          Number(u.ref.index) === fundUtxo.outputIndex
      )?.signature;
      return { fundUtxo, signature };
    });

    // Build the L2 withdraw tx and submit it to the hydra-node /decommit endpoint.
    const { tx } = await withdrawMerchant(localLucid, {
      kind: owner,
      withdraws,
      adminKey,
      hydraKey,
      walletUtxos,
    });

    localLucid.selectWallet.fromSeed(adminSeed);
    const signedTx = await localLucid
      .fromTx(tx.toCBOR())
      .sign.withWallet()
      .complete()
      .then((t) => t.toCBOR());

    logger.info(`Submitting withdraw (decommit) for ${owner} ${address}...`);
    await hydra.decommit(`${env.ADMIN_NODE_API_URL}/decommit`, signedTx);
    await hydra.awaitDecommit();
    logger.info(`Withdraw decommit finalized for ${owner} ${address}`);
    await hydra.stop();

    return { cborHex: tx.toCBOR(), fundsUtxoRef: null };
  } catch (error) {
    logger.error(`Error during withdraw for ${owner} ${address}`);
    await hydra.stop();
    throw error;
  }
}

export { handleWithdraw };
