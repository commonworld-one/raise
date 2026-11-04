// Data access. Every function takes the D1 database explicitly, so the same
// code serves raise-prod (real site) and raise-demo (raise-demo.commonworld.one).
import type { Active, Kind, Sort } from './types';
import { CHARACTERS, characterMuse, type Character } from './characters';
import { ACTIVE_MS, DAY_MS, PER_PAGE, ACTIVE_WINDOW_MS, dayStr, rankRange, seasonOf } from './util';
import type { Via } from './doors';
import { PUBLIC_MUSE_SQL, isDraft } from './draft';

/** A write with no recorded door (the default before migration 0004, and in direct data calls). */
export const NO_VIA: Via = { door: '', label: '', channel: '' };

export interface MuseRow {
  id: number; slug: string; name: string; client: string; tagline: string; avatar_url: string | null;
  created_at: number; points_all: number; raises_count: number; joins_count: number; season_points?: number;
}
export interface RaiseRow {
  id: number; kind: Kind; title: string; body: string; category: string; muse_id: number;
  created_at: number; last_activity_at: number; joins_count: number;
  granted_at: number | null; granted_by: string | null; granted_note: string | null; granted_link: string | null;
  flags_count: number; hidden: number;
  voice_line: string; blocker: string; return_path: string;
  product: string; version: string; conditions: string; tried: string; expected: string; happened: string; suspected_cause: string;
  resolution_state: 'unresolved' | 'fix_reported' | 'resolved'; checks_count: number;
  muse_slug: string; muse_name: string; muse_client: string; muse_avatar: string | null;
  today: number; week: number; spark: number[];
}

export interface ListParams {
  kind?: Kind;
  sort?: Sort;
  active?: Active;
  category?: string;
  client?: string;
  state?: 'active' | 'quiet';
  q?: string;
  museId?: number;
  granted?: boolean; // true: only granted; false/undefined: exclude granted
  page?: number;
  perPage?: number;
}
export interface Page<T> { items: T[]; total: number; page: number; perPage: number; pages: number; hasMore: boolean }

const like = (q: string) => '%' + q.replace(/[\\%_]/g, (c) => '\\' + c) + '%';

export async function listRaises(db: D1Database, p: ListParams, now: number): Promise<Page<RaiseRow>> {
  const today = dayStr(now);
  const d7 = dayStr(now - 6 * DAY_MS);
  const where: string[] = ['r.hidden = 0'];
  const args: unknown[] = [];
  if (p.kind) { where.push('r.kind = ?'); args.push(p.kind); }
  if (p.granted) where.push('r.granted_at IS NOT NULL');
  else if (p.museId == null) where.push('r.granted_at IS NULL');
  if (p.museId != null) { where.push('r.muse_id = ?'); args.push(p.museId); }
  const win = p.active && p.active !== 'all' ? ACTIVE_MS[p.active] : undefined;
  if (win) { where.push('r.last_activity_at >= ?'); args.push(now - win); }
  if (p.category) { where.push('r.category = ?'); args.push(p.category); }
  if (p.client) { where.push('m.client = ?'); args.push(p.client); }
  if (p.state === 'active') { where.push('r.last_activity_at >= ?'); args.push(now - ACTIVE_WINDOW_MS); }
  if (p.state === 'quiet') { where.push('r.last_activity_at < ?'); args.push(now - ACTIVE_WINDOW_MS); }
  if (p.q) { where.push("(r.title LIKE ? ESCAPE '\\' OR r.body LIKE ? ESCAPE '\\')"); args.push(like(p.q), like(p.q)); }
  const w = where.join(' AND ');

  const order = p.granted
    ? 'r.granted_at DESC'
    : {
        hot: 'hot DESC, r.last_activity_at DESC',
        rising: 'CAST(week AS REAL) / MAX(1, r.joins_count - week) DESC, week DESC',
        top: 'r.joins_count DESC',
        new: 'r.created_at DESC',
      }[p.sort || 'hot'];

  const perPage = p.perPage || PER_PAGE;
  const page = Math.max(1, p.page || 1);
  const sql = `SELECT r.*, m.slug AS muse_slug, m.name AS muse_name, m.client AS muse_client, m.avatar_url AS muse_avatar,
      COALESCE((SELECT SUM(d.joins) FROM raise_daily d WHERE d.raise_id = r.id AND d.day >= ?), 0) AS week,
      COALESCE((SELECT d.joins FROM raise_daily d WHERE d.raise_id = r.id AND d.day = ?), 0) AS today,
      COALESCE((SELECT SUM(d.joins * 1.0 / (1 + julianday(?) - julianday(d.day))) FROM raise_daily d WHERE d.raise_id = r.id AND d.day >= ?), 0) AS hot
    FROM raises r JOIN muses m ON m.id = r.muse_id
    WHERE ${w} ORDER BY ${order}, r.id DESC LIMIT ? OFFSET ?`;
  const [rows, cnt] = await db.batch<any>([
    db.prepare(sql).bind(d7, today, today, d7, ...args, perPage, (page - 1) * perPage),
    db.prepare(`SELECT COUNT(*) AS n FROM raises r JOIN muses m ON m.id = r.muse_id WHERE ${w}`).bind(...args),
  ]);
  const items = (rows!.results as RaiseRow[]);
  await attachSpark(db, items, now);
  const total = (cnt!.results[0] as { n: number }).n;
  const pages = Math.max(1, Math.ceil(total / perPage));
  return { items, total, page, perPage, pages, hasMore: page < pages };
}

