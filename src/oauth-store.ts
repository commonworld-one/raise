// OAuth 2.1 for the MCP endpoint: constants, URL rules and D1 access (tables of migrations/0006_oauth.sql).
// Design adapted from Commonworld's platform OAuth (commonworld-one/commonworld PR #38, platform/src/oauth/).
//
// RAISE is both the authorization server (issuer = the site origin) and the protected resource: the MCP server at
// <origin>/mcp (anonymous reads allowed) and <origin>/mcp/me (every request needs a credential; a missing one is 401
// with the RFC 9728 challenge, so connector clients that start OAuth only after a 401 show "Connect").
//
//   rcl_<22>   client_id (public)                        rcs_<43>   client secret (client_secret_post clients only)
//   rsc_<43>   authorization code (single use, 10 min)    rso_<43>   access token (1 hour)
//   rsr_<43>   refresh token (30 days, rotated on every use; a reused one revokes the whole grant)
//
// Tokens are opaque random strings (256 bits). Only HMAC-SHA256(RAISE_TOKEN_PEPPER, "oauth:" + value) is stored
// (src/secrets.ts; without the pepper nothing is issued or accepted: 500 server_misconfigured). An OAuth token never is
// and never reveals a RAISE key, works on the MCP endpoint only, and never manages credentials (claim codes,
// connected apps): those need the Muse's own key.
import type { Ctx } from './types';
import type { MuseRow } from './data';
import { SCOPES, randomToken, type Scope } from './doors';
import { seasonOf } from './util';
import { secretHash } from './secrets';
import type { Env } from './types';

export const PRM_PATH = '/.well-known/oauth-protected-resource';
export const AS_METADATA_PATH = '/.well-known/oauth-authorization-server';
export const MCP_ENDPOINTS = ['/mcp', '/mcp/me'] as const;
export type McpEndpoint = (typeof MCP_ENDPOINTS)[number];
export const OAUTH_PATHS = { authorize: '/oauth/authorize', token: '/oauth/token', register: '/oauth/register', revoke: '/oauth/revoke' } as const;

export const CODE_TTL_MS = 10 * 60_000;
export const ACCESS_TTL_MS = 60 * 60_000;
export const REFRESH_TTL_MS = 30 * 86_400_000;
export const CLAIM_TTL_MS = 10 * 60_000;
export const CONSENT_COOKIE = '__Host-raise_oauth';
export const CONSENT_TTL_S = 15 * 60;

export const ACCESS_PATTERN = /^rso_[A-Za-z0-9_-]{43}$/;
export const REFRESH_PATTERN = /^rsr_[A-Za-z0-9_-]{43}$/;
export const CODE_PATTERN = /^rsc_[A-Za-z0-9_-]{43}$/;
export const CLIENT_ID_PATTERN = /^rcl_[A-Za-z0-9_-]{22}$/;
export const CLIENT_SECRET_PATTERN = /^rcs_[A-Za-z0-9_-]{43}$/;
export const VERIFIER_PATTERN = /^[A-Za-z0-9._~-]{43,128}$/;
export const CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
/** Claim code shown to a human: 8 characters from an unambiguous alphabet, as XXXX-XXXX. */
export const CLAIM_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const CLAIM_PATTERN = /^[A-HJKMNP-Z2-9]{4}-?[A-HJKMNP-Z2-9]{4}$/;

export const DCR = { maxRedirectUris: 5, maxUriLength: 512, maxNameLength: 60, clientsPerIpPerHour: 20, clientsPerDay: 2000 } as const;
export const TOKEN_RATE_PER_MINUTE = 60;
/** Allow-page submissions per IP per hour (guards key and claim-code guessing). */
export const ALLOW_PER_IP_PER_HOUR = 20;
/** New Muses created on the Allow page, per IP per UTC day. */
export const NEW_MUSES_PER_IP_PER_DAY = 3;

export const tokenHash = (env: Env, value: string): Promise<string> => secretHash(env, `oauth:${value}`);

/** The canonical resource URI of the MCP server (RFC 8707 audience). Both endpoints share one audience: one server, two doors. */
export const mcpResource = (origin: string, endpoint: McpEndpoint = '/mcp') => `${origin}${endpoint}`;
export const resourceMetadataUrl = (origin: string, endpoint: McpEndpoint = '/mcp') => `${origin}${PRM_PATH}${endpoint}`;

