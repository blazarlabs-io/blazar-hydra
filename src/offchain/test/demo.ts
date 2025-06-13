import {
  Address,
  Blockfrost,
  Data,
  Lucid,
  LucidEvolution,
  Network,
  OutRef,
  toHex,
  validatorToAddress,
} from '@lucid-evolution/lucid';
import { env } from '../../config';
import {
  bech32ToAddressType,
  dataAddressToBech32,
  getNetworkFromLucid,
  getPrivateKey,
  waitForUtxosUpdate,
} from '../lib/utils';
import { HydraHandler } from '../lib/hydra';
import { Layer, PayMerchantSchema, WithdrawSchema } from '../../shared';
import { logger } from '../../logger';
import {
  FundsDatum,
  FundsDatumT,
  PayInfo,
  PayInfoT,
  WithdrawInfo,
  WithdrawInfoT,
} from '../lib/types';
import axios from 'axios';
import JSONbig from 'json-bigint';
import { API_ROUTES } from '../../api/schemas/routes';
import { TxBuiltResponse } from '../../api/schemas/response';
import { DBOps } from '../../prisma/db-ops';

const adminSeed = env.SEED;
const lucid = (await Lucid(
  new Blockfrost(env.PROVIDER_URL, env.PROVIDER_PROJECT_ID),
  env.NETWORK as Network
)) as LucidEvolution;
lucid.selectWallet.fromSeed(adminSeed);
const aliceWsUrl = 'ws://127.0.0.1:4001';

const aliceApiUrl = 'http://127.0.0.1:4001/commit';
const bobApiUrl = 'http://127.0.0.1:4002/commit';

const ownServerUrl = 'http://localhost:3002';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const postEp = async (path: string, param: any): Promise<any> => {
  return axios
    .post(path, JSONbig.stringify(param), {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      transformRequest: [(data) => data],
      transformResponse: [(data) => JSONbig.parse(data)],
    })
    .then((response) => {
      if (response.status === 200) {
        return response.data;
      }
      throw response;
    });
};

logger.configureLogger(
  {
    level: 'debug', //env.LOGGER_LEVEL,
    prettyPrint: true, //env.PRETTY_PRINT,
  },
  false
);

const openHead = async () => {
  lucid.selectWallet.fromSeed(adminSeed);
  const { operationId } = await postEp(ownServerUrl + API_ROUTES.OPEN_HEAD, {
    peer_api_urls: [aliceApiUrl, bobApiUrl],
  });
  logger.debug(`Operation ID: ${operationId}`);
};

