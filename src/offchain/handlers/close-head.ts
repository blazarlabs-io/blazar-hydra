import {
  assetsToValue,
  CML,
  Data,
  getAddressDetails,
  LucidEvolution,
  UTxO,
} from '@lucid-evolution/lucid';
import { HydraHandler } from '../lib/hydra';
import _ from 'lodash';
import { env, prisma } from '../../config';
import { FundsDatum, FundsDatumT } from '../lib/types';
import { WithdrawParams } from '../lib/params';
import { withdrawMerchant } from '../tx-builders/withdraw-merchant';
import { buildInputs, buildTxBody, setRequiredSigners } from '../lib/transaction';
import { DBOps } from '../../prisma/db-ops';
import { DBStatus } from '../../shared/prisma-schemas';
import { logger } from '../../shared/logger';

const MAX_UTXOS_PER_DECOMMIT = 15;

/**
 * Starts the process of closing a Hydra head. It updates the head status to DECOMMITING in the database.
 */
async function handleCloseHead(processId: string): Promise<{ status: string }> {
  try {
    await DBOps.updateHeadStatus(processId, DBStatus.DECOMMITING);
    return { status: DBStatus.DECOMMITING };
  } catch (error) {
    logger.error('Error handling close head');
    throw error;
  }
}

/**
 * Finalizes the close head process by:
 * 1. Withdrawing merchant UTXOs from the Hydra head.
 * 2. Sending the close command to the Hydra head.
 * 3. Waiting for the fanout tag and clearing the Hydra head.
 * 5. Deleting the process from the database.
 * @returns
 */
async function finalizeCloseHead(lucid: LucidEvolution, processId: string) {
  try {
    const { HYDRA_KEY: hydraKey } = env;
    const { ADMIN_NODE_WS_URL: wsUrl } = env;
    const localLucid = _.cloneDeep(lucid);
    localLucid.selectWallet.fromSeed(env.SEED);
    const adminAddress = await localLucid.wallet().address();
    const adminCredential = getAddressDetails(adminAddress).paymentCredential;
    if (!adminCredential || !adminCredential.hash) {
      throw new Error('Could not get admin key from address');
    }
    const adminKey = adminCredential.hash;
    const hydra = new HydraHandler(localLucid, wsUrl);

    // Step 1: Withdraw Merchant utxos
    const fundUtxos = await hydra.getSnapshot();
    const merchantUtxos = fundUtxos.filter((utxo) => {
      if (utxo.address === adminAddress || !utxo.datum) return false;
      try {
        const datum = Data.from<FundsDatumT>(utxo.datum, FundsDatum);
        return datum.funds_type === 'Merchant';
      } catch {
        // Not a Blazar FundsDatum (e.g. a non-fund UTxO in the head) — skip it.
        logger.debug(
          `Skipping UTxO ${utxo.txHash}#${utxo.outputIndex} in close: datum is not a FundsDatum`
        );
        return false;
      }
    });
    await withdrawMerchantUtxos(
      hydra,
      localLucid,
      adminAddress,
      adminKey,
      hydraKey,
      merchantUtxos
    );
    await DBOps.updateHeadStatus(processId, DBStatus.CLOSING);

    // A finalized decommit still leaves its (already-settled) utxoToDecommit in the confirmed
    // snapshot. Closing on that snapshot makes hydra-node's partial fanout try to re-run the
    // Blazar validator on the decommitted UTxO and fail (FailedToConstructPartialFanoutTx).
    // Advance the head to a fresh snapshot (utxoToDecommit = Nothing) before closing.
    await refreshSnapshotBeforeClose(hydra, localLucid, adminAddress, adminKey);

    // Step 2: Send close command. close() sends Close and waits for HeadIsClosed
    // (60s). The previous Promise.race(40s) loop fired before close()'s own wait,
    // sending a duplicate Close and orphaning the first waitForTag handler.
    await hydra.close();
    logger.info('Waiting for fanout tag...');
    await hydra.awaitReadyToFanout();

    // Step 3: Fanout
    await hydra.fanout();
    logger.info(`Head ${processId} is finalized.`);
    await prisma.process.delete({ where: { id: processId } });
    await hydra.stop();
    return { status: DBStatus.CLOSED };
  } catch (error) {
    logger.error('Error during close head');
    // Reflect the failure in /state instead of leaving it stuck at DECOMMITING/CLOSING.
    await DBOps.updateHeadStatus(processId, DBStatus.FAILED).catch(() => {});
    throw error;
  }
}

/**
 * Withdraws merchant UTXOs from the Hydra head.
 * It decommits the UTXOs in rounds, with a maximum of MAX_UTXOS_PER_DECOMMIT per round.
 * Waits for the decommit finalization tag to ensure the decommit was successful.
 */
