import { OutRef } from "@lucid-evolution/lucid";
import { Layer } from "./types";

type DepositSchema = {
  user_address: string;
  amount: bigint;
  funds_utxo_ref?: OutRef;
};

type WithdrawSchema = {
  address: string;
  amount: bigint;
  funds_utxo_ref: OutRef;
  signature: string;
  network_layer: Layer;
};

type PayMerchantSchema = {
  user_address: string;
  merchant_address: string;
  funds_utxo_ref: OutRef;
  amount: bigint;
  signature: string;
};

type ManageHeadSchema = {
  auth_token: string;
};


export {
  DepositSchema,
  ManageHeadSchema,
  PayMerchantSchema,
  WithdrawSchema,
}
