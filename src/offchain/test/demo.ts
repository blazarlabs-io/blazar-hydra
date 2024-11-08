import {
  Blockfrost,
  Data,
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
import { HydraHandler } from "../lib/hydra";
import { Layer, WithdrawSchema } from "../../shared";
import { handleWithdraw } from "../handlers/withdraw";
import blake2b from "blake2b";
import { handleOpenHead } from "../handlers/open-head";
import { logger } from "../../logger";

const adminSeed = env.SEED;
const privKey = getPrivateKey(adminSeed);
const lucid = (await Lucid(
  new Blockfrost(env.PROVIDER_URL, env.PROVIDER_PROJECT_ID),
  env.NETWORK as Network
)) as LucidEvolution;
lucid.selectWallet.fromSeed(adminSeed);
const aliceWsUrl = "ws://127.0.0.1:4001";


const aliceApiUrl = "http://127.0.0.1:4001/commit";
const bobApiUrl = "http://127.0.0.1:4002/commit";

logger.configureLogger(
  {
    level: "debug", //env.LOGGER_LEVEL,
    prettyPrint: true, //env.PRETTY_PRINT,
  },
  false
);

const openHead = async () => {
  lucid.selectWallet.fromSeed(adminSeed);
  await handleOpenHead(lucid, {
    auth_token: "",
    peer_api_urls: [aliceApiUrl, bobApiUrl],
  });
};

const deposit = async (fromWallet: 1 | 2) => {
  const thisSeed = fromWallet === 1 ? env.SEED : env.USER_SEED;
  lucid.selectWallet.fromSeed(thisSeed);
  const address = await lucid.wallet().address();
  const privKey = getPrivateKey(thisSeed);
  const publicKey = toHex(privKey.to_public().to_raw_bytes());
  let funds: OutRef[] = [];
  for (let i = 0; i < 2; i++) {
    console.log(`Creating a funds utxo with 10 ADA`);
    const depTx = await handleDeposit(lucid, {
      user_address: address,
      public_key: publicKey,
      amount: 10_000_000n,
    });
    const signedTx = await lucid
      .fromTx(depTx.cborHex)
      .sign.withWallet()
      .complete();
    console.log(signedTx.toCBOR());
    const txHash = await signedTx.submit();
    console.log(`Submitted deposit tx with hash: ${txHash}`);
    funds.push(depTx.fundsUtxoRef!);
    const addr = await lucid.wallet().address();
    await waitForUtxosUpdate(lucid, addr, txHash);
  }
  lucid.selectWallet.fromSeed(adminSeed);
};

const getSnapshot = async () => {
  const hydra = new HydraHandler(lucid, aliceWsUrl);
  await hydra.getSnapshot();
  await hydra.stop();
};

const closeHead = async () => {
  async function repeatCloseUntilSuccess(
    hydra: HydraHandler,
    intervalMs: number = 10000
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
  await hydra.stop();
};

const fanout = async () => {
  const hydra = new HydraHandler(lucid, aliceWsUrl);
  await hydra.fanout();
  await hydra.stop();
};

const withdraw = async (fanoutTxId: string) => {
  const adminAddress = await lucid.wallet().address();
  const msg = Buffer.from(fanoutTxId + Data.to<bigint>(0n), "hex");
  const hashedMsg = blake2b(32).update(msg).digest("hex");
  const sig = privKey.sign(Buffer.from(hashedMsg, "hex")).to_hex();

  const wSchema: WithdrawSchema = {
    address: adminAddress,
    owner: "user",
    funds_utxos_ref: [{ hash: fanoutTxId, index: 0 }],
    signature: sig,
    network_layer: Layer.L1,
  };
  const withdrawTx = await handleWithdraw(lucid, wSchema);
  const signedTx = await lucid
    .fromTx(withdrawTx.cborHex)
    .sign.withWallet()
    .complete();
  const txHash = await signedTx.submit();
  console.log(`Submitted withdraw tx with hash: ${txHash}`);
};

const abortHead = async () => {
  const hydra = new HydraHandler(lucid, aliceWsUrl);
  await hydra.abort();
  await hydra.listen("HeadIsAborted");
  hydra.stop();
};

const trace = process.env.npm_config_trace;
switch (trace) {
  case "deposit":
    const wallet = process.env.npm_config_wallet;
    if (!wallet) {
      throw new Error("Missing wallet. Provide one with --wallet");
    }
    switch (wallet) {
      case "admin":
        await deposit(1);
        break;
      case "user":
        await deposit(2);
        break;
      default:
        console.log("Invalid or missing wallet option");
        break;
    }
    break;
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
  case "withdraw":
    const txId = process.env.npm_config_fanout;
    if (!txId) {
      throw new Error("Missing txid. Provide one with --fanout");
    }
    await withdraw(txId);
    break;
  default:
    console.log("Invalid or missing trace option");
    break;
}