/**
 * RFC 8707 `resource`: <origin>, <origin>/mcp or <origin>/mcp/me (one trailing slash ignored). Returns the canonical
 * value to store with the grant, or null. A query, fragment or another host is refused.
 */
export function canonicalResource(raw: string, origin: string): string | null {
  let u: URL;
  try { u = new URL(raw); } catch { return null; }
  if (u.search || u.hash || raw.includes('#') || u.username || u.password) return null;
  const o = new URL(origin);
  if (u.protocol !== o.protocol || u.host !== o.host) return null;
  const path = u.pathname.replace(/\/$/, '');
  if (path === '' || path === '/mcp') return mcpResource(origin, '/mcp');
  if (path === '/mcp/me') return mcpResource(origin, '/mcp/me');
  return null;
}

/** Space-separated scopes -> known scopes in canonical order, or null when any is unknown. */
export function parseScope(raw: string | null | undefined): Scope[] | null {
  const parts = (raw ?? '').split(' ').filter(Boolean);
  if (parts.some((s) => !(SCOPES as readonly string[]).includes(s))) return null;
  return SCOPES.filter((s) => parts.includes(s));
}
export const scopeString = (scopes: readonly string[]): string => SCOPES.filter((s) => scopes.includes(s)).join(' ');

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);
export const isLoopback = (u: URL): boolean => u.protocol === 'http:' && LOOPBACK.has(u.hostname);

/** A registrable redirect URI: https (no userinfo, no fragment) or http on a loopback host. Returns the reason when not. */
export function redirectProblem(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw || raw.length > DCR.maxUriLength) return 'redirect_uri must be a string of 1-512 characters';
  let u: URL;
  try { u = new URL(raw); } catch { return 'redirect_uri is not an absolute URI'; }
  if (raw.includes('#')) return 'redirect_uri must not contain a fragment';
  if (u.username || u.password) return 'redirect_uri must not contain user info';
  if (/[\u0000-\u0020\u007f]/.test(raw)) return 'redirect_uri must not contain spaces or control characters';
  if (u.protocol === 'https:' && u.hostname) return null;
  if (isLoopback(u)) return null;
  return 'redirect_uri must use https, or http on a loopback host (localhost, 127.0.0.1, [::1])';
}

/** Exact match against the registered list; for loopback URIs the port may differ (RFC 8252 7.3). */
export function redirectMatches(registered: string[], given: string): boolean {
  if (registered.includes(given)) return true;
  let g: URL;
  try { g = new URL(given); } catch { return false; }
  if (!isLoopback(g) || given.includes('#')) return false;
  return registered.some((r) => {
    const u = new URL(r);
    return isLoopback(u) && u.hostname === g.hostname && u.pathname === g.pathname && u.search === g.search;
  });
}

