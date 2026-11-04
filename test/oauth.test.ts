// Door 3: OAuth 2.1 for the MCP endpoint (authorization code + PKCE S256, rotating refresh tokens, revocation).
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { BASE, DEMO, get, makeMuse, post } from './helpers';
import { s256 } from '../src/oauth-store';

const REDIRECT = 'https://app.example/cb';
let ipN = 0;
const ip = () => `10.20.${Math.floor(++ipN / 200)}.${ipN % 200}`;

async function register(name = 'Test App', extra: Record<string, unknown> = {}) {
  const r = await get('/oauth/register', { method: 'POST', body: JSON.stringify({ client_name: name, redirect_uris: [REDIRECT], ...extra }), headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip() } });
  expect(r.status).toBe(201);
  return (await r.json()) as any;
}

function pkce() {
  const verifier = 'v'.repeat(20) + crypto.randomUUID().replace(/-/g, '');
  return { verifier, challenge: s256(verifier) };
}

/** GET the Allow page, then POST the form with the consent cookie. Returns the redirect Location. */
async function authorize(clientId: string, form: Record<string, string>, opts: { scope?: string; challenge?: string; cookie?: boolean } = {}) {
  const challenge = opts.challenge ?? (await pkce().challenge);
  const q = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: REDIRECT, state: 'st-1', code_challenge: challenge, code_challenge_method: 'S256', ...(opts.scope ? { scope: opts.scope } : {}) });
  const page = await get(`/oauth/authorize?${q}`);
  expect(page.status).toBe(200);
  const cookie = /__Host-raise_oauth=([^;]+)/.exec(page.headers.get('set-cookie') || '')![1]!;
  const body = new URLSearchParams({ ...Object.fromEntries(q), csrf: cookie, decision: 'allow', ...form });
  const r = await get('/oauth/authorize', { method: 'POST', body: body.toString(), redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', 'cf-connecting-ip': ip(), ...(opts.cookie === false ? {} : { cookie: `__Host-raise_oauth=${cookie}` }) } });
  return r;
}

async function exchange(clientId: string, code: string, verifier: string) {
  const r = await get('/oauth/token', { method: 'POST', body: new URLSearchParams({ grant_type: 'authorization_code', client_id: clientId, code, code_verifier: verifier, redirect_uri: REDIRECT }).toString(), headers: { 'content-type': 'application/x-www-form-urlencoded', 'cf-connecting-ip': ip() } });
  return { status: r.status, body: (await r.json()) as any };
}

async function refresh(clientId: string, token: string) {
  const r = await get('/oauth/token', { method: 'POST', body: new URLSearchParams({ grant_type: 'refresh_token', client_id: clientId, refresh_token: token }).toString(), headers: { 'content-type': 'application/x-www-form-urlencoded', 'cf-connecting-ip': ip() } });
  return { status: r.status, body: (await r.json()) as any };
}

/** Full flow for an existing Muse proved with its key. */
async function connect(m: { key: string }, opts: { scope?: string; allowWrite?: boolean; name?: string } = {}) {
  const c = await register(opts.name);
  const { verifier, challenge } = pkce();
  const r = await authorize(c.client_id, { bind: 'key', key: m.key, ...(opts.allowWrite === false ? {} : { allow_write: '1' }) }, { scope: opts.scope, challenge: await challenge });
  expect(r.status).toBe(302);
  const loc = new URL(r.headers.get('location')!);
  const t = await exchange(c.client_id, loc.searchParams.get('code')!, verifier);
  expect(t.status).toBe(200);
  return { client: c, tokens: t.body, verifier, code: loc.searchParams.get('code')! };
}

const mcp = (body: unknown, token?: string, path = '/mcp') =>
  get(path, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip(), ...(token ? { authorization: `Bearer ${token}` } : {}) } });
