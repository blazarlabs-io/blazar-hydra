import { execSync } from 'child_process';
import { rmSync } from 'fs';
import { TEST_DATABASE_URL } from './vitest.config';

const files = ['prisma/vitest.db', 'prisma/vitest.db-journal'];

export default function setup() {
  execSync('npx prisma db push --skip-generate --force-reset', {
    env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL },
    stdio: 'ignore',
  });
  return () => files.forEach((f) => rmSync(f, { force: true }));
}
