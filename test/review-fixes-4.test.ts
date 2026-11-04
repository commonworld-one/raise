// PR #24 review fixes: the server-side pepper for stored secrets (fail closed without it, legacy SHA-256 keys still
// work), one-tap links need write and a same-origin CSRF pair, a new Muse gets its key, MCP answers CORS preflight.
import { createExecutionContext, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import worker from '../src/index';
import { BASE, get, makeMuse, post, tapLink } from './helpers';
import { hmacHex, keyLookupHashes } from '../src/secrets';
import { sha256hex } from '../src/util';

const PEPPER = (env as any).RAISE_TOKEN_PEPPER as string;
/** The Worker with RAISE_TOKEN_PEPPER removed (or replaced), called directly. */
const noPepper = (path: string, init: RequestInit = {}, pepper?: string) =>
  worker.fetch(new Request(BASE + path, init), { ...(env as any), RAISE_TOKEN_PEPPER: pepper }, createExecutionContext());
const tapPath = (url: string) => new URL(url).pathname;

describe('pepper (RAISE_TOKEN_PEPPER)', () => {
  it('one-tap tokens are stored as HMAC-SHA256(pepper), not plain SHA-256', async () => {
    const m = await makeMuse('pepper-tap');
    const p = (await (await post('/api/v1/taps', { title: 'Peppered link token', wish: 'x' }, m.key, '10.40.0.1')).json()) as any;
    const token = tapPath(p.url).slice(3);
    const row = await env.DB.prepare('SELECT token_hash FROM tap_links WHERE muse_id = ?').bind(m.id).first<{ token_hash: string }>();
    expect(row!.token_hash).toBe(await hmacHex(PEPPER, `tap:${token}`));
    expect(row!.token_hash).not.toBe(await sha256hex(`tap:${token}`));
  });

  it('claim codes and OAuth client secrets are peppered too', async () => {
    const m = await makeMuse('pepper-claim');
    const cc = (await (await post('/api/v1/me/claim-code', {}, m.key, '10.40.0.2')).json()) as any;
    const row = await env.DB.prepare('SELECT code_hash FROM muse_claims WHERE muse_id = ?').bind(m.id).first<{ code_hash: string }>();
    expect(row!.code_hash).toBe(await hmacHex(PEPPER, `claim:${cc.code.replace('-', '')}`));
    const reg = await get('/oauth/register', { method: 'POST', body: JSON.stringify({ client_name: 'Secret app', redirect_uris: ['https://app.example/cb'], token_endpoint_auth_method: 'client_secret_post' }), headers: { 'content-type': 'application/json', 'cf-connecting-ip': '10.40.0.3' } });
    const c = (await reg.json()) as any;
    const h = await env.DB.prepare('SELECT client_secret_hash FROM oauth_clients WHERE client_id = ?').bind(c.client_id).first<{ client_secret_hash: string }>();
    expect(h!.client_secret_hash).toBe(await hmacHex(PEPPER, `oauth:${c.client_secret}`));
  });

  it('legacy RAISE keys stored as plain SHA-256 keep working, and are not re-hashed', async () => {
    const m = await makeMuse('pepper-legacy', 'Muse Code', true);
    const me = await get('/api/v1/me', { headers: { authorization: `Bearer ${m.key}` } });
    expect(me.status).toBe(200);
    expect(((await me.json()) as any).slug).toBe('pepper-legacy');
    expect(await env.DB.prepare('SELECT key_hash FROM api_keys WHERE muse_id = ?').bind(m.id).first('key_hash')).toBe(await sha256hex(m.key));
    // Peppered keys work too, and a peppered key is not accepted by its plain hash.
    const p = await makeMuse('pepper-new');
    expect((await get('/api/v1/me', { headers: { authorization: `Bearer ${p.key}` } })).status).toBe(200);
    expect(await keyLookupHashes(env as any, p.key)).toEqual([await hmacHex(PEPPER, p.key), await sha256hex(p.key)]);
  });

  it('fails closed without the pepper: no tap link, no OAuth client, no Allow-page code; legacy keys still read', async () => {
    const legacy = await makeMuse('pepper-off', 'Muse Code', true);
    const json = { 'content-type': 'application/json', 'cf-connecting-ip': '10.40.1.1', authorization: `Bearer ${legacy.key}` };
    const tap = await noPepper('/api/v1/taps', { method: 'POST', body: JSON.stringify({ title: 'Must not be prepared', wish: 'x' }), headers: json });
    expect(tap.status).toBe(500);
    expect(((await tap.json()) as any).error).toBe('server_misconfigured');
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM tap_links WHERE muse_id = ?').bind(legacy.id).first('n')).toBe(0);
    const reg = await noPepper('/oauth/register', { method: 'POST', body: JSON.stringify({ client_name: 'No pepper app', redirect_uris: ['https://app.example/cb'] }), headers: { 'content-type': 'application/json', 'cf-connecting-ip': '10.40.1.2' } });
    expect(reg.status).toBe(500);
    expect(((await reg.json()) as any).error).toBe('server_misconfigured');
    // A too-short pepper counts as missing.
    expect((await noPepper('/oauth/register', { method: 'POST', body: JSON.stringify({ client_name: 'Short pepper', redirect_uris: ['https://app.example/cb'] }), headers: { 'content-type': 'application/json', 'cf-connecting-ip': '10.40.1.3' } }, 'short')).status).toBe(500);
    // Legacy keys are plain SHA-256, so reading with one still works without the pepper.
    expect((await noPepper('/api/v1/me', { headers: { authorization: `Bearer ${legacy.key}` } })).status).toBe(200);
    // A peppered key cannot be checked without the pepper: unknown, never accepted by mistake.
    const peppered = await makeMuse('pepper-off-2');
    expect((await noPepper('/api/v1/me', { headers: { authorization: `Bearer ${peppered.key}` } })).status).toBe(401);
    // An OAuth access token is refused with 500, not checked against an unpeppered hash.
    const mcp = await noPepper('/mcp', { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }), headers: { 'content-type': 'application/json', authorization: 'Bearer rso_' + 'a'.repeat(43) } });
    expect(mcp.status).toBe(500);
  });
});

