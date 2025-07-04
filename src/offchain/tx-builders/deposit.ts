import {
  Data,
  fromUnit,
  getAddressDetails,
  LucidEvolution,
  OutRef,
  toUnit,
  TxSignBuilder,
  validatorToAddress,
} from '@lucid-evolution/lucid';
import { DepositParams } from '../lib/params';
import { Spend, Mint, OutputRefT, FundsDatumT, FundsDatum } from '../lib/types';
import { bech32ToAddressType, getNetworkFromLucid } from '../lib/utils';
import blake2b from 'blake2b';

async function deposit(
  lucid: LucidEvolution,
  params: DepositParams
): Promise<{ tx: TxSignBuilder; newFundsUtxo: OutRef }> {
  const tx = lucid.newTx();
  const {
    userAddress,
    publicKey,
    amountToDeposit,
    walletUtxos,
    validatorRef,
    fundsUtxo,
  } = params;
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

  // Build the transaction
  const minLvc = 2_000_000n;
  let totalAmount = amountToDeposit;
  let validationToken = '';
  if (fundsUtxo) {
    validationToken = Object.keys(fundsUtxo.assets).find(
      (asset) => fromUnit(asset).policyId === policyId
    ) as string;
    // Add the funds from the input UTxO, including the locked_deposit
    totalAmount += fundsUtxo.assets['lovelace'];
    tx.collectFrom([fundsUtxo], Spend.AddFunds);
  } else {
    const selectedUtxo = walletUtxos[0];
    const outRef: OutputRefT = {
      transaction_id: selectedUtxo.txHash,
      output_index: BigInt(selectedUtxo.outputIndex),
    };
    const serializedIndex = Data.to<bigint>(outRef.output_index);
    const newTokenName = Buffer.from(
      outRef.transaction_id + serializedIndex,
      'hex'
    );
    const tokenNameHash = blake2b(32).update(newTokenName).digest('hex');
    validationToken = toUnit(policyId, tokenNameHash);
    totalAmount += minLvc;
    tx.mintAssets({ [validationToken]: 1n }, Mint.Mint(outRef));
  }
  const datum = Data.to<FundsDatumT>(
    {
      addr: bech32ToAddressType(lucid, userAddress),
      locked_deposit: minLvc,
      funds_type: { User: { public_key: publicKey } },
    },
    FundsDatum
  );

  const txSignBuilder = await tx
    .readFrom([validatorRef])
    .collectFrom(walletUtxos)
    .addSigner(userAddress)
    .pay.ToContract(
      scriptAddress,
      { kind: 'inline', value: datum },
      { ['lovelace']: totalAmount, [validationToken]: 1n }
    )
    .attachMetadata(674, { msg: 'HydraPay: Deposit' })
    .complete();

  const newFundsUtxo = {
    txHash: txSignBuilder.toHash(),
    outputIndex: 0,
  };

  return { tx: txSignBuilder, newFundsUtxo };
}

export { deposit };
