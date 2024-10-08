use aiken/crypto.{ScriptHash, VerificationKeyHash}
use cardano/address.{Credential}
use cardano/assets.{PolicyId}
use cardano/transaction.{Input, OutputReference, Transaction}
use types.{FundsDatum, PayInfo, WithdrawInfo}

pub fn validate_add_funds(
  _datum: FundsDatum,
  _own_input: Input,
  _tx: Transaction,
) {
  True
}

pub fn validate_commit(_datum: FundsDatum, _own_input: Input, _tx: Transaction) {
  True
}

pub fn validate_merge(_own_input: Input, _tx: Transaction) {
  True
}

pub fn validate_pay(
  _info: PayInfo,
  _datum: FundsDatum,
  _own_input: Input,
  _tx: Transaction,
) {
  True
}

pub fn validate_user_withdraw(
  _info: WithdrawInfo,
  _datum: FundsDatum,
  _own_input: Input,
  _tx: Transaction,
) {
  True
}

pub fn validate_merchant_withdraw(
  _datum: FundsDatum,
  _own_input: Input,
  _tx: Transaction,
) {
  True
}

pub fn validate_minting(
  _ref: OutputReference,
  _own_policy: PolicyId,
  _tx: Transaction,
) {
  True
}

pub fn validate_burning(_own_policy: PolicyId, _tx: Transaction) {
  True
}

pub fn validate_combined_commit(
  _own_hash: ScriptHash,
  _admin_key: VerificationKeyHash,
  _hydra_script: Credential,
  _tx: Transaction,
) {
  True
}

pub fn validate_combined_merge(_own_hash: ScriptHash, _tx: Transaction) {
  True
}

pub fn validate_combined_withdraw(_own_hash: ScriptHash, _tx: Transaction) {
  True
}
