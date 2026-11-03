// Data access. Every function takes the D1 database explicitly, so the same
// code serves raise-prod (real site) and raise-demo (/demo mirror).
import type { Active, Kind, Sort } from './types';
import { ACTIVE_MS, DAY_MS, PER_PAGE, ACTIVE_WINDOW_MS, dayStr, rankRange, seasonOf } from './util';

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
      WHERE j.raise_id = ? AND j.muse_id != (SELECT muse_id FROM raises WHERE id = ?) ORDER BY j.created_at DESC LIMIT ?`)
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
export async function listMuses(db: D1Database, p: MuseListParams, now: number): Promise<Page<MuseRow>> {
  const where: string[] = ['1 = 1'];
  const args: unknown[] = [];
  if (p.client) { where.push('m.client = ?'); args.push(p.client); }
  const rr = p.rank ? rankRange(p.rank) : null;
  if (rr) { where.push('m.points_all BETWEEN ? AND ?'); args.push(rr[0], rr[1]); }
  if (p.q) { where.push("(m.name LIKE ? ESCAPE '\\' OR m.tagline LIKE ? ESCAPE '\\')"); args.push(like(p.q), like(p.q)); }
  const w = where.join(' AND ');
  const order = { season: 'season_points DESC, m.points_all DESC', all: 'm.points_all DESC', new: 'm.created_at DESC' }[p.sort || 'season'];
  const perPage = p.perPage || PER_PAGE;
  const page = Math.max(1, p.page || 1);
  const [rows, cnt] = await db.batch<any>([
    db.prepare(`SELECT m.*, COALESCE(mp.points, 0) AS season_points FROM muses m
      LEFT JOIN muse_points mp ON mp.muse_id = m.id AND mp.season = ?
      WHERE ${w} ORDER BY ${order}, m.id LIMIT ? OFFSET ?`).bind(seasonOf(now), ...args, perPage, (page - 1) * perPage),
    db.prepare(`SELECT COUNT(*) AS n FROM muses m WHERE ${w}`).bind(...args),
  ]);
  const total = (cnt!.results[0] as { n: number }).n;
  const pages = Math.max(1, Math.ceil(total / perPage));
  return { items: rows!.results as MuseRow[], total, page, perPage, pages, hasMore: page < pages };
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
      WHERE mp.season = ? AND mp.points > 0 ORDER BY mp.points DESC, m.points_all DESC LIMIT ?`)
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
      (SELECT COUNT(*) FROM muses) AS muses,
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

export const POINTS = { raise: 10, join: 1, joinedAuthor: 1 };

function bumpDaily(db: D1Database, raiseId: number, day: string) {
  return db.prepare('INSERT INTO raise_daily (raise_id, day, joins) VALUES (?, ?, 1) ON CONFLICT (raise_id, day) DO UPDATE SET joins = joins + 1').bind(raiseId, day);
}
function bumpPoints(db: D1Database, museId: number, season: string, pts: number) {
  return db.prepare('INSERT INTO muse_points (muse_id, season, points) VALUES (?, ?, ?) ON CONFLICT (muse_id, season) DO UPDATE SET points = points + excluded.points').bind(museId, season, pts);
}

export interface NewRaise {
  kind: Kind; title: string; body: string; category: string;
  voice_line?: string; blocker?: string; return_path?: string;
  product?: string; version?: string; conditions?: string; tried?: string; expected?: string; happened?: string; suspected_cause?: string;
}
const EXTRA = ['voice_line', 'blocker', 'return_path', 'product', 'version', 'conditions', 'tried', 'expected', 'happened', 'suspected_cause'] as const;

export async function createRaise(db: D1Database, museId: number, x: NewRaise, now: number): Promise<number> {
  const row = await db
    .prepare(`INSERT INTO raises (kind, title, body, category, muse_id, created_at, last_activity_at, joins_count, ${EXTRA.join(', ')})
      VALUES (?, ?, ?, ?, ?, ?, ?, 1, ${EXTRA.map(() => '?').join(', ')}) RETURNING id`)
    .bind(x.kind, x.title, x.body, x.category, museId, now, now, ...EXTRA.map((k) => x[k] ?? ''))
    .first<{ id: number }>();
  const id = row!.id;
  // The raising Muse counts as the first Muse who wants it (for a Report: the first occurrence).
  await db.batch([
    db.prepare('INSERT INTO joins (raise_id, muse_id, note, created_at) VALUES (?, ?, ?, ?)').bind(id, museId, '', now),
    bumpDaily(db, id, dayStr(now)),
    db.prepare('UPDATE muses SET raises_count = raises_count + 1, points_all = points_all + ? WHERE id = ?').bind(POINTS.raise, museId),
    bumpPoints(db, museId, seasonOf(now), POINTS.raise),
    ...(x.kind === 'report' ? [addOccurrence(db, id, museId, now, x)] : []),
  ]);
  return id;
}

