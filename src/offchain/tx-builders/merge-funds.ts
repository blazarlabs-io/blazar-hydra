import {
  addAssets,
  Assets,
  CML,
  coreToUtxo,
  fromUnit,
  LucidEvolution,
  OutRef,
  sortUTxOs,
  TxSignBuilder,
  UTxO,
} from '@lucid-evolution/lucid';
import { MergeFundsParams } from '../lib/params';
import { Combined, Mint, Spend } from '../lib/types';
import { getNetworkFromLucid, getValidatorDetails } from '../lib/utils';

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
  const {
    scriptAddress,
    rewardAddress,
    scriptHash: policyId,
  } = getValidatorDetails(validator, network);

  // Build transaction values and datum
  const sortedInputs = sortUTxOs(userFundsUtxos, 'Canonical');
  const firstInput = sortedInputs[0];
  if (!firstInput.datum) {
    throw new Error('Invalid user funds UTxO');
  }

  const totalFunds = sortedInputs.reduce((acc, utxo) => {
    const assets = Object.fromEntries(
      Object.entries(utxo.assets).filter(
        ([asset]) => fromUnit(asset).policyId !== policyId
      )
    );
    return addAssets(acc, assets);
  }, {} as Assets);

  const continuingToken = Object.keys(firstInput.assets).find(
    (asset) => fromUnit(asset).policyId === policyId
  );
  if (!continuingToken) {
    throw new Error(
      `Couldn't find validation token in ${JSON.stringify({
        hash: firstInput.txHash,
        index: firstInput.outputIndex,
      })}`
    );
  }
  const newFundsValue = addAssets(totalFunds, { [continuingToken]: 1n });
  const newFundsDatum = firstInput.datum;

  // Start transaction building
  const tx = lucid
    .newTx()
    .readFrom([validatorRef])
    .collectFrom(adminUtxos)
    .collectFrom(userFundsUtxos, Spend.Merge)
    .pay.ToContract(
      scriptAddress,
      { kind: 'inline', value: newFundsDatum },
      newFundsValue
    )
    .withdraw(rewardAddress, 0n, Combined.CombinedMerge);

  // Burn all validation tokens except the one from the first UTxO
  sortedInputs.forEach((utxo, index) => {
    if (index === 0) return;
    const validationToken = Object.keys(utxo.assets).find(
      (asset) => fromUnit(asset).policyId === policyId
    );
    if (!validationToken) {
      throw new Error(
        `Couldn't find validation token in ${JSON.stringify({
          hash: utxo.txHash,
          index: utxo.outputIndex,
        })}`
      );
    }
    tx.mintAssets({ [validationToken]: -1n }, Mint.Burn);
  });

  // Complete tx
  const txSignBuilder = await tx.complete();
  const newFundsUtxo = {
    txHash: txSignBuilder.toHash(),
    outputIndex: 0,
  };
  const txOutputs = txSignBuilder.toTransaction().body().outputs();
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
