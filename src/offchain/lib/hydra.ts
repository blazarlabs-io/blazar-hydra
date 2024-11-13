import Websocket from "ws";
import axios from "axios";
import {
  Assets,
  CBORHex,
  CML,
  fromUnit,
  LucidEvolution,
  UTxO,
} from "@lucid-evolution/lucid";
import blake2b from "blake2b";
import { logger } from "../../logger";

/**
 * Listen and send messages to a Hydra node.
 */
class HydraHandler {
  connection: Websocket;
  lucid: LucidEvolution;
  url: URL;

  constructor(lucid: LucidEvolution, url: string) {
    let wsURL = new URL(url);
    wsURL.protocol = wsURL.protocol.replace("http", "ws");

    this.lucid = lucid;
    this.url = wsURL;
    this.connection = new Websocket(wsURL + "?history=no");
  }

  // listen for a message with a specific tag. TODO define tags from the hydra api
  public listen(tag: string): Promise<string> {
    return new Promise((resolve, _) => {
      this.connection.onopen = () => {
        logger.info(`Awaiting for ${tag} events...`);
      };
      this.connection.onmessage = async (msg: Websocket.MessageEvent) => {
        const data = JSON.parse(msg.data.toString());
        if (data.tag === tag) {
          logger.info(`Received ${tag}`);
        } else {
          logger.error(`Received: ${data.tag}`);
        }
        resolve(data.tag);
      };
      this.connection.onerror = (error) => {
        logger.error("Error on Hydra websocket: ", error);
      };
    });
  }

  public stop(): Promise<void> {
    return new Promise((resolve, _) => {
      this.connection.close();
      resolve();
    });
  }

  // Sends the Init tag to open a head
  async init(): Promise<string> {
    return new Promise((resolve, _) => {
      this.connection.onopen = () => {
        logger.info("Sending init command...");
        this.connection.send(JSON.stringify({ tag: "Init" }));
      };
      this.connection.onmessage = async (msg: Websocket.MessageEvent) => {
        const data = JSON.parse(msg.data.toString());
        switch (data.tag) {
          case "Greetings":
            break;
          case "HeadIsInitializing":
            logger.info("Received HeadIsInitializing");
            resolve(data.tag);
            break;
          default:
            logger.error("Unexpected message recibed upon Init: ", data.tag);
            resolve(data.tag);
            break;
        }
      };
      this.connection.onerror = (error) => {
        logger.error("Error on Hydra websocket: ", error);
      };
      this.connection.onclose = () => {
        logger.info("Hydra websocket closed");
      };
    });
  }

  // Sends the Abort tag to a had that is initializing
  async abort(): Promise<string> {
    return new Promise((resolve, _) => {
      this.connection.onopen = () => {
        logger.info("Aborting head opening...");
        this.connection.send(JSON.stringify({ tag: "Abort" }));
      };
      this.connection.onmessage = async (msg: Websocket.MessageEvent) => {
        const data = JSON.parse(msg.data.toString());
        switch (data.tag) {
          case "Greetings":
            break;
          case "HeadIsAborted":
            logger.info("Received HeadIsAborted");
            resolve(data.tag);
            break;
          default:
            logger.error("Unexpected message recibed upon Abort: ", data.tag);
            resolve(data.tag);
            break;
        }
      };
      this.connection.onerror = (error) => {
        logger.error("Error on Hydra websocket: ", error);
      };
      this.connection.onclose = () => {
        logger.info("Hydra websocket closed");
      };
    });
  }

