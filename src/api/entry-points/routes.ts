import e from 'express';
import { API_ROUTES } from '../schemas/routes';
import {
  DepositZodSchema,
  ManageHeadZodSchema,
  PayMerchantZodSchema,
  WithdrawZodSchema,
  IncrementalCommitZodSchema,
  IncrementalDecommitZodSchema,
  CreateAccountZodSchema,
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
  HydraUnavailableError,
} from '../../offchain';
import {
  authorizePayment,
  createPayment,
  paymentDeps,
  pendingPaymentFor,
  readPayment,
  toPaymentDto,
} from '../../offchain/handlers/execute-payment';
import {
  attachBtcTx,
  createBtcDeposit,
  DepositDeps,
  depositDeps,
  readDeposit,
  toDepositDto,
} from '../../offchain/handlers/btc-deposit';
import {
  AttachBtcTxSchema,
  CreateBtcDepositSchema,
  CreatePaymentSchema,
} from '../../shared/payment-contract';
import { Caller, requireAccount, requireAdmin, requireAdminOrOwner, sha256Hex } from '../middleware/auth';
import { Prisma } from '@prisma/client';
import axios from 'axios';
import { ZodError } from 'zod';
import { LucidEvolution } from '@lucid-evolution/lucid';
import { JSONBig } from './server';
import { logger } from '../../shared/logger';
import { env, prisma } from '../../config';
import { ProcessNotFoundError, CloseInProgressError } from '../../shared/close-guards';

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
  NOT_FOUND = 404,
  CONFLICT = 409,
  INTERNAL_SERVER_ERROR = 500,
  SERVICE_UNAVAILABLE = 503,
  UNKNOWN_ERROR = 520,
}

