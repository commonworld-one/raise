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
  // Favicon files: names in public/, the .ico image sizes from its directory, PNG sizes from the IHDR chunk.
  const ico = readFileSync('./public/favicon.ico');
  const icoSizes = Array.from({ length: ico.readUInt16LE(4) }, (_, i) => ico[6 + i * 16] || 256);
  const pngSize = (f: string) => { const b = readFileSync(f); return [b.readUInt32BE(16), b.readUInt32BE(20)]; };
  const icons = { files: readdirSync('./public'), icoSizes, png32: pngSize('./public/favicon-32.png'), apple: pngSize('./public/apple-touch-icon.png') };
  // Share images (og:image): file name -> [width, height] from the PNG header.
  const og = Object.fromEntries(readdirSync('./public/og').map((f) => [f, pngSize('./public/og/' + f)]));
  const styleCss = readFileSync('./public/style.css', 'utf8');
  const rollbackSql = readFileSync('./rollback/rollback-0012-0014.sql', 'utf8');
  const repairSql = readFileSync('./rollback/repair-null-seq.sql', 'utf8');
  const consentJs = readFileSync('./public/consent.js', 'utf8');
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: './wrangler.jsonc' },
        miniflare: { d1Databases: { RB_MIG: 'rb-mig', RB_OLD: 'rb-old', RB_FRESH: 'rb-fresh' },
        bindings: { TEST_MIGRATIONS: migrations, TEST_ROLLBACK_SQL: rollbackSql, TEST_REPAIR_SQL: repairSql, TEST_DEMO_SEED: demoSeed, TEST_DEMO_JS: demoJs, TEST_DEMO_CSS: demoCss, TEST_AVATARS: avatars, TEST_ICONS: icons, TEST_OG: og, TEST_STYLE_CSS: styleCss, TEST_CONSENT_JS: consentJs, NO_EDGE_CACHE: '1',
          // The test run makes far more than 120 requests a minute: READ_LIMITER stays bound but is skipped (test/limits.test.ts covers it).
          NO_READ_LIMIT: '1',
          // Fixed test pepper (production: wrangler secret put RAISE_TOKEN_PEPPER).
          RAISE_TOKEN_PEPPER: 'test-pepper-0123456789abcdef0123456789abcdef' } },
      }),
    ],
    test: { setupFiles: ['./test/setup.ts'], fileParallelism: false, maxWorkers: 1 },
  };
});
