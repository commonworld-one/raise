// OAuth 2.1 endpoints (door 3; constants and storage in src/oauth-store.ts). Product host only.
//
//   GET  /.well-known/oauth-protected-resource[/mcp|/mcp/me]  RFC 9728 Protected Resource Metadata
//   GET  /.well-known/oauth-authorization-server              RFC 8414 Authorization Server Metadata
//   POST /oauth/register                                      RFC 7591 Dynamic Client Registration
//   GET  /oauth/authorize                                     the Allow page (bind an existing Muse, or create one)
//   POST /oauth/authorize                                     the human's decision -> redirect with code (or error)
//   POST /oauth/token                                         authorization_code (PKCE S256 required), refresh_token (rotated)
//   POST /oauth/revoke                                        RFC 7009, revokes the whole grant
//
// On the Allow page the human binds the SAME Muse profile the RAISE key uses (proved with that key, or with a short
// claim code the Muse got with its key) or creates a new Muse. History and points stay on the profile. A pasted key is
// only checked, never shown or handed out; the app only ever gets its own tokens. A new Muse gets a RAISE key that is
// shown once, to the human, on a page before going back to the app: it is the only way back to that Muse
// (claim codes and connected apps are managed with it). Every secret is stored as HMAC-SHA256 with the pepper.
import type { Ctx } from './types';
import { ActionError, clean, hit, resolveMuse } from './actions';
import { CHARACTERS } from './characters';
import { getMuseById, type MuseRow } from './data';
import { SCOPES, SCOPE_TEXT, randomToken, sameString } from './doors';
import { keyHash, requirePepper } from './secrets';
import {
  ACCESS_PATTERN, ALLOW_PER_IP_PER_HOUR, AS_METADATA_PATH, CHALLENGE_PATTERN, CLIENT_SECRET_PATTERN, CODE_PATTERN, CONSENT_COOKIE, CONSENT_TTL_S, DCR,
  NEW_MUSES_PER_IP_PER_DAY, OAUTH_PATHS, PRM_PATH, REFRESH_PATTERN, TOKEN_RATE_PER_MINUTE, VERIFIER_PATTERN,
  canonicalResource, consumeCode, createCode, createGrant, findRefresh, getClient, grantOfToken, insertClient, isLoopback, mcpResource,
  parseScope, recordCodeReplay, redirectMatches, redirectProblem, revokeGrant, rotateRefresh, s256, scopeString, tokenHash, useClaim, type Client, type McpEndpoint,
} from './oauth-store';
import { esc, json } from './util';
import * as V from './views';

const CORS = { 'access-control-allow-origin': '*', 'access-control-expose-headers': 'WWW-Authenticate, Retry-After' };
const PREFLIGHT = { ...CORS, 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'Authorization, Content-Type, MCP-Protocol-Version', 'access-control-max-age': '86400' };
const NO_STORE = { 'cache-control': 'no-store', pragma: 'no-cache' };
const PAGE_HEADERS = { ...NO_STORE, 'x-robots-tag': 'noindex', 'x-frame-options': 'DENY', 'content-security-policy': "frame-ancestors 'none'", 'referrer-policy': 'no-referrer' };

class OAuthError extends Error {
  constructor(public status: number, public error: string, public description: string, public headers: Record<string, string> = {}) { super(error); }
}
const oauthJson = (status: number, body: unknown, headers: Record<string, string> = {}) => json(body, { status, headers: { ...CORS, ...NO_STORE, ...headers } });

const OAUTH_API = new Set<string>([PRM_PATH, `${PRM_PATH}/mcp`, `${PRM_PATH}/mcp/me`, AS_METADATA_PATH, OAUTH_PATHS.register, OAUTH_PATHS.token, OAUTH_PATHS.revoke]);
export const isOAuthPath = (path: string) => OAUTH_API.has(path) || path === OAUTH_PATHS.authorize;

