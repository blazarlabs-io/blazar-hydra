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
  Pay { info: PayInfo }
  UserWithdraw { info: WithdrawInfo }
  MerchantWithdraw { amount: Int }
}

pub type PayInfo {
  amount: Int,
  merchant_addr: Address,
  ref: OutputReference,
  sig: Signature,
}

pub type WithdrawInfo {
  amount: Int,
  ref: OutputReference,
  sig: Signature,
}

pub type CombinedFundsActions {
  CombinedCommit
  CombinedMerge
  CombinedWithdraw
}

pub type MintRedeemer {
  Mint { ref: OutputReference }
  Burn
}
