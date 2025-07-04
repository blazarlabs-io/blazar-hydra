import { Assets, UTxO } from '@lucid-evolution/lucid';

/**
 * Tx Builders params
 */

type DepositParams = {
  userAddress: string;
  publicKey: string;
  amountsToDeposit: Assets;
  walletUtxos: UTxO[];
  validatorRef: UTxO;
  fundsUtxo?: UTxO;
};

type Withdraw = {
  fundUtxo: UTxO;
  signature?: string;
};
type WithdrawParams = {
  kind: 'user' | 'merchant';
  withdraws: Withdraw[];
  address?: string;
  adminKey?: string;
  hydraKey?: string;
  validatorRef?: UTxO;
  walletUtxos?: UTxO[];
};

type PayMerchantParams = {
  adminCollateral: UTxO;
  merchantAddress: string;
  assets: Assets;
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
