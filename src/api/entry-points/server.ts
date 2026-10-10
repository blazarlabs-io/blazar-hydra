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
    // After express.raw, req.body is a Buffer. Routes only read JSON objects: an empty or non-JSON
    // body becomes {} (a Buffer reached zod, which listed Buffer.prototype keys as unrecognized).
    if (!Buffer.isBuffer(req.body)) return next();
    if (!req.is('application/json') || req.body.length === 0) {
      req.body = {};
      return next();
    }
    try {
      req.body = JSONbig.parse(req.body.toString());
    } catch {
      // json-bigint throws a plain object, which Express answered as an HTML `[object Object]` 500.
      res.status(400).json({ error: 'BAD_REQUEST' });
      return;
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
