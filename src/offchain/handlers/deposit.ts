import { DepositSchema } from '../../shared';
import { DepositParams } from '../lib/params';
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

async function handleDeposit(
  lucid: LucidEvolution,
  params: DepositSchema
): Promise<TxBuiltResponse> {
  const {
    user_address: userAddress,
    public_key: publicKey,
    amount,
    funds_utxo_ref: fundsUtxoRef,
  } = params;
  const localLucid = _.cloneDeep(lucid);
  let fundsUtxo: UTxO | undefined = undefined;
  if (fundsUtxoRef) {
    const { hash: txHash, index } = fundsUtxoRef;
    [fundsUtxo] = await localLucid.utxosByOutRef([
      { txHash, outputIndex: Number(index) },
    ]);
<<<<<<< HEAD
=======
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
>>>>>>> 10dc3de (submit deposit txs)
  }

  lucid.selectWallet.fromSeed(env.SEED);
  const adminAddress = await lucid.wallet().address();
  const amountsToDeposit = valueTuplesToAssets(amount);
  const walletUtxos = await localLucid
    .utxosAt(adminAddress)
    .then((utxos) =>
      selectUTxOs(
        utxos,
        addAssets({ ['lovelace']: 5_000_000n }, amountsToDeposit)
      )
    );
  if (walletUtxos.length === 0) {
    throw new Error('No UTxOs found in wallet to cover the deposit');
  }
  const [validatorRef] = await localLucid.utxosByOutRef([
    { txHash: env.VALIDATOR_REF, outputIndex: 0 },
  ]);

  const nonEmptyPubKey =
    publicKey && publicKey.length > 0 ? publicKey : '0'.repeat(64);
  const depositParams: DepositParams = {
    userAddress,
    publicKey: nonEmptyPubKey,
    amountsToDeposit,
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
  (await tx.sign.withWallet().complete()).submit();
  logger.info(`Deposit transaction ${tx.toHash()} submitted successfully`);
  return { cborHex: tx.toCBOR(), fundsUtxoRef: newFundsUtxo };
}

export { handleDeposit };
