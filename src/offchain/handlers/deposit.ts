import { DepositSchema } from '../../shared';
import { DepositParams } from '../lib/params';
import { deposit } from '../tx-builders/deposit';
import { LucidEvolution, selectUTxOs, UTxO } from '@lucid-evolution/lucid';
import { env } from '../../config';
import _ from 'lodash';
import { logger } from '../../logger';
import { TxBuiltResponse } from '../../api/schemas/response';

async function handleDeposit(
  lucid: LucidEvolution,
  params: DepositSchema
): Promise<TxBuiltResponse> {
  try {
    const {
      user_address: userAddress,
      public_key: publicKey,
      amount: amountToDeposit,
      funds_utxo_ref: fundsUtxoRef,
    } = params;
    const localLucid = _.cloneDeep(lucid);
    let fundsUtxo: UTxO | undefined = undefined;
    if (fundsUtxoRef) {
      const { hash: txHash, index } = fundsUtxoRef;
      [fundsUtxo] = await localLucid.utxosByOutRef([
        { txHash, outputIndex: Number(index) },
      ]);
    }

    lucid.selectWallet.fromSeed(env.SEED);
    const adminAddress = await lucid.wallet().address();
    const walletUtxos = await localLucid
      .utxosAt(adminAddress)
      .then((utxos) => selectUTxOs(utxos, { lovelace: amountToDeposit }));
    const [validatorRef] = await localLucid.utxosByOutRef([
      { txHash: env.VALIDATOR_REF, outputIndex: 0 },
    ]);
    const nonEmptyPubKey =
      publicKey && publicKey.length > 0 ? publicKey : '0'.repeat(64);
    const depositParams: DepositParams = {
      userAddress,
      publicKey: nonEmptyPubKey,
      amountToDeposit,
      walletUtxos,
      validatorRef,
      fundsUtxo,
    };
    const { tx, newFundsUtxo } = await deposit(
      localLucid,
      depositParams,
      adminAddress
    );

    logger.info(`Submitting deposit transaction with id ${tx.toHash()}`);
    lucid.selectWallet.fromSeed(env.SEED);
    (await tx.sign.withWallet().complete()).submit();
    logger.info(`Deposit transaction ${tx.toHash()} submitted successfully`);
    return { cborHex: tx.toCBOR(), fundsUtxoRef: newFundsUtxo };
  } catch (e) {
    if (e instanceof Error) {
      logger.error('500 /deposit - ' + e.message);
    } else if (typeof e === 'string' && e.includes('InputsExhaustedError')) {
      logger.error('400 /deposit - ' + e);
    } else {
      logger.error('520 /deposit - Unknown error type');
      logger.error(JSON.stringify(e));
    }
    throw e;
  }
}

export { handleDeposit };
