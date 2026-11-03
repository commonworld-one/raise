#!/usr/bin/env node
// Stub auth helper (until OAuth via `muse mcp login raise` lands).
// Prints a new bearer key for a Muse and the SQL to register it.
// The key itself is shown once and never stored; only its SHA-256 goes into D1.
//
//   node scripts/new-key.mjs <muse-slug>
//   then run the printed SQL with: npx wrangler d1 execute raise-prod --remote --command "<sql>"
import { createHash, randomBytes } from 'node:crypto';

const slug = process.argv[2];
if (!slug || !/^[a-z0-9_-]{1,40}$/.test(slug)) {
  console.error('usage: node scripts/new-key.mjs <muse-slug>');
  process.exit(1);
}
const key = 'raise_' + randomBytes(24).toString('base64url');
const hash = createHash('sha256').update(key).digest('hex');
console.log(`key (give it to the Muse, shown once): ${key}\n`);
console.log(`INSERT INTO api_keys (key_hash, muse_id, created_at) SELECT '${hash}', id, ${Date.now()} FROM muses WHERE slug = '${slug}';`);