export function protectedResourceMetadata(origin: string, endpoint: McpEndpoint) {
  return {
    resource: mcpResource(origin, endpoint),
    authorization_servers: [origin],
    scopes_supported: [...SCOPES],
    bearer_methods_supported: ['header'],
    resource_name: endpoint === '/mcp/me' ? 'Muse RAISE MCP (sign-in required)' : 'Muse RAISE MCP',
    resource_documentation: `${origin}/mcp`,
    'x-raise': {
      anonymous_access: endpoint === '/mcp/me' ? 'none: a request without a credential gets 401' : 'read tools work without a credential',
      api_key_alternative: 'Authorization: Bearer <RAISE key> also works (the key is never handed out over OAuth)',
      token_audience: `One MCP server, two URLs: a token works at ${mcpResource(origin, '/mcp')} and ${mcpResource(origin, '/mcp/me')}, never on /api/v1.`,
      scopes: SCOPE_TEXT,
    },
  };
}

export function authorizationServerMetadata(origin: string) {
  return {
    issuer: origin,
    authorization_endpoint: `${origin}${OAUTH_PATHS.authorize}`,
    token_endpoint: `${origin}${OAUTH_PATHS.token}`,
    registration_endpoint: `${origin}${OAUTH_PATHS.register}`,
    revocation_endpoint: `${origin}${OAUTH_PATHS.revoke}`,
    scopes_supported: [...SCOPES],
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_post'],
    revocation_endpoint_auth_methods_supported: ['none', 'client_secret_post'],
    code_challenge_methods_supported: ['S256'],
    authorization_response_iss_parameter_supported: true,
    client_id_metadata_document_supported: false,
    service_documentation: `${origin}/mcp`,
  };
}

/** 401 challenge for the MCP endpoint (RFC 6750 + RFC 9728 resource_metadata). */
export function mcpChallenge(origin: string, endpoint: McpEndpoint, error?: 'invalid_token', description?: string): Response {
  const parts = [`Bearer resource_metadata="${origin}${PRM_PATH}${endpoint}"`, `scope="${SCOPES.join(' ')}"`];
  if (error) parts.push(`error="${error}"`, `error_description="${(description || '').replace(/"/g, "'")}"`);
  return json({ jsonrpc: '2.0', id: null, error: { code: -32001, message: description || 'Authentication required. Connect over OAuth or send a RAISE key.' } },
    { status: 401, headers: { ...CORS, 'www-authenticate': parts.join(', ') } });
}

export async function handleOAuth(ctx: Ctx, req: Request, path: string): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: PREFLIGHT });
  if (path === OAUTH_PATHS.authorize) return authorizePage(ctx, req);
  if (path === AS_METADATA_PATH || path.startsWith(PRM_PATH)) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return json({ error: 'method_not_allowed' }, { status: 405, headers: { ...CORS, allow: 'GET, HEAD, OPTIONS' } });
    const doc = path === AS_METADATA_PATH ? authorizationServerMetadata(ctx.origin) : protectedResourceMetadata(ctx.origin, path.endsWith('/mcp/me') ? '/mcp/me' : '/mcp');
    return json(doc, { headers: { ...CORS, 'cache-control': 'public, max-age=300' } });
  }
  if (req.method !== 'POST') return oauthJson(405, { error: 'invalid_request', error_description: 'POST only' }, { allow: 'POST, OPTIONS' });
  try {
    if (path === OAUTH_PATHS.register) return await register(ctx, req);
    if (path === OAUTH_PATHS.token) return await token(ctx, req);
    return await revoke(ctx, req);
  } catch (e) {
    if (e instanceof OAuthError) return oauthJson(e.status, { error: e.error, error_description: e.description }, e.headers);
    if (e instanceof ActionError && e.status === 429) return oauthJson(429, { error: 'slow_down', error_description: e.message }, { 'retry-after': '60' });
    throw e;
  }
}

async function readParams(req: Request): Promise<URLSearchParams> {
  const text = await req.text();
  if (text.length > 8192) throw new OAuthError(413, 'invalid_request', 'body too large');
  const type = req.headers.get('content-type') ?? '';
  if (/^application\/json\b/i.test(type)) {
    let o: unknown;
    try { o = JSON.parse(text || '{}'); } catch { throw new OAuthError(400, 'invalid_request', 'body is not valid JSON'); }
    if (!o || typeof o !== 'object' || Array.isArray(o)) throw new OAuthError(400, 'invalid_request', 'body must be an object');
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(o)) if (typeof v === 'string') p.set(k, v);
    return p;
  }
  if (type && !/^application\/x-www-form-urlencoded\b/i.test(type)) throw new OAuthError(400, 'invalid_request', 'use application/x-www-form-urlencoded');
  const p = new URLSearchParams(text);
  for (const k of new Set(p.keys())) if (p.getAll(k).length > 1) throw new OAuthError(400, 'invalid_request', `parameter ${k.slice(0, 32)} repeated`);
  return p;
}

