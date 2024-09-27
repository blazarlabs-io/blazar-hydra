use cardano/address.{Address}

pub type FundsType {
  User
  Merchant
}

pub type FundsDatum {
  addr: Address,
  funds_type: FundsType,
}

pub type FundsRedeemer {
  AddFunds
  Commit
  Merge
  Withdraw
  Pay
}