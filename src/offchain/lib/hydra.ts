import Websocket from 'ws';
import axios from 'axios';
import {
  Assets,
  CBORHex,
  CML,
  fromUnit,
  LucidEvolution,
  UTxO,
} from '@lucid-evolution/lucid';
import blake2b from 'blake2b';
import { env } from '../../config';
import { logger } from '../../shared/logger';
import { waitForTag, MessageConn, HydraTerminalError } from './hydra-messages';

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
    const wsURL = new URL(url);
    wsURL.protocol = wsURL.protocol.replace('http', 'ws');

    this.lucid = lucid;
    this.lucid.selectWallet.fromSeed(env.SEED);
    this.url = wsURL;
    this.connection = new Websocket(wsURL + '?history=no');
    this.setupEventHandlers();
  }

  private async ensureConnectionReady(): Promise<void> {
    if (!this.isReady) {
      await new Promise((resolve) => (this.connection.onopen = resolve));
    }
  }

  /**
   * The ws connection viewed as a MessageConn for waitForTag. A cast is needed
   * because ws.WebSocket.onmessage is typed against the full MessageEvent, which
   * is not structurally assignable to MessageConn's minimal { data } shape.
   */
  private get msgConn(): MessageConn {
    return this.connection as unknown as MessageConn;
  }

  private setupEventHandlers() {
    this.connection.onopen = () => {
      logger.debug('WebSocket connection opened.');
      this.isReady = true;
    };

    this.connection.onerror = () => {
      logger.error('Error on Hydra websocket');
    };

    this.connection.onclose = () => {
      logger.debug('WebSocket connection closed.');
      this.isReady = false;
    };
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

  /** Sends Init; the head opens directly (empty). Resolves with the HeadIsOpen output. */
  async init(): Promise<any> { // eslint-disable-line @typescript-eslint/no-explicit-any
    await this.ensureConnectionReady();
    logger.debug('Sending Init; awaiting HeadIsOpen...');
    this.connection.send(JSON.stringify({ tag: 'Init' }));
    try {
      return await waitForTag(this.msgConn, 'HeadIsOpen', {
        timeout: 120_000,
        terminalTags: ['CommandFailed', 'PostTxOnChainFailed'],
      });
    } catch (err) {
      // Init on an already-open head returns CommandFailed; treat it as a no-op.
      if (err instanceof HydraTerminalError && err.tag === 'CommandFailed') {
        logger.info(
          'Init returned CommandFailed (head already open) — treating as no-op'
        );
        return err.payload;
      }
      throw err;
    }
  }

  /**
   * Draft a deposit/commit tx via POST {apiUrl} (/commit), sign + submit it to L1,
   * then await CommitFinalized for that deposit. Returns the deposit txId.
   */
  async commit(
    apiUrl: string,
    utxos: UTxO[],
    blueprint?: CBORHex
  ): Promise<string> {
    let depositTxId: string | undefined;
    try {
      const formatUtxos = (us: UTxO[]) =>
        us.reduce(
          (acc, u) => {
            acc[`${u.txHash}#${u.outputIndex}`] = lucidUtxoToHydraUtxo(u);
            return acc;
          },
          {} as Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
        );

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let payload: { blueprintTx?: any; utxo?: any } = {};
      if (utxos.length > 0) {
        if (blueprint) {
          payload['blueprintTx'] = { cborHex: blueprint, description: '', type: 'Tx ConwayEra' };
          payload['utxo'] = formatUtxos(utxos);
        } else {
          payload = formatUtxos(utxos);
        }
      }

      logger.debug(`Sending commit request to ${apiUrl} with ${utxos.length} UTxOs`);
      const response = await axios.post(apiUrl, payload);
      const draft = response.data.cborHex;
      this.lucid.selectWallet.fromSeed(env.SEED);
      const signedTx = await this.lucid
        .fromTx(draft)
        .sign.withWallet()
        .complete()
        .then((tx) => setRedeemersAsMap(tx.toCBOR()));
      depositTxId = await this.lucid.wallet().submitTx(signedTx);
      logger.info(`Deposit tx submitted to L1: ${depositTxId}; awaiting CommitFinalized...`);

      await waitForTag(this.msgConn, 'CommitFinalized', {
        timeout: 1_300_000, // > deposit-period (1200s) so the deadline can pass
        match: (m) => m.depositTxId === depositTxId,
        terminalTags: ['DepositExpired'],
        onMessage: (m) => {
          if (['CommitRecorded', 'CommitApproved'].includes(m.tag)) {
            logger.debug(`Commit progress: ${m.tag}`);
          }
        },
      });
      return depositTxId;
    } catch (error) {
      // On deposit-deadline expiry, best-effort recover the deposited UTxO on L1
      // (DELETE /commits/{txid}) so funds aren't stuck in the Hydra deposit.
      // NOTE: the DepositExpired->our-deposit correlation must be validated in E2E.
      if (
        error instanceof HydraTerminalError &&
        error.tag === 'DepositExpired' &&
        depositTxId
      ) {
        logger.error(
          `Deposit ${depositTxId} expired before finalization; attempting recover...`
        );
        try {
          await this.recover(`${env.ADMIN_NODE_API_URL}/commits`, depositTxId);
          logger.info(`Recovered expired deposit ${depositTxId} on L1`);
        } catch (recErr) {
          logger.error(
            `Recover of ${depositTxId} failed: ${recErr instanceof Error ? recErr.message : String(recErr)}`
          );
        }
      }
      if (axios.isAxiosError(error)) {
        const responseData = error.response?.data;
        const statusCode = error.response?.status;
        const errorDetails = responseData
          ? JSON.stringify(responseData, null, 2)
          : error.message;
        logger.error(`Hydra commit request failed with status ${statusCode}: ${errorDetails}`);
      } else {
        logger.error(
          `There was an error sending the commit transaction: ${error instanceof Error ? error.message : String(error)}`
        );
      }
      throw error;
    }
  }

  /** Recover an un-finalized deposit (DELETE {apiUrl}/{depositTxId}); awaits CommitRecovered. */
  async recover(apiUrl: string, depositTxId: string): Promise<void> {
    await axios.delete(`${apiUrl}/${depositTxId}`);
    await waitForTag(this.msgConn, 'CommitRecovered', { timeout: 120_000 });
  }

  /**
   * Sends a raw transaction to the Hydra node.
   * @param tx - The CBOR-encoded transaction to send.
   * @returns  the tag "TxValid" when the transaction is valid and "SnapshotConfirmed" when the snapshot is confirmed.
   */
  async sendTx(tx: CBORHex): Promise<string> {
    await this.ensureConnectionReady();
    logger.debug('Sending transaction...');
    this.connection.send(
      JSON.stringify({
        tag: 'NewTx',
        transaction: { cborHex: tx, description: '', type: 'Tx ConwayEra' },
      })
    );
    // waitForTag resolves with the full message object; callers expect the tag string.
    const data = await waitForTag(this.msgConn, 'TxValid', {
      terminalTags: ['TxInvalid'],
    });
    return data.tag;
  }

  /**
   * Retrieves the UTxO snapshot from the Hydra node.
   * @returns  an array of UTxOs from the snapshot.
   */
  async getSnapshot(): Promise<UTxO[]> {
    const apiURL = `${this.url.origin.replace('ws', 'http')}/snapshot/utxo`;
    try {
      const response = await axios.get(apiURL);
      const hydraUtxos = Object.entries(response.data);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const lucidUtxos = hydraUtxos.map((utxo: any) => {
        const [hash, idx] = utxo[0].split('#');
        const output = utxo[1];
        return hydraUtxoToLucidUtxo(hash, idx, output);
      });
      return lucidUtxos;
    } catch (error) {
      logger.debug(error as unknown as string);
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
        description: '',
        type: 'Tx ConwayEra',
      };
      const response = await axios.post(apiUrl, payload);
      return response.data;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        logger.error(
          `Hydra /decommit rejected (status ${error.response?.status}): ${JSON.stringify(error.response?.data)}`
        );
      } else {
        logger.error(
          `Hydra /decommit error: ${error instanceof Error ? error.message : String(error)}`
        );
      }
      throw error;
    }
  }

  /**
   * Sends a "Close" message to the Hydra node to close the current head.
   * @returns  the tag "HeadIsClosed" once the head is closed successfully.
   */
  async close(): Promise<string> {
    await this.ensureConnectionReady();
    this.connection.send(JSON.stringify({ tag: 'Close' }));
    const data = await waitForTag(this.msgConn, 'HeadIsClosed', { timeout: 60_000 });
    return data.tag;
  }

  /**
   * Sends a "Fanout" message to the Hydra node to finalize the current head.
   * @returns  the tag "HeadIsFinalized" once the head is finalized.
   */
  async fanout(): Promise<string> {
    await this.ensureConnectionReady();
    this.connection.send(JSON.stringify({ tag: 'Fanout' }));
    const data = await waitForTag(this.msgConn, 'HeadIsFinalized', { timeout: 120_000 });
    return data.tag;
  }

  /** Await the terminal of a decommit started via decommit(). */
  async awaitDecommit(): Promise<void> {
    await waitForTag(this.msgConn, 'DecommitFinalized', {
      timeout: 120_000,
      terminalTags: ['DecommitInvalid'],
    });
  }

  /** Await ReadyToFanout after a Close. ReadyToFanout only fires once the
   *  contestation deadline passes, so the timeout must exceed the contestation
   *  period (currently 120s) with margin. */
  async awaitReadyToFanout(): Promise<void> {
    await waitForTag(this.msgConn, 'ReadyToFanout', { timeout: 660_000 });
  }
}