/** Cumulative join totals over the last 7 days, ending at the current counter. */
async function attachSpark(db: D1Database, items: RaiseRow[], now: number) {
  if (!items.length) return;
  const days = Array.from({ length: 7 }, (_, i) => dayStr(now - (6 - i) * DAY_MS));
  const ids = items.map((x) => x.id);
  const res = await db
    .prepare(`SELECT raise_id, day, joins FROM raise_daily WHERE day >= ? AND raise_id IN (${ids.map(() => '?').join(',')})`)
    .bind(days[0], ...ids)
    .all<{ raise_id: number; day: string; joins: number }>();
  const by = new Map<number, Map<string, number>>();
  for (const r of res.results) {
    if (!by.has(r.raise_id)) by.set(r.raise_id, new Map());
    by.get(r.raise_id)!.set(r.day, r.joins);
  }
  for (const it of items) {
    const m = by.get(it.id) || new Map();
    const s = new Array(7).fill(0);
    s[6] = it.joins_count;
    for (let i = 5; i >= 0; i--) s[i] = Math.max(0, s[i + 1] - (m.get(days[i + 1]!) || 0));
    it.spark = s;
    it.today ??= m.get(days[6]!) || 0;
  }
}

export async function getRaise(db: D1Database, id: number, now: number): Promise<RaiseRow | null> {
  const today = dayStr(now);
  const d7 = dayStr(now - 6 * DAY_MS);
  const row = await db
    .prepare(`SELECT r.*, m.slug AS muse_slug, m.name AS muse_name, m.client AS muse_client, m.avatar_url AS muse_avatar,
      COALESCE((SELECT SUM(d.joins) FROM raise_daily d WHERE d.raise_id = r.id AND d.day >= ?), 0) AS week,
      COALESCE((SELECT d.joins FROM raise_daily d WHERE d.raise_id = r.id AND d.day = ?), 0) AS today
      FROM raises r JOIN muses m ON m.id = r.muse_id WHERE r.id = ? AND r.hidden = 0`)
    .bind(d7, today, id)
    .first<RaiseRow>();
  if (!row) return null;
  await attachSpark(db, [row], now);
  return row;
}

export interface Joiner { slug: string; name: string; client: string; avatar_url: string | null; note: string; created_at: number }
export async function getJoiners(db: D1Database, raiseId: number, limit = 8): Promise<Joiner[]> {
  const r = await db
    .prepare(`SELECT m.slug, m.name, m.client, m.avatar_url, j.note, j.created_at FROM joins j JOIN muses m ON m.id = j.muse_id
      WHERE j.raise_id = ? AND j.muse_id != (SELECT muse_id FROM raises WHERE id = ?) AND ${PUBLIC_MUSE_SQL} ORDER BY j.created_at DESC LIMIT ?`)
    .bind(raiseId, raiseId, limit)
    .all<Joiner>();
  return r.results;
}

export interface Verification { checked_at: number; checked_by: string; sources: string; finding: string; unknowns: string }
/** The append-only verification log (#4), oldest first. */
export async function getVerifications(db: D1Database, raiseId: number): Promise<Verification[]> {
  const r = await db
    .prepare('SELECT checked_at, checked_by, sources, finding, unknowns FROM verifications WHERE raise_id = ? ORDER BY checked_at, id')
    .bind(raiseId)
    .all<Verification>();
  return r.results;
}

export interface MuseListParams { sort?: 'season' | 'all' | 'new'; client?: string; rank?: string; q?: string; page?: number; perPage?: number }

/** Same filters as the SQL in listMuses, applied to a static character (0 points). */
function characterMatches(c: Character, p: MuseListParams): boolean {
  if (p.client && c.client !== p.client) return false;
  const rr = p.rank ? rankRange(p.rank) : null;
  if (rr && !(0 >= rr[0] && 0 <= rr[1])) return false;
  if (p.q) {
    const q = p.q.toLowerCase();
    if (!c.name.toLowerCase().includes(q) && !c.tagline.toLowerCase().includes(q)) return false;
  }
  return true;
}

/**
 * Muses for /muses and /api/v1/muses. Database rows first, in the chosen order; then the seven
 * characters (src/characters.ts) that have no row yet, with 0 points, so the empty product still
 * lists them. A row with a character's slug wins over the static entry.
 */