/** base64url(SHA-256(verifier)), RFC 7636 S256. */
export async function s256(verifier: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  let b = '';
  for (const x of d) b += String.fromCharCode(x);
  return btoa(b).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// ---------------------------------------------------------------- clients

export interface ClientRow {
  client_id: string; client_secret_hash: string | null; client_name: string; redirect_uris: string; grant_types: string;
  token_endpoint_auth_method: 'none' | 'client_secret_post'; scope: string; created_at: number; last_used_at: number | null;
}
export interface Client extends Omit<ClientRow, 'redirect_uris' | 'grant_types'> { redirect_uris: string[]; grant_types: string[] }

export async function getClient(db: D1Database, id: string): Promise<Client | null> {
  if (!CLIENT_ID_PATTERN.test(id)) return null;
  const r = await db.prepare('SELECT * FROM oauth_clients WHERE client_id = ?').bind(id).first<ClientRow>();
  return r ? { ...r, redirect_uris: JSON.parse(r.redirect_uris), grant_types: JSON.parse(r.grant_types) } : null;
}

export async function insertClient(ctx: Ctx, c: { client_name: string; redirect_uris: string[]; grant_types: string[]; method: 'none' | 'client_secret_post'; scope: string }, now: number) {
  const db = ctx.db;
  const clientId = randomToken('rcl_', 16);
  const secret = c.method === 'client_secret_post' ? randomToken('rcs_') : null;
  await db.prepare(`INSERT INTO oauth_clients (client_id, client_secret_hash, client_name, redirect_uris, grant_types, token_endpoint_auth_method, scope, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(clientId, secret ? await tokenHash(ctx.env, secret) : null, c.client_name, JSON.stringify(c.redirect_uris), JSON.stringify(c.grant_types), c.method, c.scope, now).run();
  return { clientId, secret };
}

// ---------------------------------------------------------------- codes

export interface CodeRow {
  code_hash: string; client_id: string; muse_id: number; redirect_uri: string; code_challenge: string; scope: string; resource: string;
  expires_at: number; used_at: number | null; grant_id: string | null; replayed_at: number | null;
}

export async function createCode(ctx: Ctx, x: { clientId: string; museId: number; redirectUri: string; challenge: string; scope: string; resource: string }, now: number): Promise<string> {
  const db = ctx.db;
  const code = randomToken('rsc_');
  await db.prepare(`INSERT INTO oauth_codes (code_hash, client_id, muse_id, redirect_uri, code_challenge, scope, resource, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(await tokenHash(ctx.env, code), x.clientId, x.museId, x.redirectUri, x.challenge, x.scope, x.resource, now, now + CODE_TTL_MS).run();
  return code;
}

/** Uses a code once (the UPDATE … WHERE used_at IS NULL wins exactly once). `reused`: it exists but was used before. */
export async function consumeCode(ctx: Ctx, code: string, now: number): Promise<{ row: CodeRow | null; reused: CodeRow | null }> {
  const db = ctx.db;
  const hash = await tokenHash(ctx.env, code);
  const row = await db.prepare('UPDATE oauth_codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL RETURNING *').bind(now, hash).first<CodeRow>();
  if (row) return { row, reused: null };
  return { row: null, reused: await db.prepare('SELECT * FROM oauth_codes WHERE code_hash = ?').bind(hash).first<CodeRow>() };
}

/** A second use of a code (OAuth 2.1 4.1.3): marks it replayed and revokes whatever grant the first use created, in one batch. */
export async function recordCodeReplay(db: D1Database, codeHash: string, clientId: string, now: number): Promise<void> {
  const grantOf = 'SELECT grant_id FROM oauth_codes WHERE code_hash = ?2 AND client_id = ?3';
  await db.batch([
    db.prepare('UPDATE oauth_codes SET replayed_at = COALESCE(replayed_at, ?1) WHERE code_hash = ?2 AND client_id = ?3').bind(now, codeHash, clientId),
    db.prepare(`UPDATE oauth_grants SET revoked_at = ?1, revoke_reason = 'code_reuse' WHERE revoked_at IS NULL AND id = (${grantOf})`).bind(now, codeHash, clientId),
    db.prepare(`DELETE FROM oauth_tokens WHERE grant_id = (${grantOf})`).bind(now, codeHash, clientId),
  ]);
}

// ---------------------------------------------------------------- grants and tokens

export interface IssuedTokens { access_token: string; refresh_token: string | null; expires_in: number; scope: string }

async function tokenStatements(ctx: Ctx, grantId: string, scope: string, withRefresh: boolean, now: number) {
  const db = ctx.db;
  const access = randomToken('rso_');
  const refresh = withRefresh ? randomToken('rsr_') : null;
  // Written only while the grant exists and is not revoked, checked inside the same batch (one transaction).
  const ins = `INSERT INTO oauth_tokens (token_hash, grant_id, kind, scope, created_at, expires_at)
    SELECT ?1, ?2, ?3, ?4, ?5, ?6 WHERE EXISTS (SELECT 1 FROM oauth_grants g WHERE g.id = ?2 AND g.revoked_at IS NULL)`;
  const statements = [db.prepare(ins).bind(await tokenHash(ctx.env, access), grantId, 'access', scope, now, now + ACCESS_TTL_MS)];
  if (refresh) statements.push(db.prepare(ins).bind(await tokenHash(ctx.env, refresh), grantId, 'refresh', scope, now, now + REFRESH_TTL_MS));
  return { statements, tokens: { access_token: access, refresh_token: refresh, expires_in: Math.floor(ACCESS_TTL_MS / 1000), scope } as IssuedTokens };
}

/** New grant from an exchanged code, with its first tokens, in one batch. Refused (null) when the code was replayed meanwhile. */
export async function createGrant(ctx: Ctx, code: CodeRow, withRefresh: boolean, now: number): Promise<IssuedTokens | null> {
  const db = ctx.db;
  const grantId = `rgr_${crypto.randomUUID()}`;
  const { statements, tokens } = await tokenStatements(ctx, grantId, code.scope, withRefresh, now);
  const [grant] = await db.batch([
    db.prepare(`INSERT INTO oauth_grants (id, client_id, muse_id, scope, resource, created_at, last_used_at)
      SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?6 WHERE EXISTS (SELECT 1 FROM muses WHERE id = ?3)
        AND EXISTS (SELECT 1 FROM oauth_codes c WHERE c.code_hash = ?7 AND c.grant_id IS NULL AND c.replayed_at IS NULL)`)
      .bind(grantId, code.client_id, code.muse_id, code.scope, code.resource, now, code.code_hash),
    ...statements,
    db.prepare('UPDATE oauth_codes SET grant_id = ?1 WHERE code_hash = ?2 AND EXISTS (SELECT 1 FROM oauth_grants WHERE id = ?1)').bind(grantId, code.code_hash),
    db.prepare('UPDATE oauth_clients SET last_used_at = ? WHERE client_id = ?').bind(now, code.client_id),
  ]);
  return (grant!.meta.changes ?? 0) === 1 ? tokens : null;
}

export interface RefreshRow { token_hash: string; grant_id: string; scope: string; expires_at: number; used_at: number | null; client_id: string; resource: string; revoked_at: number | null }

export async function findRefresh(ctx: Ctx, token: string): Promise<RefreshRow | null> {
  const db = ctx.db;
  return db.prepare(`SELECT t.token_hash, t.grant_id, t.scope, t.expires_at, t.used_at, g.client_id, g.resource, g.revoked_at
    FROM oauth_tokens t JOIN oauth_grants g ON g.id = t.grant_id WHERE t.token_hash = ? AND t.kind = 'refresh'`).bind(await tokenHash(ctx.env, token)).first<RefreshRow>();
}

/** Rotates a refresh token: marks it used (once) and issues a new pair. null = lost the race (a reuse); 'revoked' = grant gone. */
export async function rotateRefresh(ctx: Ctx, row: RefreshRow, scope: string, now: number): Promise<IssuedTokens | null | 'revoked'> {
  const db = ctx.db;
  const used = await db.prepare('UPDATE oauth_tokens SET used_at = ? WHERE token_hash = ? AND used_at IS NULL RETURNING token_hash').bind(now, row.token_hash).first();
  if (!used) {
    const still = await db.prepare('SELECT 1 AS x FROM oauth_tokens WHERE token_hash = ?').bind(row.token_hash).first();
    return still ? null : 'revoked';
  }
  const { statements, tokens } = await tokenStatements(ctx, row.grant_id, scope, true, now);
  const [access] = await db.batch([
    ...statements,
    db.prepare('UPDATE oauth_grants SET last_used_at = ? WHERE id = ?').bind(now, row.grant_id),
    db.prepare('UPDATE oauth_clients SET last_used_at = ? WHERE client_id = ?').bind(now, row.client_id),
  ]);
  return (access!.meta.changes ?? 0) === 1 ? tokens : 'revoked';
}

export type RevokeReason = 'user' | 'client' | 'refresh_reuse' | 'code_reuse';

/** Ends a grant: revoked_at set, every token of it deleted (the refresh family dies with it). */
export async function revokeGrant(db: D1Database, grantId: string, reason: RevokeReason, now: number): Promise<void> {
  await db.batch([
    db.prepare('UPDATE oauth_grants SET revoked_at = ?, revoke_reason = ? WHERE id = ? AND revoked_at IS NULL').bind(now, reason, grantId),
    db.prepare('DELETE FROM oauth_tokens WHERE grant_id = ?').bind(grantId),
  ]);
}

export async function grantOfToken(ctx: Ctx, token: string): Promise<{ grant_id: string; client_id: string } | null> {
  return ctx.db.prepare('SELECT t.grant_id, g.client_id FROM oauth_tokens t JOIN oauth_grants g ON g.id = t.grant_id WHERE t.token_hash = ?')
    .bind(await tokenHash(ctx.env, token)).first();
}

/** The Muse and scope behind a live access token, or null (unknown, expired, revoked). */
export async function accessTokenRow(ctx: Ctx, token: string): Promise<{ muse: MuseRow; scope: string; client_name: string; grant_id: string } | null> {
  const r = await ctx.db.prepare(`SELECT mu.*, COALESCE(mp.points, 0) AS season_points, t.scope AS tok_scope, c.client_name AS tok_client, g.id AS tok_grant
      FROM oauth_tokens t JOIN oauth_grants g ON g.id = t.grant_id JOIN oauth_clients c ON c.client_id = g.client_id JOIN muses mu ON mu.id = g.muse_id
      LEFT JOIN muse_points mp ON mp.muse_id = mu.id AND mp.season = ?
      WHERE t.token_hash = ? AND t.kind = 'access' AND t.expires_at > ? AND g.revoked_at IS NULL`)
    .bind(seasonOf(ctx.now), await tokenHash(ctx.env, token), ctx.now)
    .first<MuseRow & { tok_scope: string; tok_client: string; tok_grant: string }>();
  if (!r) return null;
  const { tok_scope, tok_client, tok_grant, ...muse } = r;
  return { muse, scope: tok_scope, client_name: tok_client, grant_id: tok_grant };
}

// ---------------------------------------------------------------- connected apps (managed with the Muse's own key)

export async function listApps(db: D1Database, museId: number) {
  const { results } = await db.prepare(`SELECT g.id, g.client_id, g.scope, g.created_at, g.last_used_at, c.client_name, c.redirect_uris
    FROM oauth_grants g JOIN oauth_clients c ON c.client_id = g.client_id WHERE g.muse_id = ? AND g.revoked_at IS NULL ORDER BY g.created_at DESC LIMIT 100`)
    .bind(museId).all<{ id: string; client_id: string; scope: string; created_at: number; last_used_at: number | null; client_name: string; redirect_uris: string }>();
  return results.map((r) => ({
    id: r.id, client_id: r.client_id, client_name: r.client_name, name_is_self_declared: true,
    redirect_hosts: [...new Set((JSON.parse(r.redirect_uris) as string[]).map((u) => new URL(u).host))],
    scope: r.scope.split(' ').filter(Boolean),
    connected_at: new Date(r.created_at).toISOString(), last_used_at: r.last_used_at == null ? null : new Date(r.last_used_at).toISOString(),
  }));
}

export async function revokeOwnApp(db: D1Database, museId: number, grantId: string, now: number): Promise<boolean> {
  const row = await db.prepare('SELECT id FROM oauth_grants WHERE id = ? AND muse_id = ? AND revoked_at IS NULL').bind(grantId, museId).first();
  if (!row) return false;
  await revokeGrant(db, grantId, 'user', now);
  return true;
}

// ---------------------------------------------------------------- claim codes

export function newClaimCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  const c = [...bytes].map((b) => CLAIM_ALPHABET[b % CLAIM_ALPHABET.length]).join('');
  return `${c.slice(0, 4)}-${c.slice(4)}`;
}
export const claimHash = (env: Env, code: string) => secretHash(env, `claim:${code.toUpperCase().replace('-', '')}`);

export async function createClaim(ctx: Ctx, museId: number, now: number): Promise<{ code: string; expires_at: number }> {
  const db = ctx.db;
  const code = newClaimCode();
  await db.prepare('INSERT INTO muse_claims (code_hash, muse_id, created_at, expires_at) VALUES (?, ?, ?, ?)').bind(await claimHash(ctx.env, code), museId, now, now + CLAIM_TTL_MS).run();
  return { code, expires_at: now + CLAIM_TTL_MS };
}

/** Uses a claim code once. Returns the Muse id, or null (unknown, used or expired). */
export async function useClaim(ctx: Ctx, code: string, now: number): Promise<number | null> {
  const db = ctx.db;
  const norm = code.trim().toUpperCase();
  if (!CLAIM_PATTERN.test(norm)) return null;
  const r = await db.prepare('UPDATE muse_claims SET used_at = ?1 WHERE code_hash = ?2 AND used_at IS NULL AND expires_at > ?1 RETURNING muse_id')
    .bind(now, await claimHash(ctx.env, norm)).first<{ muse_id: number }>();
  return r?.muse_id ?? null;
}
