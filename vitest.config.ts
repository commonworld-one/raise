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
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: './wrangler.jsonc' },
        miniflare: { bindings: { TEST_MIGRATIONS: migrations, TEST_DEMO_SEED: demoSeed, TEST_DEMO_JS: demoJs, TEST_DEMO_CSS: demoCss, TEST_AVATARS: avatars, TEST_ICONS: icons, NO_EDGE_CACHE: '1' } },
      }),
    ],
    test: { setupFiles: ['./test/setup.ts'], fileParallelism: false, maxWorkers: 1 },
  };
});
