import figlet from 'figlet';
import { env } from '../config';
import { createServer } from './entry-points/server';
import { setRoutes } from './entry-points/routes';
import { Lucid, Network } from '@lucid-evolution/lucid';
import { makeProvider } from '../offchain/lib/provider';
import { logger } from '../shared/logger';
import {
  paymentDeps,
  reconcileOnBoot,
} from '../offchain/handlers/execute-payment';
import {
  assertDepositConfig,
  depositDeps,
  startDepositPoller,
} from '../offchain/handlers/btc-deposit';

const startServer = async () => {
  const PORT = env.PORT;
  assertDepositConfig(); // a DEPOSIT_KEY that does not match DEPOSIT_ADDRESS must not start
  const app = createServer();
  const lucid = await Lucid(makeProvider(env), env.NETWORK as Network);
  const deposits = depositDeps(lucid);
  setRoutes(lucid, app, deposits);
  console.log(figlet.textSync('Blazar Payments', { font: 'Doom' }));
  // Before listen, so no executor can be running. Unreachable Hydra only postpones the settling of
  // `submitted` payments: GET /payments/:id reconciles them lazily.
  await reconcileOnBoot(paymentDeps(lucid)).catch((e) =>
    logger.error(`boot reconcile failed: ${e}`)
  );
  app.listen(PORT, () => {
    logger.info(`Server running on port ${PORT}`);
  });
  startDepositPoller(deposits, env.DEPOSIT_POLL_INTERVAL_MS);
};

await startServer();
