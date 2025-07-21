import {
  addAssets,
  Data,
  fromUnit,
  LucidEvolution,
  TxSignBuilder,
} from '@lucid-evolution/lucid';
import { WithdrawParams } from '../lib/params';
import {
  Combined,
  FundsDatum,
  FundsDatumT,
  Mint,
  Spend,
  WithdrawInfoT,
} from '../lib/types';
import {
  dataAddressToBech32,
  getNetworkFromLucid,
  getValidator,
  getValidatorDetails,
} from '../lib/utils';

async function withdraw(
  lucid: LucidEvolution,
  params: WithdrawParams,
  adminAddress: string
): Promise<{ tx: TxSignBuilder }> {
  const tx = lucid.newTx();
  const { kind, withdraws, adminKey, hydraKey, validatorRef, walletUtxos } =
    params;

  // Script UTxO related boilerplate
  const validator = getValidator(validatorRef, adminKey, hydraKey);
  const network = getNetworkFromLucid(lucid);
  const { scriptHash: policyId, rewardAddress } = getValidatorDetails(
    validator,
    network
  );

  const sortedInputs = withdraws.sort((a, b) => {
    const aLex = `${a.fundUtxo.txHash}${a.fundUtxo.outputIndex}`;
    const bLex = `${b.fundUtxo.txHash}${b.fundUtxo.outputIndex}`;
    if (aLex < bLex) return -1;
    return 1;
  });

  for (let i = 0; i < sortedInputs.length; i++) {
    // Build transaction values and datums
    const fundsUtxo = sortedInputs[i].fundUtxo;
    const sig = sortedInputs[i].signature;
    if (!fundsUtxo.datum) {
      throw new Error('Funds UTxO datum not found');
    }
    const datum = Data.from<FundsDatumT>(fundsUtxo.datum, FundsDatum);

    const validationToken = Object.keys(fundsUtxo.assets).find(
      (asset) => fromUnit(asset).policyId === policyId
    );
    if (!validationToken) {
      throw new Error('Validation token not found in funds UTxO');
    }
    const burnedValidationToken = { [validationToken]: -1n };
    const userReturn = addAssets(fundsUtxo.assets, burnedValidationToken);

    const withdrawInfo: WithdrawInfoT = {
      ref: {
        transaction_id: fundsUtxo.txHash,
        output_index: BigInt(fundsUtxo.outputIndex),
      },
    };

    const userAddress = dataAddressToBech32(lucid, datum.addr);

    tx.collectFrom([fundsUtxo], Spend.UserWithdraw(withdrawInfo, sig!));
    tx.mintAssets(burnedValidationToken, Mint.Burn);
    tx.pay.ToAddress(userAddress, userReturn);
  }

  // Complete transaction
  if (walletUtxos) {
    tx.collectFrom(walletUtxos);
  }
  if (kind === 'user') {
    tx.readFrom([validatorRef!]);
  }

  const txSignBuilder = await tx
    .addSigner(adminAddress)
    .withdraw(rewardAddress, 0n, Combined.CombinedWithdraw)
    .attachMetadata(674, { msg: 'HydraPay: Withdraw' })
    .complete();

  return { tx: txSignBuilder };
}

export { withdraw };
