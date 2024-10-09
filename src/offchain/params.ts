import { UTxO } from "@lucid-evolution/lucid";

/**
 * Tx Builders params
 */
type DepositParams = {
  userAddress: string;
  amountToDeposit: bigint;
  fundsUtxo?: UTxO;
};

type WithdrawParams = {
  address: string;
  amountToWithdraw: bigint;
  fundsUtxo: UTxO;
  signature: string;
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
