import { z } from 'zod';
import dotenv from 'dotenv';
import { PrismaClient } from '@prisma/client';

dotenv.config();
const envSchema = z
  .object({
    PORT: z
      .string()
      .refine(
        (val) =>
          Number.isFinite(Number.parseInt(val)) && Number.parseInt(val) > 0,
        {
          message: `Port must be a positive integer`,
        }
      )
      .transform((val) => Number.parseInt(val)),
    PROVIDER_PROJECT_ID: z.string(),
    PROVIDER_URL: z.string(),
    NETWORK: z.string(),
    VALIDATOR_REF: z.string(),
    ADMIN_KEY: z.string(),
    HYDRA_INITIAL_KEY: z.string(),
    HYDRA_DEPOSIT_KEY: z.string(),
    SEED: z.string(),
    ADMIN_NODE_WS_URL: z.string(),
    ADMIN_NODE_API_URL: z.string(),
  })
  .readonly();
type EnvSchema = z.infer<typeof envSchema>;
const env = envSchema.parse(process.env);

const prisma = new PrismaClient();

export { env, EnvSchema, prisma };