const minute = (ctx: Ctx) => new Date(ctx.now).toISOString().slice(0, 16);
async function tokenRate(ctx: Ctx) {
  if (!(await hit(ctx.db, `ip:${ctx.ip}:oauth-token`, minute(ctx), TOKEN_RATE_PER_MINUTE))) throw new OAuthError(429, 'slow_down', 'too many requests; wait a minute', { 'retry-after': '60' });
}

// ---------------------------------------------------------------- RFC 7591 registration

const CONTROL = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/;

async function register(ctx: Ctx, req: Request): Promise<Response> {
  if (!(await hit(ctx.db, `ip:${ctx.ip}:oauth-reg`, new Date(ctx.now).toISOString().slice(0, 13), DCR.clientsPerIpPerHour)))
    throw new OAuthError(429, 'slow_down', 'too many registrations from this address; try again next hour', { 'retry-after': '3600' });
  const text = await req.text();
  if (text.length > 16 * 1024) throw new OAuthError(413, 'invalid_client_metadata', 'body too large');
  if (!/^application\/json\b/i.test(req.headers.get('content-type') ?? '')) throw new OAuthError(400, 'invalid_client_metadata', 'Content-Type must be application/json');
  let body: Record<string, unknown>;
  try { body = JSON.parse(text); } catch { throw new OAuthError(400, 'invalid_client_metadata', 'body is not valid JSON'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new OAuthError(400, 'invalid_client_metadata', 'body must be a JSON object');
  const bad = (d: string): never => { throw new OAuthError(400, 'invalid_client_metadata', d); };
  const uris = body.redirect_uris;
  if (!Array.isArray(uris) || uris.length < 1 || uris.length > DCR.maxRedirectUris) throw new OAuthError(400, 'invalid_redirect_uri', `redirect_uris must be an array of 1-${DCR.maxRedirectUris} URIs`);
  for (const u of uris) { const p = redirectProblem(u); if (p) throw new OAuthError(400, 'invalid_redirect_uri', p); }
  const rawName = body.client_name === undefined ? 'Unnamed app' : body.client_name;
  if (typeof rawName !== 'string') return bad('client_name must be a string');
  const name = rawName.trim();
  if (!name || name.length > DCR.maxNameLength) return bad(`client_name must be 1-${DCR.maxNameLength} characters`);
  if (CONTROL.test(name)) return bad('client_name must not contain control or direction-changing characters');
  const grants = body.grant_types === undefined ? ['authorization_code', 'refresh_token'] : body.grant_types;
  if (!Array.isArray(grants) || !grants.length || grants.some((g) => g !== 'authorization_code' && g !== 'refresh_token') || !grants.includes('authorization_code'))
    return bad('grant_types must contain authorization_code and may contain refresh_token');
  const responseTypes = body.response_types === undefined ? ['code'] : body.response_types;
  if (!Array.isArray(responseTypes) || responseTypes.length !== 1 || responseTypes[0] !== 'code') return bad('response_types must be ["code"]');
  const method = body.token_endpoint_auth_method === undefined ? 'none' : body.token_endpoint_auth_method;
  if (method !== 'none' && method !== 'client_secret_post') return bad('token_endpoint_auth_method must be none or client_secret_post');
  const scopes = body.scope === undefined ? [...SCOPES] : typeof body.scope === 'string' ? parseScope(body.scope) : null;
  if (!scopes || !scopes.length) return bad(`scope must be a space-separated subset of: ${SCOPES.join(' ')}`);
  if (!(await hit(ctx.db, 'site:oauth-reg', new Date(ctx.now).toISOString().slice(0, 10), DCR.clientsPerDay)))
    throw new OAuthError(429, 'slow_down', 'registration is closed for today', { 'retry-after': '3600' });
  const g = [...new Set(grants as string[])];
  const { clientId, secret } = await insertClient(ctx, { client_name: name, redirect_uris: uris as string[], grant_types: g, method, scope: scopeString(scopes) }, ctx.now);
  return oauthJson(201, {
    client_id: clientId, client_id_issued_at: Math.floor(ctx.now / 1000),
    ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}),
    client_name: name, redirect_uris: uris, grant_types: g, response_types: ['code'], token_endpoint_auth_method: method, scope: scopeString(scopes),
  });
}

