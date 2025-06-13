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
  }

  const amountsToDeposit = valueTuplesToAssets(amount);
  const walletUtxos = await localLucid
    .utxosAt(userAddress)
    .then((utxos) =>
      selectUTxOs(
        utxos,
        addAssets({ ['lovelace']: 5_000_000n }, amountsToDeposit)
      )
    );
  const [validatorRef] = await localLucid.utxosByOutRef([
    { txHash: env.VALIDATOR_REF, outputIndex: 0 },
  ]);
  const depositParams: DepositParams = {
    userAddress,
    publicKey,
    amountsToDeposit,
    walletUtxos,
    validatorRef,
    fundsUtxo,
  };
  const { tx, newFundsUtxo } = await deposit(localLucid, depositParams);
  return { cborHex: tx.toCBOR(), fundsUtxoRef: newFundsUtxo };
}

export { handleDeposit };
