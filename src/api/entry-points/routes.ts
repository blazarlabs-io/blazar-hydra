import e from "express";
import { API_ROUTES } from "../schemas/routes";
import { ERRORS } from "../schemas/errors";
import {
  DepositZodSchema,
  ManageHeadZodSchema,
  PayMerchantZodSchema,
  WithdrawZodSchema,
} from "../schemas/zod";
import {
  handleCloseHead,
  handleDeposit,
  handleOpenHead,
  handlePay,
  handleQueryFunds,
  handleWithdraw,
} from "../../offchain";
import { LucidEvolution } from "@lucid-evolution/lucid";
import { JSONBig } from "./server";
import { logger } from "../../logger";

const setRoutes = (lucid: LucidEvolution, expressApp: e.Application) => {
  // User Routes
  expressApp.post(API_ROUTES.DEPOSIT, async (req, res) => {
    try {
      const depositSchema = DepositZodSchema.parse(req.body);
      const _res = await handleDeposit(lucid, depositSchema);
      res.status(200).json(_res);
      logger.info(`200 - ${API_ROUTES.DEPOSIT}`);
    } catch (e) {
      if (e instanceof Error) {
        res
          .status(500)
          .json({ error: `${ERRORS.INTERNAL_SERVER_ERROR}: ${e}` });
        logger.error(`500 - ${API_ROUTES.DEPOSIT}: ${e}`);
      } else if (typeof e === "string" && e.includes("InputsExhaustedError")) {
        res.status(400).json({ error: `${ERRORS.BAD_REQUEST}: ${e}` });
        logger.error(`400 - ${API_ROUTES.DEPOSIT}: ${e}`);
      } else {
        res
          .status(520)
          .json({ error: `${ERRORS.INTERNAL_SERVER_ERROR}: ${e}` });
        logger.error(`520 - ${API_ROUTES.DEPOSIT}: ${e}`);
      }
    }
  });

  expressApp.post(API_ROUTES.WITHDRAW, async (req, res) => {
    try {
      const withdrawSchema = WithdrawZodSchema.parse(req.body);
      const _res = await handleWithdraw(lucid, withdrawSchema);
      res.status(200).json(_res);
      logger.info(`200 - ${API_ROUTES.WITHDRAW}`);
    } catch (e) {
      if (e instanceof Error) {
        res
          .status(500)
          .json({ error: `${ERRORS.INTERNAL_SERVER_ERROR}: ${e}` });
        logger.error(`500 - ${API_ROUTES.WITHDRAW}: ${e}`);
      } else if (typeof e === "string" && e.includes("InputsExhaustedError")) {
        res.status(400).json({ error: `${ERRORS.BAD_REQUEST}: ${e}` });
        logger.error(`400 - ${API_ROUTES.WITHDRAW}: ${e}`);
      } else {
        res
          .status(520)
          .json({ error: `${ERRORS.INTERNAL_SERVER_ERROR}: ${e}` });
        logger.error(`520 - ${API_ROUTES.WITHDRAW}: ${e}`);
      }
    }
  });

  expressApp.post(API_ROUTES.PAY, async (req, res) => {
    try {
      const payMerchantSchema = PayMerchantZodSchema.parse(req.body);
      const _res = await handlePay(lucid, payMerchantSchema);
      res.status(200).json(_res);
      logger.info(`200 - ${API_ROUTES.PAY}`);
    } catch (e) {
      if (e instanceof Error) {
        res
          .status(500)
          .json({ error: `${ERRORS.INTERNAL_SERVER_ERROR}: ${e}` });
        logger.error(`500 - ${API_ROUTES.PAY}: ${e}`);
      } else if (typeof e === "string" && e.includes("InputsExhaustedError")) {
        res.status(400).json({ error: `${ERRORS.BAD_REQUEST}: ${e}` });
        logger.error(`400 - ${API_ROUTES.PAY}: ${e}`);
      } else {
        res
          .status(520)
          .json({ error: `${ERRORS.INTERNAL_SERVER_ERROR}: ${e}` });
        logger.error(`520 - ${API_ROUTES.PAY}: ${e}`);
      }
    }
  });

  expressApp.get(API_ROUTES.QUERY_FUNDS, async (req, res) => {
    try {
      const { address } = req.query as { address: string };
      const _res = await handleQueryFunds(lucid, address);
      res.status(200).json(JSON.parse(JSONBig.stringify(_res)));
      logger.info(`200 - ${API_ROUTES.QUERY_FUNDS}`);
    } catch (e) {
      res.status(500).json({ error: `${ERRORS.INTERNAL_SERVER_ERROR}: ${e}` });
      logger.error(`500 - ${API_ROUTES.QUERY_FUNDS}: ${e}`);
    }
  });

  // Admin Routes
  expressApp.post(API_ROUTES.OPEN_HEAD, async (req, res) => {
    try {
      const openHeadSchema = ManageHeadZodSchema.parse(req.body);
      const _res = await handleOpenHead(lucid, openHeadSchema);
      res.status(200).json(_res);
      logger.info(`200 - ${API_ROUTES.OPEN_HEAD}`);
    } catch (e) {
      if (e instanceof Error) {
        res
          .status(500)
          .json({ error: `${ERRORS.INTERNAL_SERVER_ERROR}: ${e}` });
        logger.error(`500 - ${API_ROUTES.OPEN_HEAD}: ${e}`);
      } else if (typeof e === "string" && e.includes("InputsExhaustedError")) {
        res.status(400).json({ error: `${ERRORS.BAD_REQUEST}: ${e}` });
        logger.error(`400 - ${API_ROUTES.OPEN_HEAD}: ${e}`);
      } else {
        res
          .status(520)
          .json({ error: `${ERRORS.INTERNAL_SERVER_ERROR}: ${e}` });
        logger.error(`520 - ${API_ROUTES.OPEN_HEAD}: ${e}`);
      }
    }
  });

  expressApp.post(API_ROUTES.CLOSE_HEAD, async (req, res) => {
    try {
      const closeHeadSchema = ManageHeadZodSchema.parse(req.body);
      const _res = await handleCloseHead(lucid, closeHeadSchema);
      res.status(200).json(_res);
      logger.info(`200 - ${API_ROUTES.CLOSE_HEAD}`);
    } catch (e) {
      if (e instanceof Error) {
        res
          .status(500)
          .json({ error: `${ERRORS.INTERNAL_SERVER_ERROR}: ${e}` });
          logger.error(`500 - ${API_ROUTES.CLOSE_HEAD}: ${e}`);
      } else if (typeof e === "string" && e.includes("InputsExhaustedError")) {
        res.status(400).json({ error: `${ERRORS.BAD_REQUEST}: ${e}` });
        logger.error(`400 - ${API_ROUTES.CLOSE_HEAD}: ${e}`);
      } else {
        res
          .status(520)
          .json({ error: `${ERRORS.INTERNAL_SERVER_ERROR}: ${e}` });
        logger.error(`520 - ${API_ROUTES.CLOSE_HEAD}: ${e}`);
      }
    }
  });
};

export { setRoutes };
