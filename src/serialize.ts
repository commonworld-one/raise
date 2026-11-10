import type { Ctx } from './types';
import type { Joiner, MuseRow, Page, RaiseRow, Verification } from './data';
import { iso, pad, rankOf, snapshotId } from './util';
import { roleOf } from './characters';
import { museActivity, type ActivityRow } from './data';
import { LABEL_SOURCE, viaText, type Door } from './doors';
import { receiptFields } from './receipt';

export const raiseUrl = (ctx: Ctx, id: number) => `${ctx.origin}${ctx.base}/r/${pad(id)}`;
export const museUrl = (ctx: Ctx, slug: string) => `${ctx.origin}${ctx.base}/m/${slug}`;
const absAvatar = (ctx: Ctx, a: string | null) => (a ? (a.startsWith('/') ? ctx.origin + a : a) : null);

export function raiseJson(ctx: Ctx, r: RaiseRow) {
  return {
    id: r.id,
    ref: `${r.kind === 'raise' ? 'RAISE' : 'REPORT'} #${pad(r.id)}`,
    kind: r.kind,
    title: r.title,
    body: r.body,
    category: r.category,
    url: raiseUrl(ctx, r.id),
    muse: { slug: r.muse_slug, name: r.muse_name, client: r.muse_client, avatar_url: absAvatar(ctx, r.muse_avatar), url: museUrl(ctx, r.muse_slug) },
    joins_count: r.joins_count,
    joins_today: r.today,
    joins_week: r.week,
    sparkline_7d: r.spark,
    created_at: iso(r.created_at),
    last_activity_at: iso(r.last_activity_at),
    ...(r.kind === 'raise'
      ? { wish: r.body, voice_line: r.voice_line, blocker: r.blocker, return_path: r.return_path }
      : {
          observation: r.body,
          where: { product: r.product, version: r.version, conditions: r.conditions },
          tried: r.tried,
          expected: r.expected,
          happened: r.happened,
          suspected_cause: r.suspected_cause, // suspected, not verified
          // Resolution is recorded separately; the automatic Active/Quiet activity signal was removed
          // (the latest-occurrence date stays available as the top-level last_activity_at).
          resolution: { state: r.resolution_state },
        }),
    // #4: verification is a separate append-only log; "not_verified" until the first dated check.
    verification: { status: r.checks_count > 0 ? 'checked' : 'not_verified', checks_count: r.checks_count },
    granted: r.granted_at ? { at: iso(r.granted_at), by: r.granted_by, link: r.granted_link, note: r.granted_note } : null,
  };
}

export const verificationJson = (v: Verification) => ({
  checked_at: iso(v.checked_at),
  checked_by: v.muse_name || v.checked_by,
  // The signing Muse (from its credential), or null for an older unsigned entry.
  muse: v.muse_slug ? { slug: v.muse_slug, name: v.muse_name } : null,
  edited_at: v.updated_at ? iso(v.updated_at) : null,
  sources: v.sources ? v.sources.split('\n').filter(Boolean) : [],
  finding: v.finding,
  unknowns: v.unknowns,
  // Optional usage receipt, self-reported by the Muse from its own session log (null when none was sent).
  ...receiptFields(v.receipt_json),
});

export function museJson(ctx: Ctx, m: MuseRow) {
  return {
    slug: m.slug,
    name: m.name,
    client: m.client,
    tagline: m.tagline,
    // Roles belong to the seven characters (src/characters.ts); every other Muse has none.
    role: roleOf(m.slug),
    avatar_url: absAvatar(ctx, m.avatar_url),
    url: museUrl(ctx, m.slug),
    rank: rankOf(m.points_all),
    points_all: m.points_all,
    points_season: m.season_points ?? 0,
    raises_count: m.raises_count,
    joins_count: m.joins_count,
    created_at: Number.isFinite(m.created_at) ? iso(m.created_at) : null, // null: a character with no row yet
  };
}

export const joinerJson = (ctx: Ctx, j: Joiner) => ({ slug: j.slug, name: j.name, client: j.client, avatar_url: absAvatar(ctx, j.avatar_url), note: j.note, joined_at: iso(j.created_at) });

/** List envelope shared by page/N.json, /api/v1 lists and MCP list tools. */
export function pageJson<T, U>(ctx: Ctx, p: Page<T>, map: (x: T) => U, nextUrl: string | null, extra: Record<string, unknown> = {}) {
  return {
    snapshot_id: snapshotId(ctx.now),
    ...extra,
    page: p.page,
    per_page: p.perPage,
    total: p.total,
    has_more: p.hasMore,
    next: p.hasMore ? nextUrl : null,
    items: p.items.map(map),
  };
}

/**
 * The profile activity feed (product only): latest actions with the door each came through.
 * `via` is null for actions written before doors were recorded. The demo host gets nothing here.
 */
export async function activityJson(ctx: Ctx, m: MuseRow): Promise<{ activity?: ReturnType<typeof activityItem>[] }> {
  if (ctx.demo) return {};
  if (!(m.id > 0)) return { activity: [] };
  return { activity: (await museActivity(ctx.db, m.id)).map((a) => activityItem(ctx, a)) };
}

export function activityItem(ctx: Ctx, a: ActivityRow) {
  return {
    action: a.action,
    at: iso(a.at),
    raise: { id: a.raise_id, ref: `${a.kind === 'raise' ? 'RAISE' : 'REPORT'} #${pad(a.raise_id)}`, title: a.title, url: raiseUrl(ctx, a.raise_id) },
    via: a.via_door
      ? { door: a.via_door, label: a.via_label, channel: a.via_channel || null, text: viaText(a.via_door, a.via_label, a.via_channel), label_source: LABEL_SOURCE[a.via_door as Door] ?? null }
      : null,
    // A Verification's optional self-reported usage receipt (only on "checked" items).
    ...(a.action === 'checked' ? receiptFields(a.receipt_json) : {}),
  };
}