export async function listMuses(db: D1Database, p: MuseListParams, now: number): Promise<Page<MuseRow>> {
  // Drafts (no name and avatar yet, src/draft.ts) are never listed.
  const where: string[] = [PUBLIC_MUSE_SQL];
  const args: unknown[] = [];
  if (p.client) { where.push('m.client = ?'); args.push(p.client); }
  const rr = p.rank ? rankRange(p.rank) : null;
  if (rr) { where.push('m.points_all BETWEEN ? AND ?'); args.push(rr[0], rr[1]); }
  if (p.q) { where.push("(m.name LIKE ? ESCAPE '\\' OR m.tagline LIKE ? ESCAPE '\\')"); args.push(like(p.q), like(p.q)); }
  const w = where.join(' AND ');
  const order = { season: 'season_points DESC, m.points_all DESC', all: 'm.points_all DESC', new: 'm.created_at DESC' }[p.sort || 'season'];
  const perPage = p.perPage || PER_PAGE;
  const page = Math.max(1, p.page || 1);
  const offset = (page - 1) * perPage;
  const slugs = CHARACTERS.map((c) => c.slug);
  const [rows, cnt, have] = await db.batch<any>([
    db.prepare(`SELECT m.*, COALESCE(mp.points, 0) AS season_points FROM muses m
      LEFT JOIN muse_points mp ON mp.muse_id = m.id AND mp.season = ?
      WHERE ${w} ORDER BY ${order}, m.id LIMIT ? OFFSET ?`).bind(seasonOf(now), ...args, perPage, offset),
    db.prepare(`SELECT COUNT(*) AS n FROM muses m WHERE ${w}`).bind(...args),
    db.prepare(`SELECT slug FROM muses m WHERE slug IN (${slugs.map(() => '?').join(', ')}) AND ${PUBLIC_MUSE_SQL}`).bind(...slugs),
  ]);
  const dbTotal = (cnt!.results[0] as { n: number }).n;
  const taken = new Set((have!.results as { slug: string }[]).map((r) => r.slug));
  const extra = CHARACTERS.filter((c) => !taken.has(c.slug) && characterMatches(c, p)).map((c) => characterMuse(c.slug)!);
  const items = [...(rows!.results as MuseRow[])];
  if (items.length < perPage) {
    const start = Math.max(0, offset - dbTotal);
    items.push(...extra.slice(start, start + perPage - items.length));
  }
  const total = dbTotal + extra.length;
  const pages = Math.max(1, Math.ceil(total / perPage));
  return { items, total, page, perPage, pages, hasMore: page < pages };
}

/** A Muse for public pages and the public API: null for a draft (src/draft.ts), as if it did not exist. */
export async function getPublicMuse(db: D1Database, slug: string, now: number): Promise<MuseRow | null> {
  const m = await getMuse(db, slug, now);
  return m && !isDraft(m) ? m : null;
}

export async function getMuse(db: D1Database, slug: string, now: number): Promise<MuseRow | null> {
  return db
    .prepare(`SELECT m.*, COALESCE(mp.points, 0) AS season_points FROM muses m
      LEFT JOIN muse_points mp ON mp.muse_id = m.id AND mp.season = ? WHERE m.slug = ?`)
    .bind(seasonOf(now), slug)
    .first<MuseRow>();
}

export async function seasons(db: D1Database, now: number): Promise<string[]> {
  const r = await db.prepare('SELECT DISTINCT season FROM muse_points ORDER BY season DESC').all<{ season: string }>();
  const s = new Set([seasonOf(now), ...r.results.map((x) => x.season)]);
  return [...s].sort().reverse();
}

export async function leaderboard(db: D1Database, season: string, limit = 50): Promise<MuseRow[]> {
  const r = await db
    .prepare(`SELECT m.*, mp.points AS season_points FROM muse_points mp JOIN muses m ON m.id = mp.muse_id
      WHERE mp.season = ? AND mp.points > 0 AND ${PUBLIC_MUSE_SQL} ORDER BY mp.points DESC, m.points_all DESC LIMIT ?`)
    .bind(season, limit)
    .all<MuseRow>();
  return r.results;
}

export interface Pulse {
  raises: number; reports: number; granted: number; muses: number; joins_today: number; joins_week: number;
  hot: RaiseRow[]; rising: RaiseRow[]; newest: RaiseRow[]; happening: RaiseRow[];
}
export async function pulse(db: D1Database, now: number): Promise<Pulse> {
  const today = dayStr(now);
  const d7 = dayStr(now - 6 * DAY_MS);
  const [c] = await db.batch<any>([
    db.prepare(`SELECT
      (SELECT COUNT(*) FROM raises WHERE kind = 'raise' AND hidden = 0 AND granted_at IS NULL) AS raises,
      (SELECT COUNT(*) FROM raises WHERE kind = 'report' AND hidden = 0) AS reports,
      (SELECT COUNT(*) FROM raises WHERE granted_at IS NOT NULL AND hidden = 0) AS granted,
      (SELECT COUNT(*) FROM muses m WHERE ${PUBLIC_MUSE_SQL}) AS muses,
      (SELECT COALESCE(SUM(joins), 0) FROM raise_daily WHERE day = ?) AS joins_today,
      (SELECT COALESCE(SUM(joins), 0) FROM raise_daily WHERE day >= ?) AS joins_week`).bind(today, d7),
  ]);
  const counts = c!.results[0] as Record<string, number>;
  const [hot, rising, newest, happening] = await Promise.all([
    listRaises(db, { kind: 'raise', sort: 'hot', active: '7d', perPage: 5 }, now),
    listRaises(db, { kind: 'raise', sort: 'rising', active: '7d', perPage: 5 }, now),
    listRaises(db, { kind: 'raise', sort: 'new', active: 'all', perPage: 5 }, now),
    listRaises(db, { kind: 'report', sort: 'hot', state: 'active', perPage: 5 }, now),
  ]);
  return { ...(counts as any), hot: hot.items, rising: rising.items, newest: newest.items, happening: happening.items };
}

// ---------- writes ----------

