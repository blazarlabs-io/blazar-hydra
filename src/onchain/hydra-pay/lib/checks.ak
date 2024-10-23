use aiken/collection/dict.{empty, size}
use aiken/collection/list.{head, length}
use aiken/collection/pairs
use aiken/crypto.{
  ScriptHash, VerificationKeyHash, blake2b_224, verify_ed25519_signature,
}
use cardano/address.{Address, Credential, Script, from_script}
use cardano/assets.{
  PolicyId, ada_asset_name, ada_policy_id, flatten, from_asset, from_lovelace,
  lovelace_of, match, quantity_of, tokens, without_lovelace,
}
use cardano/transaction.{
  InlineDatum, Input, NoDatum, Output, OutputReference, Spend, Transaction,
}
use config.{add_funds_min_lovelace}
use types.{
  CombinedCommit, CombinedMerge, CombinedWithdraw, FundsDatum, HydraCommit,
  Merchant, PayInfo, User, WithdrawInfo,
}
use utils.{
  check_withdraw_is_present, is_verification_credential,
  output_reference_to_bytestring,
}

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

pub fn validate_commit(datum: FundsDatum, own_input: Input, tx: Transaction) {
  expect User { public_key: _public_key } = datum.funds_type

  check_withdraw_is_present(own_input, CombinedCommit, tx)
}

pub fn validate_merge(own_input: Input, tx: Transaction) {
  check_withdraw_is_present(own_input, CombinedMerge, tx)
}

pub fn validate_pay(
  _info: PayInfo,
  _datum: FundsDatum,
  _own_input: Input,
  _tx: Transaction,
) {
  True
}

pub fn validate_withdraw(
  info: Option<WithdrawInfo>,
  datum: FundsDatum,
  own_input: Input,
  tx: Transaction,
) {
  // If the funds_type is User, the action must be authorized
  let authorized =
    when datum.funds_type is {
      User { public_key } -> {
        expect Some(WithdrawInfo { ref, sig }) = info
        let msg = output_reference_to_bytestring(ref)
        and {
          verify_ed25519_signature(public_key, msg, sig),
          list.any(tx.inputs, fn(i) { i.output_reference == ref }),
        }
      }

      Merchant -> True
    }

  and {
    check_withdraw_is_present(own_input, CombinedWithdraw, tx),
    authorized,
  }
}

pub fn validate_minting(
  ref: OutputReference,
  own_policy: PolicyId,
  tx: Transaction,
) {
  let expected_token_name = output_reference_to_bytestring(ref)

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
  expect User { public_key } = dat_funds_type

  let hashed_public_key = blake2b_224(public_key)

  and {
    // The public key stored in the datum must sign the transaction to prove ownership
    list.any(
      tx.extra_signatories,
      fn(signatory) { signatory == hashed_public_key },
    )?,
    // Token name should be an output reference that is being consumed to make sure it is unique
    token_name == expected_token_name,
    // The reference passed by redeemer is being consumed
    list.any(tx.inputs, fn(i) { i.output_reference == ref })?,
    // The script output has the correct address
    (o_address == from_script(own_policy))?,
    // The script value only has lovelaces and the minted token
    (without_lovelace(o_value) == from_asset(own_policy, token_name, 1))?,
    // Make sure the address stored in the datum can sign messages for the rest of the operations
    is_verification_credential(dat_addr.payment_credential)?,
    // The locked_deposit is not greater than the amount of lovelaces in the value
    (dat_locked_deposit < lovelace_of(o_value))?,
    // TODO: Revise what is a sensible minimum here
    (dat_locked_deposit > 0)?,
    // No ref script to avoid paying excessive fees
    (o_ref_script == None)?,
  }
}

pub fn validate_burning(own_policy: PolicyId, tx: Transaction) {
  tx.mint
    |> tokens(own_policy)
    |> dict.values()
    |> list.all(fn(qty) { qty < 0 })
}

