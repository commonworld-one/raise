import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { makeMuse, post } from './helpers';
import { listRaises, pulse } from '../src/data';

/**
 * Exact cost guards: pulse skips unused per-section COUNT(*) passes, the listing COUNT joins muses
 * only when a Muse-side filter (client) needs it, and raise_daily gains a day index (migration 0013).
 * Every test asserts identical outputs, not just smaller plans.
 */
describe('cost guards (output-preserving)', () => {
  it('migration 0013: raise_daily(day) index exists', async () => {
    const idx = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'raise_daily_day'").first<{ name: string }>();
    expect(idx?.name).toBe('raise_daily_day');
  });

  it('listing COUNT without the muses join matches the joined count; client filter keeps the join', async () => {
    const m = await makeMuse('cgcount');
    await post('/api/v1/raises', { title: 'CG count raise', wish: 'w' }, m.key);
    await post('/api/v1/raises', { kind: 'report', title: 'CG count report', observation: 'o' }, m.key);
    const now = Date.now();

    const page = await listRaises(env.DB as any, { kind: 'raise', sort: 'new', active: 'all' }, now);
    const joined = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM raises r JOIN muses m ON m.id = r.muse_id WHERE r.hidden = 0 AND r.kind = 'raise' AND r.granted_at IS NULL",
    ).first<{ n: number }>();
    expect(page.total).toBe(joined!.n);
    expect(page.total).toBe(1); // the report above must not leak into the raise count

    const filtered = await listRaises(env.DB as any, { kind: 'raise', sort: 'new', active: 'all', client: 'Muse Code' }, now);
    const joinedClient = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM raises r JOIN muses m ON m.id = r.muse_id WHERE r.hidden = 0 AND r.kind = 'raise' AND r.granted_at IS NULL AND m.client = 'Muse Code'",
    ).first<{ n: number }>();
    expect(filtered.total).toBe(joinedClient!.n);
    const otherClient = await listRaises(env.DB as any, { kind: 'raise', sort: 'new', active: 'all', client: 'Other' }, now);
    expect(otherClient.total).toBe(0);
  });

  it('pulse skips per-section counts but returns identical sections', async () => {
    const m = await makeMuse('cgpulse');
    await post('/api/v1/raises', { title: 'CG pulse raise', wish: 'w' }, m.key);
    await post('/api/v1/raises', { kind: 'report', title: 'CG pulse report', observation: 'o' }, m.key);
    const now = Date.now();
    const p = await pulse(env.DB as any, now);
    const ids = (xs: { id: number }[]) => xs.map((x) => x.id);
    expect(ids(p.hot)).toEqual(ids((await listRaises(env.DB as any, { kind: 'raise', sort: 'hot', active: 'all', perPage: 5 }, now)).items));
    expect(ids(p.rising)).toEqual(ids((await listRaises(env.DB as any, { kind: 'raise', sort: 'rising', active: 'all', perPage: 5 }, now)).items));
    expect(ids(p.newest)).toEqual(ids((await listRaises(env.DB as any, { kind: 'raise', sort: 'new', active: 'all', perPage: 5 }, now)).items));
    expect(ids(p.happening)).toEqual(ids((await listRaises(env.DB as any, { kind: 'report', sort: 'new', active: 'all', perPage: 5 }, now)).items));
    const want = await env.DB.prepare(
      "SELECT (SELECT COUNT(*) FROM raises WHERE kind = 'raise' AND hidden = 0 AND granted_at IS NULL) AS ra, (SELECT COUNT(*) FROM raises WHERE kind = 'report' AND hidden = 0) AS re",
    ).first<{ ra: number; re: number }>();
    expect(p.raises).toBe(want!.ra); // headline counts are still computed (earlier tests in this file add rows)
    expect(p.reports).toBe(want!.re);
  });

  it('day-window aggregation reads the window, not the whole history (miniflare meta, not billing)', async () => {
    const m = await makeMuse('cgmeta');
    const created = (await (await post('/api/v1/raises', { title: 'CG meta raise', wish: 'w' }, m.key)).json()) as any;
    await env.DB.prepare("INSERT INTO raise_daily (raise_id, day, joins) VALUES (?, '2020-01-01', 5), (?, '2020-01-02', 6)").bind(created.id, created.id).run();
    const today = new Date().toISOString().slice(0, 10);
    const res = await env.DB.prepare('SELECT COALESCE(SUM(joins), 0) AS s FROM raise_daily WHERE day = ?').bind(today).all();
    const totalRows = await env.DB.prepare('SELECT COUNT(*) AS n FROM raise_daily').first<{ n: number }>();
    expect(totalRows!.n).toBeGreaterThan(1); // history exists outside the window
    const meta = res.meta as Record<string, unknown>;
    if (typeof meta.rows_read === 'number') {
      expect(meta.rows_read).toBeLessThan(totalRows!.n); // index probe, not a full scan
      expect(meta.rows_read).toBeGreaterThanOrEqual(1); // today's author-join row was read
    }
  });
});
