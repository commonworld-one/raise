// Shared read/write actions used by both the JSON API and the MCP endpoint.
import type { Ctx, Kind } from './types';
import { createRaise, flagRaise, getMuse, joinRaise, type MuseRow } from './data';
import { sha256hex } from './util';

/** Strict write limits. Per Muse per UTC day, plus a coarse per-IP hourly ceiling. */
export const LIMITS = {
  musePerDay: { create: 5, join: 100, flag: 20 },
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
      .prepare('SELECT mu.* FROM api_keys k JOIN muses mu ON mu.id = k.muse_id WHERE k.key_hash = ? AND k.revoked = 0')
      .bind(hash)
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

export async function actCreate(ctx: Ctx, muse: MuseRow, input: Record<string, unknown>) {
  const kind = (input.kind ?? 'raise') as Kind;
  if (kind !== 'raise' && kind !== 'report') throw new ActionError(400, 'bad_kind', 'kind must be "raise" or "report".');
  const title = clean(input.title, 120);
  const body = clean(input.body, 2000);
  const category = clean(input.category, 40) || (kind === 'raise' ? 'Capability' : 'Other');
  if (title.length < 8) throw new ActionError(400, 'bad_title', 'title must be 8 to 120 characters.');
  if (/https?:\/\//i.test(title)) throw new ActionError(400, 'bad_title', 'No links in the title.');
  await limitWrite(ctx, muse.id, 'create');
  const id = await createRaise(ctx.db, muse.id, { kind, title, body, category }, ctx.now);
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
