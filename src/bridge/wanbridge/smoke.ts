/**
 * Read-only live smoke test of the WanBridge testnet route (pair 517). Sends no BTC; createTx2 is
 * stateless and creates no order. Run from src/:
 *
 *   npx tsx bridge/wanbridge/smoke.ts <addr_test1q… destination> [fromAccount tb1…]
 *
 * Part 2 replays a historic pair-517 deposit through the status, mempool.space and Koios read paths.
 */
import {
  bridgeEnv,
  BTC_UNIT,
  createTx2,
  decodeMemo,
  fetchBtcTx,
  fetchKoiosTx,
  findBtcDeposit,
  getQuotaAndFee,
  getStatus,
  getTokenPair,
  verifyCardanoArrival,
} from '.';

const [
  destination,
  fromAccount = 'tb1qapnye2f5fjddqaguz4q7klhhtv2cqr5qgkc0pu',
] = process.argv.slice(2);
if (!destination) {
  console.error(
    'usage: npx tsx bridge/wanbridge/smoke.ts <addr_test1q…> [tb1…]'
  );
  process.exit(2);
}

console.log(new Date().toISOString(), 'API', bridgeEnv.WANBRIDGE_API_URL);

const pair = await getTokenPair();
console.log(
  'tokenPair 517 OK:',
  pair.fromChain.chainType,
  '->',
  pair.toChain.chainType
);

const quota = await getQuotaAndFee();
console.log('quotaAndFee (sats):', quota);

const amountSats = 50_000n;
const tx = await createTx2({ fromAccount, toAccount: destination, amountSats });
console.log('createTx2 OK, memo verified for', destination, tx);
console.log('memo decoded:', decodeMemo(tx.memo));

// Historic deposit 2026-01-12: BTC 6633762d… (200000 sat) -> preprod b142c3c9…
const hist = {
  btcTxid: '6633762d996f7932d159f76573c388c4282e8ea7ee7dfa6e7eda1579f67cf890',
  depositAddress:
    'tb1pw57f48hne57cyqr9j9dqapj4h2h48ks7paee9w8nal0lyx2qcm4qpvnmvy',
  destination:
    'addr_test1qr2ure5s9pg3ancpwfwhtcwgzeaktepk8nk8sep0yc9gff636vajy85w3dl7xprneqftdxzzqw6ywh3ht0gz3nkaj0uqkmdz5f',
};
const histTx = await createTx2({
  fromAccount,
  toAccount: hist.destination,
  amountSats,
});
const btc = findBtcDeposit(await fetchBtcTx(hist.btcTxid), {
  depositAddress: hist.depositAddress,
  memo: histTx.memo, // today's memo must equal the one on chain in January
});
console.log('historic BTC output:', btc);
const status = await getStatus(hist.btcTxid);
console.log('historic status:', status);
if (status.status === 'Success') {
  const arrival = verifyCardanoArrival(await fetchKoiosTx(status.redeemHash), {
    redeemHash: status.redeemHash,
    destination: hist.destination,
    unit: BTC_UNIT,
    btcTxid: hist.btcTxid,
  });
  console.log('historic Cardano arrival:', arrival);
}
