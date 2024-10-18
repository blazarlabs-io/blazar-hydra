use aiken/cbor.{serialise}
use aiken/collection/pairs
use aiken/primitive/bytearray
use cardano/address.{Address, Credential, VerificationKey}
use cardano/transaction.{Input, Output, OutputReference, Transaction, Withdraw}
use types.{CombinedFundsActions}

// Checks that the given credential is indeed a wallet credential.
// More efficient than using expect
pub fn is_verification_credential(cred: Credential) {
  when cred is {
    VerificationKey(_key_hash) -> True
    _ -> False
  }
}

// Converts an OutputReference to a plain bytestring using `cbor.serialize` for
// the output_index.
pub fn output_reference_to_bytestring(ref: OutputReference) {
  let OutputReference { transaction_id, output_index } = ref

  let serialized_index = serialise(output_index)

  bytearray.concat(transaction_id, serialized_index)
}

pub fn check_withdraw_is_present(
  own_input: Input,
  expected_redeemer: CombinedFundsActions,
  tx: Transaction,
) {
  let Input {
    output: Output { address: Address { payment_credential: cred, .. }, .. },
    ..
  } = own_input

  // The withdraw purpose of the script is being run with the correct redeemer
  expect Some(redeemer_data) = pairs.get_first(tx.redeemers, Withdraw(cred))
  let expected_redeemer_data: Data = expected_redeemer

  expected_redeemer_data == redeemer_data
}
