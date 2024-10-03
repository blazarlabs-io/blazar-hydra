use aiken/crypto.{Signature}
use cardano/address.{Address}
use cardano/transaction.{OutputReference}

pub type FundsType {
  User
  Merchant
}

pub type FundsDatum {
  addr: Address,
  // Amount of lovelaces that can't be spent
  locked_deposit: Int,
  funds_type: FundsType,
}

pub type FundsRedeemer {
  AddFunds
  Commit
  Merge
  Pay {
    amount: Int,
    merchant_addr: Address,
    ref: OutputReference,
    sig: Signature,
  }
  Withdraw { amount: Int, ref: OutputReference, sig: Signature }
}

pub type MintRedeemer {
  Mint { ref: OutputReference }
  Burn
}
