import { defineConfig } from 'vitest/config';

// Tests never use a real node or DB: dummy env (config.ts validates at import) and a throwaway
// SQLite file (prisma/vitest.db, relative to the schema) created by vitest.global-setup.ts.
export const TEST_DATABASE_URL = 'file:./vitest.db';

export default defineConfig({
  test: {
    include: ['**/*.test.ts'],
    environment: 'node',
    passWithNoTests: true,
    globalSetup: './vitest.global-setup.ts',
    fileParallelism: false, // one SQLite file shared by the test files
    env: {
      DATABASE_URL: TEST_DATABASE_URL,
      PORT: '1',
      PROVIDER_PROJECT_ID: 'x',
      PROVIDER_URL: 'http://x',
      NETWORK: 'Preprod',
      VALIDATOR_REF: 'x',
      HYDRA_KEY: 'x',
      SEED: 'x',
      ADMIN_NODE_WS_URL: 'ws://127.0.0.1:9',
      ADMIN_NODE_API_URL: 'http://127.0.0.1:9',
      FIREBASE_PROJECT_ID: 'test-project',
      ADMIN_API_KEY: 'test-admin-key-0123456789abcdef0123',
      LOGGER_LEVEL: 'error',
    },
  },
});