async function withdrawMerchantUtxos(
  hydra: HydraHandler,
  lucid: LucidEvolution,
  adminAddress: string,
  adminKey: string,
  hydraKey: string,
  merchantUtxos: UTxO[]
) {
  if (merchantUtxos.length !== 0) {
    const roundsOfDecommit = Math.ceil(
      merchantUtxos.length / MAX_UTXOS_PER_DECOMMIT
    );
    logger.info(roundsOfDecommit + ' rounds of decommit');
    logger.info(merchantUtxos.length + ' merchant utxos to withdraw');
    logger.info('Withdrawing merchant utxos...');
    const utxosInL2 = await hydra.getSnapshot();
    const walletUtxos = utxosInL2.filter((utxo) => {
      return utxo.address === adminAddress;
    });
    let thisRoundUtxos = [];
    for (let i = 0; i < roundsOfDecommit; i++) {
      logger.info(`Sending decommit ${i + 1} of ${roundsOfDecommit}`);
      thisRoundUtxos = merchantUtxos.slice(0, MAX_UTXOS_PER_DECOMMIT);
      merchantUtxos.splice(0, MAX_UTXOS_PER_DECOMMIT);
      const withdrawParams: WithdrawParams = {
        kind: 'merchant',
        withdraws: thisRoundUtxos.map((u) => {
          return { fundUtxo: u };
        }),
        adminKey,
        hydraKey,
        walletUtxos,
      };
      const { tx } = await withdrawMerchant(lucid, withdrawParams);
      const signedTx = await tx.sign
        .withWallet()
        .complete()
        .then((tx) => tx.toCBOR());
      await hydra.decommit(`${env.ADMIN_NODE_API_URL}/decommit`, signedTx);
      await hydra.awaitDecommit(thisRoundUtxos);
      logger.info('Decommit finalized.');
    }
  }
}

/**
 * Submit a no-op L2 self-transfer (admin collateral → admin, no scripts, fee 0) to advance the
 * head to a fresh confirmed snapshot before Close, so Close doesn't capture a stale snapshot.
 *
 * NOTE: this does NOT work around the fanout-after-decommit limitation. A finalized decommit
 * leaves its settled `utxoToDecommit` in the snapshot, and hydra-node 2.2.0's fanout includes it
 * whenever `snapshotVersion == version` — which an L2 no-op cannot change (it doesn't bump the
 * on-chain head version). So a head that had a decommit still fails at `Fanout` with
 * `FailedToConstructPartialFanoutTx` (the partial fanout re-runs the Blazar validator on the
 * decommitted UTxO). See doc/hydra-2x-migration.md "Known limitation: fanout after decommit".
 */
async function refreshSnapshotBeforeClose(
  hydra: HydraHandler,
  lucid: LucidEvolution,
  adminAddress: string,
  adminKey: string
) {
  const utxosInL2 = await hydra.getSnapshot();
  const adminCollateral = utxosInL2.find(
    (u) => u.address === adminAddress && Object.keys(u.assets).length === 1
  );
  if (!adminCollateral) {
    logger.info('No pure-ADA admin UTxO in L2 to refresh the snapshot; skipping');
    return;
  }
  const inputs = buildInputs([adminCollateral]);
  const outputs = CML.TransactionOutputList.new();
  outputs.add(
    CML.TransactionOutput.new(
      CML.Address.from_bech32(adminAddress),
      assetsToValue(adminCollateral.assets)
    )
  );
  const txBody = buildTxBody(inputs, outputs, undefined);
  // Lucid's sign.withWallet() signs based on required_signers; without this the admin vkey
  // witness is omitted and the node rejects the tx with MissingVKeyWitnessesUTXOW.
  setRequiredSigners(txBody, adminKey);
  const cmlTx = CML.Transaction.new(
    txBody,
    CML.TransactionWitnessSet.new(),
    true
  ).to_cbor_hex();
  const signedTx = await lucid
    .fromTx(cmlTx)
    .sign.withWallet()
    .complete()
    .then((t) => t.toCBOR());
  logger.info('Submitting no-op L2 tx to refresh snapshot before close...');
  await hydra.sendTx(signedTx);
  // Wait until the no-op is reflected in the confirmed snapshot (old collateral gone), so Close
  // captures the clean snapshot rather than the stale one.
  const oldRef = `${adminCollateral.txHash}#${adminCollateral.outputIndex}`;
  for (let i = 0; i < 24; i++) {
    const snap = await hydra.getSnapshot();
    if (!snap.some((u) => `${u.txHash}#${u.outputIndex}` === oldRef)) {
      logger.info('Snapshot refreshed; proceeding to close.');
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  logger.info(
    'Snapshot refresh not observed within timeout; proceeding to close anyway.'
  );
}

export { handleCloseHead, finalizeCloseHead };
