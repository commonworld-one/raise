import type { D1Migration } from 'cloudflare:test';
import type { Env as AppEnv } from '../src/types';
declare global {
  namespace Cloudflare {
    interface Env extends AppEnv {
      TEST_MIGRATIONS: D1Migration[];
      TEST_DEMO_SEED: string;
      TEST_DEMO_JS: string;
      TEST_DEMO_CSS: string;
      TEST_AVATARS: string[];
      TEST_ICONS: { files: string[]; icoSizes: number[]; png32: number[]; apple: number[] };
    }
  }
}
export {};
