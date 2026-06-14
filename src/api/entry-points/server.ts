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
    // Only parse a non-empty body. After express.raw, req.body is a Buffer; an empty body is an
    // empty Buffer, which is truthy, so the old `req.body ? parse : req.body` fed "" to
    // JSONbig.parse and threw — surfacing as a default-Express `[object Object]` 500 on
    // body-less POSTs like /close-head (which only reads req.query).
    if (
      req.headers['content-type'] === 'application/json' &&
      req.body &&
      req.body.length > 0
    ) {
      req.body = JSONbig.parse(req.body);
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
