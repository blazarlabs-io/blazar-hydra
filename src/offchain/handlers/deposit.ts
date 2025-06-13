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
      [fundsUtxo] = await localLucid.utxosByOutRef([{ txHash, outputIndex: Number(index) }]);
    }
    const walletUtxos = await localLucid
      .utxosAt(userAddress)
      .then((utxos) => selectUTxOs(utxos, { lovelace: amountToDeposit }));
    const [validatorRef] = await localLucid.utxosByOutRef([
      { txHash: env.VALIDATOR_REF, outputIndex: 0 },
    ]);
    const depositParams: DepositParams = {
      userAddress,
      publicKey,
      amountToDeposit,
      walletUtxos,
      validatorRef,
      fundsUtxo,
    };
    const { tx, newFundsUtxo } = await deposit(localLucid, depositParams);
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