const setRoutes = (
  lucid: LucidEvolution,
  expressApp: e.Application,
  deposits: DepositDeps = depositDeps(lucid)
) => {
  // User Routes
  // Admin only: the admin wallet funds and signs the deposit (custodial top-up is a setup operation).
  expressApp.post(API_ROUTES.DEPOSIT, requireAdmin, async (req, res) => {
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

  // The admin key, or the Firebase token of the address's owner (merchant-web Cashout).
  expressApp.post(API_ROUTES.WITHDRAW, requireAdminOrOwner((b) => b.address), async (req, res) => {
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

  expressApp.post(API_ROUTES.PAY, requireAdmin, async (req, res) => {
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
      if (e instanceof HydraUnavailableError) {
        res.status(STATUS.SERVICE_UNAVAILABLE).json({ error: 'HYDRA_UNAVAILABLE' });
        logger.error(`${STATUS.SERVICE_UNAVAILABLE} - ${API_ROUTES.QUERY_FUNDS}: ${e}`);
        return;
      }
      res
        .status(STATUS.INTERNAL_SERVER_ERROR)
        .json({ error: `${ERRORS.INTERNAL_SERVER_ERROR}` });
      logger.error(
        `${STATUS.INTERNAL_SERVER_ERROR} - ${API_ROUTES.QUERY_FUNDS}: ${e}`
      );
    }
  });

  // Admin Routes
  expressApp.post(API_ROUTES.OPEN_HEAD, requireAdmin, async (req, res) => {
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

  expressApp.post(API_ROUTES.CLOSE_HEAD, requireAdmin, async (req, res) => {
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
      if (e instanceof ProcessNotFoundError) {
        res.status(STATUS.NOT_FOUND).json({ error: `Not Found: ${e.message}` });
        logger.error(`${STATUS.NOT_FOUND}: ${e.message}`, `${API_ROUTES.CLOSE_HEAD}`);
      } else if (e instanceof CloseInProgressError) {
        res.status(STATUS.CONFLICT).json({ error: `Conflict: ${e.message}` });
        logger.error(`${STATUS.CONFLICT}: ${e.message}`, `${API_ROUTES.CLOSE_HEAD}`);
      } else if (e instanceof Error) {
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
  expressApp.post(API_ROUTES.INCREMENTAL_COMMIT, requireAdmin, async (req, res) => {
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
  expressApp.post(API_ROUTES.INCREMENTAL_DECOMMIT, requireAdmin, async (req, res) => {
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

  // M3 payment contract (payment-contract.md §3.3)
  const deps = paymentDeps(lucid);
  const callerOf = (res: e.Response) => res.locals.caller as Caller;
  const notFound = (res: e.Response) => res.status(STATUS.NOT_FOUND).json({ error: 'NOT_FOUND' });
  const handle =
    (fn: (req: e.Request, res: e.Response) => Promise<unknown>): e.RequestHandler =>
    async (req, res) => {
      try {
        await fn(req, res);
      } catch (err) {
        if (err instanceof ZodError) {
          res.status(STATUS.BAD_REQUEST).json({ error: 'BAD_REQUEST', issues: err.issues });
          return;
        }
        logger.error(`${STATUS.INTERNAL_SERVER_ERROR} ${req.method} ${req.path}: ${err}`);
        res.status(STATUS.INTERNAL_SERVER_ERROR).json({ error: 'INTERNAL' });
      }
    };

  expressApp.get(API_ROUTES.HEALTH, async (_req, res) => {
    const hydra = await axios
      .get(`${env.ADMIN_NODE_API_URL}/head`, { timeout: 3000 })
      .then((r) => String(r.data?.tag), () => 'unreachable');
    res.status(STATUS.OK).json({ status: 'ok', version: env.BUILD_SHA, hydra });
  });

  expressApp.post(
    API_ROUTES.ACCOUNTS,
    requireAdmin,
    handle(async (req, res) => {
      const { apiKey, ...account } = CreateAccountZodSchema.parse(req.body);
      try {
        const a = await prisma.account.create({
          data: { ...account, apiKeyHash: apiKey ? sha256Hex(apiKey) : null },
        });
        res.status(201).json({
          id: a.id,
          kind: a.kind,
          address: a.address,
          firebaseUid: a.firebaseUid,
          hasApiKey: a.apiKeyHash !== null,
        });
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
          res.status(STATUS.CONFLICT).json({ error: 'CONFLICT' }); // uid or key already mapped
          return;
        }
        throw err;
      }
    })
  );

  expressApp.post(
    API_ROUTES.PAYMENTS,
    requireAccount('merchant'),
    handle(async (req, res) => {
      const body = CreatePaymentSchema.parse(req.body);
      if (body.merchantAddress !== callerOf(res).address) {
        res.status(403).json({ error: 'FORBIDDEN' });
        return;
      }
      res.status(201).json(toPaymentDto(await createPayment(body)));
    })
  );

  expressApp.get(
    API_ROUTES.TERMINAL_PENDING_PAYMENT,
    requireAccount('merchant'),
    handle(async (_req, res) => {
      const p = await pendingPaymentFor(callerOf(res).address);
      if (p) res.status(STATUS.OK).json(toPaymentDto(p));
      else res.status(204).end();
    })
  );

  expressApp.get(
    API_ROUTES.PAYMENT,
    requireAccount(),
    handle(async (req, res) => {
      const p = await readPayment(req.params.id, deps);
      const c = callerOf(res);
      // A merchant sees its own; a user sees unclaimed ones (to pay them) and its own.
      const visible =
        p &&
        (c.kind === 'merchant'
          ? p.merchantAddress === c.address
          : p.payerAddress === null || p.payerAddress === c.address);
      if (!visible) return notFound(res);
      res.status(STATUS.OK).json(toPaymentDto(p));
    })
  );

  expressApp.post(
    API_ROUTES.AUTHORIZE_PAYMENT,
    requireAccount('user'),
    handle(async (req, res) => {
      const { status, payment } = await authorizePayment(
        req.params.id,
        callerOf(res).address,
        deps
      );
      if (!payment) return notFound(res);
      if (status === STATUS.CONFLICT) {
        res.status(status).json({ error: 'CONFLICT' }); // authorized by another payer
        return;
      }
      res.status(status).json(toPaymentDto(payment));
    })
  );

  // M3 BTC deposits (payment-contract.md §3.7); the poller in btc-deposit.ts drives them to `available`.
  expressApp.post(
    API_ROUTES.BTC_DEPOSITS,
    requireAccount('user'),
    handle(async (req, res) => {
      const { amountSats } = CreateBtcDepositSchema.parse(req.body);
      const r = await createBtcDeposit(callerOf(res), BigInt(amountSats), deposits);
      if (r.status === 201) res.status(201).json(toDepositDto(r.deposit));
      else res.status(r.status).json({ error: r.error });
    })
  );

  expressApp.post(
    API_ROUTES.DEPOSIT_BTC_TX,
    requireAccount('user'),
    handle(async (req, res) => {
      const { btcTxid } = AttachBtcTxSchema.parse(req.body);
      const r = await attachBtcTx(req.params.id, callerOf(res).id, btcTxid, deposits);
      if (r.status === 200) {
        res.status(200).json(toDepositDto(r.deposit));
        return;
      }
      res.status(r.status).json({
        error: r.error,
        ...(r.deposit && { deposit: toDepositDto(r.deposit) }),
      });
    })
  );

  expressApp.get(
    API_ROUTES.BTC_DEPOSIT,
    requireAccount('user'),
    handle(async (req, res) => {
      const d = await readDeposit(req.params.id, callerOf(res).id);
      if (!d) return notFound(res);
      res.status(STATUS.OK).json(toDepositDto(d));
    })
  );
};

export { setRoutes };
