import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';
import { readFileSync, readdirSync } from 'node:fs';

export default defineConfig(async () => {
  const migrations = await readD1Migrations('./migrations');
  const demoSeed = readFileSync('./seed/demo.sql', 'utf8');
  // The /demo page assets are static files (served by Workers Assets, not the Worker): the tests read them here.
  const demoJs = readFileSync('./public/demo.js', 'utf8');
  const demoCss = readFileSync('./public/demo.css', 'utf8');
  const avatars = readdirSync('./public/avatars');
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: './wrangler.jsonc' },
        miniflare: { bindings: { TEST_MIGRATIONS: migrations, TEST_DEMO_SEED: demoSeed, TEST_DEMO_JS: demoJs, TEST_DEMO_CSS: demoCss, TEST_AVATARS: avatars, NO_EDGE_CACHE: '1' } },
      }),
    ],
    test: { setupFiles: ['./test/setup.ts'], fileParallelism: false, maxWorkers: 1 },
  };
});