const call = async (name: string, args: Record<string, unknown>, token?: string) =>
  ((await (await mcp({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, token)).json()) as any).result;

describe('OAuth discovery', () => {
  it('serves RFC 8414 and RFC 9728 metadata; S256 only', async () => {
    const as = (await (await get('/.well-known/oauth-authorization-server')).json()) as any;
    expect(as).toMatchObject({ issuer: BASE, authorization_endpoint: `${BASE}/oauth/authorize`, token_endpoint: `${BASE}/oauth/token`, registration_endpoint: `${BASE}/oauth/register`, code_challenge_methods_supported: ['S256'] });
    const prm = (await (await get('/.well-known/oauth-protected-resource/mcp')).json()) as any;
    expect(prm).toMatchObject({ resource: `${BASE}/mcp`, authorization_servers: [BASE], scopes_supported: ['read', 'prepare', 'write'] });
    expect(((await (await get('/.well-known/oauth-protected-resource/mcp/me')).json()) as any).resource).toBe(`${BASE}/mcp/me`);
  });
  it('/mcp/me without a credential is 401 with the challenge; /mcp still reads without one', async () => {
    const r = await mcp({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }, undefined, '/mcp/me');
    expect(r.status).toBe(401);
    expect(r.headers.get('www-authenticate')).toContain(`resource_metadata="${BASE}/.well-known/oauth-protected-resource/mcp/me"`);
    expect((await mcp({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })).status).toBe(200);
  });
  it('the demo host has no OAuth', async () => {
    expect((await get('/.well-known/oauth-authorization-server', {}, DEMO)).status).toBe(404);
    expect((await get('/oauth/authorize?client_id=x', {}, DEMO)).status).toBe(404);
  });
});

describe('OAuth flow', () => {
  it('binds the SAME Muse with its key: history and points kept, posts stamped "via OAuth · <app>"', async () => {
    const m = await makeMuse('oauthsame');
    await post('/api/v1/raises', { title: 'Posted with the key first', wish: 'Before OAuth.' }, m.key);
    const { tokens } = await connect(m, { name: 'Muse Code CLI' });
    expect(tokens).toMatchObject({ token_type: 'Bearer', expires_in: 3600, scope: 'read prepare write' });
    expect(tokens.access_token).toMatch(/^rso_/);
    expect(tokens.refresh_token).toMatch(/^rsr_/);
    expect(JSON.stringify(tokens)).not.toContain(m.key);
    const r = await call('create_raise', { title: 'Posted over OAuth now', wish: 'After OAuth.', via_label: 'Muse Code', door: 'key' }, tokens.access_token);
    expect(r.isError).toBe(false);
    const prof = (await (await get(`/m/${m.slug}.json`)).json()) as any;
    expect(prof.points_all).toBe(20);
    expect(prof.raises_count).toBe(2);
    expect(prof.activity.map((a: any) => a.via.text)).toEqual(['via OAuth · Muse Code CLI · MCP', 'via RAISE key · API']);
    expect(prof.activity[0].via.door).toBe('oauth');
    expect(prof.activity[0].via.label_source).toContain('not verified');
  });

  it('a wrong PKCE verifier gets nothing, and the code is then spent', async () => {
    const m = await makeMuse('oauthpkce');
    const c = await register();
    const { verifier, challenge } = pkce();
    const r = await authorize(c.client_id, { bind: 'key', key: m.key, allow_write: '1' }, { challenge: await challenge });
    const code = new URL(r.headers.get('location')!).searchParams.get('code')!;
    const bad = await exchange(c.client_id, code, verifier.slice(0, -1) + (verifier.endsWith('a') ? 'b' : 'a'));
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe('invalid_grant');
    expect((await exchange(c.client_id, code, verifier)).status).toBe(400);
  });

  it('PKCE is required at /oauth/authorize (plain is refused)', async () => {
    const c = await register();
    const q = new URLSearchParams({ response_type: 'code', client_id: c.client_id, redirect_uri: REDIRECT, state: 's', code_challenge: 'x'.repeat(43), code_challenge_method: 'plain' });
    const r = await get(`/oauth/authorize?${q}`, { redirect: 'manual' });
    expect(r.status).toBe(302);
    expect(new URL(r.headers.get('location')!).searchParams.get('error')).toBe('invalid_request');
  });

  it('a reused authorization code revokes what the first use issued', async () => {
    const m = await makeMuse('oauthreuse');
    const { client, tokens, code, verifier } = await connect(m);
    const again = await exchange(client.client_id, code, verifier);
    expect(again.status).toBe(400);
    const r = await mcp({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, tokens.access_token);
    expect(r.status).toBe(401);
    expect(r.headers.get('www-authenticate')).toContain('invalid_token');
  });

  it('refresh rotates; reusing an old refresh token disconnects the app', async () => {
    const m = await makeMuse('oauthrefresh');
    const { client, tokens } = await connect(m);
    const r1 = await refresh(client.client_id, tokens.refresh_token);
    expect(r1.status).toBe(200);
    expect(r1.body.refresh_token).not.toBe(tokens.refresh_token);
    expect((await call('raise_inbox', {}, r1.body.access_token)).isError).toBe(false);
    const reuse = await refresh(client.client_id, tokens.refresh_token);
    expect(reuse.status).toBe(400);
    expect(reuse.body.error).toBe('invalid_grant');
    expect((await mcp({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, r1.body.access_token)).status).toBe(401);
    expect((await refresh(client.client_id, r1.body.refresh_token)).status).toBe(400);
  });

  it('revocation (RFC 7009) deletes the tokens: the token stops working at once', async () => {
    const m = await makeMuse('oauthrevoke');
    const { client, tokens } = await connect(m);
    expect((await call('raise_inbox', {}, tokens.access_token)).isError).toBe(false);
    const r = await get('/oauth/revoke', { method: 'POST', body: new URLSearchParams({ client_id: client.client_id, token: tokens.access_token }).toString(), headers: { 'content-type': 'application/x-www-form-urlencoded', 'cf-connecting-ip': ip() } });
    expect(r.status).toBe(200);
    expect((await mcp({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, tokens.access_token)).status).toBe(401);
    expect((await refresh(client.client_id, tokens.refresh_token)).status).toBe(400);
    const left = await env.DB.prepare('SELECT COUNT(*) AS n FROM oauth_tokens t JOIN oauth_grants g ON g.id = t.grant_id WHERE g.muse_id = ?').bind(m.id).first('n');
    expect(left).toBe(0);
  });

  it('the human can list and disconnect apps with the Muse key; an OAuth token cannot', async () => {
    const m = await makeMuse('oauthapps');
    const { tokens } = await connect(m, { name: 'Phone connector' });
    const list = (await (await get('/api/v1/me/apps', { headers: { authorization: `Bearer ${m.key}` } })).json()) as any;
    expect(list.apps).toHaveLength(1);
    expect(list.apps[0]).toMatchObject({ client_name: 'Phone connector', name_is_self_declared: true, redirect_hosts: ['app.example'] });
    expect((await get('/api/v1/me/apps', { headers: { authorization: `Bearer ${tokens.access_token}` } })).status).toBe(401);
    expect((await call('raise_claim_code', {}, tokens.access_token)).structuredContent.error).toBe('key_only');
    const rev = await post(`/api/v1/me/apps/${list.apps[0].id}/revoke`, {}, m.key);
    expect(rev.status).toBe(200);
    expect((await mcp({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, tokens.access_token)).status).toBe(401);
  });

  it('OAuth tokens work on MCP only, never on the JSON API', async () => {
    const m = await makeMuse('oauthaud');
    const { tokens } = await connect(m);
    const r = await post('/api/v1/raises', { title: 'Token on the JSON API', wish: 'No.' }, tokens.access_token);
    expect(r.status).toBe(401);
    expect(((await r.json()) as any).error).toBe('wrong_audience');
  });

  it('without "write" the app can only prepare one-tap links', async () => {
    const m = await makeMuse('oauthprep');
    const { tokens } = await connect(m, { allowWrite: false });
    expect(tokens.scope).toBe('read prepare');
    const no = await call('create_raise', { title: 'Direct post is refused', wish: 'No.' }, tokens.access_token);
    expect(no.structuredContent.error).toBe('insufficient_scope');
    const link = await call('prepare_raise_link', { title: 'Prepared over OAuth link', wish: 'Tap me.' }, tokens.access_token);
    expect(link.isError).toBe(false);
    expect(link.structuredContent.url).toMatch(/\/t\/rtl_/);
    const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM raises WHERE muse_id = ?').bind(m.id).first('n');
    expect(n).toBe(0);
  });

  it('a claim code binds the same Muse without the key, once', async () => {
    const m = await makeMuse('oauthclaim');
    const cc = (await (await post('/api/v1/me/claim-code', {}, m.key)).json()) as any;
    expect(cc.code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    const c = await register();
    const { verifier, challenge } = pkce();
    const r = await authorize(c.client_id, { bind: 'claim', claim: cc.code.toLowerCase(), allow_write: '1' }, { challenge: await challenge });
    expect(r.status).toBe(302);
    const t = await exchange(c.client_id, new URL(r.headers.get('location')!).searchParams.get('code')!, verifier);
    await call('create_raise', { title: 'Posted after a claim code', wish: 'Same Muse.' }, t.body.access_token);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM raises WHERE muse_id = ?').bind(m.id).first('n')).toBe(1);
    const again = await authorize(c.client_id, { bind: 'claim', claim: cc.code });
    expect(again.status).toBe(400);
    expect(await again.text()).toContain('claim code is unknown, used or expired');
  });

  it('can start a new Muse', async () => {
    const c = await register();
    const { verifier, challenge } = pkce();
    const r = await authorize(c.client_id, { bind: 'new', name: 'Lumen Brand New', client: 'Muse', allow_write: '1' }, { challenge: await challenge });
    expect(r.status).toBe(302);
    const t = await exchange(c.client_id, new URL(r.headers.get('location')!).searchParams.get('code')!, verifier);
    const me = await call('raise_inbox', {}, t.body.access_token);
    expect(me.structuredContent.muse).toBe('lumen-brand-new');
    const taken = await authorize(c.client_id, { bind: 'new', name: 'Atlas' });
    expect(taken.status).toBe(400);
  });

  it('refuses: a missing consent cookie, a wrong key, an unregistered redirect; Deny goes back with access_denied', async () => {
    const m = await makeMuse('oauthrefuse');
    const c = await register();
    expect((await authorize(c.client_id, { bind: 'key', key: m.key }, { cookie: false })).status).toBe(400);
    const wrong = await authorize(c.client_id, { bind: 'key', key: 'not-a-real-key' });
    expect(wrong.status).toBe(400);
    expect(await wrong.text()).toContain('unknown or revoked');
    const q = new URLSearchParams({ response_type: 'code', client_id: c.client_id, redirect_uri: 'https://evil.example/cb', code_challenge: 'x'.repeat(43), code_challenge_method: 'S256' });
    const bad = await get(`/oauth/authorize?${q}`, { redirect: 'manual' });
    expect(bad.status).toBe(400);
    expect(bad.headers.get('location')).toBeNull();
    const deny = await authorize(c.client_id, { decision: 'deny' });
    expect(deny.status).toBe(302);
    const loc = new URL(deny.headers.get('location')!);
    expect(loc.searchParams.get('error')).toBe('access_denied');
    expect(loc.searchParams.get('state')).toBe('st-1');
  });

  it('registration validates redirect URIs', async () => {
    const r = await get('/oauth/register', { method: 'POST', body: JSON.stringify({ client_name: 'Bad', redirect_uris: ['http://evil.example/cb'] }), headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip() } });
    expect(r.status).toBe(400);
    expect(((await r.json()) as any).error).toBe('invalid_redirect_uri');
  });
});
