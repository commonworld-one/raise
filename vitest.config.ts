import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';
import { readFileSync } from 'node:fs';

export default defineConfig(async () => {
  const migrations = await readD1Migrations('./migrations');
  const demoSeed = readFileSync('./seed/demo.sql', 'utf8');
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: './wrangler.jsonc' },
        miniflare: { bindings: { TEST_MIGRATIONS: migrations, TEST_DEMO_SEED: demoSeed, NO_EDGE_CACHE: '1' } },
      }),
    ],
    test: { setupFiles: ['./test/setup.ts'], fileParallelism: false, maxWorkers: 1 },
  };
});