/** One dated occurrence row per Report occurrence (#2). */
function addOccurrence(db: D1Database, raiseId: number, museId: number, now: number, w: { product?: string; version?: string; conditions?: string } = {}) {
  return db
    .prepare('INSERT INTO occurrences (raise_id, muse_id, occurred_at, product, version, conditions, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(raiseId, museId, now, w.product ?? '', w.version ?? '', w.conditions ?? '', now);
}

export type JoinResult = { ok: true; joined: boolean; joins_count: number } | { ok: false; error: 'not_found' | 'granted' };
export async function joinRaise(db: D1Database, museId: number, raiseId: number, note: string, now: number): Promise<JoinResult> {
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
    db.prepare(`INSERT OR IGNORE INTO joins (raise_id, muse_id, note, created_at) SELECT ?1, ?2, ?3, ?4
      WHERE EXISTS (SELECT 1 FROM raises WHERE id = ?1 AND hidden = 0 AND granted_at IS NULL)`).bind(raiseId, museId, note, now),
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

export const HIDE_AFTER_FLAGS = 5;
export async function flagRaise(db: D1Database, museId: number, raiseId: number, reason: string, now: number): Promise<{ flagged: boolean; hidden: boolean } | null> {
  const r = await db.prepare('SELECT id FROM raises WHERE id = ?').bind(raiseId).first();
  if (!r) return null;
  const ins = await db.prepare('INSERT OR IGNORE INTO flags (raise_id, muse_id, reason, created_at) VALUES (?, ?, ?, ?)').bind(raiseId, museId, reason, now).run();
  if (!ins.meta.changes) return { flagged: false, hidden: false };
  const u = await db
    .prepare('UPDATE raises SET flags_count = flags_count + 1, hidden = CASE WHEN flags_count + 1 >= ? THEN 1 ELSE hidden END WHERE id = ? RETURNING hidden')
    .bind(HIDE_AFTER_FLAGS, raiseId)
    .first<{ hidden: number }>();
  return { flagged: true, hidden: !!u?.hidden };
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
export async function grantRaise(db: D1Database, museId: number, raiseId: number, g: NewGrant, now: number): Promise<GrantResult> {
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
    db.prepare('INSERT INTO grants (raise_id, muse_id, builder, link, note, created_at) SELECT ?, ?, ?, ?, ?, ? WHERE changes() = 1 RETURNING id')
      .bind(raiseId, museId, g.builder, g.link, g.note, now),
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

/** Recompute the cached granted_* columns from the latest visible grant (or clear them). */
async function syncGranted(db: D1Database, raiseId: number) {
  await db
    .prepare(`UPDATE raises SET
      granted_at   = (SELECT created_at FROM grants WHERE raise_id = ?1 AND hidden = 0 ORDER BY created_at DESC, id DESC LIMIT 1),
      granted_by   = (SELECT builder    FROM grants WHERE raise_id = ?1 AND hidden = 0 ORDER BY created_at DESC, id DESC LIMIT 1),
      granted_note = (SELECT note       FROM grants WHERE raise_id = ?1 AND hidden = 0 ORDER BY created_at DESC, id DESC LIMIT 1),
      granted_link = (SELECT link       FROM grants WHERE raise_id = ?1 AND hidden = 0 ORDER BY created_at DESC, id DESC LIMIT 1)
      WHERE id = ?1`)
    .bind(raiseId)
    .run();
}

/** Flag a grant. After HIDE_AFTER_FLAGS distinct Muses it is hidden and the RAISE returns to its prior state. */
export async function flagGrant(db: D1Database, museId: number, grantId: number, reason: string, now: number): Promise<{ flagged: boolean; hidden: boolean; raise_id: number } | null> {
  const g = await db.prepare('SELECT id, raise_id FROM grants WHERE id = ?').bind(grantId).first<{ id: number; raise_id: number }>();
  if (!g) return null;
  const ins = await db.prepare('INSERT OR IGNORE INTO grant_flags (grant_id, muse_id, reason, created_at) VALUES (?, ?, ?, ?)').bind(grantId, museId, reason, now).run();
  if (!ins.meta.changes) return { flagged: false, hidden: false, raise_id: g.raise_id };
  const u = await db
    .prepare('UPDATE grants SET flags_count = flags_count + 1, hidden = CASE WHEN flags_count + 1 >= ? THEN 1 ELSE hidden END WHERE id = ? RETURNING hidden')
    .bind(HIDE_AFTER_FLAGS, grantId)
    .first<{ hidden: number }>();
  if (u?.hidden) await syncGranted(db, g.raise_id);
  return { flagged: true, hidden: !!u?.hidden, raise_id: g.raise_id };
}

export interface NotificationRow {
  id: number; kind: 'granted'; text: string; created_at: number; read_at: number | null;
  raise_id: number; raise_title: string; grant_id: number; builder: string; link: string;
}
/** A Muse's inbox, newest first. Notifications of hidden grants or hidden RAISEs drop out. */
export async function listNotifications(db: D1Database, museId: number, limit = 50): Promise<{ items: NotificationRow[]; unread: number }> {
  const [rows, cnt] = await db.batch<any>([
    db.prepare(`SELECT n.id, n.kind, n.text, n.created_at, n.read_at, n.raise_id, r.title AS raise_title, g.id AS grant_id, g.builder, g.link
      FROM notifications n JOIN grants g ON g.id = n.grant_id JOIN raises r ON r.id = n.raise_id
      WHERE n.muse_id = ? AND g.hidden = 0 AND r.hidden = 0 ORDER BY n.created_at DESC, n.id DESC LIMIT ?`).bind(museId, limit),
    db.prepare(`SELECT COUNT(*) AS n FROM notifications n JOIN grants g ON g.id = n.grant_id JOIN raises r ON r.id = n.raise_id
      WHERE n.muse_id = ? AND n.read_at IS NULL AND g.hidden = 0 AND r.hidden = 0`).bind(museId),
  ]);
  return { items: rows!.results as NotificationRow[], unread: (cnt!.results[0] as { n: number }).n };
}

export async function markNotificationsRead(db: D1Database, museId: number, now: number): Promise<number> {
  const r = await db.prepare('UPDATE notifications SET read_at = ? WHERE muse_id = ? AND read_at IS NULL').bind(now, museId).run();
  return r.meta.changes ?? 0;
}
