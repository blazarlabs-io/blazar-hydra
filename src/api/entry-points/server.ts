import express, { RequestHandler } from "express";
import cors from "cors";
import { addRequestIdExpressMiddleware } from "../middleware/request-id-middleware";
import { logger } from "../../logger";
import JSONBig from "json-bigint";

const JSONbig = JSONBig({
  alwaysParseAsBig: true,
  useNativeBigInt: true,
});

// Initialize the express engine
const createServer = () => {
  logger.configureLogger(
    {
      level: "debug", //env.LOGGER_LEVEL,
      prettyPrint: true, //env.PRETTY_PRINT,
    },
    true,
  );
  const app: express.Application = express();
  const bigintMiddleware: RequestHandler = (req, res, next) => {
    if (req.headers["content-type"] === "application/json") {
      req.body = req.body ? JSONbig.parse(req.body) : req.body;
    }
    next();
  };
  app.use(express.raw({ inflate: true, limit: "1000kb", type: "*/*" }));
  app.use(bigintMiddleware);
  app.use(addRequestIdExpressMiddleware);
  app.use(express.urlencoded({ extended: true }));
  app.use(cors());
  app.use(express.json());
  return app;
};

export { createServer, JSONBig };
