import {
  Data,
  getAddressDetails,
  LucidEvolution,
  UTxO,
} from '@lucid-evolution/lucid';
import { HydraHandler } from '../lib/hydra';
import { HydraTerminalError } from '../lib/hydra-messages';
import _ from 'lodash';
import { env, prisma } from '../../config';
import { FundsDatum, FundsDatumT } from '../lib/types';
import { WithdrawParams } from '../lib/params';
import { withdrawMerchant } from '../tx-builders/withdraw-merchant';
import { assertFundsEmpty } from '../lib/funds';
import { writeResetMarker } from '../lib/reset-signal';
import { DBOps } from '../../prisma/db-ops';
import { DBStatus } from '../../shared/prisma-schemas';
import { logger } from '../../shared/logger';
import { assertCloseable } from '../../shared/close-guards';

const MAX_UTXOS_PER_DECOMMIT = 15;

/**
 * Starts the process of closing a Hydra head. It updates the head status to DECOMMITING in the database.
 */
async function handleCloseHead(processId: string): Promise<{ status: string }> {
  try {
    const process = await prisma.process.findUnique({ where: { id: processId } });
    assertCloseable(process, processId);
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
  try {
    // Step 1: settle ALL funds out of the head (merchant + user). After this the head holds only
    // the admin collateral, so a discard abandons nothing recoverable.
    const fundUtxos = await hydra.getSnapshot();
    const classify = (type: 'Merchant' | 'User') =>
      fundUtxos.filter((utxo) => {
        if (utxo.address === adminAddress || !utxo.datum) return false;
        try {
          const datum = Data.from<FundsDatumT>(utxo.datum, FundsDatum);
          return type === 'Merchant'
            ? datum.funds_type === 'Merchant'
            : datum.funds_type !== 'Merchant';
        } catch {
          logger.debug(`Skipping UTxO ${utxo.txHash}#${utxo.outputIndex} in close: not a FundsDatum`);
          return false;
        }
      });
    await withdrawMerchantUtxos(hydra, localLucid, adminAddress, adminKey, hydraKey, classify('Merchant'));
    await withdrawUserUtxos(hydra, localLucid, adminAddress, adminKey, hydraKey, classify('User'));
    await DBOps.updateHeadStatus(processId, DBStatus.CLOSING);

    // Step 2: PRIMARY funds-empty gate — BEFORE Close. If anything but admin collateral remains,
    // abort: do not Close (so we never create a stuck Closed head holding funds).
    assertFundsEmpty(await hydra.getSnapshot(), adminAddress);

    // Step 3: Close -> ReadyToFanout -> Fanout (Part C fast-fail kept).
    await hydra.close();
    logger.info('Waiting for fanout tag...');
    await hydra.awaitReadyToFanout();
    await hydra.fanout();
    logger.info(`Head ${processId} is finalized.`);
    await prisma.process.delete({ where: { id: processId } });
    await hydra.stop();
    return { status: DBStatus.CLOSED };
  } catch (error) {
    await DBOps.updateHeadStatus(processId, DBStatus.FAILED).catch(() => {});
    if (error instanceof HydraTerminalError && error.tag === 'PostTxOnChainFailed') {
      // The deterministic fanout-after-decommit bug. Auto-reset ONLY if the head is funds-empty
      // (last guard — re-query the snapshot). Otherwise leave FAILED for manual handling.
      try {
        assertFundsEmpty(await hydra.getSnapshot(), adminAddress);
        const marker = await writeResetMarker(env.RESET_SIGNAL_DIR, processId, 'fanout-after-decommit');
        logger.error(
          `Close: fanout rejected (PostTxOnChainFailed) — fanout-after-decommit. Head is funds-empty; ` +
            `wrote reset marker ${marker}; hydra-reset will reset the node to Idle.`
        );
      } catch (guardErr) {
        logger.error(
          `Close: fanout rejected but head is NOT funds-empty (${guardErr}) — NOT auto-resetting; ` +
            `manual intervention required.`
        );
      }
    } else {
      logger.error('Error during close head');
    }
    throw error;
  } finally {
    await hydra.stop().catch(() => {});
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
 * Decommits all USER fund UTxOs out of the head (admin-authorized: validate_withdraw checks the
 * admin_key, not the redeemer sig, so an empty per-fund signature is fine). Mirrors
 * withdrawMerchantUtxos. Re-queries admin collateral from the live snapshot for each round.
 */
async function withdrawUserUtxos(
  hydra: HydraHandler,
  lucid: LucidEvolution,
  adminAddress: string,
  adminKey: string,
  hydraKey: string,
  userUtxos: UTxO[]
) {
  if (userUtxos.length === 0) return;
  const rounds = Math.ceil(userUtxos.length / MAX_UTXOS_PER_DECOMMIT);
  logger.info(`${rounds} rounds of user decommit (${userUtxos.length} user utxos)`);
  for (let i = 0; i < rounds; i++) {
    const thisRound = userUtxos.slice(0, MAX_UTXOS_PER_DECOMMIT);
    userUtxos.splice(0, MAX_UTXOS_PER_DECOMMIT);
    const utxosInL2 = await hydra.getSnapshot();
    const walletUtxos = utxosInL2.filter((u) => u.address === adminAddress);
    const withdrawParams: WithdrawParams = {
      kind: 'user',
      withdraws: thisRound.map((u) => ({ fundUtxo: u, signature: '' })),
      adminKey,
      hydraKey,
      walletUtxos,
    };
    const { tx } = await withdrawMerchant(lucid, withdrawParams);
    const signedTx = await tx.sign.withWallet().complete().then((t) => t.toCBOR());
    await hydra.decommit(`${env.ADMIN_NODE_API_URL}/decommit`, signedTx);
    await hydra.awaitDecommit(thisRound);
    logger.info(`User decommit ${i + 1}/${rounds} finalized.`);
  }
}

export { handleCloseHead, finalizeCloseHead };