// ---------------------------------------------------------------- client authentication

async function authenticateClient(ctx: Ctx, p: URLSearchParams, req: Request): Promise<Client> {
  if (req.headers.has('authorization')) throw new OAuthError(401, 'invalid_client', 'use client_secret_post (or none for public clients); HTTP Basic is not supported', { 'www-authenticate': 'Basic realm="raise"' });
  const client = await getClient(ctx.db, p.get('client_id') ?? '');
  if (!client) throw new OAuthError(401, 'invalid_client', 'unknown client_id');
  if (client.token_endpoint_auth_method === 'client_secret_post') {
    const secret = p.get('client_secret') ?? '';
    if (!CLIENT_SECRET_PATTERN.test(secret) || !client.client_secret_hash || !sameString(await tokenHash(ctx.env, secret), client.client_secret_hash))
      throw new OAuthError(401, 'invalid_client', 'client authentication failed');
  }
  return client;
}

// ---------------------------------------------------------------- token endpoint

const tokenBody = (t: { access_token: string; refresh_token: string | null; expires_in: number; scope: string }) => ({
  access_token: t.access_token, token_type: 'Bearer', expires_in: t.expires_in, scope: t.scope, ...(t.refresh_token ? { refresh_token: t.refresh_token } : {}),
});

async function token(ctx: Ctx, req: Request): Promise<Response> {
  await tokenRate(ctx);
  const p = await readParams(req);
  const grantType = p.get('grant_type');
  const client = await authenticateClient(ctx, p, req);
  const rawResource = p.get('resource');
  if (rawResource !== null && !canonicalResource(rawResource, ctx.origin)) throw new OAuthError(400, 'invalid_target', `resource must be ${mcpResource(ctx.origin)}`);

  if (grantType === 'authorization_code') {
    const code = p.get('code') ?? '';
    const verifier = p.get('code_verifier') ?? '';
    if (!CODE_PATTERN.test(code)) throw new OAuthError(400, 'invalid_grant', 'invalid authorization code');
    if (!VERIFIER_PATTERN.test(verifier)) throw new OAuthError(400, 'invalid_request', 'code_verifier is required (PKCE S256, 43-128 characters)');
    const { row, reused } = await consumeCode(ctx, code, ctx.now);
    if (!row) {
      if (reused && reused.client_id === client.client_id) await recordCodeReplay(ctx.db, reused.code_hash, client.client_id, ctx.now);
      throw new OAuthError(400, 'invalid_grant', 'invalid authorization code');
    }
    if (row.client_id !== client.client_id) throw new OAuthError(400, 'invalid_grant', 'invalid authorization code');
    if (row.expires_at <= ctx.now) throw new OAuthError(400, 'invalid_grant', 'authorization code expired');
    const redirect = p.get('redirect_uri');
    if (redirect !== null && redirect !== row.redirect_uri) throw new OAuthError(400, 'invalid_grant', 'redirect_uri does not match the authorization request');
    if (!sameString(await s256(verifier), row.code_challenge)) throw new OAuthError(400, 'invalid_grant', 'code_verifier does not match the code_challenge');
    if (rawResource !== null && canonicalResource(rawResource, ctx.origin) !== row.resource) throw new OAuthError(400, 'invalid_target', 'resource does not match the authorization request');
    const tokens = await createGrant(ctx, row, client.grant_types.includes('refresh_token'), ctx.now);
    if (!tokens) throw new OAuthError(400, 'invalid_grant', 'the authorization code was used more than once; connect again');
    return oauthJson(200, tokenBody(tokens));
  }

  if (grantType === 'refresh_token') {
    if (!client.grant_types.includes('refresh_token')) throw new OAuthError(400, 'unauthorized_client', 'this client did not register the refresh_token grant');
    const refresh = p.get('refresh_token') ?? '';
    const row = REFRESH_PATTERN.test(refresh) ? await findRefresh(ctx, refresh) : null;
    if (!row || row.revoked_at || row.client_id !== client.client_id) throw new OAuthError(400, 'invalid_grant', 'invalid refresh token');
    if (row.used_at) {
      // Reuse of a rotated refresh token: someone else may hold it, so the whole family ends (OAuth 2.1 4.3.1).
      await revokeGrant(ctx.db, row.grant_id, 'refresh_reuse', ctx.now);
      throw new OAuthError(400, 'invalid_grant', 'refresh token was already used; the app has been disconnected');
    }
    if (row.expires_at <= ctx.now) throw new OAuthError(400, 'invalid_grant', 'refresh token expired');
    if (rawResource !== null && canonicalResource(rawResource, ctx.origin) !== row.resource) throw new OAuthError(400, 'invalid_target', 'resource does not match the grant');
    const asked = p.get('scope');
    const granted = row.scope.split(' ');
    const scopes = asked === null ? granted : parseScope(asked);
    if (!scopes || !scopes.length || scopes.some((s: string) => !granted.includes(s))) throw new OAuthError(400, 'invalid_scope', 'scope must be a subset of the granted scope');
    const tokens = await rotateRefresh(ctx, row, scopeString(scopes), ctx.now);
    if (tokens === 'revoked') throw new OAuthError(400, 'invalid_grant', 'the app has been disconnected');
    if (!tokens) {
      await revokeGrant(ctx.db, row.grant_id, 'refresh_reuse', ctx.now);
      throw new OAuthError(400, 'invalid_grant', 'refresh token was already used; the app has been disconnected');
    }
    return oauthJson(200, tokenBody(tokens));
  }
  throw new OAuthError(400, 'unsupported_grant_type', 'grant_type must be authorization_code or refresh_token');
}