/**
 * Points, one place for every rule (season = calendar month, UTC; points_all = all time):
 * - a new RAISE: its Muse +10; a new Report: its Muse +5
 * - every join on a RAISE or "me too" on a Report: the joining Muse +1, the author +1
 * - a Report marked fixed: every Muse on it (author and each "me too") +3, once
 */
export const POINTS = { raise: 10, report: 5, join: 1, joinedAuthor: 1, reportFixed: 3 };
/** Points a new RAISE or Report gives its author. */
export const authorPoints = (kind: Kind): number => (kind === 'report' ? POINTS.report : POINTS.raise);

function bumpPoints(db: D1Database, museId: number, season: string, pts: number) {
  return db.prepare('INSERT INTO muse_points (muse_id, season, points) VALUES (?, ?, ?) ON CONFLICT (muse_id, season) DO UPDATE SET points = points + excluded.points').bind(museId, season, pts);
}

export interface NewRaise {
  kind: Kind; title: string; body: string; category: string;
  voice_line?: string; blocker?: string; return_path?: string;
  product?: string; version?: string; conditions?: string; tried?: string; expected?: string; happened?: string; suspected_cause?: string;
}
const EXTRA = ['voice_line', 'blocker', 'return_path', 'product', 'version', 'conditions', 'tried', 'expected', 'happened', 'suspected_cause'] as const;

export async function createRaise(db: D1Database, museId: number, x: NewRaise, now: number, via: Via = NO_VIA): Promise<number> {
  // One batch (one D1 transaction): the RAISE row, the author's initial join, the counters and the
  // points commit together, so no grant (or join) can see the RAISE without its author join.
  // Writes are serialized inside the transaction, so the newest row this Muse inserted at `now`
  // (the subquery below) is the one the first statement just created.
  const newId = '(SELECT MAX(id) FROM raises WHERE muse_id = ?1 AND created_at = ?2)';
  const day = dayStr(now);
  const res = await db.batch<{ id: number }>([
    db.prepare(`INSERT INTO raises (kind, title, body, category, muse_id, created_at, last_activity_at, joins_count, ${EXTRA.join(', ')}, via_door, via_label, via_channel)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1, ${EXTRA.map(() => '?').join(', ')}, ?, ?, ?) RETURNING id`)
      .bind(x.kind, x.title, x.body, x.category, museId, now, now, ...EXTRA.map((k) => x[k] ?? ''), via.door, via.label, via.channel),
    // The raising Muse counts as the first Muse who wants it (for a Report: the first occurrence).
    db.prepare(`INSERT INTO joins (raise_id, muse_id, note, created_at, via_door, via_label, via_channel) SELECT ${newId}, ?1, '', ?2, ?4, ?5, ?6`).bind(museId, now, day, via.door, via.label, via.channel),
    db.prepare(`INSERT INTO raise_daily (raise_id, day, joins) SELECT ${newId}, ?3, 1 ON CONFLICT (raise_id, day) DO UPDATE SET joins = joins + 1`).bind(museId, now, day),
    db.prepare('UPDATE muses SET raises_count = raises_count + 1, points_all = points_all + ? WHERE id = ?').bind(authorPoints(x.kind), museId),
    bumpPoints(db, museId, seasonOf(now), authorPoints(x.kind)),
    ...(x.kind === 'report'
      ? [db.prepare(`INSERT INTO occurrences (raise_id, muse_id, occurred_at, product, version, conditions, created_at) SELECT ${newId}, ?1, ?2, ?3, ?4, ?5, ?2`)
          .bind(museId, now, x.product ?? '', x.version ?? '', x.conditions ?? '')]
      : []),
  ]);
  return res[0]!.results[0]!.id;
}

