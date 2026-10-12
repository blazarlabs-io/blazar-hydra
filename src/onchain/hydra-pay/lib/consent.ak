use aiken/cbor.{serialise}
use aiken/crypto.{Signature, verify_ed25519_signature}
use cardano/address.{Address, Inline, VerificationKey}
use cardano/transaction.{OutputReference}
use types.{PayInfo}

/// The payer's consent to one payment: an ed25519 signature, by the key stored in its User datum,
/// over the CBOR of the PayInfo (amount, merchant address, spent funds UTxO) carried by the redeemer.
/// Same check as the audited validator (main, ed99a650); `ref` makes a signature single-use.
pub fn pay_signed_by(public_key: ByteArray, info: PayInfo, sig: Signature) -> Bool {
  verify_ed25519_signature(public_key, serialise(info), sig)
}

// Golden vectors (12 Oct 2026): the same values are asserted by the backend (offchain/lib/pay-message.test.ts)
// and the mobile app (services/__tests__/pay-message-test.ts), so all three agree byte for byte.
const payer_key: ByteArray =
  #"8a88e3dd7409f195fd52db2d3cba5d72ca6709bf1d94121bf3748801b40f6f5c"

const other_key: ByteArray =
  #"8139770ea87d175f56a35466c34c7ecccb8d8a91b4ee37a25df60f5b8fc9b394"

const ada_payment: PayInfo =
  PayInfo {
    amount: [Pair(#"", [Pair(#"", 5000000)])],
    merchant_addr: Address {
      payment_credential: VerificationKey(
        #"e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1",
      ),
      stake_credential: Some(
        Inline(
          VerificationKey(
            #"0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f",
          ),
        ),
      ),
    },
    ref: OutputReference {
      transaction_id: #"1111111111111111111111111111111111111111111111111111111111111111",
      output_index: 0,
    },
  }

const ada_signature: ByteArray =
  #"722aea99e109cc990a416a8b84a6ead4a1568c5dbebb4755b52c56382056aa7d1f8b6ba42e42526ea97e0281145102b813229077bfa376888f967e477f688a04"

test pay_info_cbor_is_the_golden_vector() {
  serialise(ada_payment) == #"d8799fa140a1401a004c4b40d8799fd8799f581ce1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1ffd8799fd8799fd8799f581c0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0fffffffffd8799f5820111111111111111111111111111111111111111111111111111111111111111100ffff"
}

test accepts_the_payer_signature() {
  pay_signed_by(payer_key, ada_payment, ada_signature)
}

test rejects_another_amount() {
  !pay_signed_by(
    payer_key,
    PayInfo { ..ada_payment, amount: [Pair(#"", [Pair(#"", 5000001)])] },
    ada_signature,
  )
}

test rejects_another_merchant() {
  !pay_signed_by(
    payer_key,
    PayInfo {
      ..ada_payment,
      merchant_addr: Address {
        ..ada_payment.merchant_addr,
        payment_credential: VerificationKey(
          #"e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2",
        ),
      },
    },
    ada_signature,
  )
}

test rejects_another_funds_utxo() {
  !pay_signed_by(
    payer_key,
    PayInfo {
      ..ada_payment,
      ref: OutputReference { ..ada_payment.ref, output_index: 1 },
    },
    ada_signature,
  )
}

test rejects_another_key() {
  !pay_signed_by(other_key, ada_payment, ada_signature)
}
