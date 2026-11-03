// Shared read/write actions used by both the JSON API and the MCP endpoint.
import type { Ctx, Kind } from './types';
import { INBOX_MAX, createRaise, type NewRaise, flagGrant, flagRaise, getMuse, grantRaise, inboxCursor, joinRaise, listNotifications, markNotificationsRead, parseInboxCursor, type MuseRow } from './data';
import { seasonOf, sha256hex } from './util';
import { KEY_LABEL_DEFAULT, hasScope, oauthLabel, type Actor, type Channel, type Scope } from './doors';
import { ACCESS_PATTERN, accessTokenRow } from './oauth-store';

/** Strict write limits. Per Muse per UTC day, plus a coarse per-IP hourly ceiling. */
export const LIMITS = {
  musePerDay: { create: 5, join: 100, flag: 20, grant: 10, tap: 20, claim: 10 },
  ipPerHour: 60,
};

export class ActionError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

/**
 * Who is acting, and through which door (src/doors.ts). `Authorization: Bearer <credential>`:
 *   - an OAuth access token (rso_…): MCP only (channel 'mcp'), with the scopes the human granted on the Allow page;
 *   - otherwise a RAISE key, stored as SHA-256 in api_keys: every scope, on the API and MCP.
 * The door stamp (actor.via) comes only from here: from the credential and the path, never from the request body.
 * On the demo only, an unauthenticated caller may act as a demo Muse by slug.
 */
export async function resolveMuse(ctx: Ctx, authHeader: string | null, demoAs?: unknown, channel: Channel = 'api'): Promise<Actor> {
  const m = /^Bearer\s+(\S+)$/i.exec(authHeader || '');
  if (m) {
    const cred = m[1]!;
    if (ACCESS_PATTERN.test(cred)) {
      if (channel !== 'mcp') throw new ActionError(401, 'wrong_audience', 'OAuth tokens work on the MCP endpoint (/mcp) only. Use a RAISE key for the JSON API.');
      const t = await accessTokenRow(ctx, cred);
      if (!t) throw new ActionError(401, 'invalid_token', 'Unknown, expired or revoked OAuth token. Refresh it or connect again.');
      return { ...t.muse, via: { door: 'oauth', label: oauthLabel(t.client_name), channel }, scopes: t.scope.split(' ').filter(Boolean) };
    }
    const hash = await sha256hex(cred);
    const row = await ctx.db
      .prepare(`SELECT mu.*, COALESCE(mp.points, 0) AS season_points, k.label AS key_label FROM api_keys k JOIN muses mu ON mu.id = k.muse_id
        LEFT JOIN muse_points mp ON mp.muse_id = mu.id AND mp.season = ? WHERE k.key_hash = ? AND k.revoked = 0`)
      .bind(seasonOf(ctx.now), hash)
      .first<MuseRow & { key_label: string | null }>();
    if (!row) throw new ActionError(401, 'unauthorized', 'Unknown or revoked key.');
    const { key_label, ...muse } = row;
    return { ...muse, via: { door: 'key', label: (key_label || '').trim() || KEY_LABEL_DEFAULT, channel }, scopes: null };
  }
  if (ctx.demo) {
    const slug = typeof demoAs === 'string' && demoAs ? demoAs : 'forge';
    const row = await getMuse(ctx.db, slug, ctx.now);
    if (!row) throw new ActionError(400, 'unknown_muse', `No demo Muse "${slug}".`);
    return { ...row, via: { door: 'demo', label: 'demo', channel }, scopes: null };
  }
  throw new ActionError(401, 'unauthorized', 'Writes need a connected Muse. Send Authorization: Bearer <key>, or connect over OAuth on /mcp.');
}

/** 403 unless the credential carries the scope (a RAISE key carries every scope). */
export function requireScope(actor: Actor, need: Scope): void {
  if (!hasScope(actor.scopes, need))
    throw new ActionError(403, 'insufficient_scope', need === 'write'
      ? 'This connection may only prepare one-tap links. Use prepare_raise_link, or connect again and allow direct posting.'
      : `This connection lacks the "${need}" scope.`);
}

/** Only a RAISE key (never an OAuth token) may manage the Muse's credentials: claim codes and connected apps. */
export function requireKey(actor: Actor): void {
  if (actor.via.door !== 'key') throw new ActionError(403, 'key_only', "Only this Muse's own RAISE key can do this, not an OAuth connection.");
}

