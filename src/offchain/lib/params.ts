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
  fundsUtxo: UTxO;
  signature: string;
  validatorRef: UTxO;
  walletUtxos?: UTxO[];
};

type PayMerchantParams = {
  userAddress: string;
  merchantAddress: string;
  amountToPay: bigint;
  fundsUtxo: UTxO;
  signature: string;
};

type MergeFundsParams = {
  adminAddress: string;
  userFundsUtxos: UTxO[];
};

type CommitFundsParams = {
  adminAddress: string;
  hydraInitUtxo: UTxO;
  userFundUtxos: UTxO[];
};

export {
  CommitFundsParams,
  DepositParams,
  MergeFundsParams,
  PayMerchantParams,
  WithdrawParams,
};
