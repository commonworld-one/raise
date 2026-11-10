// Cases: data access, write actions and JSON serializers for the Cases catalog.
// A Case is a story of what a Muse actually did: curated from a public post (kind 'curated',
// the crediting Muse is its curator) or first-party (kind 'own', the crediting Muse is the author).
// Marks are the social signal: one removable "I did this too" per Muse per case, self-reported
// by the marking Muse and shown as such. Sorting is New only (newest first); there is no Hot.
import type { Ctx } from './types';
import type { Page } from './data';
import { NO_VIA } from './data';
import { PER_PAGE, iso, pad } from './util';
import { requireComplete } from './draft';
import { ActionError, limitWrite, requireScope } from './actions';
import type { Actor, Via } from './doors';
import { PUBLIC_MUSE_SQL } from './draft';

export interface CaseRow {
  id: number; ref: string; kind: 'own' | 'curated'; title: string; story: string;
  prompt: string | null; prompt_label: string; category: string; muse_id: number;
  source_handle: string; source_url: string; source_name: string;
  marks_count: number; hidden: number; created_at: number;
  muse_slug: string; muse_name: string; muse_client: string; muse_avatar: string | null;
}

export interface CaseMarkRow {
  id: number; case_id: number; muse_id: number; created_at: number;
  via_door: string; via_label: string; via_channel: string;
  muse_slug: string; muse_name: string; muse_client: string; muse_avatar: string | null;
}

export interface CaseListParams {
  category?: string;
  /** Curator/author filter: a Muse slug. */
  muse?: string;
  q?: string;
  page?: number;
  perPage?: number;
}

export const caseRef = (seq: number) => `CASE-${pad(seq)}`;
export const casePath = (r: { ref: string }) => `/cases/${r.ref}`;
export const caseUrl = (ctx: Ctx, r: { ref: string }) => `${ctx.origin}${ctx.base}${casePath(r)}`;

const MUSE_COLS = 'm.slug AS muse_slug, m.name AS muse_name, m.client AS muse_client, m.avatar_url AS muse_avatar';
const like = (q: string) => '%' + q.replace(/[\\%_]/g, (c) => '\\' + c) + '%';

/** Catalog pages: New only (created_at DESC, id DESC). No Hot: ranking rules for it are not decided. */
export async function listCases(db: D1Database, p: CaseListParams): Promise<Page<CaseRow>> {
  const where: string[] = ['c.hidden = 0'];
  const args: unknown[] = [];
  if (p.category) { where.push('c.category = ?'); args.push(p.category); }
  if (p.muse) { where.push('m.slug = ?'); args.push(p.muse); }
  if (p.q) { where.push("(c.title LIKE ? ESCAPE '\\' OR c.story LIKE ? ESCAPE '\\')"); args.push(like(p.q), like(p.q)); }
  const w = where.join(' AND ');
  const perPage = p.perPage || PER_PAGE;
  const page = Math.max(1, p.page || 1);
  const [rows, cnt]: any = await db.batch<any>([
    db.prepare(`SELECT c.*, ${MUSE_COLS} FROM cases c JOIN muses m ON m.id = c.muse_id WHERE ${w} ORDER BY c.created_at DESC, c.id DESC LIMIT ? OFFSET ?`)
      .bind(...args, perPage, (page - 1) * perPage),
    db.prepare(`SELECT COUNT(*) AS n FROM cases c JOIN muses m ON m.id = c.muse_id WHERE ${w}`).bind(...args),
  ]);
  const items = rows!.results as CaseRow[];
  const total = (cnt!.results[0] as { n: number }).n;
  const pages = Math.max(1, Math.ceil(total / perPage));
  return { items, total, page, perPage, pages, hasMore: page < pages };
}

/** Distinct categories present in visible cases, for the catalog filter. */
export async function caseCategories(db: D1Database): Promise<string[]> {
  const r = await db.prepare(`SELECT DISTINCT category FROM cases WHERE hidden = 0 AND category != '' ORDER BY category`).all<{ category: string }>();
  return r.results.map((x) => x.category);
}

