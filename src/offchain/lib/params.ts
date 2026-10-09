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
  /** Consumed and used to name the validation token instead of walletUtxos[0] (bridged BTC UTxO). */
  seedUtxo?: UTxO;
  /** Also lock the deposited lovelace in locked_deposit, so only the tokens are payable. */
  lockDeposited?: boolean;
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

type IncrementalCommitParams = {
  userAddress: string;
  publicKey: string;
  amountsToCommit: Assets;
  walletUtxos: UTxO[];
  validatorRef: UTxO;
  fundsUtxo?: UTxO;
};

type IncrementalDecommitParams = {
  address: string;
  owner: 'user' | 'merchant';
  fundUtxo: UTxO;
  signature?: string;
  adminKey?: string;
  hydraKey?: string;
  walletUtxos?: UTxO[];
};

export {
  DepositParams,
  MergeFundsParams,
  PayMerchantParams,
  WithdrawParams,
  IncrementalCommitParams,
  IncrementalDecommitParams,
};