const deposit = async (fromWallet: 1 | 2) => {
  const thisSeed = fromWallet === 1 ? env.USER_SEED : env.USER_SEED_2;
  lucid.selectWallet.fromSeed(thisSeed);
  const address = await lucid.wallet().address();
  const privKey = getPrivateKey(thisSeed);
  const publicKey = toHex(privKey.to_public().to_raw_bytes());
  const funds: OutRef[] = [];
  for (let i = 0; i < 2; i++) {
    console.log(`Creating a funds utxo with 10 ADA`);
    const depositParams = {
      user_address: address,
      public_key: publicKey,
      amount: 40_000_000n,
    };
    const depTx: TxBuiltResponse = await postEp(
      ownServerUrl + API_ROUTES.DEPOSIT,
      depositParams
    );
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
  from: Address,
  to: Address,
  withWallet: 1 | 2
) => {
  const hydra = new HydraHandler(lucid, aliceWsUrl);
  const utxos = await hydra.getSnapshot();
  const [fRef] = utxos.filter((utxo) => {
    if (utxo.address === env.ADMIN_ADDRESS) {
      return false;
    }
    const dat = utxo.datum;
    if (!dat) {
      return false;
    }
    const owner = Data.from<FundsDatumT>(dat, FundsDatum).addr;
    return dataAddressToBech32(lucid, owner) === from;
  });
  await hydra.stop();

  const [fundsTxId, fundsIx] = [fRef.txHash, fRef.outputIndex];
  const mAddr = bech32ToAddressType(lucid, to);
  const payInfo: PayInfoT = {
    amount: amount,
    merchant_addr: mAddr,
    ref: { transaction_id: fundsTxId, output_index: BigInt(fundsIx) },
  };
  const signatureSeed = withWallet === 1 ? env.USER_SEED : env.USER_SEED_2;
  const userPrivKey = getPrivateKey(signatureSeed);
  const msg = Buffer.from(Data.to<PayInfoT>(payInfo, PayInfo), 'hex');
  const sig = userPrivKey.sign(msg).to_hex();

  const pSchema: PayMerchantSchema = {
    merchant_address: to,
    funds_utxo_ref: { hash: fundsTxId, index: BigInt(fundsIx) },
    amount: amount,
    signature: sig,
    merchant_funds_utxo: undefined,
  };
  const res = await postEp(ownServerUrl + API_ROUTES.PAY, pSchema);
  logger.info(res);
};

const fanout = async () => {
  const hydra = new HydraHandler(lucid, aliceWsUrl);
  await hydra.fanout();
  await hydra.stop();
};

const withdraw = async (address: Address, seed: string) => {
  const [validatorUtxo] = await lucid.utxosByOutRef([
    { txHash: env.VALIDATOR_REF, outputIndex: 0 },
  ]);
  const validator = validatorUtxo.scriptRef!;
  const network = getNetworkFromLucid(lucid);
  const scriptAddress = validatorToAddress(network, validator);
  const withdrawInfos: WithdrawInfoT[] = await lucid
    .utxosAt(scriptAddress)
    .then((utxos) =>
      utxos.filter((utxo) => {
        const dat = utxo.datum;
        if (!dat) {
          return false;
        }
        const datum = Data.from<FundsDatumT>(dat, FundsDatum);
        if (datum.funds_type === 'Merchant') {
          return false;
        }
        return dataAddressToBech32(lucid, datum.addr) === address;
      })
    )
    .then((utxos) =>
      utxos.map((u) => {
        return {
          ref: {
            transaction_id: u.txHash,
            output_index: BigInt(u.outputIndex),
          },
        };
      })
    );

  const withdraws = withdrawInfos.map((w) => {
    const msg = Buffer.from(Data.to<WithdrawInfoT>(w, WithdrawInfo), 'hex');
    const sig = getPrivateKey(seed).sign(msg).to_hex();
    return {
      ref: { hash: w.ref.transaction_id, index: w.ref.output_index },
      signature: sig,
    };
  });

  const wSchema: WithdrawSchema = {
    address: address,
    owner: 'user',
    funds_utxos: withdraws,
    network_layer: Layer.L1,
  };
  lucid.selectWallet.fromSeed(seed);
  const withdrawTx: TxBuiltResponse = await postEp(
    ownServerUrl + API_ROUTES.WITHDRAW,
    wSchema
  );
  // Sign user
  const signedTx = await lucid
    .fromTx(withdrawTx.cborHex)
    .sign.withWallet()
    .complete();
  const txHash = await signedTx.submit();
  console.log(`Submitted withdraw tx with hash: ${txHash}`);
  lucid.selectWallet.fromSeed(adminSeed);
};

const abortHead = async () => {
  const hydra = new HydraHandler(lucid, aliceWsUrl);
  await hydra.abort();
  await hydra.listen('HeadIsAborted');
  hydra.stop();
};

const trace = process.env.npm_config_trace;
switch (trace) {
  case 'deposit': {
    const wallet = process.env.npm_config_wallet;
    if (!wallet) {
      throw new Error('Missing wallet. Provide one with --wallet');
    }
    switch (wallet) {
      case 'user1':
        await deposit(1);
        break;
      case 'user2':
        await deposit(2);
        break;
      default:
        console.log('Invalid or missing wallet option');
        break;
    }
    break;
  }
  case 'open':
    await openHead();
    break;
  case 'abort':
    await abortHead();
    break;
  case 'snapshot':
    await getSnapshot();
    break;
  case 'close':
    const id = process.env.npm_config_id;
    await postEp(`${ownServerUrl}${API_ROUTES.CLOSE_HEAD}/?id=${id}`, {
      peer_api_urls: [aliceApiUrl, bobApiUrl],
    });
    break;
  case 'pay':
    const amount = process.env.npm_config_amount;
    const user = process.env.npm_config_from;
    const mAddr = process.env.npm_config_merchant_address;
    if (!amount) {
      throw new Error('Missing amount. Provide with --amount');
    }
    if (!mAddr) {
      throw new Error(
        'Missing merchant address. Provide with --merchant-address'
      );
    }
    if (!user) {
      throw new Error(
        'User not specified. Provide with --from. Options: user1, user2'
      );
    }
    const withWallet = user === 'user1' ? 1 : 2;
    const userAddr = withWallet === 1 ? env.USER_ADDRESS : env.USER_ADDRESS_2;
    await pay(BigInt(amount), userAddr, mAddr, withWallet);
    break;
  case 'fanout':
    await fanout();
    break;
  case 'withdraw':
    const from = process.env.npm_config_from;
    if (!from) {
      throw new Error('Missing from. Provide one with --from');
    }
    const wallet = from === 'user1' ? 1 : 2;
    const addr = wallet === 1 ? env.USER_ADDRESS : env.USER_ADDRESS_2;
    const seed = wallet === 1 ? env.USER_SEED : env.USER_SEED_2;
    await withdraw(addr, seed);
    break;
  case 'paymany':
    const hydra = new HydraHandler(lucid, aliceWsUrl);
    const utxos = await hydra.getSnapshot();
    utxos
      .filter((utxo) => {
        const dat = utxo.datum;
        if (!dat) {
          return false;
        }
        if (utxo.address == env.ADMIN_ADDRESS) {
          return false;
        }
        const type = Data.from<FundsDatumT>(dat, FundsDatum).funds_type;
        return type != 'Merchant';
      })
      .map((utxo) => {
        return utxo.txHash + '#' + utxo.outputIndex;
      })
      .forEach(async () => {
        await pay(2000000n, env.USER_ADDRESS_2, env.USER_ADDRESS, 2);
        await hydra.listen('TxValid');
      });
    console.dir('Many payments done', { depth: null });
    await hydra.stop();
    break;
  case 'clean-db':
    await DBOps.cleanDB();
    console.log('Database cleaned');
    break;
  default:
    console.log('Invalid or missing trace option');
    break;
}
