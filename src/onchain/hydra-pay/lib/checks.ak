use aiken/cbor.{serialise}
use aiken/collection/dict.{empty, size, to_pairs}
use aiken/collection/list.{length}
use aiken/collection/pairs
use aiken/crypto.{
  ScriptHash, Signature, VerificationKeyHash, blake2b_224,
  verify_ed25519_signature,
}
use cardano/address.{Address, Credential, Script, VerificationKey, from_script}
use cardano/assets.{
  PolicyId, add, from_asset, from_asset_list, lovelace_of, match, merge, negate,
  quantity_of, restricted_to, tokens, without_lovelace, zero,
}
use cardano/transaction.{
  InlineDatum, Input, NoDatum, Output, OutputReference, Spend, Transaction,
  find_script_outputs,
}
use config.{add_funds_min_lovelace}
use types.{
  AddFunds, CombinedCommit, CombinedMerge, CombinedPartialCommit,
  CombinedWithdraw, FundsDatum, HydraCommit, Merchant, PayInfo, User,
  WithdrawInfo,
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
  red_info: PayInfo,
  red_sig: Signature,
  datum: FundsDatum,
  own_input: Input,
  tx: Transaction,
) {
  let Transaction { inputs, outputs, redeemers, mint, .. } = tx
  expect Input {
    output: Output {
      address: Address { payment_credential: Script(own_hash), .. },
      value: u_i_value,
      datum: u_i_datum,
      ..
    },
    output_reference: u_i_ref,
  } = own_input

  let FundsDatum {
    funds_type: i_dat_funds_type,
    locked_deposit: i_dat_locked_deposit,
    ..
  } = datum

  // The script UTxO being validated has User funds_type
  expect User { public_key } = i_dat_funds_type

  let PayInfo {
    amount: red_amount,
    merchant_addr: red_merchant_addr,
    ref: red_ref,
  } = red_info

  let msg = serialise(red_info)

  let own_inputs =
    list.filter(
      inputs,
      fn(i) { i.output.address.payment_credential == Script(own_hash) },
    )

  let (m_i_funds, m_i_datum) =
    when own_inputs is {
      [_user_input] -> (zero, None)
      // At most, one other input at the script address is present.
      // This input is considered the Merchant Funds input
      [input1, input2] -> {
        let merchant_input =
          if input1 == own_input {
            input2
          } else {
            input1
          }

        let Input {
          output_reference: m_o_ref,
          output: Output { value: m_i_value, datum: m_i_datum, .. },
        } = merchant_input

        expect InlineDatum(m_i_dat_data) = m_i_datum
        expect FundsDatum { addr: m_dat_addr, funds_type: m_dat_f_type, .. } =
          m_i_dat_data

        // The Merchant Funds input has the validation token
        expect [Pair(_, 1)] = tokens(m_i_value, own_hash) |> to_pairs()

        // The Merchant Funds input is being consumed with the AddFunds redeemer
        expect Some(m_i_redeemer_data) =
          pairs.get_first(redeemers, Spend(m_o_ref))
        expect AddFunds = m_i_redeemer_data

        expect and {
            // The Merchant Funds input has the same address in the datum than
            // the merchantAddr passed by redeemer
            (m_dat_addr == red_merchant_addr)?,
            // The Merchant Funds input has the Merchant funds_type
            (m_dat_f_type == Merchant)?,
          }
        (m_i_value, Some(m_i_dat_data))
      }

      _ -> fail
    }

  // The first output is the Merchant Funds output
  // The second output is the Remaining User Funds UTxO
  expect [merchant_output, user_output] = find_script_outputs(outputs, own_hash)

  let Output {
    address: m_o_addr,
    value: m_o_value,
    datum: m_o_datum,
    reference_script: m_o_ref_script,
  } = merchant_output

  let Output {
    address: u_o_addr,
    value: u_o_value,
    datum: u_o_datum,
    reference_script: u_o_ref_script,
  } = user_output

  // If there's a Merchant input, datum must match. If not, build the datum from scratch
  let merchant_correct_datum =
    when m_i_datum is {
      Some(data) -> (m_o_datum == InlineDatum(data))?
      None -> {
        let expected_datum =
          FundsDatum {
            addr: red_merchant_addr,
            locked_deposit: 0,
            funds_type: Merchant,
          }
        let expected_datum_data: Data = expected_datum
        (m_o_datum == InlineDatum(expected_datum_data))?
      }
    }

  let expected_merchant_funds =
    if m_i_funds == zero {
      let new_control_token = {
        let expected_token_name = output_reference_to_bytestring(u_i_ref)
        from_asset(own_hash, expected_token_name, 1)
      }
      // Min ada?
      merge(new_control_token, from_asset_list(red_amount))
    } else {
      merge(m_i_funds, from_asset_list(red_amount))
    }

  // If there's no Merchant Funds input, a new validation token must be minted
  let mint_correct =
    when m_i_datum is {
      None -> {
        let expected_token_name = output_reference_to_bytestring(u_i_ref)

        expect [Pair(token_name, 1)] =
          tx.mint |> tokens(own_hash) |> dict.to_pairs()
        (expected_token_name == token_name)?
      }
      Some(_) -> (tokens(mint, own_hash) == empty)?
    }

  // The Merchant Funds output has the validation token
  expect [Pair(_m_token_name, 1)] = tokens(m_o_value, own_hash) |> to_pairs()
  expect [Pair(_u_token_name, 1)] = tokens(u_o_value, own_hash) |> to_pairs()

  and {
    // The msg and signature from the redeemer validate against the user vkey stored in the datum

    // COMMENTED OUT: There is a serialization difference in the offchain and onchain which is causing this
    // to fail. We'll leave it commented out for now but will come back to it later.
    verify_ed25519_signature(public_key, msg, red_sig)?,

    // The ref stored in the redeemer msg is being spent
    list.any(inputs, fn(i) { i.output_reference == red_ref })?,
    // Merchant and User Funds UTxOs must be paid to our script
    (m_o_addr.payment_credential == Script(own_hash))?,
    (u_o_addr.payment_credential == Script(own_hash))?,
    // The amount of lovelaces of the Merchant Funds output is the same as the
    // amount specified in the Pay redeemer plus the Merchant Funds input (If present)
    match(m_o_value, expected_merchant_funds, >=)?,
    // The User Funds output value must be equal to the input value minus the payed assets,
    // and a greater or equal amount of lovelace
    match(u_o_value, merge(u_i_value, negate(from_asset_list(red_amount))), >=)?,
    // The User Funds output must have at least the locked lovelace deposit specified in the datum
    (lovelace_of(u_o_value) >= i_dat_locked_deposit)?,
    merchant_correct_datum?,
    // Remaining User Funds datum must be the same as User Funds UTxO
    (u_o_datum == u_i_datum)?,
    // No ref script to avoid paying excessive fees
    (m_o_ref_script == None)?,
    (u_o_ref_script == None)?,
    mint_correct?,
  }
}

