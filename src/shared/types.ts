import { z } from 'zod';
import {
  Layer,
  DepositZodSchema,
  ManageHeadZodSchema,
  PayMerchantZodSchema,
  WithdrawZodSchema,
  IncrementalCommitZodSchema,
  IncrementalDecommitZodSchema,
} from '../api/schemas/zod';

type DepositSchema = z.infer<typeof DepositZodSchema>;
type ManageHeadSchema = z.infer<typeof ManageHeadZodSchema>;
type PayMerchantSchema = z.infer<typeof PayMerchantZodSchema>;
type WithdrawSchema = z.infer<typeof WithdrawZodSchema>;
type IncrementalCommitSchema = z.infer<typeof IncrementalCommitZodSchema>;
type IncrementalDecommitSchema = z.infer<typeof IncrementalDecommitZodSchema>;

export {
  Layer,
  DepositSchema,
  ManageHeadSchema,
  PayMerchantSchema,
  WithdrawSchema,
  IncrementalCommitSchema,
  IncrementalDecommitSchema,
};
