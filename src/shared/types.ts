import { z } from "zod";
import {
  Layer,
  DepositZodSchema,
  ManageHeadZodSchema,
  PayMerchantZodSchema,
  WithdrawZodSchema,
} from "../api/schemas/zod-schemas";

type DepositSchema = z.infer<typeof DepositZodSchema>;
type ManageHeadSchema = z.infer<typeof ManageHeadZodSchema>;
type PayMerchantSchema = z.infer<typeof PayMerchantZodSchema>;
type WithdrawSchema = z.infer<typeof WithdrawZodSchema>;

export { Layer, DepositSchema, ManageHeadSchema, PayMerchantSchema, WithdrawSchema };
