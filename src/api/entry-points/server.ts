import express, { RequestHandler } from 'express';
import cors from 'cors';
import { addRequestIdExpressMiddleware } from '../middleware/request-id-middleware';
import JSONBig from 'json-bigint';

const JSONbig = JSONBig({
  alwaysParseAsBig: true,
  useNativeBigInt: true,
});

// Initialize the express engine
const createServer = () => {
  const app: express.Application = express();
  const bigintMiddleware: RequestHandler = (req, res, next) => {
    if (req.headers['content-type'] === 'application/json') {
      req.body = req.body ? JSONbig.parse(req.body) : req.body;
    }
    next();
  };
  app.use(express.raw({ inflate: true, limit: '1000kb', type: '*/*' }));
  app.use(bigintMiddleware);
  app.use(addRequestIdExpressMiddleware);
  app.use(express.urlencoded({ extended: true }));
  app.use(cors());
  app.use(express.json());
  return app;
};

export { createServer, JSONBig };
