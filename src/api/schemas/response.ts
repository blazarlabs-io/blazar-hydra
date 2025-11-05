import { Assets, OutRef } from '@lucid-evolution/lucid';

type QueryFundsResponse = {
  fundsInL1: OutRef[];
  totalInL1: Assets;
  fundsInL2: OutRef[];
  totalInL2: Assets;
};

type TxBuiltResponse = {
  cborHex: string;
  fundsUtxoRef: OutRef | null;
};

export { TxBuiltResponse, QueryFundsResponse };