pub fn validate_withdraw(
  red_info: WithdrawInfo,
  red_sig: Signature,
  datum: FundsDatum,
  own_input: Input,
  tx: Transaction,
) {
  // If the funds_type is User, the action must be authorized
  let authorized =
    when datum.funds_type is {
      User { public_key } -> {
        let WithdrawInfo { ref } = red_info
        let msg = serialise(red_info)
        and {
          verify_ed25519_signature(public_key, msg, red_sig)?,
          list.any(tx.inputs, fn(i) { i.output_reference == ref })?,
        }
      }

      Merchant -> False
    }

  and {
    check_withdraw_is_present(own_input, CombinedWithdraw, tx)?,
    authorized?,
  }
}

pub fn validate_merchant_withdraw(
  i_datum: FundsDatum,
  own_input: Input,
  tx: Transaction,
) {
  let Transaction { outputs, mint, .. } = tx

  expect Input {
    output_reference: i_ref,
    output: Output {
      address: Address { payment_credential: Script(own_hash), .. },
      value: i_value,
      ..
    },
  } = own_input

  expect [validation_token_name] = tokens(i_value, own_hash) |> dict.keys()

  expect Some(validation_token_mint_amount) =
    tokens(mint, own_hash) |> dict.get(validation_token_name)

  expect FundsDatum { addr: dat_addr, funds_type: Merchant, .. } = i_datum

  let valid_merch_output =
    list.any(
      outputs,
      fn(o) {
        let Output {
          address: o_addr,
          value: o_value,
          datum: o_datum,
          reference_script: o_ref_script,
        } = o

        when o_datum is {
          InlineDatum(o_dat_data) -> {
            let expected_datum = i_ref
            let expected_datum_data: Data = expected_datum

            // Merchant should receive all tokens, except the validation token
            let expected_value =
              add(i_value, own_hash, validation_token_name, -1)

            and {
              (o_addr == dat_addr)?,
              match(o_value, expected_value, >=)?,
              (o_dat_data == expected_datum_data)?,
              (o_ref_script == None)?,
            }
          }
          _ -> False
        }
      },
    )

  and {
    validation_token_mint_amount == -1,
    valid_merch_output?,
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

  let funds_type_valid =
    when dat_funds_type is {
      User { public_key } -> {
        let hashed_public_key = blake2b_224(public_key)
        and {
          // The public key stored in the datum must sign the transaction to prove ownership
          list.any(
            tx.extra_signatories,
            fn(signatory) { signatory == hashed_public_key },
          )?,
          // TODO: Revise what is a sensible minimum here, users must have some deposit
          (dat_locked_deposit > 0)?,
        }
      }
      Merchant ->
        // Merchants won't pay so they don't neccesarily need a deposit
        // must still prevent negative numbers
        (dat_locked_deposit >= 0)?
    }

  and {
    // Token name should be an output reference that is being consumed to make sure it is unique
    (token_name == expected_token_name)?,
    // The reference passed by redeemer is being consumed
    list.any(tx.inputs, fn(i) { i.output_reference == ref })?,
    // The script output has the correct address
    (o_address == from_script(own_policy))?,
    // The script value has the minted token
    (quantity_of(o_value,  own_policy, expected_token_name) == 1)?,
    // Make sure the address stored in the datum can sign messages for the rest of the operations
    is_verification_credential(dat_addr.payment_credential)?,
    // The locked_deposit is not greater than the amount of lovelaces in the value
    (dat_locked_deposit < lovelace_of(o_value))?,
    // No ref script to avoid paying excessive fees
    (o_ref_script == None)?,
    // Validations change depending on the funds_type
    funds_type_valid?,
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
        let cred = i.output.address.payment_credential
        if cred == Script(own_hash) || cred == VerificationKey(admin_key) {
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
    (hydra_redeemer == expected_redeemer_data)?,
    // Must be authorized by the admin
    list.any(extra_signatories, fn(sig) { sig == admin_key })?,
    // No token mint or burn under our policy
    (tokens(mint, own_hash) == empty)?,
  }
}

pub fn validate_combined_merge(own_hash: ScriptHash, tx: Transaction) {
  let Transaction { inputs, outputs, .. } = tx

  let own_inputs =
    list.filter(
      inputs,
      fn(i) { i.output.address.payment_credential == Script(own_hash) },
    )

  // Get first input to copy over datum and control token
  expect [first_input, ..rest_i] = own_inputs

  // Calculate funds to be merged
  let sum_of_values =
    list.foldl(rest_i, zero, fn(i, acc) { merge(acc, i.output.value) })

  let control_tokens = restricted_to(sum_of_values, [own_hash])

  let sum_without_control_token = merge(sum_of_values, negate(control_tokens))

  let expected_output_value =
    merge(sum_without_control_token, first_input.output.value)

  // Only one output allowed to have a token of ours
  expect [
    Output {
      address: o_addr,
      value: o_value,
      datum: o_datum,
      reference_script: o_ref_script,
    },
  ] = list.filter(outputs, fn(o) { tokens(o.value, own_hash) != empty })

  and {
    // All inputs must have the same datum
    list.all(own_inputs, fn(i) { i.output.datum == first_input.output.datum }),
    // More than one input to avoid DDoS
    length(own_inputs) > 1,
    // Output must be paid to our script
    o_addr.payment_credential == Script(own_hash),
    // Make sure that the output value contains the expected tokens
    match(o_value, expected_output_value, >=),
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

  recursive_withdraw_checks(own_inputs, outputs, own_hash)?
}

fn recursive_withdraw_checks(
  inputs: List<Input>,
  outputs: List<Output>,
  own_hash: ScriptHash,
) {
  when (inputs, outputs) is {
    ([], []) -> True
    ([], [o, ..rest_o]) ->
      // No Output should have a token with our policy
      // This effectively makes sure that all tokens are burnt and no new ones are minted
      and {
        (tokens(o.value, own_hash) == dict.empty)?,
        recursive_withdraw_checks([], rest_o, own_hash)?,
      }

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

      expect [Pair(validation_token_name, 1)] =
        tokens(i_value, own_hash) |> to_pairs()

      let expected_value = add(i_value, own_hash, validation_token_name, -1)

      and {
        // Output address must match address stored in datum
        (o_addr == i_d_addr)?,
        // Output should contain at least the stored lovelaces and no other tokens
        match(o_value, expected_value, >=)?,
        // No datum to optimize UTxO size and tx cost
        (o_datum == NoDatum)?,
        // No ref script to optimize UTxO size and tx cost
        (o_ref_script == None)?,
        // Continue the checks recursively
        recursive_withdraw_checks(rest_i, rest_o, own_hash)?,
      }
    }
    _ -> False?
  }
}

pub fn validate_partial_commit(
  datum: FundsDatum,
  own_input: Input,
  tx: Transaction,
) {
  expect User { public_key: _public_key } = datum.funds_type

  check_withdraw_is_present(own_input, CombinedPartialCommit, tx)
}

pub fn validate_combined_partial_commit(
  _own_hash: ScriptHash,
  admin_key: VerificationKeyHash,
  _hydra_script: Credential,
  tx: Transaction,
) {
  // Must be authorized by the admin
  list.any(tx.extra_signatories, fn(sig) { sig == admin_key })?
}
