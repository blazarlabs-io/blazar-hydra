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
  kind: "user" | "merchant";
  fundsUtxos: UTxO[];
  address?: string;
  signature?: string;
  adminKey?: string;
  hydraKey?: string;
  validatorRef?: UTxO;
  walletUtxos?: UTxO[];
};

type PayMerchantParams = {
  adminCollateral: UTxO;
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
  adminCollateral?: UTxO;
};

export {
  CommitFundsParams,
  DepositParams,
  MergeFundsParams,
  PayMerchantParams,
  WithdrawParams,
};
