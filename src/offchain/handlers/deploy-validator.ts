import {
  Blockfrost,
  Data,
  Lucid,
  LucidEvolution,
  Network,
  scriptFromNative,
  validatorToAddress,
  validatorToRewardAddress,
} from '@lucid-evolution/lucid';
import { env } from '../../config';
import { buildValidator } from '../validator/handle';
import { getNetworkFromLucid } from '../lib/utils';

async function deployScript(
  admin_key?: string,
  hydra_initial_key?: string,
  lucid_config?: LucidEvolution
): Promise<{ txDeployHash: string }> {
  if (!admin_key || !hydra_initial_key) {
    console.log('Using validator parameters from environment file.');
  }

  const adminKey = admin_key ?? env.ADMIN_KEY;
  const hydraInitialKey = hydra_initial_key ?? env.HYDRA_INITIAL_KEY;

  const lucid =
    lucid_config ??
    ((await Lucid(
      new Blockfrost(env.PROVIDER_URL, env.PROVIDER_PROJECT_ID),
      env.NETWORK as Network
    )) as LucidEvolution);
  lucid.selectWallet.fromSeed(env.SEED);
  const network = getNetworkFromLucid(lucid);

  // TODO implement a proper script to hold the validator?
  const validator = buildValidator(adminKey, {
    Script_cred: { Key: hydraInitialKey },
  });
  const rewardAddress = validatorToRewardAddress(network, validator);
  const refScriptAddress = validatorToAddress(
    network,
    scriptFromNative({ type: 'sig', keyHash: adminKey })
  );
  const txDeployHash = await lucid
    .newTx()
    .pay.ToContract(
      refScriptAddress,
      {
        kind: 'inline',
        value: Data.void(),
      },
      {},
      validator
    )
    .register.Stake(rewardAddress)
    .complete()
    .then((txSignBuilder) => txSignBuilder.sign.withWallet().complete())
    .then((txSigned) => txSigned.submit());

  lucid.awaitTx(txDeployHash);
  return { txDeployHash };
}

export { deployScript };

// Arguments passed when run as npm script from /src
const admin_key = process.env.npm_config_admin_key;
const hydra_initial_key = process.env.npm_config_hydra_initial_key;

if (admin_key && hydra_initial_key) {
  const { txDeployHash } = await deployScript(admin_key, hydra_initial_key);
  console.log(`Deployed script with tx hash: ${txDeployHash}`);
}