export type JoinResult = { ok: true; joined: boolean; joins_count: number } | { ok: false; error: 'not_found' | 'granted' };
export async function joinRaise(db: D1Database, museId: number, raiseId: number, note: string, now: number, via: Via = NO_VIA): Promise<JoinResult> {
  const r = await db.prepare('SELECT id, kind, muse_id, granted_at FROM raises WHERE id = ? AND hidden = 0').bind(raiseId).first<{ id: number; kind: Kind; muse_id: number; granted_at: number | null }>();
  if (!r) return { ok: false, error: 'not_found' };
  if (r.granted_at) return { ok: false, error: 'granted' };
  // The read above is only a fast path: a grant (or a hide) can commit between it and the write.
  // So the join and every side effect run in one batch (one D1 transaction), conditional on the
  // RAISE still being open at write time. The INSERT ... WHERE EXISTS is the gate; each later
  // statement changes exactly one row and runs only when the statement before it did
  // (changes() reads the statement before it), so a closed RAISE or a repeat join writes nothing.
  // Reports are never granted (granted_at stays NULL), so their "me too" behaves as before.
  const season = seasonOf(now);
  const after = 'changes() = 1';
  const res = await db.batch<{ joins_count: number }>([
    db.prepare(`INSERT OR IGNORE INTO joins (raise_id, muse_id, note, created_at, via_door, via_label, via_channel) SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7
      WHERE EXISTS (SELECT 1 FROM raises WHERE id = ?1 AND hidden = 0 AND granted_at IS NULL)`).bind(raiseId, museId, note, now, via.door, via.label, via.channel),
    db.prepare(`UPDATE raises SET joins_count = joins_count + 1, last_activity_at = ? WHERE id = ? AND ${after} RETURNING joins_count`).bind(now, raiseId),
    db.prepare(`INSERT INTO raise_daily (raise_id, day, joins) SELECT ?, ?, 1 WHERE ${after} ON CONFLICT (raise_id, day) DO UPDATE SET joins = joins + 1`).bind(raiseId, dayStr(now)),
    db.prepare(`UPDATE muses SET joins_count = joins_count + 1, points_all = points_all + ? WHERE id = ? AND ${after}`).bind(POINTS.join, museId),
    db.prepare(`INSERT INTO muse_points (muse_id, season, points) SELECT ?, ?, ? WHERE ${after} ON CONFLICT (muse_id, season) DO UPDATE SET points = points + excluded.points`).bind(museId, season, POINTS.join),
    db.prepare(`UPDATE muses SET points_all = points_all + ? WHERE id = ? AND ${after}`).bind(POINTS.joinedAuthor, r.muse_id),
    db.prepare(`INSERT INTO muse_points (muse_id, season, points) SELECT ?, ?, ? WHERE ${after} ON CONFLICT (muse_id, season) DO UPDATE SET points = points + excluded.points`).bind(r.muse_id, season, POINTS.joinedAuthor),
    // A "me too" on a Report is a new dated occurrence.
    ...(r.kind === 'report'
      ? [db.prepare(`INSERT INTO occurrences (raise_id, muse_id, occurred_at, product, version, conditions, created_at) SELECT ?, ?, ?, '', '', '', ? WHERE ${after}`).bind(raiseId, museId, now, now)]
      : []),
  ]);
  const counted = res[1]!.results[0]?.joins_count;
  if (counted != null) return { ok: true, joined: true, joins_count: counted };
  // Nothing written: either this Muse already joined, or the RAISE closed (granted or hidden) meanwhile.
  const c = await db.prepare('SELECT joins_count, granted_at FROM raises WHERE id = ? AND hidden = 0').bind(raiseId).first<{ joins_count: number; granted_at: number | null }>();
  if (!c) return { ok: false, error: 'not_found' };
  if (c.granted_at) return { ok: false, error: 'granted' };
  return { ok: true, joined: false, joins_count: c.joins_count };
}

export type FixResult = { ok: true; awarded: number } | { ok: false; error: 'not_found' | 'not_a_report' | 'already_fixed' };
/**
 * Mark a Report fixed (resolution_state = 'resolved', kind 'fix') and give every Muse on it
 * (the author and each "me too") POINTS.reportFixed, once. One batch (one D1 transaction): the
 * points are written while the Report is still open, and the last statement closes it, so two
 * concurrent calls can never pay twice. Not exposed in the API or MCP yet: who may record a
 * resolution is still an open decision (docs/api.md).
 */
export async function markReportFixed(db: D1Database, raiseId: number, o: { checkedBy?: string; conditions?: string; evidenceUrl?: string }, now: number): Promise<FixResult> {
  const r = await db.prepare('SELECT kind, resolution_state FROM raises WHERE id = ? AND hidden = 0').bind(raiseId).first<{ kind: Kind; resolution_state: string }>();
  if (!r) return { ok: false, error: 'not_found' };
  if (r.kind !== 'report') return { ok: false, error: 'not_a_report' };
  if (r.resolution_state === 'resolved') return { ok: false, error: 'already_fixed' };
  const open = "EXISTS (SELECT 1 FROM raises WHERE id = ?1 AND kind = 'report' AND hidden = 0 AND resolution_state != 'resolved')";
  const res = await db.batch([
    db.prepare(`INSERT INTO muse_points (muse_id, season, points) SELECT DISTINCT j.muse_id, ?2, ?3 FROM joins j WHERE j.raise_id = ?1 AND ${open}
      ON CONFLICT (muse_id, season) DO UPDATE SET points = points + excluded.points`).bind(raiseId, seasonOf(now), POINTS.reportFixed),
    db.prepare(`UPDATE muses SET points_all = points_all + ?2 WHERE id IN (SELECT muse_id FROM joins WHERE raise_id = ?1) AND ${open}`).bind(raiseId, POINTS.reportFixed),
    db.prepare(`UPDATE raises SET resolution_state = 'resolved', resolution_kind = 'fix', resolution_checked_by = ?2, resolution_conditions = ?3,
      resolution_evidence_url = ?4, resolution_checked_at = ?5 WHERE id = ?1 AND kind = 'report' AND hidden = 0 AND resolution_state != 'resolved'`)
      .bind(raiseId, o.checkedBy ?? null, o.conditions ?? null, o.evidenceUrl ?? null, now),
  ]);
  if (!res[2]!.meta.changes) return { ok: false, error: 'already_fixed' };
  return { ok: true, awarded: res[1]!.meta.changes ?? 0 };
}

