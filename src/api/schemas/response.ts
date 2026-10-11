import { Assets, OutRef } from '@lucid-evolution/lucid';

type QueryFundsResponse = {
  fundsInL1: OutRef[];
  totalInL1: Assets;
  fundsInL2: OutRef[];
  totalInL2: Assets;
  // Per unit, base units as strings: max spendable from one L2 funds UTxO (lovelace minus locked_deposit).
  payableInL2: Record<string, string>;
};

type TxBuiltResponse = {
  cborHex: string;
  fundsUtxoRef: OutRef | null;
};

export { TxBuiltResponse, QueryFundsResponse };