  async sendCommit(
    apiUrl: string,
    blueprint: CBORHex,
    utxos: UTxO[]
  ): Promise<string> {
    try {
      const payloadUtxos: Record<string, any> = {};
      utxos.map((utxo) => {
        const key = utxo.txHash + "#" + utxo.outputIndex;
        const val = lucidUtxoToHydraUtxo(utxo);
        payloadUtxos[key] = val;
      });
      const payload = {
        blueprintTx: {
          cborHex: blueprint,
          description: "",
          type: "Tx BabbageEra",
        },
        utxo: payloadUtxos,
      };
      const response = await axios.post(apiUrl, payload);
      const txWitnessed = response.data.cborHex;
      let signedTx: any = await this.lucid
        .fromTx(txWitnessed)
        .sign.withWallet()
        .complete();
      signedTx = setRedeemersAsMap(signedTx.toCBOR());
      const txHash = await this.lucid.wallet().submitTx(signedTx);
      return txHash;
    } catch (error) {
      logger.error(error as unknown as string);
      throw error;
    }
  }

  async sendTx(tx: CBORHex): Promise<string> {
    logger.info("Inside Send...");
    return new Promise((resolve, _) => {
     const message = {
       tag: "NewTx",
       transaction: {
         cborHex: tx,
         description: "",
         type: "Tx BabbageEra",
      },
    };
    this.connection.onopen = () => {
      logger.info("Sending transaction...");
      this.connection.send(JSON.stringify(message));
    };
    this.connection.onerror = (error) => {
      logger.error("Error on Hydra websocket: ", error);
    };
    this.connection.onclose = () => {
      logger.info("Hydra websocket closed");
    };
  })
}

  async getSnapshot(): Promise<UTxO[]> {
    const apiURL = `${this.url.origin.replace("ws", "http")}/snapshot/utxo`;
    try {
      const response = await axios.get(apiURL);
      const hydraUtxos = Object.entries(response.data);
      const lucidUtxos = hydraUtxos.map((utxo: any) => {
        const [hash, idx] = utxo[0].split("#");
        const output = utxo[1];
        return hydraUtxoToLucidUtxo(hash, idx, output);
      });
      console.log(lucidUtxos);
      return lucidUtxos;
    } catch (error) {
      logger.info(error as unknown as string);
      throw error;
    }
  }

  async close(): Promise<string> {
    return new Promise((resolve, _) => {
      this.connection.onopen = () => {
        logger.info("Closing head...");
        this.connection.send(JSON.stringify({ tag: "Close" }));
      };
      this.connection.onmessage = async (msg: Websocket.MessageEvent) => {
        const data = JSON.parse(msg.data.toString());
        switch (data.tag) {
          case "Greetings":
            break;
          case "HeadIsClosed":
            logger.info("Received HeadIsClosed");
            resolve(data.tag);
            break;
          default:
            logger.error("Unexpected message recibed upon Close: ", data.tag);
            resolve(data.tag);
            break;
        }
      };
      this.connection.onerror = (error) => {
        logger.error("Error on Hydra websocket: ", error);
      };
      this.connection.onclose = () => {
        logger.info("Hydra websocket closed");
      };
    });
  }

  async fanout(): Promise<void> {
    return new Promise((resolve, _) => {
      this.connection.resume();
      this.connection.onopen = () => {
        logger.info("Sending fanout command...");
        this.connection.send(JSON.stringify({ tag: "Fanout" }));
      };
      this.connection.onmessage = async (msg: Websocket.MessageEvent) => {
        const data = JSON.parse(msg.data.toString());
        switch (data.tag) {
          case "Greetings":
            break;
          case "HeadIsFinalized":
            logger.info("Received HeadIsFinalized");
            resolve(data.tag);
            break;
          default:
            logger.error("Unexpected message recibed upon Close: ", data.tag);
            resolve(data.tag);
            break;
        }
      };
      this.connection.onerror = (error) => {
        logger.error("Error on Hydra websocket: ", error);
      };
      this.connection.onclose = () => {
        logger.info("Hydra websocket closed");
      };
    });
  }
}

