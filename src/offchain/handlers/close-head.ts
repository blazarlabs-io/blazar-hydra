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
import { assertFundsEmpty, assertOnlyUserFunds } from '../lib/funds';
import { payOutOnL1, userFundsOps } from '../lib/user-funds';
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
    // Step 1: withdraw the merchant funds inside the head: their validation tokens were minted in
    // L2 and are burned there. User funds stay: their tokens were minted on L1 and must leave
    // through the fanout (burning them in L2 blocks the fanout with H4, see user-funds.ts).
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
    const userUtxos = classify('User');
    await withdrawMerchantUtxos(hydra, localLucid, adminAddress, adminKey, hydraKey, classify('Merchant'));
    await DBOps.updateHeadStatus(processId, DBStatus.CLOSING);

    // Step 2: gate BEFORE Close: only admin collateral and user funds may remain, i.e. everything
    // left can leave through the fanout (so we never create a Closed head that cannot fan out).
    assertOnlyUserFunds(await hydra.getSnapshot(), adminAddress);

    // Step 3: Close -> ReadyToFanout -> Fanout (Part C fast-fail kept).
    await hydra.close();
    logger.info('Waiting for fanout tag...');
    await hydra.awaitReadyToFanout();
    await hydra.fanout();
    logger.info(`Head ${processId} is finalized.`);

    // Step 4: the fanout returned the user funds to the validator on L1, tokens intact; pay the
    // owners there (UserWithdraw burns each token on L1).
    if (userUtxos.length > 0) {
      const [validatorRef] = await localLucid.utxosByOutRef([
        { txHash: env.VALIDATOR_REF, outputIndex: 0 },
      ]);
      const paid = await payOutOnL1(
        userFundsOps(localLucid, hydra, {
          seed: env.SEED,
          adminAddress,
          adminKey,
          hydraKey,
          validatorRef,
          decommitUrl: `${env.ADMIN_NODE_API_URL}/decommit`,
        }),
        userUtxos
      );
      logger.info(`Paid ${userUtxos.length} user(s) on L1: ${paid.map((p) => p.txHash).join(', ')}`);
    }
    await prisma.process.delete({ where: { id: processId } });
    await hydra.stop();
    return { status: DBStatus.CLOSED };
  } catch (error) {
    await DBOps.updateHeadStatus(processId, DBStatus.FAILED).catch(() => {});
    if (error instanceof HydraTerminalError && error.tag === 'PostTxOnChainFailed') {
      // Fanout rejected (the old "fanout-after-decommit" was H4 from user tokens burned in L2, now
      // avoided). Auto-reset ONLY if the head is funds-empty (last guard — re-query the snapshot).
      // Otherwise leave FAILED for manual handling.
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


export { handleCloseHead, finalizeCloseHead };
