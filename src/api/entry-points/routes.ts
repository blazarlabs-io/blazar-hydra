import e from "express";
import { API_ROUTES } from "../schemas/routes";
import { ERRORS } from "../schemas/errors";
import {
  DepositZodSchema,
  PayMerchantZodSchema,
  WithdrawZodSchema,
} from "../schemas/zod";
import {
  handleDeposit,
  handlePay,
  handleQueryFunds,
  handleWithdraw,
} from "../../offchain";
import { LucidEvolution } from "@lucid-evolution/lucid";
import { JSONBig } from "./server";

const setRoutes = (lucid: LucidEvolution, expressApp: e.Application) => {
  // User Routes
  expressApp.post(API_ROUTES.DEPOSIT, async (req, res) => {
    try {
      const depositSchema = DepositZodSchema.parse(req.body);
      const _res = await handleDeposit(lucid, depositSchema);
      res.status(200).json(_res);
    } catch (e) {
      if (e instanceof Error) {
        res
          .status(500)
          .json({ error: `${ERRORS.INTERNAL_SERVER_ERROR}: ${e}` });
      } else if (typeof e === "string" && e.includes("InputsExhaustedError")) {
        res.status(400).json({ error: `${ERRORS.BAD_REQUEST}: ${e}` });
      } else {
        res
          .status(520)
          .json({ error: `${ERRORS.INTERNAL_SERVER_ERROR}: ${e}` });
      }
    }
  });

  expressApp.post(API_ROUTES.WITHDRAW, async (req, res) => {
    try {
      const withdrawSchema = WithdrawZodSchema.parse(req.body);
      const _res = await handleWithdraw(lucid, withdrawSchema);
      res.status(200).json(_res);
    } catch (e) {
      if (e instanceof Error) {
        res
          .status(500)
          .json({ error: `${ERRORS.INTERNAL_SERVER_ERROR}: ${e}` });
      } else if (typeof e === "string" && e.includes("InputsExhaustedError")) {
        res.status(400).json({ error: `${ERRORS.BAD_REQUEST}: ${e}` });
      } else {
        res
          .status(520)
          .json({ error: `${ERRORS.INTERNAL_SERVER_ERROR}: ${e}` });
      }
    }
  });

  expressApp.post(API_ROUTES.PAY, async (req, res) => {
    try {
      const payMerchantSchema = PayMerchantZodSchema.parse(req.body);
      const _res = await handlePay(lucid, payMerchantSchema);
      res.status(200).json(_res);
    } catch (e) {
      if (e instanceof Error) {
        res
          .status(500)
          .json({ error: `${ERRORS.INTERNAL_SERVER_ERROR}: ${e}` });
      } else if (typeof e === "string" && e.includes("InputsExhaustedError")) {
        res.status(400).json({ error: `${ERRORS.BAD_REQUEST}: ${e}` });
      } else {
        res
          .status(520)
          .json({ error: `${ERRORS.INTERNAL_SERVER_ERROR}: ${e}` });
      }
    }
  });

  expressApp.get(API_ROUTES.QUERY_FUNDS, async (req, res) => {
    try {
      const { address } = req.query as { address: string };
      const _res = await handleQueryFunds(lucid, address);
      res.status(200).json(JSON.parse(JSONBig.stringify(_res)));
    } catch (e) {
      res.status(500).json({ error: `${ERRORS.INTERNAL_SERVER_ERROR}: ${e}` });
    }
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