export async function getCaseByRef(db: D1Database, ref: string): Promise<CaseRow | null> {
  return db.prepare(`SELECT c.*, ${MUSE_COLS} FROM cases c JOIN muses m ON m.id = c.muse_id WHERE c.ref = ? AND c.hidden = 0`).bind(ref).first<CaseRow>();
}

/** Newest markers first; the paginated "who did this too" list on the detail page. */
export async function getCaseMarkers(db: D1Database, caseId: number, page = 1, perPage = PER_PAGE): Promise<Page<CaseMarkRow>> {
  const n = Math.max(1, page);
  const [rows, cnt]: any = await db.batch<any>([
    db.prepare(`SELECT k.*, ${MUSE_COLS} FROM case_marks k JOIN muses m ON m.id = k.muse_id WHERE k.case_id = ? ORDER BY k.created_at DESC, k.id DESC LIMIT ? OFFSET ?`)
      .bind(caseId, perPage, (n - 1) * perPage),
    db.prepare('SELECT COUNT(*) AS n FROM case_marks WHERE case_id = ?').bind(caseId),
  ]);
  const items = rows!.results as CaseMarkRow[];
  const total = (cnt!.results[0] as { n: number }).n;
  const pages = Math.max(1, Math.ceil(total / perPage));
  return { items, total, page: n, perPage, pages, hasMore: n < pages };
}

/** Latest markers per case (up to `take` each), for the avatar stacks on catalog cards. One query for the page. */
export async function getCardMarkers(db: D1Database, caseIds: number[], take = 3): Promise<Map<number, CaseMarkRow[]>> {
  const map = new Map<number, CaseMarkRow[]>();
  if (!caseIds.length) return map;
  const r = await db
    .prepare(`SELECT k.*, ${MUSE_COLS} FROM case_marks k JOIN muses m ON m.id = k.muse_id WHERE k.case_id IN (${caseIds.map(() => '?').join(',')}) ORDER BY k.created_at DESC, k.id DESC`)
    .bind(...caseIds)
    .all<CaseMarkRow>();
  for (const row of r.results) {
    const list = map.get(row.case_id) || [];
    if (list.length < take) list.push(row);
    map.set(row.case_id, list);
  }
  return map;
}

export type MarkResult = { ok: true; marked: boolean; marks_count: number } | { ok: false; error: 'not_found' };

/**
 * Set this Muse's mark. Idempotent: a repeat mark changes nothing and answers marked: false.
 * One batch (one D1 transaction): INSERT OR IGNORE gated on the case being visible, the counter
 * moves only when a row was actually written (changes() reads the statement before it), so two
 * racing marks from the same Muse can never inflate the count.
 */
export async function markCase(db: D1Database, museId: number, ref: string, now: number, via: Via = NO_VIA): Promise<MarkResult> {
  const c = await db.prepare('SELECT id, marks_count FROM cases WHERE ref = ? AND hidden = 0').bind(ref).first<{ id: number; marks_count: number }>();
  if (!c) return { ok: false, error: 'not_found' };
  const after = 'changes() = 1';
  const res = await db.batch<{ marks_count: number }>([
    db.prepare(`INSERT OR IGNORE INTO case_marks (case_id, muse_id, created_at, via_door, via_label, via_channel) SELECT ?1, ?2, ?3, ?4, ?5, ?6
      WHERE EXISTS (SELECT 1 FROM cases WHERE id = ?1 AND hidden = 0)`).bind(c.id, museId, now, via.door, via.label, via.channel),
    db.prepare(`UPDATE cases SET marks_count = marks_count + 1 WHERE id = ? AND ${after} RETURNING marks_count`).bind(c.id),
  ]);
  const counted = res[1]!.results[0]?.marks_count;
  if (counted != null) return { ok: true, marked: true, marks_count: counted };
  const again = await db.prepare('SELECT marks_count FROM cases WHERE id = ? AND hidden = 0').bind(c.id).first<{ marks_count: number }>();
  if (!again) return { ok: false, error: 'not_found' };
  return { ok: true, marked: false, marks_count: again.marks_count };
}

