import { Layer, WithdrawSchema } from "../../shared";
import { withdraw } from "../tx-builders/withdraw";
import { LucidEvolution, selectUTxOs } from "@lucid-evolution/lucid";
import { WithdrawParams } from "../lib/params";
import { TxBuiltResponse } from "../../api/schemas/response";
import _ from "lodash";
import { env } from "../../config";
import { logger } from "../../logger";

async function handleWithdraw(
  lucid: LucidEvolution,
  params: WithdrawSchema
): Promise<TxBuiltResponse> {
  try {
    const localLucid = _.cloneDeep(lucid);
    const {
      address,
      owner,
      funds_utxo_ref: fundsUtxoRef,
      signature,
      network_layer,
    } = params;

    // Lookup funds and validator UTxOs
    const { hash: txHash, index: outputIndex } = fundsUtxoRef;
    const [fundsUtxo] = await localLucid.utxosByOutRef([
      { txHash, outputIndex },
    ]);
    if (!fundsUtxo) {
      throw new Error(`Funds utxo not found in ${network_layer}`);
    }
    const [validatorRef] = await localLucid.utxosByOutRef([
      { txHash: env.VALIDATOR_REF, outputIndex: 0 },
    ]);

    // Prepare tx builder parameters
    let withdrawParams: WithdrawParams = {
      address,
      fundsUtxo,
      signature,
      validatorRef,
    };
    switch ([owner, network_layer]) {
      case ["merchant", Layer.L2]:
        break;

      case ["user", Layer.L1]:
        const walletUtxos = await localLucid
          .utxosAt(address)
          .then((utxos) => selectUTxOs(utxos, { lovelace: 10_000_000n }));
        withdrawParams = { ...withdrawParams, walletUtxos };
        break;

      default:
        throw new Error("Unsupported owner and network layer combination");
    }

    // Build and return the transaction
    const { tx, newFundsUtxo } = await withdraw(localLucid, withdrawParams);
    return { cborHex: tx.toCBOR(), fundsUtxoRef: newFundsUtxo };
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