type HydraUtxo = {
  address: string;
  datum: string | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
  const datum = null;
  let inlineDatum = null;
  let inlineDatumhash = null;
  let referenceScript = null;

  for (const [unit, amount] of Object.entries(utxo.assets)) {
    if (unit === 'lovelace') {
      value['lovelace'] = Number(amount);
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
      .update(Buffer.from(utxo.datum, 'hex'))
      .digest('hex');
  }
  if (utxo.scriptRef) {
    let refinedScriptType;
    /**
     * Lucid ScriptType = Native | PlutusV1 | PlutusV2 | PlutusV3
     * Hydra ScriptType = PlutusScriptV3 | ...
     */
    if (utxo.scriptRef.type.includes('Plutus')) {
      refinedScriptType = utxo.scriptRef.type.replace('Plutus', 'PlutusScript');
    } else {
      refinedScriptType = utxo.scriptRef.type;
    }
    referenceScript = {
      script: {
        cborHex: utxo.scriptRef.script,
        description: '',
        type: refinedScriptType,
      },
      scriptLanguage: `PlutusScriptLanguage ${refinedScriptType}`,
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function hydraUtxoToLucidUtxo(hash: string, idx: number, output: any): UTxO {
  const datumBytes = output.inlineDatum ? output.inlineDatumRaw : null;
  const assets: Assets = {};
  for (const [policy, value] of Object.entries(output.value)) {
    if (policy === 'lovelace') {
      assets[policy] = BigInt(value as number);
    } else {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
 * If no redeemers exist (e.g., incremental commits), returns the original transaction.
 * @param tx Transaction CBOR
 * @returns {CBORHex} Transaction CBOR with redeemers as a map, or original if no redeemers
 */
function setRedeemersAsMap(tx: CBORHex): CBORHex {
  const cmlTx = CML.Transaction.from_cbor_hex(tx);
  const body = cmlTx.body();
  const auxData = cmlTx.auxiliary_data();
  const witnessSet = cmlTx.witness_set();

  const redeemersList = witnessSet.redeemers()?.as_arr_legacy_redeemer();
  // If no redeemers, return original transaction (common for incremental commits)
  if (!redeemersList) {
    logger.debug('No redeemers found in transaction, returning original CBOR');
    return tx;
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
