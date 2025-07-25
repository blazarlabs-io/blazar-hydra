import { Data } from '@lucid-evolution/lucid';

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
  transaction_id: Data.Bytes(),
  output_index: Data.Integer(),
});
type OutputRefT = Data.Static<typeof OutputRefSchema>;

/**
 *  Contract types
 */
const FundsTypeSchema = Data.Enum([
  Data.Object({
    User: Data.Object({ public_key: Data.Bytes() }),
  }),
  Data.Literal('Merchant'),
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

const MapAssets = Data.Map(
  Data.Bytes(),
  Data.Map(Data.Bytes(), Data.Integer())
);
type MapAssetsT = Data.Static<typeof MapAssets>;
const PayInfoSchema = Data.Object({
  amount: Data.Map(Data.Bytes(), Data.Map(Data.Bytes(), Data.Integer())),
  merchant_addr: AddressSchema,
  ref: OutputRefSchema,
});
type PayInfoT = Data.Static<typeof PayInfoSchema>;
const PayInfo = PayInfoSchema as unknown as PayInfoT;
const WithdrawInfoSchema = Data.Object({
  ref: OutputRefSchema,
});

type WithdrawInfoT = Data.Static<typeof WithdrawInfoSchema>;
const WithdrawInfo = WithdrawInfoSchema as unknown as WithdrawInfoT;
const FundsRedeemerSchema = Data.Enum([
  Data.Literal('AddFunds'),
  Data.Literal('Commit'),
  Data.Literal('PartialCommit'),
  Data.Literal('Merge'),
  Data.Object({ Pay: Data.Object({ info: PayInfoSchema, sig: Data.Bytes() }) }),
  Data.Object({
    UserWithdraw: Data.Object({ info: WithdrawInfoSchema, sig: Data.Bytes() }),
  }),
  Data.Literal('MerchantWithdraw'),
]);
type FundsRedeemerT = Data.Static<typeof FundsRedeemerSchema>;
const FundsRedeemer = FundsRedeemerSchema as unknown as FundsRedeemerT;
namespace Spend {
  export const AddFunds = Data.to<FundsRedeemerT>('AddFunds', FundsRedeemer);
  export const Commit = Data.to<FundsRedeemerT>('Commit', FundsRedeemer);
  export const Merge = Data.to<FundsRedeemerT>('Merge', FundsRedeemer);
  export const Pay = (info: PayInfoT, sig: string) =>
    Data.to<FundsRedeemerT>({ Pay: { info, sig } }, FundsRedeemer);
  export const UserWithdraw = (info: WithdrawInfoT, sig: string) =>
    Data.to<FundsRedeemerT>({ UserWithdraw: { info, sig } }, FundsRedeemer);
  export const MerchantWithdraw = Data.to<FundsRedeemerT>(
    'MerchantWithdraw',
    FundsRedeemer
  );
}

const CombinedActionSchema = Data.Enum([
  Data.Literal('CombinedCommit'),
  Data.Literal('CombinedMerge'),
  Data.Literal('CombinedWithdraw'),
]);
type CombinedActionT = Data.Static<typeof CombinedActionSchema>;
const CombinedAction = CombinedActionSchema as unknown as CombinedActionT;
namespace Combined {
  export const CombinedCommit = Data.to<CombinedActionT>(
    'CombinedCommit',
    CombinedAction
  );
  export const CombinedMerge = Data.to<CombinedActionT>(
    'CombinedMerge',
    CombinedAction
  );
  export const CombinedWithdraw = Data.to<CombinedActionT>(
    'CombinedWithdraw',
    CombinedAction
  );
}

const MintRedeemerSchema = Data.Enum([
  Data.Object({ Mint: Data.Object({ ref: OutputRefSchema }) }),
  Data.Literal('Burn'),
]);
type MintRedeemerT = Data.Static<typeof MintRedeemerSchema>;
const MintRedeemer = MintRedeemerSchema as unknown as MintRedeemerT;
namespace Mint {
  export const Mint = (ref: OutputRefT) =>
    Data.to<MintRedeemerT>({ Mint: { ref } }, MintRedeemer);
  export const Burn = Data.to<MintRedeemerT>('Burn', MintRedeemer);
}

export {
  Address,
  AddressT,
  CredentialSchema,
  CredentialT,
  CombinedAction,
  CombinedActionT,
  Combined,
  FundsType,
  FundsTypeT,
  FundsDatumSchema,
  FundsDatum,
  FundsDatumT,
  FundsRedeemer,
  FundsRedeemerT,
  MapAssets,
  MapAssetsT,
  MintRedeemer,
  MintRedeemerT,
  Mint,
  OutputRefSchema,
  OutputRefT,
  PayInfoSchema,
  PayInfoT,
  PayInfo,
  Spend,
  WithdrawInfoSchema,
  WithdrawInfo,
  WithdrawInfoT,
};
