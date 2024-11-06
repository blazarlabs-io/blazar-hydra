import {
  Data,
  LucidEvolution,
  OutRef,
  selectUTxOs,
  UTxO,
  validatorToAddress,
} from "@lucid-evolution/lucid";
import { ManageHeadSchema } from "../../shared";
import { HydraHandler } from "../lib/hydra";
import { env } from "../../config";
import {
  dataAddressToBech32,
  getValidator,
  waitForUtxosUpdate,
} from "../lib/utils";
import _ from "lodash";
import { FundsDatum, FundsDatumT } from "../lib/types";
import { mergeFunds } from "../tx-builders/merge-funds";
import { logger } from "../../logger";
import { commitFunds } from "../tx-builders/commit-funds";
import { CommitFundsParams } from "../lib/params";

async function handleOpenHead(
  lucid: LucidEvolution,
  params: ManageHeadSchema
): Promise<void> {
  const { auth_token, peer_api_urls: peerUrls } = params;
  const {
    ADMIN_ADDRESS: adminAddress,
    ADMIN_NODE_WS_URL: wsUrl,
    VALIDATOR_REF: vRef,
  } = env;
  if (!validateAdmin(auth_token)) {
    throw new Error("Unauthorized");
  }
  const localLucid = _.cloneDeep(lucid);

  // Step 1: Initialize the head
  logger.info("Initializing head...");
  const hydra = new HydraHandler(lucid, wsUrl);
  const initTag = await hydra.init();
  if (initTag !== "HeadIsInitializing") {
    logger.error("Head already initialized");
  }

  // Step 2: Lookup deposit UTxOs in L1 and merge them for each user
  const [validatorRef] = await localLucid.utxosByOutRef([
    { txHash: vRef, outputIndex: 0 },
  ]);
  const validator = getValidator(validatorRef);
  const scriptAddress = validatorToAddress(
    localLucid.config().network,
    validator
  );
  const scriptUtxos = await localLucid.utxosAt(scriptAddress);
  if (scriptUtxos.length === 0) {
    throw new Error("No deposits to commit");
  }
  const userToDepositsMap = new Map<string, UTxO[]>();
  for (const utxo of scriptUtxos) {
    const { addr } = Data.from<FundsDatumT>(utxo.datum!, FundsDatum);
    const userAddress = dataAddressToBech32(localLucid, addr);
    if (!userToDepositsMap.has(userAddress)) {
      userToDepositsMap.set(userAddress, []);
    }
    userToDepositsMap.get(userAddress)!.push(utxo);
  }
  let currentAdminUtxos = await localLucid.utxosAt(adminAddress).then((utxos) =>
    selectUTxOs(utxos, {
      ["lovelace"]: BigInt(userToDepositsMap.size * 1_000_000),
    })
  );
  let mergeTxs: string[] = [];
  let fundsRefs: OutRef[] = [];
  logger.info("Preparing merge transactions...");
  for (const [_, deposits] of userToDepositsMap) {
    const params = {
      adminAddress,
      userFundsUtxos: deposits,
      adminUtxos: currentAdminUtxos,
      validatorRef: validatorRef,
    };
    const { tx, newFundsUtxo, newAdminUtxos } = await mergeFunds(
      localLucid,
      params
    );
    const signedTx = await tx.sign
      .withWallet()
      .complete()
      .then((tx) => tx.toCBOR());
    fundsRefs.push(newFundsUtxo);
    mergeTxs.push(signedTx);
    currentAdminUtxos = newAdminUtxos;
  }
  logger.info("Submitting merge transactions...");
  for (const tx of mergeTxs) {
    await localLucid.wallet().submitTx(tx);
  }
  const lastSubmittedTxHash = lucid
    .fromTx(mergeTxs[mergeTxs.length - 1])
    .toHash();
  await waitForUtxosUpdate(localLucid, lastSubmittedTxHash);
  logger.info(
    "Merge transactions submitted succesfully, last tx: " + lastSubmittedTxHash
  );

  // Step 3: Commit the funds
  logger.info("Committing the funds...");
  let fundsUtxosToCommit = await localLucid.utxosByOutRef(fundsRefs);
  const utxosPerPeer = fundsUtxosToCommit.length / peerUrls.length;
  for (let i = 0; i < peerUrls.length; i++) {
    const peerUrl = peerUrls[i];
    const thisPeerUtxos = fundsUtxosToCommit.slice(0, utxosPerPeer - 1);
    fundsUtxosToCommit = fundsUtxosToCommit.splice(0 , utxosPerPeer);
    const params: CommitFundsParams = {
      adminAddress,
      userFundUtxos: thisPeerUtxos,
      validatorRefUtxo: validatorRef,
    };
    const { tx } = await commitFunds(localLucid, params);
    const peerCommitTxId = await hydra.sendCommit(peerUrl, tx.toCBOR(), thisPeerUtxos);
    logger.info(`Commit transaction submitted! tx id: ${peerCommitTxId}`);
    let commitTag = "";
    console.info("Waiting for last commit to be confirmed by the hydra node");
    while (commitTag !== "Committed") {
      commitTag = await hydra.listen("Committed");
    }
  }
  logger.info("All funds committed successfully");

  let openHeadTag = "";
  while (openHeadTag !== "HeadIsOpen") {
    console.log("Head not opened yet");
    openHeadTag = await hydra.listen("HeadIsOpen");
  }
  await hydra.stop();
  return;
}

function validateAdmin(auth_token: string): boolean {
  return true;
}

export { handleOpenHead };
