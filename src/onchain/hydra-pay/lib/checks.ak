use aiken/cbor.{serialise}
use aiken/collection/dict.{size}
use aiken/collection/list
use aiken/crypto.{ScriptHash, VerificationKeyHash}
use aiken/primitive/bytearray
use cardano/address.{Credential, Script, from_script}
use cardano/assets.{
  PolicyId, from_asset, lovelace_of, match, quantity_of, tokens,
  without_lovelace,
}
use cardano/transaction.{
  InlineDatum, Input, Output, OutputReference, Transaction,
}
use config.{add_funds_min_lovelace}
use types.{FundsDatum, PayInfo, User, WithdrawInfo}
use utils.{is_verification_credential}

pub fn validate_add_funds(own_input: Input, tx: Transaction) {
  // Continuing output must be the first output
  expect [script_output, ..] = tx.outputs

  let Output { address: i_address, value: i_value, datum: i_datum, .. } =
    own_input.output

  expect Script(own_hash) = i_address.payment_credential

  let Output {
    address: o_address,
    value: o_value,
    datum: o_datum,
    reference_script: o_ref_script,
  } = script_output

  and {
    // Validation token is present in the input
    ( tokens(i_value, own_hash) |> size() ) == 1,
    // Output value is equal to the input value, except for lovelaces that must
    // increase by at least add_funds_min_lovelace
    match(
      o_value,
      i_value,
      fn(o_l, i_l) { o_l >= i_l + add_funds_min_lovelace },
    ),
    // Address doesn't change
    o_address == i_address,
    // Datum doesn't change
    o_datum == i_datum,
    // No ref script to avoid paying excessive fees
    o_ref_script == None,
  }
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

  let serialized_index = serialise(output_index)

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

  // Only users can deposit
  expect User { public_key: _vk } = dat_funds_type

  and {
    // Token name should be an output reference that is being consumed to make sure it is unique
    token_name == bytearray.concat(transaction_id, serialized_index),
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
    // TODO: Revise what is a sensible minimum here
    dat_locked_deposit > 0,
    // No ref script to avoid paying excessive fees
    o_ref_script == None,
  }
}

pub fn validate_burning(own_policy: PolicyId, tx: Transaction) {
  tx.mint
    |> tokens(own_policy)
    |> dict.values()
    |> list.all(fn(qty) { qty < 0 })
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
