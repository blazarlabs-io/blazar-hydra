import {
  addAssets,
  Data,
  fromUnit,
  LucidEvolution,
  OutRef,
  toUnit,
  TxSignBuilder,
} from '@lucid-evolution/lucid';
import { DepositParams } from '../lib/params';
import { Spend, Mint, OutputRefT, FundsDatumT, FundsDatum } from '../lib/types';
import {
  bech32ToAddressType,
  getNetworkFromLucid,
  getValidatorDetails,
} from '../lib/utils';
import blake2b from 'blake2b';

async function deposit(
  lucid: LucidEvolution,
  params: DepositParams
): Promise<{ tx: TxSignBuilder; newFundsUtxo: OutRef }> {
  const {
    userAddress,
    publicKey,
    amountsToDeposit,
    walletUtxos,
    validatorRef,
    fundsUtxo,
  } = params;
  lucid.selectWallet.fromAddress(userAddress, walletUtxos);
  const tx = lucid.newTx();
  const network = getNetworkFromLucid(lucid);

  // Script UTxO related boilerplate
  const validator = validatorRef.scriptRef;
  if (!validator) {
    throw new Error('Invalid validator reference');
  }
  const { scriptAddress, scriptHash: policyId } = getValidatorDetails(
    validator,
    network
  );

  // Build the transaction
  const minLvc = 2_000_000n;
  let totalAmount = amountsToDeposit;
  let validationToken = '';
  // If a funds UTxO for this user already exists, we will add the new funds to it. Otherwise, we will create a new one.
  if (fundsUtxo) {
    validationToken = Object.keys(fundsUtxo.assets).find(
      (asset) => fromUnit(asset).policyId === policyId
    ) as string;

    // Add the funds from the input UTxO
    totalAmount = addAssets(totalAmount, fundsUtxo.assets);

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
    totalAmount = addAssets(totalAmount, {
      ['lovelace']: minLvc,
      [validationToken]: 1n,
    });

    tx.collectFrom([selectedUtxo]);
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
    .addSigner(userAddress)
    .pay.ToContract(
      scriptAddress,
      { kind: 'inline', value: datum },
      totalAmount
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
