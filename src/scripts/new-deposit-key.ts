/**
 * Generates a fresh DEPOSIT_KEY (24-word mnemonic, same format as SEED) into <key-file> with 0600
 * permissions and prints ONLY its preprod base address (DEPOSIT_ADDRESS). Refuses to overwrite.
 *
 *   npm run deposit-key -- <key-file>
 */
import { generateSeedPhrase, walletFromSeed } from '@lucid-evolution/lucid';
import { writeFileSync } from 'fs';

const [keyFile] = process.argv.slice(2);
if (!keyFile) {
  console.error('usage: npm run deposit-key -- <key-file>');
  process.exit(2);
}
const seed = generateSeedPhrase();
writeFileSync(keyFile, seed, { mode: 0o600, flag: 'wx' });
const { address } = walletFromSeed(seed, {
  network: 'Preprod',
  addressType: 'Base',
  accountIndex: 0,
});
console.log(address);