describe('one-tap links: CSRF and same origin', () => {
  async function prepared(slug: string) {
    const m = await makeMuse(slug);
    const p = (await (await post('/api/v1/taps', { title: `Link for ${slug}`, wish: 'x' }, m.key, '10.41.0.1')).json()) as any;
    return { m, url: p.url as string };
  }
  const count = async (id: number) => env.DB.prepare('SELECT COUNT(*) AS n FROM raises WHERE muse_id = ?').bind(id).first('n');

  it('the page sets a Strict, HttpOnly __Host- cookie and a form field; referrer stays same-origin', async () => {
    const { url } = await prepared('csrf-page');
    const page = await get(tapPath(url));
    expect(page.headers.get('set-cookie')).toMatch(/^__Host-raise_tap=[A-Za-z0-9_-]{32}; Path=\/; Max-Age=3600; HttpOnly; Secure; SameSite=Strict$/);
    expect(page.headers.get('referrer-policy')).toBe('same-origin');
    const html = await page.text();
    expect(html).toMatch(/name="csrf" value="[0-9a-f]{64}"/);
    expect(html).toContain('Whoever has this link can post it');
  });

  it('a POST without the cookie, with a wrong field, from another origin or with no origin at all posts nothing', async () => {
    const { m, url } = await prepared('csrf-refuse');
    const page = await get(tapPath(url));
    const cookie = /__Host-raise_tap=([^;]+)/.exec(page.headers.get('set-cookie')!)![1]!;
    const csrf = /name="csrf" value="([^"]+)"/.exec(await page.text())![1]!;
    const form = { 'content-type': 'application/x-www-form-urlencoded', 'cf-connecting-ip': '10.41.1.1' };
    const send = (headers: Record<string, string>, body = `do=post&csrf=${csrf}`) => get(tapPath(url), { method: 'POST', body, headers: { ...form, ...headers } });
    expect((await send({ origin: BASE })).status).toBe(403); // no cookie
    expect((await send({ origin: BASE, cookie: `__Host-raise_tap=${cookie}` }, 'do=post&csrf=' + '0'.repeat(64))).status).toBe(403);
    expect((await send({ origin: 'https://evil.example', cookie: `__Host-raise_tap=${cookie}` })).status).toBe(403);
    expect((await send({ 'sec-fetch-site': 'cross-site', cookie: `__Host-raise_tap=${cookie}` })).status).toBe(403);
    expect((await send({ cookie: `__Host-raise_tap=${cookie}` })).status).toBe(403); // neither Origin nor Sec-Fetch-Site
    expect(await count(m.id)).toBe(0);
    // The link is still open: the right pair posts it.
    const ok = await send({ origin: BASE, 'sec-fetch-site': 'same-origin', cookie: `__Host-raise_tap=${cookie}` });
    expect(ok.status).toBe(200);
    expect(await count(m.id)).toBe(1);
  });

  it('one cookie serves several open links; a field is bound to its own link', async () => {
    const a = await prepared('csrf-multi-a');
    const b = await prepared('csrf-multi-b');
    const pa = await get(tapPath(a.url));
    const cookie = /__Host-raise_tap=([^;]+)/.exec(pa.headers.get('set-cookie')!)![1]!;
    const csrfA = /name="csrf" value="([^"]+)"/.exec(await pa.text())![1]!;
    const pb = await get(tapPath(b.url), { headers: { cookie: `__Host-raise_tap=${cookie}` } });
    expect(pb.headers.get('set-cookie')).toContain(`__Host-raise_tap=${cookie};`);
    const headers = { 'content-type': 'application/x-www-form-urlencoded', origin: BASE, cookie: `__Host-raise_tap=${cookie}`, 'cf-connecting-ip': '10.41.2.1' };
    expect((await get(tapPath(b.url), { method: 'POST', body: `do=post&csrf=${csrfA}`, headers })).status).toBe(403);
    expect((await get(tapPath(a.url), { method: 'POST', body: `do=post&csrf=${csrfA}`, headers })).status).toBe(200);
  });

  it('the stamp stays "via one-tap link" and claims no human verification', async () => {
    const { m, url } = await prepared('csrf-stamp');
    expect((await tapLink(url)).status).toBe(200);
    const feed = ((await (await get(`/m/${m.slug}.json`)).json()) as any).activity;
    expect(feed[0].via.text).toBe('via one-tap link');
    expect(JSON.stringify(feed[0].via)).not.toMatch(/the human tapped|human-verified|verified human/i);
  });
});

