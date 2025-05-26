import {
  Data,
  LucidEvolution,
  UTxO,
  validatorToAddress,
} from "@lucid-evolution/lucid";
import { QueryFundsResponse } from "../../api/schemas/response";
import { HydraHandler } from "../lib/hydra";
import _ from "lodash";
import { env } from "../../config";
import {
  dataAddressToBech32,
  getNetworkFromLucid,
  getValidator,
} from "../lib/utils";
import { FundsDatum, FundsDatumT } from "../lib/types";
import { logger } from "../../logger";

async function handleQueryFunds(
  lucid: LucidEvolution,
  address: string,
): Promise<QueryFundsResponse> {
  let fundsInL1: UTxO[] = [],
    fundsInL2: UTxO[] = [];
  const localLucid = _.cloneDeep(lucid);
  const network = getNetworkFromLucid(localLucid);
  const [vRef] = await lucid.utxosByOutRef([
    { txHash: env.VALIDATOR_REF, outputIndex: 0 },
  ]);
  const validator = getValidator(vRef);
  const validatorAddr = validatorToAddress(network, validator);
  const isOwnUtxo = (utxo: UTxO, addr: string) => {
    if (!utxo.datum) {
      return false;
    }
    if (utxo.address !== validatorAddr) {
      return false;
    }
    try {
      const datum = Data.from<FundsDatumT>(utxo.datum, FundsDatum);
      return dataAddressToBech32(localLucid, datum.addr) === addr;
    } catch (error) {
      logger.warning(
        `Utxo at validator address with unknown datum: ${utxo.txHash}#${utxo.outputIndex}`,
      );
      return false;
    }
  };
  try {
    fundsInL1 = await localLucid
      .utxosAt(validatorAddr)
      .then((utxos) => utxos.filter((utxo) => isOwnUtxo(utxo, address)));
  } catch (error) {
    logger.error(`Error querying funds in L1: ${error}`);
    throw new Error(`Error querying funds in L1: ${error}`);
  }
  try {
    const hydra = new HydraHandler(localLucid, env.ADMIN_NODE_WS_URL);
    fundsInL2 = await hydra
      .getSnapshot()
      .then((utxos) => utxos.filter((utxo) => isOwnUtxo(utxo, address)));
    await hydra.stop();
  } catch (error: any) {
    if (JSON.stringify(error).includes("ECONNREFUSED")) {
      logger.error(`Not connected to websocket`);
    } else {
      logger.error(`Error querying funds in L2: ${error}`);
    }
  }
  const getTotalLvc = (acc: bigint, utxo: UTxO) =>
    acc + utxo.assets["lovelace"];
  const totalInL1 = fundsInL1.reduce(getTotalLvc, 0n);
  const totalInL2 = fundsInL2.reduce(getTotalLvc, 0n);
  const funds: QueryFundsResponse = {
    fundsInL1,
    totalInL1,
    fundsInL2,
    totalInL2,
  };
  return funds;
}

export { handleQueryFunds };
