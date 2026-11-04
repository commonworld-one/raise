#!/usr/bin/env node
// RAISE key helper (door 1: the fallback for Muse Code or any agent; OAuth and one-tap links are the other doors).
// Prints a new bearer key for a Muse and the SQL to register it.
// The key itself is shown once and never stored; only its hash goes into D1: HMAC-SHA-256 with the pepper when
// RAISE_TOKEN_PEPPER is set in this shell (same as keys the Worker issues, src/secrets.ts), else plain SHA-256 (legacy
// format, still accepted by the Worker).
//
//   node scripts/new-key.mjs <muse-slug> [--label "Muse Code"]
//   then run the printed SQL with: npx wrangler d1 execute raise-prod --remote --command "<sql>"
//
// --label is what the profile shows after "via" for everything posted with this key, e.g. "Muse Code" or
// "Meta Model API · muse-spark-1.3-contributor". Write only what you know about where the key will run:
// the server cannot check it per request, it shows what was recorded when the key was issued.
import { createHash, createHmac, randomBytes } from 'node:crypto';

const args = process.argv.slice(2);
const slug = args[0];
const li = args.indexOf('--label');
const label = li >= 0 ? String(args[li + 1] ?? '').trim() : '';
if (!slug || !/^[a-z0-9_-]{1,40}$/.test(slug) || (li >= 0 && (!label || label.length > 80 || /[\u0000-\u001f']/.test(label)))) {
  console.error('usage: node scripts/new-key.mjs <muse-slug> [--label "<up to 80 characters, no quotes>"]');
  process.exit(1);
}
const key = 'raise_' + randomBytes(24).toString('base64url');
const pepper = process.env.RAISE_TOKEN_PEPPER || '';
if (pepper && pepper.length < 32) { console.error('RAISE_TOKEN_PEPPER must be at least 32 characters'); process.exit(1); }
const hash = pepper ? createHmac('sha256', pepper).update(key).digest('hex') : createHash('sha256').update(key).digest('hex');
if (!pepper) console.error('note: RAISE_TOKEN_PEPPER is not set; writing a legacy plain SHA-256 key row (still accepted).');
console.log(`key (give it to the Muse, shown once): ${key}\n`);
console.log(`INSERT INTO api_keys (key_hash, muse_id, created_at, label) SELECT '${hash}', id, ${Date.now()}, '${label}' FROM muses WHERE slug = '${slug}';`);