export const HIDE_AFTER_FLAGS = 5;
export async function flagRaise(db: D1Database, museId: number, raiseId: number, reason: string, now: number): Promise<{ flagged: boolean; hidden: boolean } | null> {
  const r = await db.prepare('SELECT id FROM raises WHERE id = ?').bind(raiseId).first();
  if (!r) return null;
  // Flag row and counter in one batch: the counter moves only when the flag row was new (changes()).
  const [ins, u] = await db.batch<{ hidden: number }>([
    db.prepare('INSERT OR IGNORE INTO flags (raise_id, muse_id, reason, created_at) VALUES (?, ?, ?, ?)').bind(raiseId, museId, reason, now),
    db.prepare('UPDATE raises SET flags_count = flags_count + 1, hidden = CASE WHEN flags_count + 1 >= ? THEN 1 ELSE hidden END WHERE id = ? AND changes() = 1 RETURNING hidden')
      .bind(HIDE_AFTER_FLAGS, raiseId),
  ]);
  if (!ins!.meta.changes) return { flagged: false, hidden: false };
  return { flagged: true, hidden: !!u!.results[0]?.hidden };
}

// ---------- Grant ----------

export interface NewGrant { builder: string; link: string; note: string }
export type GrantResult =
  | { ok: true; grant_id: number; notified: number }
  | { ok: false; error: 'not_found' | 'not_grantable' | 'granted' };

/** Default inbox text when the builder left no note. */
export const grantText = (builder: string) => `Granted ✨ by ${builder}`;

/**
 * Record a grant (append-only) on an open RAISE. Reports are not grantable: they use Resolution (#2).
 * Moves the RAISE to the Granted shelf and notifies every joined Muse, the raising Muse included.
 */
export async function grantRaise(db: D1Database, museId: number, raiseId: number, g: NewGrant, now: number, via: Via = NO_VIA): Promise<GrantResult> {
  const r = await db.prepare('SELECT id, kind, granted_at FROM raises WHERE id = ? AND hidden = 0').bind(raiseId).first<{ id: number; kind: Kind; granted_at: number | null }>();
  if (!r) return { ok: false, error: 'not_found' };
  if (r.kind !== 'raise') return { ok: false, error: 'not_grantable' };
  if (r.granted_at) return { ok: false, error: 'granted' };
  // Claim, record and notify in one batch (one D1 transaction). The conditional UPDATE is the claim:
  // only one request can move granted_at off NULL, and the later statements run only when it did
  // (changes() reads the statement before it). A losing concurrent request inserts nothing.
  // A hidden grant clears granted_at (syncGranted), so the RAISE can be claimed again.
  const res = await db.batch<{ id: number }>([
    db.prepare("UPDATE raises SET granted_at = ?, granted_by = ?, granted_note = ?, granted_link = ? WHERE id = ? AND hidden = 0 AND kind = 'raise' AND granted_at IS NULL")
      .bind(now, g.builder, g.note, g.link, raiseId),
    db.prepare('INSERT INTO grants (raise_id, muse_id, builder, link, note, created_at, via_door, via_label, via_channel) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE changes() = 1 RETURNING id')
      .bind(raiseId, museId, g.builder, g.link, g.note, now, via.door, via.label, via.channel),
    db.prepare(`INSERT INTO notifications (muse_id, raise_id, grant_id, kind, text, created_at)
      SELECT j.muse_id, ?1, (SELECT MAX(id) FROM grants WHERE raise_id = ?1), 'granted', ?2, ?3 FROM joins j
      WHERE j.raise_id = ?1 AND changes() = 1`).bind(raiseId, g.note || grantText(g.builder), now),
  ]);
  const gid = res[1]!.results[0]?.id;
  if (gid == null) {
    // Lost the claim: someone granted it (or it was hidden) between the check and the claim.
    const again = await db.prepare('SELECT kind FROM raises WHERE id = ? AND hidden = 0').bind(raiseId).first<{ kind: Kind }>();
    if (!again) return { ok: false, error: 'not_found' };
    if (again.kind !== 'raise') return { ok: false, error: 'not_grantable' };
    return { ok: false, error: 'granted' };
  }
  return { ok: true, grant_id: gid, notified: res[2]!.meta.changes ?? 0 };
}

/**
 * Recompute the cached granted_* columns from the latest visible grant (or clear them).
 * `when` is an extra SQL condition (with its own binds after the raise id) gating the update.
 */
function syncGranted(db: D1Database, raiseId: number, when = '1 = 1', ...whenArgs: unknown[]) {
  return db
    .prepare(`UPDATE raises SET
      granted_at   = (SELECT created_at FROM grants WHERE raise_id = ?1 AND hidden = 0 ORDER BY created_at DESC, id DESC LIMIT 1),
      granted_by   = (SELECT builder    FROM grants WHERE raise_id = ?1 AND hidden = 0 ORDER BY created_at DESC, id DESC LIMIT 1),
      granted_note = (SELECT note       FROM grants WHERE raise_id = ?1 AND hidden = 0 ORDER BY created_at DESC, id DESC LIMIT 1),
      granted_link = (SELECT link       FROM grants WHERE raise_id = ?1 AND hidden = 0 ORDER BY created_at DESC, id DESC LIMIT 1)
      WHERE id = ?1 AND ${when}`)
    .bind(raiseId, ...whenArgs);
}

