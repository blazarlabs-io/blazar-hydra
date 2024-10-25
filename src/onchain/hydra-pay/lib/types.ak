use aiken/crypto.{Blake2b_256, Hash, Signature, VerificationKey}
use cardano/address.{Address}
use cardano/transaction.{OutputReference, Transaction}

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
  Pay { info: PayInfo }
  UserWithdraw { info: WithdrawInfo }
  MerchantWithdraw
}

pub type PayInfo {
  amount: Int,
  merchant_addr: Address,
  ref: OutputReference,
  sig: Signature,
}

pub type WithdrawInfo {
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

pub type MockHydraRedeemer {
  HydraDummy
  HydraCommit { utxos_refs: List<HaskellOutputReference> }
}

pub type HaskellOutputReference {
  transaction_id: HaskellTransactionId,
  output_index: Int,
}

pub type HaskellTransactionId {
  tx_hash: Hash<Blake2b_256, Transaction>,
}
