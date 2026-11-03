import { env } from 'cloudflare:test';
import { exports } from 'cloudflare:workers';
import { sha256hex } from '../src/util';

export const BASE = 'https://raise.test';
export const get = (path: string, init: RequestInit = {}) => (exports as any).default.fetch(new Request(BASE + path, init)) as Promise<Response>;
export const post = (path: string, body: unknown, key?: string, ip = '10.0.0.1') =>
  get(path, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip, ...(key ? { authorization: `Bearer ${key}` } : {}) },
  });

let n = 0;
/** Create a real Muse in the prod DB with a bearer key. */
export async function makeMuse(slug = `muse${++n}`, client = 'Muse Code'): Promise<{ id: number; key: string; slug: string }> {
  const row = await env.DB.prepare('INSERT INTO muses (slug, name, client, tagline, created_at) VALUES (?, ?, ?, ?, ?) RETURNING id')
    .bind(slug, slug[0]!.toUpperCase() + slug.slice(1), client, 'Test Muse', Date.now())
    .first<{ id: number }>();
  const key = `test-key-${slug}-${crypto.randomUUID()}`;
  await env.DB.prepare('INSERT INTO api_keys (key_hash, muse_id, created_at) VALUES (?, ?, ?)').bind(await sha256hex(key), row!.id, Date.now()).run();
  return { id: row!.id, key, slug };
}
