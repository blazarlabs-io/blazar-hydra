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
  params: DepositParams,
  adminAddress: string
): Promise<{ tx: TxSignBuilder; newFundsUtxo: OutRef }> {
  const {
    userAddress,
    publicKey,
    amountsToDeposit,
    walletUtxos,
    validatorRef,
    fundsUtxo,
    seedUtxo,
    lockDeposited,
  } = params;
  lucid.selectWallet.fromAddress(adminAddress, walletUtxos);
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
    const selectedUtxo = seedUtxo ?? walletUtxos[0];
    const outRef: OutputRefT = {
      transaction_id: selectedUtxo.txHash,
      output_index: BigInt(selectedUtxo.outputIndex),
    };

    validationToken = toUnit(policyId, validationTokenName(selectedUtxo));
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
      locked_deposit:
        minLvc + (lockDeposited ? (amountsToDeposit['lovelace'] ?? 0n) : 0n),
      funds_type: { User: { public_key: publicKey } },
    },
    FundsDatum
  );

  const txSignBuilder = await tx
    .readFrom([validatorRef])
    .addSigner(adminAddress)
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

/** Name of the validation token minted when `ref` is consumed (on-chain output_reference_to_bytestring). */
function validationTokenName(ref: OutRef): string {
  const serializedIndex = Data.to<bigint>(BigInt(ref.outputIndex));
  return blake2b(32)
    .update(Buffer.from(ref.txHash + serializedIndex, 'hex'))
    .digest('hex');
}

export { deposit, validationTokenName };
