use aiken/crypto.{Script, VerificationKeyHash}
use cardano/address.{Credential}
use cardano/assets.{PolicyId}
use cardano/certificate.{Certificate}
use cardano/transaction.{OutputReference, Transaction}
use types.{FundsDatum, FundsRedeemer, MintRedeemer}

validator main(_admin_key: VerificationKeyHash, _hydra_contract: Script) {
  spend(
    _datum: Option<FundsDatum>,
    _redeemer: FundsRedeemer,
    _ownref: OutputReference,
    _tx: Transaction,
  ) {
    True
  }

  mint(_redeemer: MintRedeemer, _policy: PolicyId, _tx: Transaction) {
    True
  }

  withdraw(_redeemer: FundsRedeemer, _account: Credential, _tx: Transaction) {
    True
  }

  publish(_redeemer: Data, _cert: Certificate, _tx: Transaction) {
    True
  }

  else(_) {
    False
  }
}
