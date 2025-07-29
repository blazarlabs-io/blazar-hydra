import { LucidEvolution, validatorToAddress } from '@lucid-evolution/lucid';
import { PartialCommitSchema } from '../../shared';
import { HydraHandler } from '../lib/hydra';
import { env } from '../../config';
import { getNetworkFromLucid, getValidator } from '../lib/utils';
import { commitUtxos } from '../lib/hydra-flow-subroutines';

const MAX_UTXOS_PER_COMMIT = 10;

export async function handlePartialCommit(
  lucid: LucidEvolution,
  partialCommitSchema: PartialCommitSchema
): Promise<void> {
  const { peer_api_urls: peerUrls } = partialCommitSchema;
  const adminAddress = await lucid.wallet().address();
  const network = getNetworkFromLucid(lucid);
  const hydra = new HydraHandler(lucid, env.ADMIN_NODE_WS_URL);

  // Lookup deposit UTxOs in L1
  const [validatorRef] = await lucid.utxosByOutRef([
    { txHash: env.VALIDATOR_REF, outputIndex: 0 },
  ]);
  const validator = getValidator(validatorRef);
  const scriptAddress = validatorToAddress(network, validator);
  const maxScriptUtxos = MAX_UTXOS_PER_COMMIT * peerUrls.length;
  const scriptUtxos = await lucid
    .utxosAt(scriptAddress)
    .then((utxos) => utxos.slice(0, maxScriptUtxos));

  // Commit funds to the open head
  await commitUtxos(
    hydra,
    lucid,
    scriptUtxos,
    peerUrls,
    adminAddress,
    validatorRef,
    true // isPartialCommit
  );
}
