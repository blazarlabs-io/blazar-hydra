import {
  addAssets,
  Assets,
  fromUnit,
  LucidEvolution,
  sortUTxOs,
  TxSignBuilder,
  UTxO,
} from '@lucid-evolution/lucid';
import { Combined, Mint, Spend } from '../lib/types';
import { fundsOwnerOf } from '../lib/funds';
import { getNetworkFromLucid, getValidatorDetails } from '../lib/utils';

/**
 * L1 `UserWithdraw` for user funds UTxOs that came back from the head (intact decommit or fanout):
 * each owner gets their whole UTxO minus the validation token, which is burned here, on L1, where
 * it was minted. The validator pairs its inputs, in ledger order, with the first outputs, so the
 * payouts follow the canonical input order and the wallet change comes last. Operator-signed.
 */
async function withdrawUsersOnL1(
  lucid: LucidEvolution,
  params: { fundUtxos: UTxO[]; validatorRef: UTxO; adminAddress: string }
): Promise<TxSignBuilder> {
  const { fundUtxos, validatorRef, adminAddress } = params;
  if (!validatorRef.scriptRef) throw new Error('Validator reference UTxO has no script');
  const { scriptHash, rewardAddress } = getValidatorDetails(
    validatorRef.scriptRef,
    getNetworkFromLucid(lucid)
  );

  const sorted = sortUTxOs(fundUtxos, 'Canonical');
  const burn: Assets = {};
  const tx = lucid.newTx().readFrom([validatorRef]);
  const payouts = sorted.map((u) => {
    const ref = `${u.txHash}#${u.outputIndex}`;
    const token = Object.keys(u.assets).find(
      (unit) => unit !== 'lovelace' && fromUnit(unit).policyId === scriptHash
    );
    const owner = fundsOwnerOf(lucid, u);
    if (!token || !owner) throw new Error(`${ref} is not a Blazar funds UTxO`);
    burn[token] = -1n;
    tx.collectFrom(
      [u],
      Spend.UserWithdraw(
        { ref: { transaction_id: u.txHash, output_index: BigInt(u.outputIndex) } },
        ''
      )
    );
    return { owner, assets: addAssets(u.assets, { [token]: -1n }) };
  });
  tx.withdraw(rewardAddress, 0n, Combined.CombinedWithdraw)
    .mintAssets(burn, Mint.Burn)
    .addSigner(adminAddress);
  for (const p of payouts) tx.pay.ToAddress(p.owner, p.assets);
  return tx.complete();
}

export { withdrawUsersOnL1 };