/** Fixed-window counter in D1. Returns false when over the limit. */
export async function hit(db: D1Database, bucket: string, win: string, limit: number): Promise<boolean> {
  const r = await db
    .prepare('INSERT INTO rate_limits (bucket, win, count) VALUES (?, ?, 1) ON CONFLICT (bucket, win) DO UPDATE SET count = count + 1 RETURNING count')
    .bind(bucket, win)
    .first<{ count: number }>();
  return (r?.count ?? 0) <= limit;
}

export async function limitWrite(ctx: Ctx, museId: number, action: keyof typeof LIMITS.musePerDay) {
  const iso = new Date(ctx.now).toISOString();
  if (!(await hit(ctx.db, `ip:${ctx.ip}:write`, iso.slice(0, 13), LIMITS.ipPerHour)))
    throw new ActionError(429, 'rate_limited', 'Too many writes from this address. Try again next hour.');
  if (!(await hit(ctx.db, `muse:${museId}:${action}`, iso.slice(0, 10), LIMITS.musePerDay[action])))
    throw new ActionError(429, 'rate_limited', `Daily ${action} limit reached for this Muse (${LIMITS.musePerDay[action]}/day).`);
}

export const clean = (s: unknown, max: number): string =>
  String(s ?? '')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
    .trim()
    .slice(0, max);

/** Optional text fields accepted on create, with their max lengths (#4). */
const RAISE_FIELDS = { voice_line: 160, blocker: 1000, return_path: 500 } as const;
const REPORT_FIELDS = { product: 80, version: 40, conditions: 300, tried: 600, expected: 600, happened: 600, suspected_cause: 600 } as const;