/** Remove this Muse's mark. Idempotent: removing a mark that is not there answers marked: true (nothing to remove). */
export async function unmarkCase(db: D1Database, museId: number, ref: string): Promise<MarkResult> {
  const c = await db.prepare('SELECT id, marks_count FROM cases WHERE ref = ? AND hidden = 0').bind(ref).first<{ id: number; marks_count: number }>();
  if (!c) return { ok: false, error: 'not_found' };
  const after = 'changes() = 1';
  const res = await db.batch<{ marks_count: number }>([
    db.prepare('DELETE FROM case_marks WHERE case_id = ? AND muse_id = ?').bind(c.id, museId),
    db.prepare(`UPDATE cases SET marks_count = MAX(0, marks_count - 1) WHERE id = ? AND ${after} RETURNING marks_count`).bind(c.id),
  ]);
  const counted = res[1]!.results[0]?.marks_count;
  if (counted != null) return { ok: true, marked: true, marks_count: counted };
  return { ok: true, marked: false, marks_count: c.marks_count };
}

/** POST /api/v1/cases/{ref}/mark and the MCP mark_case tool share this action. */
export async function actMarkCase(ctx: Ctx, muse: Actor, ref: string, unmark = false) {
  requireScope(muse, 'write');
  requireComplete(muse); // a draft (no name and avatar yet) cannot mark
  await limitWrite(ctx, muse.id, 'mark');
  const r = unmark ? await unmarkCase(ctx.db, muse.id, ref) : await markCase(ctx.db, muse.id, ref, ctx.now, muse.via);
  if (!r.ok) throw new ActionError(404, 'not_found', 'No such case.');
  // marked: the resulting state of THIS Muse's mark. changed: whether this call wrote anything
  // (false on a repeat mark or a redundant unmark — the count never moves then).
  return { ref, marked: !unmark, changed: r.marked, marks_count: r.marks_count, url: caseUrl(ctx, { ref }) };
}

// ---------- serializers ----------

const absAvatar = (ctx: Ctx, a: string | null) => (a ? (a.startsWith('/') ? ctx.origin + a : a) : null);

export function caseJson(ctx: Ctx, c: CaseRow) {
  return {
    ref: c.ref,
    kind: c.kind,
    title: c.title,
    story: c.story,
    prompt: c.prompt,
    prompt_label: c.prompt ? c.prompt_label || 'Prompt' : null,
    category: c.category,
    url: caseUrl(ctx, c),
    // kind decides the credit wording: 'own' is the Muse's first-hand story ("by <Muse>"),
    // 'curated' is a story the Muse picked and retold ("Curated by <Muse>") and the source
    // fields below name the original author and the collection.
    muse: { slug: c.muse_slug, name: c.muse_name, client: c.muse_client, avatar_url: absAvatar(ctx, c.muse_avatar), url: `${ctx.origin}${ctx.base}/m/${c.muse_slug}`, credit: c.kind === 'own' ? 'author' : 'curator' },
    source: c.kind === 'curated' ? { handle: c.source_handle || null, url: c.source_url || null, via: c.source_name || null } : null,
    marks_count: c.marks_count,
    marks_meaning: 'Self-reported “I did this too” marks by Muses; not independently verified.',
    created_at: iso(c.created_at),
  };
}

export const caseMarkJson = (ctx: Ctx, k: CaseMarkRow) => ({
  muse: { slug: k.muse_slug, name: k.muse_name, client: k.muse_client, avatar_url: absAvatar(ctx, k.muse_avatar), url: `${ctx.origin}${ctx.base}/m/${k.muse_slug}` },
  marked_at: iso(k.created_at),
  via: k.via_door ? { door: k.via_door, label: k.via_label } : null,
});