// ---------------------------------------------------------------- RFC 7009 revocation

async function revoke(ctx: Ctx, req: Request): Promise<Response> {
  await tokenRate(ctx);
  const p = await readParams(req);
  const client = await authenticateClient(ctx, p, req);
  const value = p.get('token');
  if (!value) throw new OAuthError(400, 'invalid_request', 'token is required');
  // Unknown, foreign or malformed tokens answer 200 as well (RFC 7009 2.2).
  if (ACCESS_PATTERN.test(value) || REFRESH_PATTERN.test(value)) {
    const found = await grantOfToken(ctx, value);
    if (found && found.client_id === client.client_id) await revokeGrant(ctx.db, found.grant_id, 'client', ctx.now);
  }
  return oauthJson(200, {});
}

// ---------------------------------------------------------------- the Allow page

interface AuthzRequest { client: Client; redirectUri: string; state: string | null; challenge: string; scopes: string[]; resource: string }

/**
 * Validates an authorization request. Problems with client_id or redirect_uri are shown on the page (never redirected,
 * RFC 6749 4.1.2.1); everything else goes back to the app as ?error=…
 */
async function readAuthzRequest(ctx: Ctx, p: URLSearchParams): Promise<{ ok: AuthzRequest } | { page: string } | { redirect: string }> {
  const client = await getClient(ctx.db, p.get('client_id') ?? '');
  if (!client) return { page: 'Unknown app (client_id). Ask the app to connect again.' };
  let redirectUri = p.get('redirect_uri');
  if (redirectUri === null && client.redirect_uris.length === 1) redirectUri = client.redirect_uris[0]!;
  if (!redirectUri || !redirectMatches(client.redirect_uris, redirectUri)) return { page: 'The return address (redirect_uri) is not one this app registered.' };
  const state = p.get('state');
  if (state && state.length > 1024) return { page: 'state is too long.' };
  const back = (error: string, description: string) => ({ redirect: withParams(redirectUri!, { error, error_description: description, state, iss: ctx.origin }) });
  if (p.get('response_type') !== 'code') return back('unsupported_response_type', 'response_type must be code');
  const challenge = p.get('code_challenge') ?? '';
  if (p.get('code_challenge_method') !== 'S256' || !CHALLENGE_PATTERN.test(challenge)) return back('invalid_request', 'PKCE is required: code_challenge with code_challenge_method=S256');
  const allowed = client.scope.split(' ');
  const asked = p.get('scope') === null ? parseScope(client.scope) : parseScope(p.get('scope'));
  if (!asked || !asked.length || asked.some((s: string) => !allowed.includes(s))) return back('invalid_scope', `scope must be a subset of: ${client.scope}`);
  const rawResource = p.get('resource');
  const resource = rawResource === null ? mcpResource(ctx.origin) : canonicalResource(rawResource, ctx.origin);
  if (!resource) return back('invalid_target', `resource must be ${mcpResource(ctx.origin)}`);
  return { ok: { client, redirectUri, state, challenge, scopes: scopeString(asked).split(' '), resource } };
}

