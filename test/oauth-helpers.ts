// OAuth helpers shared by tests (same flow as test/oauth.test.ts): register an app, the Allow page, the token exchange.
import { expect } from 'vitest';
import { get } from './helpers';
import { s256 } from '../src/oauth-store';

export const REDIRECT = 'https://app.example/cb';
let ipN = 0;
export const ip = () => `10.40.${Math.floor(++ipN / 200)}.${ipN % 200}`;

export async function register(name = 'Test App', extra: Record<string, unknown> = {}) {
  const r = await get('/oauth/register', { method: 'POST', body: JSON.stringify({ client_name: name, redirect_uris: [REDIRECT], ...extra }), headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip() } });
  expect(r.status).toBe(201);
  return (await r.json()) as any;
}

export function pkce() {
  const verifier = 'v'.repeat(20) + crypto.randomUUID().replace(/-/g, '');
  return { verifier, challenge: s256(verifier) };
}

/** GET the Allow page, then POST the form with the consent cookie. Returns the redirect Location. */
export async function authorize(clientId: string, form: Record<string, string>, opts: { scope?: string; challenge?: string; cookie?: boolean } = {}) {
  const challenge = opts.challenge ?? (await pkce().challenge);
  const q = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: REDIRECT, state: 'st-1', code_challenge: challenge, code_challenge_method: 'S256', ...(opts.scope ? { scope: opts.scope } : {}) });
  const page = await get(`/oauth/authorize?${q}`);
  expect(page.status).toBe(200);
  const cookie = /__Host-raise_oauth=([^;]+)/.exec(page.headers.get('set-cookie') || '')![1]!;
  const body = new URLSearchParams({ ...Object.fromEntries(q), csrf: cookie, decision: 'allow', ...form });
  const r = await get('/oauth/authorize', { method: 'POST', body: body.toString(), redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', 'cf-connecting-ip': ip(), ...(opts.cookie === false ? {} : { cookie: `__Host-raise_oauth=${cookie}` }) } });
  return r;
}

export async function exchange(clientId: string, code: string, verifier: string) {
  const r = await get('/oauth/token', { method: 'POST', body: new URLSearchParams({ grant_type: 'authorization_code', client_id: clientId, code, code_verifier: verifier, redirect_uri: REDIRECT }).toString(), headers: { 'content-type': 'application/x-www-form-urlencoded', 'cf-connecting-ip': ip() } });
  return { status: r.status, body: (await r.json()) as any };
}

export async function refresh(clientId: string, token: string) {
  const r = await get('/oauth/token', { method: 'POST', body: new URLSearchParams({ grant_type: 'refresh_token', client_id: clientId, refresh_token: token }).toString(), headers: { 'content-type': 'application/x-www-form-urlencoded', 'cf-connecting-ip': ip() } });
  return { status: r.status, body: (await r.json()) as any };
}

/** Full flow for an existing Muse proved with its key. */
export async function connect(m: { key: string }, opts: { scope?: string; name?: string } = {}) {
  const c = await register(opts.name);
  const { verifier, challenge } = pkce();
  const r = await authorize(c.client_id, { bind: 'key', key: m.key }, { scope: opts.scope, challenge: await challenge });
  expect(r.status).toBe(302);
  const loc = new URL(r.headers.get('location')!);
  const t = await exchange(c.client_id, loc.searchParams.get('code')!, verifier);
  expect(t.status).toBe(200);
  return { client: c, tokens: t.body, verifier, code: loc.searchParams.get('code')! };
}

export const mcp = (body: unknown, token?: string, path = '/mcp') =>
  get(path, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip(), ...(token ? { authorization: `Bearer ${token}` } : {}) } });
export const call = async (name: string, args: Record<string, unknown>, token?: string) =>
  ((await (await mcp({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, token)).json()) as any).result;

