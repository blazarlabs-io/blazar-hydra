use aiken/crypto.{Signature, VerificationKey}
use cardano/address.{Address}
use cardano/transaction.{OutputReference}

pub type FundsType {
  User { public_key: VerificationKey }
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
  Pay { info: PayInfo, sig: Signature }
  UserWithdraw { info: WithdrawInfo, sig: Signature }
  MerchantWithdraw
}

pub type PayInfo {
  amount: Int,
  merchant_addr: Address,
  ref: OutputReference,
}

pub type WithdrawInfo {
  ref: OutputReference,
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

pub type MockHydraRedeemer {
  HydraDummy
  HydraCommit { utxos_refs: List<OutputReference> }
}