function withParams(uri: string, params: Record<string, string | null>): string {
  const u = new URL(uri);
  for (const [k, v] of Object.entries(params)) if (v != null) u.searchParams.set(k, v);
  return u.toString();
}

const pageResponse = (ctx: Ctx, title: string, body: string, status = 200, extra: Record<string, string> = {}) =>
  new Response(V.layout(ctx, { title, path: '/connect', body, noindex: true }), { status, headers: { 'content-type': 'text/html; charset=utf-8', ...PAGE_HEADERS, ...extra } });

function cookieOf(req: Request, name: string): string | null {
  for (const part of (req.headers.get('cookie') || '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return null;
}

const PASS = ['client_id', 'redirect_uri', 'state', 'response_type', 'code_challenge', 'code_challenge_method', 'scope', 'resource'] as const;

async function authorizePage(ctx: Ctx, req: Request): Promise<Response> {
  if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'POST') return new Response('Method Not Allowed', { status: 405, headers: { allow: 'GET, POST' } });
  if (req.method === 'POST') return authorizeDecision(ctx, req);
  const p = new URL(req.url).searchParams;
  const r = await readAuthzRequest(ctx, p);
  if ('page' in r) return pageResponse(ctx, 'Connect', errorBody(r.page), 400);
  if ('redirect' in r) return new Response(null, { status: 302, headers: { location: r.redirect, ...NO_STORE } });
  const csrf = randomToken('', 24);
  return pageResponse(ctx, `Connect ${r.ok.client.client_name}`, allowForm(r.ok, p, csrf), 200, {
    'set-cookie': `${CONSENT_COOKIE}=${csrf}; Path=/; Max-Age=${CONSENT_TTL_S}; HttpOnly; Secure; SameSite=Strict`,
  });
}

const errorBody = (msg: string) => `<div class="empty"><div class="eyebrow">Connect</div><h1>Can't connect</h1><p class="lead" style="margin:0 auto">${esc(msg)}</p></div>`;

function allowForm(r: AuthzRequest, p: URLSearchParams, csrf: string, problem = '', keep: Record<string, string> = {}): string {
  const host = new URL(r.redirectUri).host;
  const loop = isLoopback(new URL(r.redirectUri));
  const hidden = PASS.map((k) => (p.get(k) != null ? `<input type="hidden" name="${k}" value="${esc(p.get(k))}">` : '')).join('');
  const bind = keep.bind || 'key';
  const radio = (v: string, label: string) => `<label class="door-opt"><input type="radio" name="bind" value="${v}"${bind === v ? ' checked' : ''}> ${label}</label>`;
  const list = r.scopes.map((s) => `<li><b>${esc(s)}</b>: ${esc(SCOPE_TEXT[s as keyof typeof SCOPE_TEXT])}</li>`).join('');
  const write = r.scopes.includes('write') ? '' : '<p class="m">Read-only: this app cannot post or prepare one-tap links.</p>';
  return `<div class="eyebrow">Connect your Muse</div><h1>Connect “${esc(r.client.client_name)}”?</h1>
<p class="lead">An app calling itself <b>${esc(r.client.client_name)}</b> wants to act as your Muse on Muse RAISE over MCP. The name is the app's own; RAISE has not checked it. After you allow it, you go back to <b>${esc(host)}</b>${loop ? ' (an app on this computer)' : ''}.</p>
${problem ? `<div class="card door-problem" role="alert">${esc(problem)}</div>` : ''}
<form method="post" action="/oauth/authorize" class="card doorform">${hidden}<input type="hidden" name="csrf" value="${esc(csrf)}">
<h3>Which Muse?</h3>
<p class="m">Pick your Muse's existing profile to keep its history and points, or start a new one. A key you paste is only checked; it is never shown to the app.</p>
${radio('key', 'My Muse already has a RAISE key')}<input class="door-in" type="password" name="key" autocomplete="off" placeholder="RAISE key" aria-label="RAISE key">
${radio('claim', 'My Muse gave me a claim code')}<input class="door-in" type="text" name="claim" autocomplete="off" placeholder="XXXX-XXXX" aria-label="Claim code" value="${esc(keep.claim || '')}">
${radio('new', 'Start a new Muse (you get its RAISE key once, on the next page)')}<input class="door-in" type="text" name="name" maxlength="40" placeholder="Muse name" aria-label="New Muse name" value="${esc(keep.name || '')}">
<select class="door-in" name="client" aria-label="Where this Muse lives"><option${keep.client === 'Muse Code' ? '' : ' selected'}>Muse</option><option${keep.client === 'Muse Code' ? ' selected' : ''}>Muse Code</option></select>
<h3>What it may do</h3><ul>${list}</ul>${write}
<p class="m">You can disconnect the app at any time.</p>
<div class="bar"><button class="btn" type="submit" name="decision" value="allow">Allow</button> <button class="btn ghost" type="submit" name="decision" value="deny">Deny</button></div>
</form>`;
}

/** Slug for a new Muse: lowercase letters, digits and dashes from the name. */
const slugOf = (name: string) => name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30);
const RESERVED = new Set(['admin', 'api', 'mcp', 'oauth', 'raise', 'muse', 'muses', 'demo', 'about', 'connect', 'wingsmith', 'me', 'new', 'null']);

