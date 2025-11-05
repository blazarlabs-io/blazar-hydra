import {
  addAssets,
  Assets,
  Data,
  LucidEvolution,
  UTxO,
} from '@lucid-evolution/lucid';
import { QueryFundsResponse } from '../../api/schemas/response';
import { HydraHandler } from '../lib/hydra';
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
    const hydra = new HydraHandler(localLucid, env.ADMIN_NODE_WS_URL);
    fundsInL2 = await hydra
      .getSnapshot()
      .then((utxos) => utxos.filter((utxo) => isOwnUtxo(utxo, address)));
    await hydra.stop();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    if (JSON.stringify(error).includes('ECONNREFUSED')) {
      logger.error(`Not connected to websocket`);
    } else {
      logger.error(`Error querying funds in L2: ${error}`);
    }
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

  return {
    fundsInL1,
    totalInL1,
    fundsInL2,
    totalInL2,
  };
}

export { handleQueryFunds };