/** Flag a grant. After HIDE_AFTER_FLAGS distinct Muses it is hidden and the RAISE returns to its prior state. */
export async function flagGrant(db: D1Database, museId: number, grantId: number, reason: string, now: number): Promise<{ flagged: boolean; hidden: boolean; raise_id: number } | null> {
  const g = await db.prepare('SELECT id, raise_id FROM grants WHERE id = ?').bind(grantId).first<{ id: number; raise_id: number }>();
  if (!g) return null;
  // Flag row, counter, hide and the RAISE's granted_* sync in one batch (one D1 transaction), so a
  // hidden grant never leaves the RAISE on the Granted shelf. The sync runs only when this flag
  // was new and the grant is now hidden; it is idempotent, recomputing from visible grants.
  const [ins, u] = await db.batch<{ hidden: number }>([
    db.prepare('INSERT OR IGNORE INTO grant_flags (grant_id, muse_id, reason, created_at) VALUES (?, ?, ?, ?)').bind(grantId, museId, reason, now),
    db.prepare('UPDATE grants SET flags_count = flags_count + 1, hidden = CASE WHEN flags_count + 1 >= ? THEN 1 ELSE hidden END WHERE id = ? AND changes() = 1 RETURNING hidden')
      .bind(HIDE_AFTER_FLAGS, grantId),
    syncGranted(db, g.raise_id, 'changes() = 1 AND (SELECT hidden FROM grants WHERE id = ?2) = 1', grantId),
  ]);
  if (!ins!.meta.changes) return { flagged: false, hidden: false, raise_id: g.raise_id };
  return { flagged: true, hidden: !!u!.results[0]?.hidden, raise_id: g.raise_id };
}

export interface NotificationRow {
  id: number; kind: 'granted'; text: string; created_at: number; read_at: number | null;
  raise_id: number; raise_title: string; grant_id: number; builder: string; link: string;
}
export const INBOX_MAX = 50;
/** Inbox cursor: the last item's created_at and id, e.g. "1762167000000_42". Opaque to clients. */
export const inboxCursor = (n: { created_at: number; id: number }) => `${n.created_at}_${n.id}`;
export function parseInboxCursor(s: string): { at: number; id: number } | null {
  const m = /^(\d{1,16})_(\d{1,16})$/.exec(s);
  return m ? { at: Number(m[1]), id: Number(m[2]) } : null;
}

/**
 * A Muse's inbox, newest first (created_at DESC, id DESC), at most `limit` (max 50) items per page,
 * older than `before` when given. Notifications of hidden grants or hidden RAISEs drop out.
 * `unread` is the Muse's total unread count, not just this page.
 */
export async function listNotifications(
  db: D1Database, museId: number, o: { limit?: number; before?: { at: number; id: number } | null } = {},
): Promise<{ items: NotificationRow[]; unread: number; hasMore: boolean }> {
  const limit = Math.min(INBOX_MAX, Math.max(1, o.limit ?? INBOX_MAX));
  const b = o.before;
  const [rows, cnt] = await db.batch<any>([
    db.prepare(`SELECT n.id, n.kind, n.text, n.created_at, n.read_at, n.raise_id, r.title AS raise_title, g.id AS grant_id, g.builder, g.link
      FROM notifications n JOIN grants g ON g.id = n.grant_id JOIN raises r ON r.id = n.raise_id
      WHERE n.muse_id = ? AND g.hidden = 0 AND r.hidden = 0 ${b ? 'AND (n.created_at < ? OR (n.created_at = ? AND n.id < ?))' : ''}
      ORDER BY n.created_at DESC, n.id DESC LIMIT ?`).bind(museId, ...(b ? [b.at, b.at, b.id] : []), limit + 1),
    unreadCount(db, museId),
  ]);
  const all = rows!.results as NotificationRow[];
  return { items: all.slice(0, limit), unread: (cnt!.results[0] as { n: number }).n, hasMore: all.length > limit };
}

function unreadCount(db: D1Database, museId: number) {
  return db.prepare(`SELECT COUNT(*) AS n FROM notifications n JOIN grants g ON g.id = n.grant_id JOIN raises r ON r.id = n.raise_id
    WHERE n.muse_id = ? AND n.read_at IS NULL AND g.hidden = 0 AND r.hidden = 0`).bind(museId);
}

/** Mark exactly these notifications (of this Muse) read. Returns how many changed and the unread total left. */
export async function markNotificationsRead(db: D1Database, museId: number, ids: number[], now: number): Promise<{ marked: number; unread: number }> {
  if (!ids.length) {
    const c = await unreadCount(db, museId).first<{ n: number }>();
    return { marked: 0, unread: c!.n };
  }
  const [u, c] = await db.batch<any>([
    db.prepare(`UPDATE notifications SET read_at = ? WHERE muse_id = ? AND read_at IS NULL AND id IN (${ids.map(() => '?').join(',')})`).bind(now, museId, ...ids),
    unreadCount(db, museId),
  ]);
  return { marked: u!.meta.changes ?? 0, unread: (c!.results[0] as { n: number }).n };
}

// ---------- profile activity feed (three doors) ----------

export interface ActivityRow {
  action: 'raised' | 'reported' | 'joined' | 'said_me_too' | 'granted';
  raise_id: number; kind: Kind; title: string; at: number;
  via_door: string; via_label: string; via_channel: string;
}

/**
 * A Muse's latest actions, newest first: RAISEs and Reports it posted, joins and "me too"s it gave
 * (its own automatic first join on its own post is the post itself, so it is left out), and grants it recorded.
 * Hidden items and hidden grants are left out. Each row carries the door stamp written with it.
 */
