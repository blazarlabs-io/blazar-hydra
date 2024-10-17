use aiken/cbor.{serialise}
use aiken/primitive/bytearray
use cardano/address.{Credential, VerificationKey}
use cardano/transaction.{OutputReference}

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
