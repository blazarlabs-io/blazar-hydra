import {
  addAssets,
  Assets,
  Data,
  LucidEvolution,
  OutRef,
  UTxO,
} from '@lucid-evolution/lucid';
import { PayMerchantParams } from '../lib/params';
import { PayMerchantSchema } from '../../shared';
import { payMerchant } from '../tx-builders/pay';
import { env } from '../../config';
import _ from 'lodash';
import { HydraHandler } from '../lib/hydra';
import { FundsDatum, FundsDatumT } from '../lib/types';
import { valueTuplesToAssets } from '../lib/utils';
import { logger } from '../../shared/logger';

async function handlePay(
  lucid: LucidEvolution,
  params: PayMerchantSchema
): Promise<{ fundsUtxoRef: OutRef; merchUtxo: OutRef }> {
  const localLucid = _.cloneDeep(lucid);
  const {
    merchant_address: merchantAddress,
    funds_utxo_ref,
    amount,
    signature,
    merchant_funds_utxo,
  } = params;
  const { hash: txHash, index: outputIndex } = funds_utxo_ref;
  const { ADMIN_KEY: adminKey, HYDRA_KEY: hydraKey } = env;
  const hydra = new HydraHandler(localLucid, env.ADMIN_NODE_WS_URL);
  const utxosInL2 = await hydra.getSnapshot();

  // Lookup admin collateral UTxO in L2
  const adminCollateral = utxosInL2.find(
    (utxo) => utxo.address === env.ADMIN_ADDRESS
  );
  if (!adminCollateral) {
    throw new Error(`Admin collateral UTxO not found`);
  }

  // Lookup user Funds UTxO in L2
  const userFundsUtxo: UTxO | undefined = utxosInL2.find((utxo) => {
    return utxo.txHash === txHash && BigInt(utxo.outputIndex) === outputIndex;
  });
  if (!userFundsUtxo) {
    throw new Error(`User funds or collateral utxo not found`);
  }
  const datum = Data.from<FundsDatumT>(userFundsUtxo.datum!, FundsDatum);

  // Check if there are enough funds to pay the merchant
  const amountToPay: Assets = valueTuplesToAssets(amount);
  const availableFunds = addAssets(userFundsUtxo.assets, {
    ['lovelace']: -datum.locked_deposit,
  });
  if (isGreaterOrEqual(amountToPay, availableFunds)) {
    throw new Error(`Insufficient funds`);
  }

  // Check if there is a merchant UTxO to pay the funds to
  let merchantFundsUtxo: UTxO | undefined;
  if (merchant_funds_utxo) {
    const { hash: txHash, index: outputIndex } = merchant_funds_utxo;
    const merchantFundsUtxo = utxosInL2.find((utxo) => {
      return utxo.txHash === txHash && utxo.outputIndex === outputIndex;
    });
    if (!merchantFundsUtxo) {
      throw new Error(`Merchant funds utxo not found`);
    }
  }

  const payMerchantParams: PayMerchantParams = {
    adminCollateral,
    merchantAddress,
    assets: amountToPay,
    userFundsUtxo,
    signature,
    adminKey,
    hydraKey,
    merchantFundsUtxo,
  };
  const { tx, userUtxo, merchantUtxo } = await payMerchant(
    localLucid,
    payMerchantParams
  );
  logger.debug('Submitting payment to hydra head...');
  lucid.selectWallet.fromSeed(env.SEED);
  const signedTx = await lucid.fromTx(tx.toCBOR()).sign.withWallet().complete();
  const tag = await hydra.sendTx(signedTx.toCBOR());
  if (tag !== 'TxValid') {
    await hydra.stop();
    throw new Error(`Failed to submit payment tx to hydra head`);
  }
  await hydra.stop();

  return {
    fundsUtxoRef: userUtxo,
    merchUtxo: merchantUtxo,
  };
}

export { handlePay };

function isGreaterOrEqual(a: Assets, b: Assets): boolean {
  const aEntries = Object.entries(a);
  const bEntries = Object.entries(b);
  return (
    aEntries.length == bEntries.length &&
    aEntries.every(([asset, value]) => {
      return b[asset] && value >= BigInt(b[asset]);
    })
  );
}
