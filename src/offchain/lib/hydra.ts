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


const ERROR_TAGS = [
  "PeerHandshakeFailure",
  "TxInvalid",
  "InvalidInput",
  "PostTxOnChainFailed",
  "CommandFailed",
  "DecommitInvalid",
]


/**
 * Listen and send messages to a Hydra node.
 */
class HydraHandler {
  private connection: Websocket;
  private lucid: LucidEvolution;
  private url: URL;
  private isReady: boolean = false;

  /**
   * @constructor
   * @param lucid - An instance of LucidEvolution used to interact with the blockchain.
   * @param url - The URL of the Hydra node WebSocket server.
   * Initializes the HydraHandler class and sets up the WebSocket connection.
   */
  constructor(lucid: LucidEvolution, url: string) {
    let wsURL = new URL(url);
    wsURL.protocol = wsURL.protocol.replace("http", "ws");

    this.lucid = lucid;
    this.url = wsURL;
    this.connection = new Websocket(wsURL + "?history=no");
    this.setupEventHandlers();
  }

  private async ensureConnectionReady(): Promise<void> {
    if (!this.isReady) {
      await new Promise((resolve) => (this.connection.onopen = resolve));
    }
  }

  private setupEventHandlers() {
    this.connection.onopen = () => {
      logger.info("WebSocket connection opened.");
      this.isReady = true;
    };

    this.connection.onerror = (error) => {
      logger.error("Error on Hydra websocket: ", error);
    };

    this.connection.onclose = () => {
      logger.info("WebSocket connection closed.");
      this.isReady = false;
    };
  }

  private waitForMessage(tag: string, timeout = 10000): Promise<any> {
    return new Promise((resolve, _) => {
      const timeoutId = setTimeout(() => {
        resolve(`Timeout waiting for tag: ${tag}`);
      }, timeout);

      this.connection.onmessage = (msg: Websocket.MessageEvent) => {
        const data = JSON.parse(msg.data.toString());
        if (data.tag === tag) {
          logger.info(`Received ${tag}`);
          clearTimeout(timeoutId);
          resolve(data);
        } else if (ERROR_TAGS.includes(data.tag)) {
          logger.error(`Received ${data.tag}`);
        } else {
          logger.info(`Received ${data.tag} while waiting for ${tag}`);
        }
      };
    });
  }

  /**
   * Listens for a specific tag from the Hydra node's WebSocket.
   *
   * @param tag - The tag to listen for in incoming messages.
   * @returns  the tag when it is received from the Hydra node.
   */
  public async listen(tag: string): Promise<string> {
    return new Promise((resolve, _) => {
      this.connection.onopen = () => {
        logger.info(`Awaiting for ${tag} events...`);
      };
      this.connection.onmessage = async (msg: Websocket.MessageEvent) => {
        const data = JSON.parse(msg.data.toString());
        if (ERROR_TAGS.includes(data.tag)) {
          logger.error(`Received: ${data.tag}`);
          resolve(data.tag);
        }
        logger.info(`Received: ${data.tag}`);
        resolve(data.tag);
      };
      this.connection.onerror = (error) => {
        logger.error("Error on Hydra websocket: ", error);
      };
    });
  }

  /**
   * Closes the WebSocket connection to the Hydra node.
   * @returns A promise that resolves when the connection is closed.
   */
  public async stop(): Promise<void> {
    return new Promise((resolve) => {
      this.connection.close();
      resolve();
    });
  }

  /**
   * Sends an "Init" message to the Hydra node to start a new head.
   * @returns  the tag "HeadIsInitializing" once the head is initialized.
   */
  async init(): Promise<string> {
    await this.ensureConnectionReady();
    logger.info("Sending init command...");
    this.connection.send(JSON.stringify({ tag: "Init" }));
    return new Promise((resolve, _) => {
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
    });
  }

  /**
   * Sends an "Abort" message to the Hydra node to abort the initialization of a Hydra head.
   * @returns  the tag "HeadIsAborted" if the head was aborted successfully.
   */
  async abort(): Promise<void> {
    await this.ensureConnectionReady();
    logger.info("Aborting head opening...");
    this.connection.send(JSON.stringify({ tag: "Abort" }));
    return new Promise((resolve, _) => {
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
    }).then(() => this.stop());
  }