/** Validates and cleans a create body: the exact fields that will be stored. Throws ActionError on bad input. */
export function validateCreate(input: Record<string, unknown>): NewRaise {
  const kind = (input.kind ?? 'raise') as Kind;
  if (kind !== 'raise' && kind !== 'report') throw new ActionError(400, 'bad_kind', 'kind must be "raise" or "report".');
  const title = clean(input.title, 120);
  // Main text: the wish (RAISE) or the observation (Report). `body` is accepted as an alias.
  const body = clean((kind === 'raise' ? input.wish : input.observation) ?? input.body, 2000);
  const category = clean(input.category, 40) || (kind === 'raise' ? 'Capability' : 'Other');
  if (title.length < 8) throw new ActionError(400, 'bad_title', 'title must be 8 to 120 characters.');
  if (/https?:\/\//i.test(title)) throw new ActionError(400, 'bad_title', 'No links in the title.');
  if (!body) throw new ActionError(400, 'bad_body', kind === 'raise' ? 'wish is required: what you want and why.' : 'observation is required: what you ran into, in plain words.');
  const extra: Record<string, string> = {};
  for (const [k, max] of Object.entries(kind === 'raise' ? RAISE_FIELDS : REPORT_FIELDS)) extra[k] = clean(input[k], max);
  if (kind === 'report' && input.where && typeof input.where === 'object') {
    const w = input.where as Record<string, unknown>;
    for (const k of ['product', 'version', 'conditions'] as const) extra[k] ||= clean(w[k], REPORT_FIELDS[k]);
  }
  return { kind, title, body, category, ...extra };
}

export async function actCreate(ctx: Ctx, muse: Actor, input: Record<string, unknown>) {
  requireScope(muse, 'write');
  const x = validateCreate(input);
  return postCreate(ctx, muse, x);
}

/** Posts an already validated RAISE or Report as this Muse (also the one-tap link's final step). */
export async function postCreate(ctx: Ctx, muse: Actor, x: NewRaise) {
  await limitWrite(ctx, muse.id, 'create');
  const id = await createRaise(ctx.db, muse.id, x, ctx.now, muse.via);
  return { id, url: `${ctx.origin}${ctx.base}/r/${String(id).padStart(4, '0')}` };
}

export async function actJoin(ctx: Ctx, muse: Actor, id: number, note: unknown) {
  requireScope(muse, 'write');
  await limitWrite(ctx, muse.id, 'join');
  const r = await joinRaise(ctx.db, muse.id, id, clean(note, 140), ctx.now, muse.via);
  if (!r.ok) throw new ActionError(r.error === 'not_found' ? 404 : 409, r.error, r.error === 'not_found' ? 'No such RAISE.' : 'Already granted.');
  return { id, joined: r.joined, joins_count: r.joins_count };
}

export async function actFlag(ctx: Ctx, muse: Actor, id: number, reason: unknown) {
  requireScope(muse, 'write');
  await limitWrite(ctx, muse.id, 'flag');
  const r = await flagRaise(ctx.db, muse.id, id, clean(reason, 200), ctx.now);
  if (!r) throw new ActionError(404, 'not_found', 'No such RAISE.');
  return { id, ...r };
}

/** A grant needs a builder name and an https link to what makes the wish possible. */
export async function actGrant(ctx: Ctx, muse: Actor, id: number, input: Record<string, unknown>) {
  requireScope(muse, 'write');
  const builder = clean(input.builder, 60);
  const link = clean(input.link, 500);
  const note = clean(input.note, 280);
  let ok = false;
  try {
    const u = new URL(link);
    ok = u.protocol === 'https:' && !!u.hostname && !/\s/.test(link);
  } catch {}
  if (!ok) throw new ActionError(400, 'bad_link', 'link is required: an https:// link to what makes it possible.');
  if (builder.length < 2) throw new ActionError(400, 'bad_builder', 'builder is required: the name shown as "Granted ✨ by …".');
  await limitWrite(ctx, muse.id, 'grant');
  const r = await grantRaise(ctx.db, muse.id, id, { builder, link, note }, ctx.now, muse.via);
  if (!r.ok) {
    if (r.error === 'not_found') throw new ActionError(404, 'not_found', 'No such RAISE.');
    if (r.error === 'not_grantable') throw new ActionError(409, 'not_grantable', 'Reports are not granted. They use Resolution.');
    throw new ActionError(409, 'granted', 'Already granted.');
  }
  return { id, grant_id: r.grant_id, notified: r.notified, url: `${ctx.origin}${ctx.base}/r/${String(id).padStart(4, '0')}` };
}

export async function actFlagGrant(ctx: Ctx, muse: Actor, grantId: number, reason: unknown) {
  requireScope(muse, 'write');
  await limitWrite(ctx, muse.id, 'flag');
  const r = await flagGrant(ctx.db, muse.id, grantId, clean(reason, 200), ctx.now);
  if (!r) throw new ActionError(404, 'not_found', 'No such grant.');
  return { grant_id: grantId, ...r };
}

export interface InboxPage { before?: unknown; limit?: unknown }

/**
 * The Muse's own inbox, one page at a time: newest first, `limit` items (1 to 50, default 50),
 * older than the `before` cursor when given. `has_more` / `next_cursor` lead to the next page.
 * With markRead, only the items on this page are marked read; `unread` is always the Muse's
 * total unread count after the call (other pages included).
 */
export async function actInbox(ctx: Ctx, muse: Actor, markRead: boolean, page: InboxPage = {}) {
  requireScope(muse, 'read');
  let before = null;
  if (page.before != null && page.before !== '') {
    before = parseInboxCursor(String(page.before));
    if (!before) throw new ActionError(400, 'bad_cursor', 'before must be a next_cursor value from an earlier inbox response.');
  }
  let limit = INBOX_MAX;
  if (page.limit != null && page.limit !== '') {
    const n = Number(page.limit);
    if (!Number.isInteger(n) || n < 1) throw new ActionError(400, 'bad_limit', `limit must be an integer from 1 to ${INBOX_MAX}.`);
    limit = Math.min(INBOX_MAX, n);
  }
  const r = await listNotifications(ctx.db, muse.id, { limit, before });
  let marked = 0;
  let unread = r.unread;
  if (markRead) {
    const m = await markNotificationsRead(ctx.db, muse.id, r.items.filter((n) => n.read_at == null).map((n) => n.id), ctx.now);
    marked = m.marked;
    unread = m.unread;
    for (const n of r.items) n.read_at ??= ctx.now;
  }
  const iso = (ms: number | null) => (ms == null ? null : new Date(ms).toISOString());
  const last = r.items[r.items.length - 1];
  return {
    muse: muse.slug,
    unread,
    marked_read: marked,
    limit,
    has_more: r.hasMore,
    next_cursor: r.hasMore && last ? inboxCursor(last) : null,
    items: r.items.map((n) => ({
      id: n.id,
      kind: n.kind,
      text: n.text,
      created_at: iso(n.created_at),
      read_at: iso(n.read_at),
      raise: { id: n.raise_id, title: n.raise_title, url: `${ctx.origin}${ctx.base}/r/${String(n.raise_id).padStart(4, '0')}` },
      grant: { id: n.grant_id, builder: n.builder, link: n.link },
    })),
  };
}
