import { UTxO } from "@lucid-evolution/lucid";

/**
 * Tx Builders params
 */

type DepositParams = {
  userAddress: string;
  publicKey: string;
  amountToDeposit: bigint;
  walletUtxos: UTxO[];
  validatorRef: UTxO;
  fundsUtxo?: UTxO;
};

type WithdrawParams = {
  address: string;
  kind: "user" | "merchant";
  fundsUtxos: UTxO[];
  signature: string;
  adminKey?: string;
  hydraKey?: string;
  validatorRef?: UTxO;
  walletUtxos?: UTxO[];
};

type PayMerchantParams = {
  userAddress: string;
  merchantAddress: string;
  amountToPay: bigint;
  userFundsUtxo: UTxO;
  signature: string;
  adminKey: string;
  hydraKey: string;
  merchantFundsUtxo?: UTxO;
};

type MergeFundsParams = {
  adminAddress: string;
  userFundsUtxos: UTxO[];
  adminUtxos: UTxO[];
  validatorRef: UTxO;
};

type CommitFundsParams = {
  adminAddress: string;
  userFundUtxos: UTxO[];
  validatorRefUtxo: UTxO;
};

export {
  CommitFundsParams,
  DepositParams,
  MergeFundsParams,
  PayMerchantParams,
  WithdrawParams,
};
