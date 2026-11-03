import { applyD1Migrations, env } from 'cloudflare:test';

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
await applyD1Migrations(env.DEMO_DB, env.TEST_MIGRATIONS);
const stmts = env.TEST_DEMO_SEED.split(/;\s*\n/).map((s) => s.replace(/^--.*$/gm, '').trim()).filter(Boolean);
await env.DEMO_DB.batch(stmts.map((s) => env.DEMO_DB.prepare(s)));
