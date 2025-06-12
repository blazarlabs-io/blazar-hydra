use aiken/collection/list
use aiken/crypto.{ScriptHash, VerificationKeyHash}
use cardano/address.{Credential, Script}
use cardano/assets.{PolicyId}
use cardano/certificate.{Certificate}
use cardano/transaction.{OutputReference, Transaction}
use checks.{
  validate_add_funds, validate_burning, validate_combined_commit,
  validate_combined_merge, validate_combined_partial_commit,
  validate_combined_withdraw, validate_commit, validate_merchant_withdraw,
  validate_merge, validate_minting, validate_partial_commit, validate_pay,
  validate_withdraw,
}
use types.{
  AddFunds, Burn, CombinedCommit, CombinedFundsActions, CombinedMerge,
  CombinedPartialCommit, CombinedWithdraw, Commit, FundsDatum, FundsRedeemer,
  MerchantWithdraw, Merge, Mint, MintRedeemer, PartialCommit, Pay, UserWithdraw,
}

validator main(
  admin_key: VerificationKeyHash,
  hydra_commit_hash: ScriptHash,
  hydra_deposit_hash: ScriptHash,
) {
  spend(
    o_datum: Option<FundsDatum>,
    redeemer: FundsRedeemer,
    own_ref: OutputReference,
    tx: Transaction,
  ) {
    expect Some(datum) = o_datum
    expect Some(own_input) =
      list.find(tx.inputs, fn(input) { input.output_reference == own_ref })

    when redeemer is {
      AddFunds -> validate_add_funds(own_input, tx)
      Commit -> validate_commit(datum, own_input, tx)
      Merge -> validate_merge(own_input, tx)
      Pay { info, sig } -> validate_pay(info, sig, datum, own_input, tx)
      UserWithdraw { info, sig } ->
        validate_withdraw(info, sig, datum, own_input, tx)
      MerchantWithdraw -> validate_merchant_withdraw(datum, own_input, tx)
      PartialCommit -> validate_partial_commit(datum, own_input, tx)
    }
  }

  mint(redeemer: MintRedeemer, own_policy: PolicyId, tx: Transaction) {
    when redeemer is {
      Mint { ref } -> validate_minting(ref, own_policy, tx)
      Burn -> validate_burning(own_policy, tx)
    }
  }

  withdraw(redeemer: CombinedFundsActions, account: Credential, tx: Transaction) {
    expect Script(own_hash) = account

    when redeemer is {
      CombinedCommit ->
        validate_combined_commit(own_hash, admin_key, hydra_commit_hash, tx)
      CombinedMerge -> validate_combined_merge(own_hash, tx)
      CombinedWithdraw -> validate_combined_withdraw(own_hash, tx)
      CombinedPartialCommit ->
        validate_combined_partial_commit(
          own_hash,
          admin_key,
          hydra_deposit_hash,
          tx,
        )
    }
  }

  publish(_redeemer: Data, _cert: Certificate, tx: Transaction) {
    list.any(tx.extra_signatories, fn(signatory) { signatory == admin_key })?
  }

  else(_) {
    False
  }
}
