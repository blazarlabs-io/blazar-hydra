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
import { mnemonicToEntropy } from "bip39";
import { commitFunds } from "../tx-builders/commit-funds";
import { logger } from "../../logger";

function getPrivateKey(
  seed: string,
  options: {
    password?: string;
    addressType?: "Base" | "Enterprise";
    accountIndex?: number;
    network?: Network;
  } = { addressType: "Base", accountIndex: 0, network: "Mainnet" }
): CML.PrivateKey {
  function harden(num: number): number {
    if (typeof num !== "number") throw new Error("Type number required here!");
    return 0x80000000 + num;
  }

  const entropy = mnemonicToEntropy(seed);
  const rootKey = CML.Bip32PrivateKey.from_bip39_entropy(
    fromHex(entropy),
    options.password
      ? new TextEncoder().encode(options.password)
      : new Uint8Array()
  );

  const accountKey = rootKey
    .derive(harden(1852))
    .derive(harden(1815))
    .derive(harden(options.accountIndex!));

  const paymentKey = accountKey.derive(0).derive(0).to_raw_key();
  return paymentKey;
}

async function waitForUtxosUpdate(lucid: LucidEvolution, txId: string): Promise<void> {
  let userUtxosUpdated = false;
  let scriptUtxoUpdated = false;
  while (!userUtxosUpdated || !scriptUtxoUpdated) {
    logger.info("Waiting for utxos update...");
    await new Promise((r) => setTimeout(r, 10000));
    const utxos = await lucid.wallet().getUtxos();
    const scriptUtxos = await lucid.utxosByOutRef([
      { txHash: txId, outputIndex: 0 },
    ]);
    userUtxosUpdated = utxos.some((utxo) => utxo.txHash === txId);
    scriptUtxoUpdated = scriptUtxos.length !== 0;
  }
  // wait for 20 more seconds because sometimes it is insufficient
  await new Promise((r) => setTimeout(r, 20000));
}

const adminSeed = env.SEED;
const lucid = (await Lucid(
  new Blockfrost(env.PROVIDER_URL, env.PROVIDER_PROJECT_ID),
  env.NETWORK as Network
)) as LucidEvolution;
lucid.selectWallet.fromSeed(adminSeed);
const adminAddress = await lucid.wallet().address();
const publicKey = toHex(getPrivateKey(adminSeed).to_public().to_raw_bytes());

// let funds: OutRef[] = [];
// for (let i = 0; i < 2; i++) {
//   console.log(`Creating a funds utxo with 10 ADA`);
//   const depTx = await handleDeposit(lucid, {
//     user_address: adminAddress,
//     public_key: publicKey,
//     amount: 10_000_000n,
//   });
//   const signedTx = await lucid
//     .fromTx(depTx.cborHex)
//     .sign.withWallet()
//     .complete();
//   const txHash = await signedTx.submit();
//   console.log(`Submitted deposit tx with hash: ${txHash}`);
//   funds.push(depTx.fundsUtxoRef!);
//   await waitForUtxosUpdate(lucid, txHash);
// }

const fundsIds = [
  "394f068ed0184bdbee25840401934bc4b9207c53182eb406508b353500117d30",
  "1296b1f127d815bbb5037df8b54cdaae3f5b3d15cfb838180cd3fafecd7ae265"
]
const userFundUtxos = await lucid.utxosByOutRef(fundsIds.map((id) => ({ txHash: id, outputIndex: 0 })));
const [validatorRef] = await lucid.utxosByOutRef([
  { txHash: env.VALIDATOR_REF, outputIndex: 0 },
]);
const commitTx = await commitFunds(lucid, {
  adminAddress: adminAddress,
  userFundUtxos,
  validatorRefUtxo: validatorRef
})

console.log(commitTx.tx.toCBOR());