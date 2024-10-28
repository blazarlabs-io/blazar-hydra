import {
  Blockfrost,
  Lucid,
  LucidEvolution,
  Network,
  OutRef,
  toHex,
} from "@lucid-evolution/lucid";
import { env } from "../../config";
import { handleDeposit } from "../handlers/deposit";
import { commitFunds } from "../tx-builders/commit-funds";
import { getPrivateKey, waitForUtxosUpdate } from "../lib/utils";
import { HydraHandler, lucidUtxoToHydraUtxo } from "../lib/hydra";
import { logger } from "../../logger";

const adminSeed = env.SEED;
const lucid = (await Lucid(
  new Blockfrost(env.PROVIDER_URL, env.PROVIDER_PROJECT_ID),
  env.NETWORK as Network
)) as LucidEvolution;
lucid.selectWallet.fromSeed(adminSeed);
const aliceWsUrl = "ws://127.0.0.1:4001";

const openHead = async () => {
  const hydra = new HydraHandler(lucid, aliceWsUrl);
  const initTag = await hydra.init();
  if (initTag !== "HeadIsInitializing") {
    throw new Error("Something went wrong when initializing the hydra head");
  }

  const adminAddress = await lucid.wallet().address();
  const publicKey = toHex(getPrivateKey(adminSeed).to_public().to_raw_bytes());
  let funds: OutRef[] = [];
  for (let i = 0; i < 2; i++) {
    console.log(`Creating a funds utxo with 10 ADA`);
    const depTx = await handleDeposit(lucid, {
      user_address: adminAddress,
      public_key: publicKey,
      amount: 10_000_000n,
    });
    const signedTx = await lucid
      .fromTx(depTx.cborHex)
      .sign.withWallet()
      .complete();
    const txHash = await signedTx.submit();
    console.log(`Submitted deposit tx with hash: ${txHash}`);
    funds.push(depTx.fundsUtxoRef!);
    await waitForUtxosUpdate(lucid, txHash);
  }
  const userFundUtxos = await lucid.utxosByOutRef(
    funds.map((outref) => ({ txHash: outref.txHash, outputIndex: 0 }))
  );

  const [validatorRef] = await lucid.utxosByOutRef([
    { txHash: env.VALIDATOR_REF, outputIndex: 0 },
  ]);

  const commitTxAlice = await commitFunds(lucid, {
    adminAddress: adminAddress,
    userFundUtxos: [userFundUtxos[0]],
    validatorRefUtxo: validatorRef,
  });

  const commitTxBob = await commitFunds(lucid, {
    adminAddress: adminAddress,
    userFundUtxos: [userFundUtxos[1]],
    validatorRefUtxo: validatorRef,
  });

  /// Connect to hydra node
  const aliceApiUrl = "http://127.0.0.1:4001/commit";
  const bobApiUrl = "http://127.0.0.1:4002/commit";

  //  Send commits to hydra node
  const utxos1: [string, any][] = [
    [
      userFundUtxos[0].txHash + "#" + userFundUtxos[0].outputIndex,
      lucidUtxoToHydraUtxo(userFundUtxos[0]),
    ],
  ];
  const aliceCommitTxId = await hydra.sendCommit({
    apiUrl: aliceApiUrl,
    blueprint: commitTxAlice.tx.toCBOR(),
    utxos: utxos1,
  });
  console.log(`Alice commit transaction submitted! tx id: ${aliceCommitTxId}`);
  let aliceCommitTag = "";
  console.info("Waiting for Alice commit to be confirmed by the hydra node");
  while (aliceCommitTag !== "Committed") {
    aliceCommitTag = await hydra.listen("Committed");
  }

  const utxos2: [string, any][] = [
    [
      userFundUtxos[1].txHash + "#" + userFundUtxos[1].outputIndex,
      lucidUtxoToHydraUtxo(userFundUtxos[1]),
    ],
  ];
  const bobCommitTxId = await hydra.sendCommit({
    apiUrl: bobApiUrl,
    blueprint: commitTxBob.tx.toCBOR(),
    utxos: utxos2,
  });
  console.log(`Bob commit transaction submitted! tx id: ${bobCommitTxId}`);
  let bobCommitTag = "";
  console.info("Waiting for Bob commit to be confirmed by the hydra node");
  while (bobCommitTag !== "Committed") {
    bobCommitTag = await hydra.listen("Committed");
  }

  let openHeadTag = "";
  while (openHeadTag !== "HeadIsOpen") {
    console.log("Head not opened yet");
    openHeadTag = await hydra.listen("HeadIsOpen");
  }
};

const getSnapshot = async () => {
  const hydra = new HydraHandler(lucid, aliceWsUrl);
  await hydra.getSnapshot();
  hydra.stop();
};

const closeHead = async () => {
  async function repeatCloseUntilSuccess(
    hydra: HydraHandler,
    intervalMs: number = 30000
  ): Promise<string> {
    return new Promise((resolve, _) => {
      const attemptClose = async () => {
        try {
          const result = await hydra.close();
          if (result === "HeadIsClosed") {
            clearInterval(interval); // Stop further attempts when expected tag is received
            resolve(result);
          }
        } catch (error) {
          console.error("Error during close attempt,:", error);
          console.error("Retrying...");
        }
      };

      const interval = setInterval(attemptClose, intervalMs);
      attemptClose(); // Initial attempt immediately
    });
  }
  const hydra = new HydraHandler(lucid, aliceWsUrl);
  await repeatCloseUntilSuccess(hydra);
  let readyToFanoutTag = "";
  while (readyToFanoutTag !== "ReadyToFanout") {
    readyToFanoutTag = await hydra.listen("ReadyToFanout");
  }
  hydra.stop();
};

const fanout = async () => {
  const hydra = new HydraHandler(lucid, aliceWsUrl);
  await hydra.fanout();
  hydra.stop();
};

const abortHead = async () => {
  const hydra = new HydraHandler(lucid, aliceWsUrl);
  await hydra.abort();
  await hydra.listen("HeadIsAborted");
  hydra.stop();
};

const trace = process.env.npm_config_trace;
switch (trace) {
  case "open":
    await openHead();
    break;
  case "abort":
    await abortHead();
    break;
  case "snapshot":
    await getSnapshot();
    break;
  case "close":
    await closeHead();
    break;
  case "fanout":
    await fanout();
    break;
  default:
    console.log("Invalid or missing trace option");
    break;
}