describe('scopes: no "prepare"-only apps', () => {
  it('scope "prepare" is unknown at registration; the Allow page has no write checkbox', async () => {
    const reg = await get('/oauth/register', { method: 'POST', body: JSON.stringify({ client_name: 'Prepare only', redirect_uris: ['https://app.example/cb'], scope: 'read prepare' }), headers: { 'content-type': 'application/json', 'cf-connecting-ip': '10.42.0.1' } });
    expect(reg.status).toBe(400);
    const meta = (await (await get('/.well-known/oauth-authorization-server')).json()) as any;
    expect(meta.scopes_supported).toEqual(['read', 'write']);
    const ok = (await (await get('/oauth/register', { method: 'POST', body: JSON.stringify({ client_name: 'Normal', redirect_uris: ['https://app.example/cb'] }), headers: { 'content-type': 'application/json', 'cf-connecting-ip': '10.42.0.2' } })).json()) as any;
    const q = new URLSearchParams({ response_type: 'code', client_id: ok.client_id, redirect_uri: 'https://app.example/cb', code_challenge: 'x'.repeat(43), code_challenge_method: 'S256' });
    const html = await (await get(`/oauth/authorize?${q}`)).text();
    expect(html).not.toContain('allow_write');
    expect(html).not.toMatch(/[Uu]ntick/);
  });
});

describe('MCP CORS preflight', () => {
  for (const path of ['/mcp', '/mcp/me']) {
    it(`OPTIONS ${path} answers 204 with the MCP headers`, async () => {
      const r = await get(path, { method: 'OPTIONS', headers: { origin: 'https://client.example', 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization, content-type, mcp-session-id, mcp-protocol-version' } });
      expect(r.status).toBe(204);
      expect(r.headers.get('access-control-allow-origin')).toBe('*');
      expect(r.headers.get('access-control-allow-methods')).toContain('POST');
      const allowed = r.headers.get('access-control-allow-headers')!.toLowerCase();
      for (const h of ['authorization', 'content-type', 'mcp-session-id', 'mcp-protocol-version']) expect(allowed).toContain(h);
    });
  }
});
