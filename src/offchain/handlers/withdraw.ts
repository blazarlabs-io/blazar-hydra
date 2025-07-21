import { Layer, WithdrawSchema } from '../../shared';
import { withdraw } from '../tx-builders/withdraw-user';
import {
  getAddressDetails,
  LucidEvolution,
  selectUTxOs,
} from '@lucid-evolution/lucid';
import { WithdrawParams } from '../lib/params';
import _ from 'lodash';
import { env } from '../../config';
import { TxBuiltResponse } from '../../api/schemas/response';

async function handleWithdraw(
  lucid: LucidEvolution,
  params: WithdrawSchema
): Promise<TxBuiltResponse> {
  const localLucid = _.cloneDeep(lucid);
  const { address, owner, funds_utxos, network_layer } = params;
  const { SEED: adminSeed, HYDRA_KEY: hydraKey, VALIDATOR_REF: vRef } = env;

  lucid.selectWallet.fromSeed(adminSeed);
  const adminAddress = await lucid.wallet().address();
  const adminKey = getAddressDetails(adminAddress).paymentCredential?.hash;
  if (!adminKey) {
    throw new Error('Admin address does not have a valid payment credential');
  }

  // Lookup funds and validator UTxOs
  const fundsRefs = funds_utxos.map(({ ref }) => ({
    txHash: ref.hash,
    outputIndex: Number(ref.index),
  }));
  const fundsUtxos = await localLucid.utxosByOutRef(fundsRefs);
  if (fundsUtxos.length === 0) {
    throw new Error(`Funds utxos not found in ${network_layer}`);
  }
  const [validatorRef] = await localLucid.utxosByOutRef([
    { txHash: vRef, outputIndex: 0 },
  ]);

  // Prepare tx builder parameters
  let withdrawParams: WithdrawParams = {
    address,
    kind: owner,
    withdraws: [],
  };
  switch (owner) {
    case 'merchant':
      if (network_layer === Layer.L1) {
        throw new Error('Merchant cannot withdraw from L1');
      }
      withdrawParams = {
        ...withdrawParams,
        adminKey,
        hydraKey,
        withdraws: fundsUtxos.map((utxo) => {
          return { fundUtxo: utxo };
        }),
      };
      break;

    case 'user':
      if (network_layer === Layer.L2) {
        throw new Error('User cannot withdraw from L2');
      }
      const walletUtxos = await localLucid
        .utxosAt(address)
        .then((utxos) => selectUTxOs(utxos, { lovelace: 10_000_000n }));
      const zipFundsAndSignatures = fundsUtxos.map((utxo) => {
        const signature = funds_utxos.find(
          (u) =>
            u.ref.hash === utxo.txHash &&
            Number(u.ref.index) === utxo.outputIndex
        )?.signature;
        if (!signature) {
          throw new Error(
            `User signature not found for UTxO ${utxo.txHash}#${utxo.outputIndex}`
          );
        }
        return { fundUtxo: utxo, signature };
      });
      withdrawParams = {
        ...withdrawParams,
        validatorRef,
        walletUtxos,
        withdraws: zipFundsAndSignatures,
      };
      break;

    default:
      throw new Error('Unsupported owner and network layer combination');
  }

  // Build and return the transaction
  const { tx } = await withdraw(localLucid, withdrawParams, adminAddress);
  return { cborHex: tx.toCBOR(), fundsUtxoRef: null };
}

export { handleWithdraw };
