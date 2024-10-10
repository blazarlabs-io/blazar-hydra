import { Data } from "@lucid-evolution/lucid";

/**
 * Common Types
 */
const CredentialSchema = Data.Enum([
  Data.Object({
    Verification_key_cred: Data.Object({ Key: Data.Bytes() }),
  }),
  Data.Object({ Script_cred: Data.Object({ Key: Data.Bytes() }) }),
]);
type CredentialT = Data.Static<typeof CredentialSchema>;
const Credential = CredentialSchema as unknown as CredentialT;
const AddressSchema = Data.Object({
  payment_credential: CredentialSchema,
  stake_credential: Data.Nullable(
    Data.Object({
      inline: CredentialSchema,
    })
  ),
});
type AddressT = Data.Static<typeof AddressSchema>;
const Address = AddressSchema as unknown as AddressT;
const OutputRefSchema = Data.Object({
  transaction_id: Data.Object({
    hash: Data.Bytes(),
  }),
  output_index: Data.Integer(),
});

/**
 *  Contract types
 */
const FundsTypeSchema = Data.Enum([
  Data.Literal("User"),
  Data.Literal("Merchant"),
]);
type FundsTypeT = Data.Static<typeof FundsTypeSchema>;
const FundsType = FundsTypeSchema as unknown as FundsTypeT;

const FundsDatumSchema = Data.Object({
  addr: AddressSchema,
  locked_deposit: Data.Integer(),
  funds_type: FundsTypeSchema,
});
type FundsDatumT = Data.Static<typeof FundsDatumSchema>;
const FundsDatum = FundsDatumSchema as unknown as FundsDatumT;

const PayInfoSchema = Data.Object({
  amount: Data.Integer(),
  merchant_addr: AddressSchema,
  ref: OutputRefSchema,
  sig: Data.Bytes(),
});
const WithdrawInfoSchema = Data.Object({
  amount: Data.Integer(),
  ref: OutputRefSchema,
  sig: Data.Bytes(),
});
const FundsRedeemerSchema = Data.Enum([
  Data.Literal("AddFunds"),
  Data.Literal("Commit"),
  Data.Literal("Merge"),
  Data.Object({ Pay: Data.Object({ info: PayInfoSchema }) }),
  Data.Object({ UserWithdraw: Data.Object({ info: WithdrawInfoSchema }) }),
  Data.Object({ MerchantWithdraw: Data.Object({ amount: Data.Integer() }) }),
]);
type FundsRedeemerT = Data.Static<typeof FundsRedeemerSchema>;
const FundsRedeemer = FundsRedeemerSchema as unknown as FundsRedeemerT;

const CombinedActionSchema = Data.Enum([
  Data.Literal("CombinedCommit"),
  Data.Literal("CombinedMerge"),
  Data.Literal("CombinedWithdraw"),
]);
type CombinedActionT = Data.Static<typeof CombinedActionSchema>;
const CombinedAction =
  CombinedActionSchema as unknown as CombinedActionT;

const MintRedeemerSchema = Data.Enum([
  Data.Object({ Mint: Data.Object({ ref: OutputRefSchema }) }),
  Data.Literal("Burn"),
]);
type MintRedeemerT = Data.Static<typeof MintRedeemerSchema>;
const MintRedeemer = MintRedeemerSchema as unknown as MintRedeemerT;

export {
  Address,
  AddressT,
  CredentialSchema,
  CredentialT,
  OutputRefSchema,
  FundsType,
  FundsTypeT,
  FundsDatum,
  FundsDatumT,
  PayInfoSchema,
  WithdrawInfoSchema,
  FundsRedeemer,
  FundsRedeemerT,
  CombinedAction,
  CombinedActionT,
  MintRedeemer,
  MintRedeemerT,
}