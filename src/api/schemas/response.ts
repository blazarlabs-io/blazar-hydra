import { OutRef } from "@lucid-evolution/lucid";

type QueryFundsResponse = {
  adaInL1: bigint;
  adaInL2: bigint;
};

type TxBuiltResponse = {
  cborHex: string;
  fundsUtxoRef: OutRef | null;
}

export {  TxBuiltResponse, QueryFundsResponse };