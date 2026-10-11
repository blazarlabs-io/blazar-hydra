import {
  addAssets,
  Assets,
  Data,
  LucidEvolution,
  UTxO,
} from '@lucid-evolution/lucid';
import { QueryFundsResponse } from '../../api/schemas/response';
import { fetchSnapshot } from '../lib/hydra';
import { fundsDatumOf, spendable } from '../lib/funds';
import _ from 'lodash';
import { env } from '../../config';
import {
  dataAddressToBech32,
  getNetworkFromLucid,
  getValidator,
  getValidatorDetails,
} from '../lib/utils';
import { FundsDatum, FundsDatumT } from '../lib/types';
import { logger } from '../../shared/logger';

async function handleQueryFunds(
  lucid: LucidEvolution,
  address: string
): Promise<QueryFundsResponse> {
  let fundsInL1: UTxO[] = [],
    fundsInL2: UTxO[] = [];
  const localLucid = _.cloneDeep(lucid);
  const network = getNetworkFromLucid(localLucid);
  const [vRef] = await lucid.utxosByOutRef([
    { txHash: env.VALIDATOR_REF, outputIndex: 0 },
  ]);
  const validator = getValidator(vRef);
  const { scriptAddress: validatorAddr, scriptHash: controlTokenPolicy } =
    getValidatorDetails(validator, network);

  const isOwnUtxo = (utxo: UTxO, addr: string) => {
    if (!utxo.datum) {
      return false;
    }
    if (utxo.address !== validatorAddr) {
      return false;
    }
    try {
      const datum = Data.from<FundsDatumT>(utxo.datum, FundsDatum);
      return dataAddressToBech32(localLucid, datum.addr) === addr;
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
    } catch (error) {
      logger.warning(
        `Utxo at validator address with unknown datum: ${utxo.txHash}#${utxo.outputIndex}`
      );
      return false;
    }
  };

  // Fetch funds in L1
  try {
    fundsInL1 = await localLucid
      .utxosAt(validatorAddr)
      .then((utxos) => utxos.filter((utxo) => isOwnUtxo(utxo, address)));
  } catch (error) {
    const msg = `Error querying funds in L1: ${error}`;
    logger.error(msg);
    throw new Error(msg);
  }

  // Fetch funds in L2. Precondition: the head must be opened
  try {
    fundsInL2 = (await fetchSnapshot(env.ADMIN_NODE_API_URL)).filter((utxo) =>
      isOwnUtxo(utxo, address)
    );
  } catch (error) {
    logger.error(`Error querying funds in L2: ${error}`);
    throw new HydraUnavailableError(`${error}`);
  }

  const addAssetsFromUtxo = (acc: Assets, utxo: UTxO) =>
    addAssets(acc, utxo.assets);
  const removeControlTokens = (assets: Assets): Assets => {
    return Object.fromEntries(
      Object.entries(assets).filter(([unit]) => {
        return !unit.startsWith(controlTokenPolicy);
      })
    );
  };
  const totalInL1 = removeControlTokens(
    fundsInL1.reduce(addAssetsFromUtxo, {})
  );
  const totalInL2 = removeControlTokens(
    fundsInL2.reduce(addAssetsFromUtxo, {})
  );

  // Max over the user's L2 funds UTxOs: one payment spends exactly one funds UTxO.
  const payableInL2: Record<string, string> = {};
  for (const utxo of fundsInL2) {
    const datum = fundsDatumOf(utxo);
    if (!datum || datum.funds_type === 'Merchant') continue;
    for (const unit of Object.keys(removeControlTokens(utxo.assets))) {
      const v = spendable(utxo, datum, unit);
      if (v > BigInt(payableInL2[unit] ?? '0'))
        payableInL2[unit] = v.toString();
    }
  }

  return {
    fundsInL1,
    totalInL1,
    fundsInL2,
    totalInL2,
    payableInL2,
  };
}

/** The head snapshot could not be read: the route answers 503 instead of an empty L2. */
class HydraUnavailableError extends Error {}

export { handleQueryFunds, HydraUnavailableError };
