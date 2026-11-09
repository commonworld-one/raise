import { env } from 'cloudflare:test';
import { exports } from 'cloudflare:workers';
import { keyHash } from '../src/secrets';
import { DEMO_REFERENCE_MS, sha256hex } from '../src/util';
import { API_PREFIX, handleApi } from '../src/api';
import { handleMcp } from '../src/mcp';
import type { Ctx } from '../src/types';

/** Any host that is not the demo host is the product (DB). */
export const BASE = 'https://raise.test';
/** The demo host from wrangler.jsonc DEMO_SITE_URL (DEMO_DB). */
export const DEMO = 'https://raise-demo.commonworld.one';
export const PROD = 'https://raise.commonworld.one';
export const get = (path: string, init: RequestInit = {}, base = BASE) => (exports as any).default.fetch(new Request(base + path, init)) as Promise<Response>;
export const post = (path: string, body: unknown, key?: string, ip = '10.0.0.1', base = BASE) =>
  get(path, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip, ...(key ? { authorization: `Bearer ${key}` } : {}) },
  }, base);
/** Same as get, on the demo host (pages only: the demo host 404s the JSON API and MCP). */
export const dget = (path: string, init: RequestInit = {}) => get(path, init, DEMO);
/**
 * The JSON API and MCP handlers run against DEMO_DB with a demo context, called directly: the demo host no
 * longer routes them (it serves pages only), but the demo-mode logic (as / as_muse, DEMO_DB) stays covered.
 */
export function dapi(path: string, init: RequestInit = {}): Promise<Response> {
  const req = new Request(DEMO + path, init);
  const u = new URL(req.url);
  const now = Date.now();
  const ctx: Ctx = { env: env as any, db: env.DEMO_DB, demo: true, base: '', origin: DEMO, path: u.pathname, search: u.search, now, ageNow: DEMO_REFERENCE_MS, ip: req.headers.get('cf-connecting-ip') || 'local' };
  if (u.pathname === '/mcp') return handleMcp(ctx, req);
  if (!u.pathname.startsWith(API_PREFIX)) throw new Error(`dapi: not an API path: ${path}`);
  return handleApi(ctx, req, u.pathname.slice(API_PREFIX.length), u);
}
export const dpost = (path: string, body: unknown, key?: string, ip = '10.0.0.1') =>
  dapi(path, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip, ...(key ? { authorization: `Bearer ${key}` } : {}) } });

let n = 0;
/**
 * A tap on a one-tap link as a browser does it: GET the page (CSRF cookie + form field), then POST the form
 * same-origin with the cookie. When the page is not 200 (unknown, used, expired) the POST goes without them.
 */
export async function tapLink(url: string, what: 'post' | 'cancel' = 'post', ip = '10.7.0.1'): Promise<Response> {
  const path = new URL(url).pathname;
  const page = await get(path, { headers: { 'cf-connecting-ip': ip } });
  const cookie = /__Host-raise_tap=([^;]+)/.exec(page.headers.get('set-cookie') || '')?.[1];
  const csrf = /name="csrf" value="([^"]+)"/.exec(await page.text())?.[1];
  return get(path, {
    method: 'POST', body: `do=${what}${csrf ? `&csrf=${csrf}` : ''}`,
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'cf-connecting-ip': ip, origin: BASE, 'sec-fetch-site': 'same-origin', ...(cookie ? { cookie: `__Host-raise_tap=${cookie}` } : {}) },
  });
}

/**
 * Create a real Muse in the prod DB with a bearer key (stored peppered, like keys the Worker issues).
 * It has a name and an avatar, so it is not a draft; `draft: true` leaves the avatar out (src/draft.ts).
 */
export async function makeMuse(slug = `muse${++n}`, client = 'Muse Code', legacy = false, draft = false): Promise<{ id: number; key: string; slug: string }> {
  const row = await env.DB.prepare('INSERT INTO muses (slug, name, client, tagline, avatar_url, created_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING id')
    .bind(slug, slug[0]!.toUpperCase() + slug.slice(1), client, 'Test Muse', draft ? null : '/avatars/bob.png', Date.now())
    .first<{ id: number }>();
  const key = `test-key-${slug}-${crypto.randomUUID()}`;
  await env.DB.prepare('INSERT INTO api_keys (key_hash, muse_id, created_at) VALUES (?, ?, ?)').bind(legacy ? await sha256hex(key) : await keyHash(env as any, key), row!.id, Date.now()).run();
  return { id: row!.id, key, slug };
}

/** A Muse with the granter role (muses.granter, migration 0010), which only a human admin sets in D1. */
export async function makeGranter(slug?: string): Promise<{ id: number; key: string; slug: string }> {
  const m = await makeMuse(slug);
  await env.DB.prepare('UPDATE muses SET granter = 1 WHERE id = ?').bind(m.id).run();
  return m;
}
