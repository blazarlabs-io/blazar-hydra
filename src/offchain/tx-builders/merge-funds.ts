import {
  CML,
  coreToUtxo,
  fromUnit,
  getAddressDetails,
  LucidEvolution,
  OutRef,
  TxSignBuilder,
  UTxO,
  validatorToAddress,
  validatorToRewardAddress,
} from '@lucid-evolution/lucid';
import { MergeFundsParams } from '../lib/params';
import { Combined, Mint, Spend } from '../lib/types';
import { getNetworkFromLucid } from '../lib/utils';

async function mergeFunds(
  lucid: LucidEvolution,
  params: MergeFundsParams
): Promise<{ tx: TxSignBuilder; newFundsUtxo: OutRef; newAdminUtxos: UTxO[] }> {
  const { userFundsUtxos, adminUtxos, validatorRef } = params;
  lucid.overrideUTxOs(adminUtxos);
  const network = getNetworkFromLucid(lucid);

  // Script UTxO related boilerplate
  const validator = validatorRef.scriptRef;
  if (!validator) {
    throw new Error('Invalid validator reference');
  }
  const scriptAddress = validatorToAddress(network, validator);
  const policyId = getAddressDetails(scriptAddress).paymentCredential?.hash;
  if (!policyId) {
    throw new Error('Invalid script address');
  }

  // Build transaction values and datum
  const userFunds = userFundsUtxos.reduce(
    (acc, utxo) => acc + utxo.assets['lovelace'],
    0n
  );
  const validationToken = Object.keys(userFundsUtxos[0].assets).find(
    (asset) => fromUnit(asset).policyId === policyId
  );
  if (!validationToken) {
    throw new Error(
      `Couldn't find validation token in ${JSON.stringify({
        hash: userFundsUtxos[0].txHash,
        index: userFundsUtxos[0].outputIndex,
      })}`
    );
  }
  const newFundsValue = {
    lovelace: userFunds,
    [validationToken]: 1n,
  };
  if (!userFundsUtxos[0].datum) {
    throw new Error('Invalid user funds UTxO');
  }

  // Start transaction building
  const rewardAddress = validatorToRewardAddress(network, validator);
  const tx = lucid
    .newTx()
    .readFrom([validatorRef])
    .collectFrom(adminUtxos)
    .collectFrom(userFundsUtxos, Spend.Merge)
    .pay.ToContract(
      scriptAddress,
      { kind: 'inline', value: userFundsUtxos[0].datum },
      newFundsValue
    )
    .withdraw(rewardAddress, 0n, Combined.CombinedMerge);

  // Burn all validation tokens but one
  for (let i = 1; i < userFundsUtxos.length; i++) {
    const utxo = userFundsUtxos[i];
    const validationToken = Object.keys(utxo.assets).find(
      (asset) => fromUnit(asset).policyId === policyId
    );
    if (!validationToken) {
      throw new Error(
        `Couldn't find validation token in ${JSON.stringify({
          hash: userFundsUtxos[0].txHash,
          index: userFundsUtxos[0].outputIndex,
        })}`
      );
    }
    tx.mintAssets({ [validationToken]: -1n }, Mint.Burn);
  }

  // Complete tx
  const txSignBuilder = await tx.complete();
  const newFundsUtxo = {
    txHash: txSignBuilder.toHash(),
    outputIndex: 0,
  };
  const txOutputs = lucid
    .fromTx(txSignBuilder.toCBOR())
    .toTransaction()
    .body()
    .outputs();
  const newAdminUtxos = [];
  const adminAddress = adminUtxos[0].address;
  for (let i = 0; i < txOutputs.len(); i++) {
    const output = txOutputs.get(i);
    if (output.address().to_bech32() === adminAddress) {
      const input = CML.TransactionInput.new(
        CML.TransactionHash.from_hex(txSignBuilder.toHash()),
        BigInt(i)
      );
      const utxo = CML.TransactionUnspentOutput.new(input, output);
      newAdminUtxos.push(coreToUtxo(utxo));
    }
  }

  return { tx: txSignBuilder, newFundsUtxo, newAdminUtxos };
}

export { mergeFunds };
