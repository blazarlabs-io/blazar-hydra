import { DepositSchema } from "../../shared";
import { DepositParams } from "../lib/params";
import { deposit } from "../tx-builders/deposit";
import {
  CBORHex,
  LucidEvolution,
  selectUTxOs,
  UTxO,
} from "@lucid-evolution/lucid";
import { env } from "../../config";
import _ from "lodash";
import { logger } from "../../logger";

async function handleDeposit(
  lucid: LucidEvolution,
  params: DepositSchema
): Promise<CBORHex> {
  try {
    const {
      user_address: userAddress,
      amount: amountToDeposit,
      funds_utxo_ref: fundsUtxoRef,
    } = params;
    const localLucid = _.cloneDeep(lucid);
    let fundsUtxo: UTxO | undefined = undefined;
    if (fundsUtxoRef) {
      const { hash: txHash, index: outputIndex } = fundsUtxoRef;
      [fundsUtxo] = await localLucid.utxosByOutRef([{ txHash, outputIndex }]);
    }
    const walletUtxos = await localLucid
      .utxosAt(userAddress)
      .then((utxos) => selectUTxOs(utxos, { lovelace: amountToDeposit }));
    const [validatorRef] = await localLucid.utxosByOutRef([
      { txHash: env.VALIDATOR_REF, outputIndex: 0 },
    ]);
    const depositParams: DepositParams = {
      userAddress,
      amountToDeposit,
      walletUtxos,
      validatorRef,
      fundsUtxo,
    };
    const unsignedTx = await deposit(localLucid, depositParams);
    return unsignedTx.toCBOR();
  } catch (e) {
    if (e instanceof Error) {
      logger.error("500 /deposit - " + e.message);
    } else if (typeof e === "string" && e.includes("InputsExhaustedError")) {
      logger.error("400 /deposit - " + e);
    } else {
      logger.error("520 /deposit - Unknown error type");
      logger.error(JSON.stringify(e));
    }
    throw e;
  }
}

export { handleDeposit };
