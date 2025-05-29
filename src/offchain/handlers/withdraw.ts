import { Layer, WithdrawSchema } from "../../shared";
import { withdraw } from "../tx-builders/withdraw-user";
import { CBORHex, LucidEvolution, selectUTxOs } from "@lucid-evolution/lucid";
import { WithdrawParams } from "../lib/params";
import _ from "lodash";
import { env } from "../../config";
import { logger } from "../../logger";
import { TxBuiltResponse } from "../../api/schemas/response";

async function handleWithdraw(
  lucid: LucidEvolution,
  params: WithdrawSchema,
): Promise<TxBuiltResponse> {
  try {
    // TODO here lucid needs instantiation with the correct network
    const localLucid = _.cloneDeep(lucid);
    const {
      address,
      owner,
      funds_utxos_ref: fundsUtxosRef,
      signature,
      network_layer,
    } = params;
    const {
      ADMIN_KEY: adminKey,
      HYDRA_KEY: hydraKey,
      VALIDATOR_REF: vRef,
    } = env;

    // Lookup funds and validator UTxOs
    const fundsRefs = fundsUtxosRef.map(({ hash, index }) => ({
      txHash: hash,
      outputIndex: index,
    }));
    const fundsUtxos = await localLucid.utxosByOutRef(fundsRefs);
    if (fundsUtxos.length === 0) {
      throw new Error(`Funds utxos not found in ${network_layer}`);
    }
    const [validatorRef] = await localLucid.utxosByOutRef([
      { txHash: vRef, outputIndex: 0 },
    ]);

    // Prepare tx builder parameters
    let withdrawParams: WithdrawParams = {
      address,
      kind: owner,
      fundsUtxos,
      signature,
    };
    switch (owner) {
      case "merchant":
        if (network_layer === Layer.L1) {
          throw new Error("Merchant cannot withdraw from L1");
        }
        withdrawParams = { ...withdrawParams, adminKey, hydraKey };
        break;

      case "user":
        if (network_layer === Layer.L2) {
          throw new Error("User cannot withdraw from L2");
        }
        const walletUtxos = await localLucid
          .utxosAt(address)
          .then((utxos) => selectUTxOs(utxos, { lovelace: 10_000_000n }));
        withdrawParams = { ...withdrawParams, validatorRef, walletUtxos };
        break;

      default:
        throw new Error("Unsupported owner and network layer combination");
    }

    // Build and return the transaction
    const { tx } = await withdraw(localLucid, withdrawParams);
    return { cborHex: tx.toCBOR(), fundsUtxoRef: null };
  } catch (e) {
    if (e instanceof Error) {
      logger.error("500 /withdraw - " + e.message);
    } else if (typeof e === "string" && e.includes("InputsExhaustedError")) {
      logger.error("400 /withdraw - " + e);
    } else {
      logger.error("520 /withdraw - Unknown error type");
      logger.error(JSON.stringify(e));
    }
    throw e;
  }
}

export { handleWithdraw };
