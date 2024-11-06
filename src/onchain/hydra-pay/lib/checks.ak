use aiken/cbor.{serialise}
use aiken/collection/dict.{empty, size, to_pairs}
use aiken/collection/list.{head, length}
use aiken/collection/pairs
use aiken/crypto.{
  ScriptHash, Signature, VerificationKeyHash, blake2b_224,
  verify_ed25519_signature,
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
  AddFunds, CombinedCommit, CombinedMerge, CombinedWithdraw, FundsDatum,
  HaskellOutputReference, HaskellTransactionId, HydraCommit, Merchant, PayInfo,
  User, WithdrawInfo,
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

  // The script UTxO being validated has User funds_type
  expect User { public_key } = datum.funds_type

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
      [_user_input] -> (0, None)
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
          output: Output {
            address: m_i_addr,
            value: m_i_value,
            datum: m_i_datum,
            ..
          },
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
            m_i_addr.payment_credential == Script(own_hash),
            // The Merchant Funds input has the same address in the datum than
            // the merchantAddr passed by redeemer
            m_dat_addr == red_merchant_addr,
            // The Merchant Funds input has the Merchant funds_type
            m_dat_f_type == Merchant,
          }
        (lovelace_of(m_i_value), Some(m_i_dat_data))
      }

      _ -> fail
    }

  // The first output is the Merchant Funds output
  // The second output is the Remaining User Funds UTxO
  expect [merchant_output,
    user_output] =
    list.filter(
      outputs,
      fn(o) { o.address.payment_credential == Script(own_hash) },
    )

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

  let merchant_correct_datum =
    when m_i_datum is {
      Some(data) -> m_o_datum == InlineDatum(data)
      None -> {
        let expected_datum =
          FundsDatum {
            addr: red_merchant_addr,
            locked_deposit: 0,
            funds_type: Merchant,
          }
        let expected_datum_data: Data = expected_datum
        m_o_datum == InlineDatum(expected_datum_data)
      }
    }

  let expected_merchant_funds = m_i_funds + red_amount

  // If there's no Merchant Funds input, a new validation token must be minted
  let mint_correct =
    when m_i_datum is {
      None -> {
        let expected_token_name = output_reference_to_bytestring(u_i_ref)

        expect [Pair(token_name, 1)] =
          tx.mint |> tokens(own_hash) |> dict.to_pairs()
        expected_token_name == token_name
      }
      Some(_) -> tokens(mint, own_hash) == empty
    }

  // The Merchant Funds output has the validation token
  expect [Pair(_m_token_name, 1)] = tokens(m_o_value, own_hash) |> to_pairs()
  expect [Pair(_u_token_name, 1)] = tokens(u_o_value, own_hash) |> to_pairs()

  and {
    // The msg and signature from the redeemer validate against the user vkey stored in the datum
    verify_ed25519_signature(public_key, msg, red_sig),
    // The ref stored in the redeemer msg is being spent
    list.any(inputs, fn(i) { i.output_reference == red_ref }),
    m_o_addr.payment_credential == Script(own_hash),
    // Remaining User Funds address must be the same as User Funds UTxO
    u_o_addr.payment_credential == Script(own_hash),
    // The amount of lovelaces of the Merchant Funds output is the same as the
    // amount specified in the Pay redeemer plus the Merchant Funds input (If present)
    lovelace_of(m_o_value) >= expected_merchant_funds,
    // The User Funds output must have at least the original amount of lovelaces
    // minus the amount specified in the redeemer
    match(
      u_o_value,
      u_i_value,
      fn(o_lov, i_lov) { o_lov >= i_lov - red_amount },
    ),
    merchant_correct_datum,
    u_o_datum == u_i_datum,
    m_o_ref_script == None,
    // Remaining User Funds datum must be the same as User Funds UTxO
    u_o_ref_script == None,
    mint_correct,
  }
}

pub fn validate_withdraw(
  red_opt_info: Option<(WithdrawInfo, Signature)>,
  datum: FundsDatum,
  own_input: Input,
  tx: Transaction,
) {
  // If the funds_type is User, the action must be authorized
  let authorized =
    when datum.funds_type is {
      User { public_key } -> {
        expect Some((red_info, red_sig)) = red_opt_info
        let WithdrawInfo { ref } = red_info
        let msg = serialise(red_info)
        and {
          verify_ed25519_signature(public_key, msg, red_sig),
          list.any(tx.inputs, fn(i) { i.output_reference == ref }),
        }
      }

      Merchant -> True
    }

  and {
    check_withdraw_is_present(own_input, CombinedWithdraw, tx)?,
    authorized?,
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
    // The script value only has lovelaces and the minted token
    (without_lovelace(o_value) == from_asset(own_policy, token_name, 1))?,
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
        if i.output.address.payment_credential == Script(own_hash) {
          let h_tx_id: HaskellTransactionId =
            HaskellTransactionId { tx_hash: i.output_reference.transaction_id }
          let h_ref =
            HaskellOutputReference {
              transaction_id: h_tx_id,
              output_index: i.output_reference.output_index,
            }
          Some(h_ref)
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

      let expected_value = from_lovelace(lovelace_of(i_value))

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
