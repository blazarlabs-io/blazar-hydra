use cardano/address.{Credential, VerificationKey}

// Checks that the given credential is indeed a wallet credential.
// More efficient than using expect
pub fn is_verification_credential(cred: Credential) {
  when cred is {
    VerificationKey(_key_hash) -> True
    _ -> False
  }
}