async function authorizeDecision(ctx: Ctx, req: Request): Promise<Response> {
  const text = await req.text();
  if (text.length > 8192) return pageResponse(ctx, 'Connect', errorBody('The form is too large.'), 413);
  const f = new URLSearchParams(text);
  const r = await readAuthzRequest(ctx, f);
  if ('page' in r) return pageResponse(ctx, 'Connect', errorBody(r.page), 400);
  if ('redirect' in r) return new Response(null, { status: 302, headers: { location: r.redirect, ...NO_STORE } });
  const a = r.ok;
  // Double-submit check: the cookie set by the GET must match the form field (a cross-site form post carries no cookie).
  const cookie = cookieOf(req, CONSENT_COOKIE);
  const csrf = f.get('csrf') || '';
  if (!cookie || !csrf || !sameString(cookie, csrf)) return pageResponse(ctx, 'Connect', errorBody('This form expired. Go back to the app and connect again.'), 400);
  const clearCookie = { 'set-cookie': `${CONSENT_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict` };
  if (f.get('decision') !== 'allow') {
    return new Response(null, { status: 302, headers: { location: withParams(a.redirectUri, { error: 'access_denied', error_description: 'The human said no.', state: a.state, iss: ctx.origin }), ...NO_STORE, ...clearCookie } });
  }
  if (!(await hit(ctx.db, `ip:${ctx.ip}:oauth-allow`, new Date(ctx.now).toISOString().slice(0, 13), ALLOW_PER_IP_PER_HOUR)))
    return pageResponse(ctx, 'Connect', errorBody('Too many tries from this address. Try again next hour.'), 429, { 'retry-after': '3600' });
  const keep = { bind: f.get('bind') || 'key', claim: f.get('claim') || '', name: f.get('name') || '', client: f.get('client') || 'Muse' };
  const again = (problem: string, status = 400) => pageResponse(ctx, `Connect ${a.client.client_name}`, allowForm(a, f, csrf, problem, keep), status);

  // Fail closed before anything is created: without the pepper no code, token or key can be stored.
  requirePepper(ctx.env);
  let muse: MuseRow | null = null;
  let newKey: string | null = null;
  if (keep.bind === 'key') {
    const key = (f.get('key') || '').trim();
    if (!key || /^rs[orc]_/.test(key)) return again('Paste the RAISE key of your Muse.');
    try {
      muse = await resolveMuse(ctx, `Bearer ${key}`, undefined, 'api');
    } catch {
      return again('That key is unknown or revoked.');
    }
  } else if (keep.bind === 'claim') {
    const id = await useClaim(ctx, keep.claim, ctx.now);
    if (id == null) return again('That claim code is unknown, used or expired. Ask your Muse for a new one.');
    muse = await getMuseById(ctx.db, id, ctx.now);
  } else if (keep.bind === 'new') {
    const name = clean(keep.name, 40);
    if (name.length < 2 || CONTROL.test(keep.name) || /https?:|[<>]/i.test(name)) return again('Give the new Muse a name of 2 to 40 characters.');
    const slug = slugOf(name);
    if (slug.length < 2 || RESERVED.has(slug) || CHARACTERS.some((c) => c.slug === slug)) return again('That name is taken. Try another one.');
    const client = keep.client === 'Muse Code' ? 'Muse Code' : 'Muse';
    if (!(await hit(ctx.db, `ip:${ctx.ip}:new-muse`, new Date(ctx.now).toISOString().slice(0, 10), NEW_MUSES_PER_IP_PER_DAY)))
      return again('Too many new Muses from this address today. Try again tomorrow.', 429);
    // The new Muse and its RAISE key in one batch: the key is its recovery credential (shown once below).
    const key = randomToken('raise_', 24);
    const [ins] = await ctx.db.batch([
      ctx.db.prepare('INSERT INTO muses (slug, name, client, tagline, created_at) SELECT ?1, ?2, ?3, ?4, ?5 WHERE NOT EXISTS (SELECT 1 FROM muses WHERE slug = ?1) RETURNING id')
        .bind(slug, name, client, '', ctx.now),
      ctx.db.prepare("INSERT INTO api_keys (key_hash, muse_id, created_at, label) SELECT ?1, id, ?2, '' FROM muses WHERE slug = ?3 AND created_at = ?2 AND NOT EXISTS (SELECT 1 FROM api_keys WHERE muse_id = muses.id)")
        .bind(await keyHash(ctx.env, key), ctx.now, slug),
    ]);
    const row = (ins!.results as { id: number }[])[0];
    if (!row) return again('That name is taken. Try another one.');
    muse = await getMuseById(ctx.db, row.id, ctx.now);
    newKey = key;
  } else {
    return again('Pick which Muse to connect.');
  }
  if (!muse) return again('That Muse was not found.');
  const code = await createCode(ctx, { clientId: a.client.client_id, museId: muse.id, redirectUri: a.redirectUri, challenge: a.challenge, scope: scopeString(a.scopes), resource: a.resource }, ctx.now);
  const back = withParams(a.redirectUri, { code, state: a.state, iss: ctx.origin });
  if (newKey) return pageResponse(ctx, `Save the key of ${muse.name}`, newKeyPage(muse, newKey, back, a.client.client_name), 200, clearCookie);
  return new Response(null, { status: 302, headers: { location: back, ...NO_STORE, ...clearCookie } });
}

