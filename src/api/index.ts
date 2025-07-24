import figlet from 'figlet';
import { env } from '../config';
import { createServer } from './entry-points/server';
import { setRoutes } from './entry-points/routes';
import { Blockfrost, Lucid, Network } from '@lucid-evolution/lucid';
import { logger } from '../shared/logger';

const startServer = async () => {
  const PORT = env.PORT;
  const app = createServer();
  const lucid = await Lucid(
    new Blockfrost(env.PROVIDER_URL, env.PROVIDER_PROJECT_ID),
    env.NETWORK as Network
  );
  setRoutes(lucid, app);
  console.log(figlet.textSync('Blazar Payments', { font: 'Doom' }));
  app.listen(PORT, () => {
    logger.info(`Server running on port ${PORT}`);
  });
};

await startServer();