  /**
   * Sends a commit transaction to the Hydra node.
   * @param apiUrl - The URL of the Hydra API endpoint.
   * @param blueprint - The CBOR-encoded transaction blueprint.
   * @param utxos - An array of the UTxOs to commit.
   * @returns  the transaction hash once the commit is successful.
   */
  async sendCommit(
    apiUrl: string,
    blueprint: CBORHex,
    utxos: UTxO[]
  ): Promise<string> {
    try {
      const payloadUtxos = utxos.reduce((acc, utxo) => {
        acc[`${utxo.txHash}#${utxo.outputIndex}`] = lucidUtxoToHydraUtxo(utxo);
        return acc;
      }, {} as Record<string, any>);

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
      const signedTx = await this.lucid
        .fromTx(txWitnessed)
        .sign.withWallet()
        .complete()
        .then((tx) => setRedeemersAsMap(tx.toCBOR()));
      const txHash = await this.lucid.wallet().submitTx(signedTx);
      return txHash;
    } catch (error) {
      logger.error(error as unknown as string);
      throw error;
    }
  }

  /**
   * Sends a raw transaction to the Hydra node.
   * @param tx - The CBOR-encoded transaction to send.
   * @returns  the tag "TxValid" when the transaction is valid and "SnapshotConfirmed" when the snapshot is confirmed.
   */
  async sendTx(tx: CBORHex): Promise<string> {
    await this.ensureConnectionReady();
    logger.info("Sending transaction...");
    this.connection.send(
      JSON.stringify({
        tag: "NewTx",
        transaction: { cborHex: tx, description: "", type: "Tx BabbageEra" },
      })
    );
    return new Promise((resolve, _) => {
      this.connection.onmessage = async (msg: Websocket.MessageEvent) => {
        const data = JSON.parse(msg.data.toString());
        switch (data.tag) {
          case "Greetings":
            break;
          case "TxValid":
            logger.info("Received TxValid");
            resolve(data.tag);
            break;
          case "SnapshotConfirmed":
            logger.info("Received SnapshotConfirmed");
            resolve(data.tag);
            break;
          default:
            logger.error("Unexpected message recibed upon SendTx: ", data.tag);
            resolve(data.tag);
            break;
        }
      };
    });
  }

  /**
   * Retrieves the UTxO snapshot from the Hydra node.
   * @returns  an array of UTxOs from the snapshot.
   */
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
      return lucidUtxos;
    } catch (error) {
      logger.info(error as unknown as string);
      throw error;
    }
  }

  /**
   * Sends a decommit transaction to the Hydra node.
   * @param apiUrl - The URL of the Hydra API endpoint.
   * @param tx - The CBOR-encoded transaction to send for decommitment.
   * @returns  the response data from the Hydra node.
   */
  async decommit(apiUrl: string, tx: CBORHex): Promise<string> {
    try {
      const payload = {
        cborHex: tx,
        description: "",
        type: "Tx BabbageEra",
      };
      const response = await axios.post(apiUrl, payload);
      return response.data;
    } catch (error) {
      logger.error(error as unknown as string);
      throw error;
    }
  }

  /**
   * Sends a "Close" message to the Hydra node to close the current head.
   * @returns  the tag "HeadIsClosed" once the head is closed successfully.
   */
  async close(): Promise<string> {
    await this.ensureConnectionReady();
    logger.info("Closing head...");
    this.connection.send(JSON.stringify({ tag: "Close" }));
    const data = await this.waitForMessage("HeadIsClosed", 30_000);
    return data.tag;
  }

  /**
   * Sends a "Fanout" message to the Hydra node to finalize the current head.
   * @returns  the tag "HeadIsFinalized" once the head is finalized.
   */
  async fanout(): Promise<void> {
    await this.ensureConnectionReady();
    logger.info("Sending fanout command...");
    this.connection.send(JSON.stringify({ tag: "Fanout" }));
    await this.waitForMessage("HeadIsFinalized");
    await this.stop();
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
