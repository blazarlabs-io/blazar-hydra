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
    PROVIDER_TYPE: z.enum(['blockfrost', 'kupmios']).default('blockfrost'),
    PROVIDER_PROJECT_ID: z.string().optional(),
    PROVIDER_URL: z.string().optional(),
    KUPO_URL: z.string().optional(),
    OGMIOS_URL: z.string().optional(),
    NETWORK: z.string(),
    VALIDATOR_REF: z.string(),
    HYDRA_KEY: z.string(),
    SEED: z.string(),
    ADMIN_NODE_WS_URL: z.string(),
    ADMIN_NODE_API_URL: z.string(),
    USER_ADDRESS: z.string().optional(),
    USER_SEED: z.string().optional(),
    USER_ADDRESS_2: z.string().optional(),
    USER_SEED_2: z.string().optional(),
    LOGGER_LEVEL: z
      .string()
      .refine(
        (val) => ['error', 'warn', 'info', 'debug'].includes(val.toLowerCase()),
        "Invalid logger level: must be one of 'error', 'warn', 'info', or 'debug'"
      )
      .default('info')
      .transform((val) => val.toLowerCase()),
  })
  .readonly()
  .superRefine((env, ctx) => {
    if (env.PROVIDER_TYPE === 'kupmios') {
      if (!env.KUPO_URL)
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['KUPO_URL'], message: 'KUPO_URL is required when PROVIDER_TYPE=kupmios' });
      if (!env.OGMIOS_URL)
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['OGMIOS_URL'], message: 'OGMIOS_URL is required when PROVIDER_TYPE=kupmios' });
    } else {
      if (!env.PROVIDER_URL)
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['PROVIDER_URL'], message: 'PROVIDER_URL is required when PROVIDER_TYPE=blockfrost' });
      if (!env.PROVIDER_PROJECT_ID)
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['PROVIDER_PROJECT_ID'], message: 'PROVIDER_PROJECT_ID is required when PROVIDER_TYPE=blockfrost' });
    }
  });
type EnvSchema = z.infer<typeof envSchema>;
const env = envSchema.parse(process.env);

const prisma = new PrismaClient();

export { env, EnvSchema, prisma };
