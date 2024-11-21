import { OutRef } from "@lucid-evolution/lucid";

type QueryFundsResponse = {
  fundsInL1: OutRef[];
  totalInL1: bigint;
  fundsInL2: OutRef[];
  totalInL2: bigint;
};

type TxBuiltResponse = {
  cborHex: string;
  fundsUtxoRef: OutRef | null;
}

export {  TxBuiltResponse, QueryFundsResponse };