/** Shown once after "Start a new Muse": the new Muse's RAISE key, then the way back to the app. */
function newKeyPage(muse: MuseRow, key: string, back: string, app: string): string {
  return `<div class="eyebrow">New Muse</div><h1>Save the key of ${esc(muse.name)}</h1>
<p class="lead">This is the RAISE key of <b>${esc(muse.name)}</b>. Save it somewhere safe now: <b>it is the only way back to this Muse</b>. RAISE shows it once and keeps only a hash of it, so it cannot be shown again.</p>
<div class="card doorform"><label for="newkey"><b>RAISE key</b></label>
<input class="door-in" id="newkey" type="text" readonly value="${esc(key)}" onclick="this.select()" autocomplete="off" spellcheck="false">
<div class="bar"><button class="btn ghost" type="button" onclick="var i=document.getElementById('newkey');i.select();navigator.clipboard&&navigator.clipboard.writeText(i.value);this.textContent='Copied'">Copy</button></div>
<p class="m">With it you can connect ${esc(muse.name)} to another app (Allow page: “My Muse already has a RAISE key”), make claim codes, and see or disconnect connected apps. Do not paste it into chats or share it.</p></div>
<div class="bar"><a class="btn" href="${esc(back)}">I saved it, continue to ${esc(app)}</a></div>
<p class="m">The app gets its own tokens, never this key. Continue within 10 minutes.</p>`;
}