type HydraUtxo = {
  address: string;
  datum: string | null;
  inlineDatum: any;
  inlineDatumhash: string | null;
  referenceScript: {
    script: { cborHex: string; description: string; type: string };
    scriptLanguage: string;
  } | null;
  value: Record<string, number | Record<string, number>>;
};
function lucidUtxoToHydraUtxo(utxo: UTxO): HydraUtxo {
  const address = utxo.address;
  const value: Record<string, number | Record<string, number>> = {};
  // Probably needs fix for datums which are not inlined
  let datum = null;
  let inlineDatum = null;
  let inlineDatumhash = null;
  let referenceScript = null;

  for (const [unit, amount] of Object.entries(utxo.assets)) {
    if (unit === "lovelace") {
      value["lovelace"] = Number(amount);
    } else {
      const fromU = fromUnit(unit);
      const currentValue =
        (value[fromU.policyId] as Record<string, number>) || {};
      currentValue[fromU.assetName!] = Number(amount);
      value[fromU.policyId] = currentValue;
    }
  }
  if (utxo.datum) {
    const plutusData = CML.PlutusData.from_cbor_hex(utxo.datum);
    inlineDatum = JSON.parse(
      CML.decode_plutus_datum_to_json_str(
        plutusData,
        CML.CardanoNodePlutusDatumSchema.DetailedSchema
      )
    );
    inlineDatumhash = blake2b(32)
      .update(Buffer.from(utxo.datum, "hex"))
      .digest("hex");
  }
  if (utxo.scriptRef) {
    referenceScript = {
      script: {
        cborHex: utxo.scriptRef.script,
        description: "",
        type: utxo.scriptRef.type,
      },
      scriptLanguage: `PlutusScriptLanguage ${utxo.scriptRef.type}`,
    };
  }
  return {
    address,
    value,
    datum,
    inlineDatum,
    inlineDatumhash,
    referenceScript,
  };
}

function hydraUtxoToLucidUtxo(hash: string, idx: number, output: any): UTxO {
  const datumBytes = output.inlineDatum ? output.inlineDatumRaw : null;
  const assets: Assets = {};
  for (const [policy, value] of Object.entries(output.value)) {
    if (policy === "lovelace") {
      assets[policy] = BigInt(value as number);
    } else {
      const namesAndAmounts: [string, number][] = Object.entries(value as any);
      for (const [assetName, amount] of namesAndAmounts) {
        const unit = `${policy}${assetName}`;
        assets[unit] = BigInt(amount as number);
      }
    }
  }
  return {
    txHash: hash,
    outputIndex: Number(idx),
    assets: assets,
    address: output.address,
    datum: datumBytes,
  };
}

/**
 * Converts the redeemers of a transaction witness set from a list to a map.
 * @param tx Transaction CBOR
 * @returns {CBORHex} Transaction CBOR with redeemers as a map
 */
function setRedeemersAsMap(tx: CBORHex): CBORHex {
  const cmlTx = CML.Transaction.from_cbor_hex(tx);
  const body = cmlTx.body();
  const auxData = cmlTx.auxiliary_data();
  const witnessSet = cmlTx.witness_set();

  const redeemersList = witnessSet.redeemers()?.as_arr_legacy_redeemer();
  if (!redeemersList) {
    throw new Error("Could not find redeemers list");
  }
  const redeemersMap = CML.MapRedeemerKeyToRedeemerVal.new(); //CML.Redeemers.map_redeemer_key_to_redeemer_val();
  for (let i = 0; i < redeemersList.len(); i++) {
    const redeemers = redeemersList.get(i) as CML.LegacyRedeemer;
    const key = CML.RedeemerKey.new(redeemers.tag(), redeemers.index());
    const value = CML.RedeemerVal.new(redeemers.data(), redeemers.ex_units());
    redeemersMap.insert(key, value);
  }
  const redeemers =
    CML.Redeemers.new_map_redeemer_key_to_redeemer_val(redeemersMap);
  witnessSet.set_redeemers(redeemers);

  const newTx = CML.Transaction.new(
    body,
    witnessSet,
    true,
    auxData
  ).to_cbor_hex();

  return newTx;
}

export { HydraHandler, lucidUtxoToHydraUtxo };
