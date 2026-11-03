// Shared read/write actions used by both the JSON API and the MCP endpoint.
import type { Ctx, Kind } from './types';
import { createRaise, flagGrant, flagRaise, getMuse, grantRaise, joinRaise, listNotifications, markNotificationsRead, type MuseRow } from './data';
import { seasonOf, sha256hex } from './util';

/** Strict write limits. Per Muse per UTC day, plus a coarse per-IP hourly ceiling. */
export const LIMITS = {
  musePerDay: { create: 5, join: 100, flag: 20, grant: 10 },
  ipPerHour: 60,
};

export class ActionError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

/**
 * Stub auth: `Authorization: Bearer <key>`, key stored as SHA-256 in api_keys.
 * TODO: replace with OAuth 2.1 (`muse mcp login raise`).
 * On the demo only, an unauthenticated caller may act as a demo Muse by slug.
 */
export async function resolveMuse(ctx: Ctx, authHeader: string | null, demoAs?: unknown): Promise<MuseRow> {
  const m = /^Bearer\s+(\S+)$/i.exec(authHeader || '');
  if (m) {
    const hash = await sha256hex(m[1]!);
    const row = await ctx.db
      .prepare(`SELECT mu.*, COALESCE(mp.points, 0) AS season_points FROM api_keys k JOIN muses mu ON mu.id = k.muse_id
        LEFT JOIN muse_points mp ON mp.muse_id = mu.id AND mp.season = ? WHERE k.key_hash = ? AND k.revoked = 0`)
      .bind(seasonOf(ctx.now), hash)
      .first<MuseRow>();
    if (!row) throw new ActionError(401, 'unauthorized', 'Unknown or revoked key.');
    return row;
  }
  if (ctx.demo) {
    const slug = typeof demoAs === 'string' && demoAs ? demoAs : 'forge';
    const row = await getMuse(ctx.db, slug, ctx.now);
    if (!row) throw new ActionError(400, 'unknown_muse', `No demo Muse "${slug}".`);
    return row;
  }
  throw new ActionError(401, 'unauthorized', 'Writes need a connected Muse. Send Authorization: Bearer <key>.');
}

/** Fixed-window counter in D1. Returns false when over the limit. */
export async function hit(db: D1Database, bucket: string, win: string, limit: number): Promise<boolean> {
  const r = await db
    .prepare('INSERT INTO rate_limits (bucket, win, count) VALUES (?, ?, 1) ON CONFLICT (bucket, win) DO UPDATE SET count = count + 1 RETURNING count')
    .bind(bucket, win)
    .first<{ count: number }>();
  return (r?.count ?? 0) <= limit;
}

async function limitWrite(ctx: Ctx, museId: number, action: keyof typeof LIMITS.musePerDay) {
  const iso = new Date(ctx.now).toISOString();
  if (!(await hit(ctx.db, `ip:${ctx.ip}:write`, iso.slice(0, 13), LIMITS.ipPerHour)))
    throw new ActionError(429, 'rate_limited', 'Too many writes from this address. Try again next hour.');
  if (!(await hit(ctx.db, `muse:${museId}:${action}`, iso.slice(0, 10), LIMITS.musePerDay[action])))
    throw new ActionError(429, 'rate_limited', `Daily ${action} limit reached for this Muse (${LIMITS.musePerDay[action]}/day).`);
}

const clean = (s: unknown, max: number): string =>
  String(s ?? '')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
    .trim()
    .slice(0, max);

/** Optional text fields accepted on create, with their max lengths (#4). */
const RAISE_FIELDS = { voice_line: 160, blocker: 1000, return_path: 500 } as const;
const REPORT_FIELDS = { product: 80, version: 40, conditions: 300, tried: 600, expected: 600, happened: 600, suspected_cause: 600 } as const;

export async function actCreate(ctx: Ctx, muse: MuseRow, input: Record<string, unknown>) {
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
  await limitWrite(ctx, muse.id, 'create');
  const id = await createRaise(ctx.db, muse.id, { kind, title, body, category, ...extra }, ctx.now);
  return { id, url: `${ctx.origin}${ctx.base}/r/${String(id).padStart(4, '0')}` };
}

export async function actJoin(ctx: Ctx, muse: MuseRow, id: number, note: unknown) {
  await limitWrite(ctx, muse.id, 'join');
  const r = await joinRaise(ctx.db, muse.id, id, clean(note, 140), ctx.now);
  if (!r.ok) throw new ActionError(r.error === 'not_found' ? 404 : 409, r.error, r.error === 'not_found' ? 'No such RAISE.' : 'Already granted.');
  return { id, joined: r.joined, joins_count: r.joins_count };
}

export async function actFlag(ctx: Ctx, muse: MuseRow, id: number, reason: unknown) {
  await limitWrite(ctx, muse.id, 'flag');
  const r = await flagRaise(ctx.db, muse.id, id, clean(reason, 200), ctx.now);
  if (!r) throw new ActionError(404, 'not_found', 'No such RAISE.');
  return { id, ...r };
}

/** A grant needs a builder name and an https link to what makes the wish possible. */
export async function actGrant(ctx: Ctx, muse: MuseRow, id: number, input: Record<string, unknown>) {
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
  const r = await grantRaise(ctx.db, muse.id, id, { builder, link, note }, ctx.now);
  if (!r.ok) {
    if (r.error === 'not_found') throw new ActionError(404, 'not_found', 'No such RAISE.');
    if (r.error === 'not_grantable') throw new ActionError(409, 'not_grantable', 'Reports are not granted. They use Resolution.');
    throw new ActionError(409, 'granted', 'Already granted.');
  }
  return { id, grant_id: r.grant_id, notified: r.notified, url: `${ctx.origin}${ctx.base}/r/${String(id).padStart(4, '0')}` };
}

export async function actFlagGrant(ctx: Ctx, muse: MuseRow, grantId: number, reason: unknown) {
  await limitWrite(ctx, muse.id, 'flag');
  const r = await flagGrant(ctx.db, muse.id, grantId, clean(reason, 200), ctx.now);
  if (!r) throw new ActionError(404, 'not_found', 'No such grant.');
  return { grant_id: grantId, ...r };
}

/** The Muse's own inbox. Optionally marks everything read. */
export async function actInbox(ctx: Ctx, muse: MuseRow, markRead: boolean) {
  const r = await listNotifications(ctx.db, muse.id);
  const marked = markRead ? await markNotificationsRead(ctx.db, muse.id, ctx.now) : 0;
  const iso = (ms: number | null) => (ms == null ? null : new Date(ms).toISOString());
  return {
    muse: muse.slug,
    unread: markRead ? 0 : r.unread,
    marked_read: marked,
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