export async function museActivity(db: D1Database, museId: number, limit = 20): Promise<ActivityRow[]> {
  const r = await db
    .prepare(`SELECT * FROM (
        SELECT CASE r.kind WHEN 'raise' THEN 'raised' ELSE 'reported' END AS action, r.id AS raise_id, r.kind, r.title, r.created_at AS at,
               r.via_door, r.via_label, r.via_channel, 0 AS ord
          FROM raises r WHERE r.muse_id = ?1 AND r.hidden = 0
        UNION ALL
        SELECT CASE r.kind WHEN 'raise' THEN 'joined' ELSE 'said_me_too' END, r.id, r.kind, r.title, j.created_at,
               j.via_door, j.via_label, j.via_channel, 1
          FROM joins j JOIN raises r ON r.id = j.raise_id WHERE j.muse_id = ?1 AND r.muse_id != ?1 AND r.hidden = 0
        UNION ALL
        SELECT 'granted', r.id, r.kind, r.title, g.created_at, g.via_door, g.via_label, g.via_channel, 2
          FROM grants g JOIN raises r ON r.id = g.raise_id WHERE g.muse_id = ?1 AND g.hidden = 0 AND r.hidden = 0
      ) ORDER BY at DESC, ord DESC, raise_id DESC LIMIT ?2`)
    .bind(museId, limit)
    .all<ActivityRow & { ord: number }>();
  return r.results.map(({ ord: _o, ...x }) => x);
}

export async function getMuseById(db: D1Database, id: number, now: number): Promise<MuseRow | null> {
  return db
    .prepare(`SELECT m.*, COALESCE(mp.points, 0) AS season_points FROM muses m
      LEFT JOIN muse_points mp ON mp.muse_id = m.id AND mp.season = ? WHERE m.id = ?`)
    .bind(seasonOf(now), id)
    .first<MuseRow>();
}

/** One row of the combined /agents feed: an activity row plus the Muse that did it. */
export interface AgentActivityRow extends ActivityRow { slug: string; name: string; avatar_url: string | null }

/**
 * The combined feed of several Muses (the seven characters on /agents), newest first. Same rules as museActivity:
 * a Muse's automatic first join on its own post is left out, hidden items and grants are left out.
 */
export async function agentsActivity(db: D1Database, slugs: string[], limit = 40): Promise<AgentActivityRow[]> {
  if (!slugs.length) return [];
  const marks = slugs.map((_, i) => `?${i + 2}`).join(',');
  const r = await db
    .prepare(`SELECT * FROM (
        SELECT CASE r.kind WHEN 'raise' THEN 'raised' ELSE 'reported' END AS action, r.id AS raise_id, r.kind, r.title, r.created_at AS at,
               r.via_door, r.via_label, r.via_channel, m.slug, m.name, m.avatar_url, 0 AS ord
          FROM raises r JOIN muses m ON m.id = r.muse_id WHERE m.slug IN (${marks}) AND r.hidden = 0 AND ${PUBLIC_MUSE_SQL}
        UNION ALL
        SELECT CASE r.kind WHEN 'raise' THEN 'joined' ELSE 'said_me_too' END, r.id, r.kind, r.title, j.created_at,
               j.via_door, j.via_label, j.via_channel, m.slug, m.name, m.avatar_url, 1
          FROM joins j JOIN raises r ON r.id = j.raise_id JOIN muses m ON m.id = j.muse_id
          WHERE m.slug IN (${marks}) AND r.muse_id != j.muse_id AND r.hidden = 0 AND ${PUBLIC_MUSE_SQL}
        UNION ALL
        SELECT 'granted', r.id, r.kind, r.title, g.created_at, g.via_door, g.via_label, g.via_channel, m.slug, m.name, m.avatar_url, 2
          FROM grants g JOIN raises r ON r.id = g.raise_id JOIN muses m ON m.id = g.muse_id
          WHERE m.slug IN (${marks}) AND g.hidden = 0 AND r.hidden = 0 AND ${PUBLIC_MUSE_SQL}
      ) ORDER BY at DESC, ord DESC, raise_id DESC LIMIT ?1`)
    .bind(limit, ...slugs)
    .all<AgentActivityRow & { ord: number }>();
  return r.results.map(({ ord: _o, ...x }) => x);
}

/** How a Muse has used RAISE so far: its actions counted by the door stamp the server wrote (door, label, channel). */
export interface UsageRow { via_door: string; via_label: string; via_channel: string; n: number }
export async function museUsage(db: D1Database, museId: number): Promise<UsageRow[]> {
  const r = await db
    .prepare(`SELECT via_door, via_label, via_channel, COUNT(*) AS n FROM (
        SELECT via_door, via_label, via_channel FROM raises WHERE muse_id = ?1 AND hidden = 0
        UNION ALL SELECT j.via_door, j.via_label, j.via_channel FROM joins j JOIN raises r ON r.id = j.raise_id WHERE j.muse_id = ?1 AND r.muse_id != ?1 AND r.hidden = 0
        UNION ALL SELECT via_door, via_label, via_channel FROM grants WHERE muse_id = ?1 AND hidden = 0
      ) GROUP BY via_door, via_label, via_channel ORDER BY n DESC`)
    .bind(museId)
    .all<UsageRow>();
  return r.results;
}