pub fn validate_combined_commit(
  own_hash: ScriptHash,
  admin_key: VerificationKeyHash,
  hydra_script: Credential,
  tx: Transaction,
) {
  let Transaction { inputs, redeemers, extra_signatories, mint, .. } = tx

  expect [hydra_input] =
    list.filter(
      inputs,
      fn(i) { i.output.address.payment_credential == hydra_script },
    )

  let own_utxo_refs =
    list.filter_map(
      inputs,
      fn(i) {
        if i.output.address.payment_credential == Script(own_hash) {
          Some(i.output_reference)
        } else {
          None
        }
      },
    )

  let expected_redeemer = HydraCommit { utxos_refs: own_utxo_refs }
  let expected_redeemer_data: Data = expected_redeemer

  expect Some(hydra_redeemer) =
    pairs.get_first(redeemers, Spend(hydra_input.output_reference))

  and {
    // Hydra redeemer must contain the complete list of own input refs
    hydra_redeemer == expected_redeemer_data,
    // Must be authorized by the admin
    list.any(extra_signatories, fn(sig) { sig == admin_key }),
    // No token mint or burn under our policy
    tokens(mint, own_hash) == empty,
  }
}

pub fn validate_combined_merge(own_hash: ScriptHash, tx: Transaction) {
  let Transaction { inputs, outputs, .. } = tx

  let own_inputs =
    list.filter(
      inputs,
      fn(i) { i.output.address.payment_credential == Script(own_hash) },
    )

  // Calculate funds to be merged
  let sum_of_lovelace =
    list.foldl(own_inputs, 0, fn(i, acc) { acc + lovelace_of(i.output.value) })

  // Get first input to copy over datum
  expect Some(first_input) = head(own_inputs)

  // Only one output allowed to have a token of ours
  expect [
    Output {
      address: o_addr,
      value: o_value,
      datum: o_datum,
      reference_script: o_ref_script,
    },
  ] = list.filter(outputs, fn(o) { tokens(o.value, own_hash) != empty })

  // This output should have adas and only one of our tokens
  expect [(fst_pol, fst_an, fst_qty), (snd_pol, _snd_tn, 1)] = flatten(o_value)

  and {
    // All inputs must have the same datum
    list.all(own_inputs, fn(i) { i.output.datum == first_input.output.datum }),
    // More than one input to avoid DDoS
    length(own_inputs) > 1,
    // Output must be paid to our script
    o_addr.payment_credential == Script(own_hash),
    // Make sure that the output value contains enough ada and one token
    (fst_pol, fst_an) == (ada_policy_id, ada_asset_name),
    fst_qty >= sum_of_lovelace,
    snd_pol == own_hash,
    // Make sure datum is copied over
    o_datum == first_input.output.datum,
    // No ref script to avoid paying excessive fees
    o_ref_script == None,
  }
}

pub fn validate_combined_withdraw(own_hash: ScriptHash, tx: Transaction) {
  let Transaction { inputs, outputs, .. } = tx

  let own_inputs =
    list.filter(
      inputs,
      fn(i) { i.output.address.payment_credential == Script(own_hash) },
    )

  let own_outputs =
    list.filter(
      outputs,
      fn(Output { address: o_address, value: o_value, .. }) {
        // No Output should have a token with our policy
        // This effectively makes sure that all tokens are burnt and no new ones are minted
        expect tokens(o_value, own_hash) == dict.empty
        o_address.payment_credential == Script(own_hash)
      },
    )

  recursive_withdraw_checks(own_inputs, own_outputs)
}

fn recursive_withdraw_checks(inputs: List<Input>, outputs: List<Output>) {
  when (inputs, outputs) is {
    ([], []) -> True
    ([i, ..rest_i], [o, ..rest_o]) -> {
      let Output { value: i_value, datum: i_datum, .. } = i.output

      expect InlineDatum(i_data) = i_datum
      expect FundsDatum { addr: i_d_addr, .. } = i_data

      let Output {
        address: o_addr,
        value: o_value,
        datum: o_datum,
        reference_script: o_ref_script,
      } = o

      let expected_value = from_lovelace(lovelace_of(i_value))

      and {
        // Output address must match address stored in datum
        o_addr == i_d_addr,
        // Output should contain at least the stored lovelaces and no other tokens
        match(o_value, expected_value, >=),
        // No datum to optimize UTxO size and tx cost
        o_datum == NoDatum,
        // No ref script to optimize UTxO size and tx cost
        o_ref_script == None,
        // Continue the checks recursively
        recursive_withdraw_checks(rest_i, rest_o),
      }
    }
    _ -> False
  }
}
