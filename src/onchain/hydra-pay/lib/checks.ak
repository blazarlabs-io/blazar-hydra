use aiken/collection/dict
use aiken/collection/list
use aiken/crypto.{ScriptHash, VerificationKeyHash}
use aiken/primitive/bytearray
use cardano/address.{Credential, from_script}
use cardano/assets.{
  PolicyId, from_asset, lovelace_of, quantity_of, tokens, without_lovelace,
}
use cardano/transaction.{
  InlineDatum, Input, Output, OutputReference, Transaction,
}
use types.{FundsDatum, PayInfo, User, WithdrawInfo}
use utils.{is_verification_credential}

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
  ref: OutputReference,
  own_policy: PolicyId,
  tx: Transaction,
) {
  let OutputReference { transaction_id, output_index } = ref

  expect [Pair(token_name, 1)] =
    tx.mint |> tokens(own_policy) |> dict.to_pairs()

  expect Some(Output {
    address: o_address,
    value: o_value,
    datum: o_datum,
    reference_script: o_ref_script,
  }) =
    list.find(
      tx.outputs,
      fn(o) { quantity_of(o.value, own_policy, token_name) == 1 },
    )

  expect InlineDatum(o_datum_data) = o_datum
  expect FundsDatum {
    addr: dat_addr,
    locked_deposit: dat_locked_deposit,
    funds_type: dat_funds_type,
  } = o_datum_data

  and {
    // TODO: FIX
    token_name == bytearray.concat(transaction_id, "#"),
    // The reference passed by redeemer is being consumed
    list.any(tx.inputs, fn(i) { i.output_reference == ref }),
    // The script output has the correct address
    o_address == from_script(own_policy),
    // The script value only has lovelaces and the minted token
    without_lovelace(o_value) == from_asset(own_policy, token_name, 1),
    // Make sure the address stored in the datum can sign messages for the rest of the operations
    is_verification_credential(dat_addr.payment_credential),
    // The locked_deposit is not greater than the amount of lovelaces in the value
    dat_locked_deposit < lovelace_of(o_value),
    // Only users can deposit
    dat_funds_type == User,
    // No ref script to avoid paying excessive fees
    o_ref_script == None,
  }
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
