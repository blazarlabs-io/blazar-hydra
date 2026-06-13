import e from 'express';
import { API_ROUTES } from '../schemas/routes';
import {
  DepositZodSchema,
  ManageHeadZodSchema,
  PayMerchantZodSchema,
  WithdrawZodSchema,
  IncrementalCommitZodSchema,
  IncrementalDecommitZodSchema,
} from '../schemas/zod';
import {
  finalizeCloseHead,
  finalizeOpenHead,
  handleCloseHead,
  handleDeposit,
  handleOpenHead,
  handlePay,
  handleQueryFunds,
  handleWithdraw,
  handleIncrementalCommit,
  handleIncrementalDecommit,
} from '../../offchain';
import { LucidEvolution } from '@lucid-evolution/lucid';
import { JSONBig } from './server';
import { logger } from '../../shared/logger';
import { prisma } from '../../config';

enum ERRORS {
  ADDRESS_NOT_FOUND = "The provided address couldn't be found on the protocol",
  BAD_REQUEST = 'Bad Request',
  FORBIDDEN = 'Forbidden',
  INTERNAL_SERVER_ERROR = 'Internal Server Error',
  UTXO_NOT_FOUND = 'Funds UTxO not found',
}

enum STATUS {
  OK = 200,
  BAD_REQUEST = 400,
  INTERNAL_SERVER_ERROR = 500,
  UNKNOWN_ERROR = 520,
}

