use aiken/collection/list as list
use aiken/collection/pairs as pairs
use aiken/option.{is_some}
use cardano/address.{Address, Credential}
use cardano/transaction.{Input, Output, OutputReference, Transaction}
use types.{FundsDatum, FundsRedeemer}

validator main {
  spend(
    _datum: Option<FundsDatum>,
    _redeemer: FundsRedeemer,
    ownref: OutputReference,
    tx: Transaction,
  ) {
    let withdraws = tx.withdrawals
    let b = list.find(tx.inputs, fn(i) { i.output_reference == ownref })

    expect Some(self_input) = b

    let cred = self_input.output.address.payment_credential

    let a = pairs.get_first(withdraws, cred)

    is_some(a)?
  }

  withdraw(_redeemer: FundsRedeemer, account: Credential, tx: Transaction) {
    let c =
      list.filter(
        tx.inputs,
        fn(i) { i.output.address.payment_credential == account },
      )

    (list.length(c) > 0)?
  }

  else(_) {
    True
  }
}
