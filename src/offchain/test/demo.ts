import {
  Address,
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
import {
  bech32ToAddressType,
  getPrivateKey,
  waitForUtxosUpdate,
} from "../lib/utils";
import { HydraHandler } from "../lib/hydra";
import { Layer, PayMerchantSchema, WithdrawSchema } from "../../shared";
import { handleWithdraw } from "../handlers/withdraw";
import blake2b from "blake2b";
import { handleOpenHead } from "../handlers/open-head";
import { logger } from "../../logger";
import { FundsDatum, FundsDatumT, PayInfo, PayInfoT, WithdrawInfo, WithdrawInfoT } from "../lib/types";
import { handlePay } from "../handlers/pay-merchant";
import { handleCloseHead } from "../handlers/close-head";

const adminSeed = env.SEED;
const privKey = getPrivateKey(adminSeed);
const lucid = (await Lucid(
  new Blockfrost(env.PROVIDER_URL, env.PROVIDER_PROJECT_ID),
  env.NETWORK as Network
)) as LucidEvolution;
lucid.selectWallet.fromSeed(adminSeed);
const aliceWsUrl = "ws://127.0.0.1:4002";

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
      amount: 40_000_000n,
    });
    const signedTx = await lucid
      .fromTx(depTx.cborHex)
      .sign.withWallet()
      .complete();
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
  const utxos = await hydra.getSnapshot();
  console.dir(utxos, { depth: null });
  await hydra.stop();
};

const pay = async (
  amount: bigint,
  mAddrB32: Address,
  fRef: string,
  withWallet: 1 | 2
) => {
  const [fundsTxId, fundsIx] = fRef.split("#");
  const mAddr = bech32ToAddressType(lucid, mAddrB32);
  const payInfo: PayInfoT = {
    amount: amount,
    merchant_addr: mAddr,
    ref: { transaction_id: fundsTxId, output_index: BigInt(fundsIx) },
  };
  const signatureSeed = withWallet === 1 ? env.SEED : env.USER_SEED;
  const userPrivKey = getPrivateKey(signatureSeed);
  const msg = Buffer.from(Data.to<PayInfoT>(payInfo, PayInfo), "hex");
  const sig = userPrivKey.sign(msg).to_hex();

  const pSchema: PayMerchantSchema = {
    merchant_address: mAddrB32,
    funds_utxo_ref: { hash: fundsTxId, index: Number(fundsIx) },
    amount: amount,
    signature: sig,
    merchant_funds_utxo: undefined,
    user_address: "",
  };
  logger.info("Before send tx");
  await handlePay(lucid, pSchema);
  logger.info("After send tx");
};

const fanout = async () => {
  const hydra = new HydraHandler(lucid, aliceWsUrl);
  await hydra.fanout();
  await hydra.stop();
};

const withdraw = async (fanoutTxId: string) => {
  const adminAddress = await lucid.wallet().address();
  const withdrawInfo: WithdrawInfoT = {
    ref: {
      transaction_id: fanoutTxId,
      output_index: 0n,
    },
  };
  const msg = Buffer.from(
    Data.to<WithdrawInfoT>(withdrawInfo, WithdrawInfo),
    "hex"
  );
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
  case "deposit": {
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
  }
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
    await handleCloseHead(lucid, {
      auth_token: "",
      peer_api_urls: [aliceApiUrl, bobApiUrl],
    });
    break;
  case "pay":
    const amount = process.env.npm_config_amount;
    const mAddr = process.env.npm_config_merchant_address;
    const fundsRef = process.env.npm_config_funds_ref;
    const wallet = process.env.npm_config_wallet;
    if (!amount) {
      throw new Error("Missing amount. Provide with --amount");
    }
    if (!mAddr) {
      throw new Error(
        "Missing merchant address. Provide with --merchant-address"
      );
    }
    if (!fundsRef) {
      throw new Error("Missing Funds UTxO Ref. Provide with --funds-ref");
    }
    if (!wallet) {
      throw new Error("Missing wallet. Provide one with --wallet");
    }
    const withWallet = wallet === "admin" ? 1 : 2;
    await pay(BigInt(amount), mAddr, fundsRef, withWallet);
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
  case "paymany":
    const hydra = new HydraHandler(lucid, aliceWsUrl);
    const utxos = await hydra.getSnapshot();
    const magia = utxos.filter((utxo) => { const dat = utxo.datum

      if (!dat) {
        return false
      }

      if (utxo.address == "addr_test1qztpj076fax0h3hy7vekhzuls2ezd7kh3mphanxh944yuhka76a8nz64ccpusr9q0w7q7kt2ze49d4dtu8564a2m23as8k20j9") {
        return false
      }

      const type = Data.from<FundsDatumT>(dat, FundsDatum).funds_type
      return type != "Merchant"
    }).map((utxo) => { return utxo.txHash + "#" + utxo.outputIndex}).forEach(async (ref) => {
      await pay(2000000n, "addr_test1qpkxq49y8vv5vwmacfs58h9dr6tzmdet8e4jvp5dkxxmaaqx69fzeuykylvmlcaav5eyp49stczujq0c2xxv83eukf5sc0ed6m", ref, 2)
    })
    console.dir(magia, { depth: null });
    await hydra.stop();
    break;
  default:
    console.log("Invalid or missing trace option");
    break;
}
