import {
  Blockfrost,
  CML,
  fromHex,
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

const adminSeed = env.SEED;
const lucid = (await Lucid(
  new Blockfrost(env.PROVIDER_URL, env.PROVIDER_PROJECT_ID),
  env.NETWORK as Network
)) as LucidEvolution;
lucid.selectWallet.fromSeed(adminSeed);
const adminAddress = await lucid.wallet().address();
const publicKey = toHex(getPrivateKey(adminSeed).to_public().to_raw_bytes());

const openHead = async () => {
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

  // const fundsIds = [
  //   "  ",
  //   "1bf91d5bd031bdc8b7aea44ff2f61f75d04677614750974a99d1a31a22220b3a"
  // ]
  // const userFundUtxos = await lucid.utxosByOutRef(fundsIds.map((id) => ({ txHash: id, outputIndex: 0 })));

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
  const aliceUrl = "ws://127.0.0.1:4001";
  const bobUrl = "ws://127.0.0.1:4002";
  const hydra = new HydraHandler(lucid, aliceUrl);
  const initTag = await hydra.init();
  if (initTag !== "HeadIsInitializing") {
    throw new Error("Something went wrong when initializing the hydra head");
  }

  // Send commits to hydra node
  const utxos1: [string, any] = [
    userFundUtxos[0].txHash + "#" + userFundUtxos[0].outputIndex,
    lucidUtxoToHydraUtxo(userFundUtxos[0]),
  ];
  const aliceCommitTxId = await hydra.sendCommit({
    peerHost: bobUrl,
    blueprint: commitTxAlice.tx.toCBOR(),
    utxos: utxos1,
  });
  console.log(`Alice commit transaction submitted! tx id: ${aliceCommitTxId}`);
  const aliceCommitTag = await hydra.listen("Commited");
  if (aliceCommitTag !== "Commited") {
    throw new Error("Alice commit was not confirmed");
  }

  const utxos2: [string, any] = [
    userFundUtxos[1].txHash + "#" + userFundUtxos[1].outputIndex,
    lucidUtxoToHydraUtxo(userFundUtxos[1]),
  ];
  const bobCommitTxId = await hydra.sendCommit({
    peerHost: aliceUrl,
    blueprint: commitTxBob.tx.toCBOR(),
    utxos: utxos2,
  });
  console.log(`Bob commit transaction submitted! tx id: ${bobCommitTxId}`);
  const bobCommitTag = await hydra.listen("Commited");
  if (bobCommitTag !== "Commited") {
    throw new Error("Bob commit was not confirmed");
  }

  const openHeadTag = await hydra.listen("HeadIsOpen");
  if (openHeadTag !== "HeadIsOpen") {
    throw new Error("Head was not opened");
  }
};

// const [someUtxo] = await lucid.utxosByOutRef([
//   {
//     txHash: "2ef04411c87117f715bbe94c77998022178a0ed678d6912dd12c24214685a0c7",
//     outputIndex: 0,
//   },
// ]);

// console.log(lucidUtxoToHydraUtxo(someUtxo));