const setRoutes = (lucid: LucidEvolution, expressApp: e.Application) => {
  // User Routes
  expressApp.post(API_ROUTES.DEPOSIT, async (req, res) => {
    try {
      const depositSchema = DepositZodSchema.parse(req.body);
      const _res = await handleDeposit(lucid, depositSchema);
      res.status(STATUS.OK).json(JSON.parse(JSONBig.stringify(_res)));
      logger.info(`${STATUS.OK}`, `${API_ROUTES.DEPOSIT}`);
    } catch (e) {
      if (e instanceof Error) {
        res
          .status(STATUS.INTERNAL_SERVER_ERROR)
          .json({ error: `${ERRORS.INTERNAL_SERVER_ERROR}: ${e}` });
        logger.error(
          `${STATUS.INTERNAL_SERVER_ERROR}: ${e}`,
          `${API_ROUTES.DEPOSIT}`
        );
      } else if (typeof e === 'string' && e.includes('InputsExhaustedError')) {
        res
          .status(STATUS.BAD_REQUEST)
          .json({ error: `${ERRORS.BAD_REQUEST}: ${e}` });
        logger.error(`${STATUS.BAD_REQUEST}: ${e}`, `${API_ROUTES.DEPOSIT}`);
      } else {
        res
          .status(STATUS.UNKNOWN_ERROR)
          .json({ error: `${ERRORS.INTERNAL_SERVER_ERROR}: ${e}` });
        logger.error(`${STATUS.UNKNOWN_ERROR}: ${e}`, `${API_ROUTES.DEPOSIT}`);
      }
    }
  });

  expressApp.post(API_ROUTES.WITHDRAW, async (req, res) => {
    try {
      const withdrawSchema = WithdrawZodSchema.parse(req.body);
      const _res = await handleWithdraw(lucid, withdrawSchema);
      res.status(STATUS.OK).json(JSON.parse(JSONBig.stringify(_res)));
      logger.info(`${STATUS.OK}`, `${API_ROUTES.WITHDRAW}`);
    } catch (e) {
      if (e instanceof Error) {
        res
          .status(STATUS.INTERNAL_SERVER_ERROR)
          .json({ error: `${ERRORS.INTERNAL_SERVER_ERROR}: ${e}` });
        logger.error(
          `${STATUS.INTERNAL_SERVER_ERROR}: ${e}`,
          `${API_ROUTES.WITHDRAW}`
        );
      } else if (typeof e === 'string' && e.includes('InputsExhaustedError')) {
        res
          .status(STATUS.BAD_REQUEST)
          .json({ error: `${ERRORS.BAD_REQUEST}: ${e}` });
        logger.error(`${STATUS.BAD_REQUEST}: ${e}`, `${API_ROUTES.WITHDRAW}`);
      } else {
        res
          .status(STATUS.UNKNOWN_ERROR)
          .json({ error: `${ERRORS.INTERNAL_SERVER_ERROR}: ${e}` });
        logger.error(`${STATUS.UNKNOWN_ERROR}: ${e}`, `${API_ROUTES.WITHDRAW}`);
      }
    }
  });

  expressApp.post(API_ROUTES.PAY, async (req, res) => {
    try {
      const payMerchantSchema = PayMerchantZodSchema.parse(req.body);
      const _res = await handlePay(lucid, payMerchantSchema);
      res.status(STATUS.OK).json(JSON.parse(JSONBig.stringify(_res)));
      logger.info(`${STATUS.OK}`, `${API_ROUTES.PAY}`);
    } catch (e) {
      if (e instanceof Error) {
        res
          .status(STATUS.INTERNAL_SERVER_ERROR)
          .json({ error: `${ERRORS.INTERNAL_SERVER_ERROR}: ${e}` });
        logger.error(
          `${STATUS.INTERNAL_SERVER_ERROR}`,
          `${API_ROUTES.PAY}: ${e}`
        );
      } else if (typeof e === 'string' && e.includes('InputsExhaustedError')) {
        res
          .status(STATUS.BAD_REQUEST)
          .json({ error: `${ERRORS.BAD_REQUEST}: ${e}` });
        logger.error(`${STATUS.BAD_REQUEST}`, `${API_ROUTES.PAY}: ${e}`);
      } else {
        res
          .status(STATUS.UNKNOWN_ERROR)
          .json({ error: `${ERRORS.INTERNAL_SERVER_ERROR}: ${e}` });
        logger.error(`${STATUS.UNKNOWN_ERROR}`, `${API_ROUTES.PAY}: ${e}`);
      }
    }
  });

  expressApp.get('/state', async (req, res) => {
    try {
      const procId = req.query.id as string;
      const process = await prisma.process
        .findUniqueOrThrow({
          where: { id: procId },
        })
        .catch((error) => {
          logger.error('DB Error while fetching status: ' + error);
          throw error;
        });
      res.status(STATUS.OK).json({ status: process.status });
      logger.info(`${STATUS.OK}`, `/state`);
    } catch (e) {
      res
        .status(STATUS.INTERNAL_SERVER_ERROR)
        .json({ error: `${ERRORS.INTERNAL_SERVER_ERROR}: ${e}` });
      logger.error(`${STATUS.INTERNAL_SERVER_ERROR}`, `/state: ${e}`);
    }
  });

  expressApp.get(API_ROUTES.QUERY_FUNDS, async (req, res) => {
    try {
      const { address } = req.query as { address: string };
      const _res = await handleQueryFunds(lucid, address);
      res.status(STATUS.OK).json(JSON.parse(JSONBig.stringify(_res)));
      logger.info(`${STATUS.OK}`, `${API_ROUTES.QUERY_FUNDS}`);
    } catch (e) {
      res
        .status(STATUS.INTERNAL_SERVER_ERROR)
        .json({ error: `${ERRORS.INTERNAL_SERVER_ERROR}` });
      logger.error(
        `${STATUS.INTERNAL_SERVER_ERROR} - ${API_ROUTES.QUERY_FUNDS}: ${e}`
      );
    }
  });

  // Admin Routes
  expressApp.post(API_ROUTES.OPEN_HEAD, async (req, res) => {
    try {
      const openHeadSchema = ManageHeadZodSchema.parse(req.body);
      const _res = await handleOpenHead(lucid);
      res.status(STATUS.OK).json(JSON.parse(JSONBig.stringify(_res)));
      logger.info(`${STATUS.OK}`, `${API_ROUTES.OPEN_HEAD}`);
      finalizeOpenHead(lucid, openHeadSchema, _res.operationId).catch(
        (error) => {
          logger.error(`Error finalizing open head: ${error}`);
        }
      );
    } catch (e) {
      if (e instanceof Error) {
        logger.error(
          `${STATUS.INTERNAL_SERVER_ERROR}: ${e}`,
          `${API_ROUTES.OPEN_HEAD}`
        );
        res
          .status(STATUS.INTERNAL_SERVER_ERROR)
          .json({ error: `${ERRORS.INTERNAL_SERVER_ERROR}` });
      } else if (typeof e === 'string' && e.includes('InputsExhaustedError')) {
        logger.error(`${STATUS.BAD_REQUEST}: ${e}`, `${API_ROUTES.OPEN_HEAD}`);
        res.status(STATUS.BAD_REQUEST).json({ error: `${ERRORS.BAD_REQUEST}` });
      } else {
        logger.error(
          `${STATUS.UNKNOWN_ERROR}: ${e}`,
          `${API_ROUTES.OPEN_HEAD}`
        );
        res
          .status(STATUS.UNKNOWN_ERROR)
          .json({ error: `${ERRORS.INTERNAL_SERVER_ERROR}: ${e}` });
      }
    }
  });

  expressApp.post(API_ROUTES.CLOSE_HEAD, async (req, res) => {
    try {
      const procId = req.query.id as string;
      const _res = await handleCloseHead(procId);
      res.status(STATUS.OK).json(JSON.parse(JSONBig.stringify(_res)));
      logger.info(`${STATUS.OK}`, `${API_ROUTES.CLOSE_HEAD}`);
      finalizeCloseHead(lucid, procId).catch((error) => {
        logger.error(
          `Error finalizing close head: ${
            error instanceof Error
              ? (error.stack ?? error.message)
              : JSON.stringify(error)
          }`
        );
      });
    } catch (e) {
      if (e instanceof Error) {
        res
          .status(STATUS.INTERNAL_SERVER_ERROR)
          .json({ error: `${ERRORS.INTERNAL_SERVER_ERROR}: ${e}` });
        logger.error(
          `${STATUS.INTERNAL_SERVER_ERROR}: ${e}`,
          `${API_ROUTES.CLOSE_HEAD}`
        );
      } else if (typeof e === 'string' && e.includes('InputsExhaustedError')) {
        res
          .status(STATUS.BAD_REQUEST)
          .json({ error: `${ERRORS.BAD_REQUEST}: ${e}` });
        logger.error(`${STATUS.BAD_REQUEST}: ${e}`, `${API_ROUTES.CLOSE_HEAD}`);
      } else {
        let msg: string;
        try {
          msg = typeof e === 'string' ? e : JSON.stringify(e);
        } catch {
          // e.g. circular structures (AxiosError) — JSON.stringify throws.
          msg = String((e as { message?: unknown })?.message ?? e);
        }
        res
          .status(STATUS.UNKNOWN_ERROR)
          .json({ error: `${ERRORS.INTERNAL_SERVER_ERROR}: ${msg}` });
        logger.error(
          `${STATUS.UNKNOWN_ERROR}: ${msg}`,
          `${API_ROUTES.CLOSE_HEAD}`
        );
      }
    }
  });

  // Incremental Commit Route
  expressApp.post(API_ROUTES.INCREMENTAL_COMMIT, async (req, res) => {
    try {
      const incrementalCommitSchema = IncrementalCommitZodSchema.parse(req.body);
      const _res = await handleIncrementalCommit(lucid, incrementalCommitSchema);
      res.status(STATUS.OK).json(JSON.parse(JSONBig.stringify(_res)));
      logger.info(`${STATUS.OK}`, `${API_ROUTES.INCREMENTAL_COMMIT}`);
    } catch (e) {
      if (e instanceof Error) {
        res
          .status(STATUS.INTERNAL_SERVER_ERROR)
          .json({ error: `${ERRORS.INTERNAL_SERVER_ERROR}: ${e.message}` });
        logger.error(
          `${STATUS.INTERNAL_SERVER_ERROR}: ${e.message}`,
          `${API_ROUTES.INCREMENTAL_COMMIT}`
        );
      } else if (typeof e === 'string' && e.includes('InputsExhaustedError')) {
        res
          .status(STATUS.BAD_REQUEST)
          .json({ error: `${ERRORS.BAD_REQUEST}: ${e}` });
        logger.error(`${STATUS.BAD_REQUEST}: ${e}`, `${API_ROUTES.INCREMENTAL_COMMIT}`);
      } else {
        res
          .status(STATUS.UNKNOWN_ERROR)
          .json({ error: `${ERRORS.INTERNAL_SERVER_ERROR}: ${e}` });
        logger.error(
          `${STATUS.UNKNOWN_ERROR}: ${e}`,
          `${API_ROUTES.INCREMENTAL_COMMIT}`
        );
      }
    }
  });

  // Incremental Decommit Route
  expressApp.post(API_ROUTES.INCREMENTAL_DECOMMIT, async (req, res) => {
    try {
      const incrementalDecommitSchema = IncrementalDecommitZodSchema.parse(req.body);
      const _res = await handleIncrementalDecommit(lucid, incrementalDecommitSchema);
      res.status(STATUS.OK).json(JSON.parse(JSONBig.stringify(_res)));
      logger.info(`${STATUS.OK}`, `${API_ROUTES.INCREMENTAL_DECOMMIT}`);
    } catch (e) {
      if (e instanceof Error) {
        res
          .status(STATUS.INTERNAL_SERVER_ERROR)
          .json({ error: `${ERRORS.INTERNAL_SERVER_ERROR}: ${e.message}` });
        logger.error(
          `${STATUS.INTERNAL_SERVER_ERROR}: ${e.message}`,
          `${API_ROUTES.INCREMENTAL_DECOMMIT}`
        );
      } else if (typeof e === 'string' && e.includes('InputsExhaustedError')) {
        res
          .status(STATUS.BAD_REQUEST)
          .json({ error: `${ERRORS.BAD_REQUEST}: ${e}` });
        logger.error(`${STATUS.BAD_REQUEST}: ${e}`, `${API_ROUTES.INCREMENTAL_DECOMMIT}`);
      } else {
        res
          .status(STATUS.UNKNOWN_ERROR)
          .json({ error: `${ERRORS.INTERNAL_SERVER_ERROR}: ${e}` });
        logger.error(
          `${STATUS.UNKNOWN_ERROR}: ${e}`,
          `${API_ROUTES.INCREMENTAL_DECOMMIT}`
        );
      }
    }
  });
};

export { setRoutes };
