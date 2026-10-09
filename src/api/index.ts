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

const startServer = async () => {
  const PORT = env.PORT;
  const app = createServer();
  const lucid = await Lucid(makeProvider(env), env.NETWORK as Network);
  setRoutes(lucid, app);
  console.log(figlet.textSync('Blazar Payments', { font: 'Doom' }));
  // Before listen, so no executor can be running. Unreachable Hydra only postpones the settling of
  // `submitted` payments: GET /payments/:id reconciles them lazily.
  await reconcileOnBoot(paymentDeps(lucid)).catch((e) =>
    logger.error(`boot reconcile failed: ${e}`)
  );
  app.listen(PORT, () => {
    logger.info(`Server running on port ${PORT}`);
  });
};

await startServer();
