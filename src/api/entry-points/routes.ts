import e from "express";
import { API_ROUTES } from "../schemas/routes";
import { ERRORS } from "../schemas/errors";
import { DepositZodSchema } from "../schemas/zod-schemas";
import { handleDeposit } from "../../offchain";
import { LucidEvolution } from "@lucid-evolution/lucid";

const setRoutes = (lucid: LucidEvolution, expressApp: e.Application) => {
  // User Routes
  expressApp.post(API_ROUTES.DEPOSIT, async (req, res) => {
    try {
      const depositSchema = DepositZodSchema.parse(req.body);
      const _res = await handleDeposit(lucid, depositSchema);
      res.status(200).json(_res);
    } catch (e) {
      if (e instanceof Error) {
        res.status(500).json({ error: `${ERRORS.INTERNAL_SERVER_ERROR}: ${e}` });
      } else if (typeof e === "string" && e.includes("InputsExhaustedError")) {
        res.status(400).json({ error: `${ERRORS.BAD_REQUEST}: ${e}` });
      } else {
        res.status(520).json({ error: `${ERRORS.INTERNAL_SERVER_ERROR}: ${e}` });
      }
    }
  });

  expressApp.post(API_ROUTES.WITHDRAW, (req, res) => {
    res.send("Withdraw funds route");
  });

  expressApp.post(API_ROUTES.PAY, (req, res) => {
    res.send("Pay merchant route");
  });

  expressApp.get(API_ROUTES.QUERY_FUNDS, (req, res) => {
    res.send("Query funds route");
  });


  // Admin Routes
  expressApp.post(API_ROUTES.OPEN_HEAD, (req, res) => {
    res.send("Open hydra head route");
  });

  expressApp.post(API_ROUTES.CLOSE_HEAD, (req, res) => {
    res.send("Close hydra head route");
  });
};

export { setRoutes };
