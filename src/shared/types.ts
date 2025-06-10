import { z } from 'zod';
import {
  DepositZodSchema,
  ManageHeadZodSchema,
  PayMerchantZodSchema,
  WithdrawZodSchema,
  PartialCommitZodSchema,
} from '../api/schemas/zod';

export { Layer } from '../api/schemas/zod';
export type DepositSchema = z.infer<typeof DepositZodSchema>;
export type ManageHeadSchema = z.infer<typeof ManageHeadZodSchema>;
export type PayMerchantSchema = z.infer<typeof PayMerchantZodSchema>;
export type WithdrawSchema = z.infer<typeof WithdrawZodSchema>;
export type PartialCommitSchema = z.infer<typeof PartialCommitZodSchema>;
