import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { makeMuse } from './helpers';
import { listRaises } from '../src/data';
import { reportAreas } from '../src/index';

/**
 * Differential verification for the two-phase Hot/Rising ranking and the reportAreas skip-scan:
 * the optimized queries must reproduce the legacy single-phase query's FULL ordered output
 * (ids + week/today/hot values) across filters and pages, including boundary fixtures.
 */

const NOW = Date.parse('2026-11-10T12:00:00.000Z');
const DAY = 86_400_000;
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const d7 = day(NOW - 6 * DAY);
const X = Date.parse(d7 + 'T00:00:00.000Z'); // phase boundary: start of the oldest window day

/** Mimic the writer invariant: a join writes raise_daily and bumps joins_count + last_activity_at. */
async function joinAt(raiseId: number, t: number) {
  await env.DB.batch([
    env.DB.prepare('INSERT INTO raise_daily (raise_id, day, joins) VALUES (?, ?, 1) ON CONFLICT (raise_id, day) DO UPDATE SET joins = joins + 1').bind(raiseId, day(t)),
    env.DB.prepare('UPDATE raises SET joins_count = joins_count + 1, last_activity_at = ? WHERE id = ?').bind(t, raiseId),
  ]);
}

async function seed() {
  const clients = ['Muse', 'Muse Code', 'Other'];
  const muses: number[] = [];
  for (let i = 0; i < 3; i++) muses.push((await makeMuse(`diffm${i}`, clients[i]!)).id);
  const raiseCats = ['Capability', 'App or service', ''];
  const reportCats = ['Billing', 'Login', 'Sync', ''];
  const stmts: any[] = [];
  const N = 60;
  for (let i = 1; i <= N; i++) {
    stmts.push(
      env.DB.prepare("INSERT INTO raises (kind, title, body, category, muse_id, created_at, last_activity_at, joins_count, hidden, seq) VALUES ('raise', ?, ?, ?, ?, ?, ?, 1, ?, ?)").bind(
        i % 5 === 0 ? `Card zzz ${i}` : `Card ${i}`,
        i % 7 === 0 ? 'body with zzz' : '',
        raiseCats[i % 3],
        muses[i % 3],
        NOW - 40 * DAY,
        NOW - 40 * DAY,
        i === 11 || i === 23 ? 1 : 0, // two hidden
        i,
      ),
    );
  }
  for (let i = 1; i <= 12; i++) {
    stmts.push(
      env.DB.prepare("INSERT INTO raises (kind, title, category, muse_id, created_at, last_activity_at, joins_count, hidden, seq) VALUES ('report', ?, ?, ?, ?, ?, 1, 0, ?)").bind(
        `Report ${i}`,
        reportCats[i % 4],
        muses[i % 3],
        NOW - 40 * DAY,
        NOW - 40 * DAY,
        i,
      ),
    );
  }
  await env.DB.batch(stmts);
  // Two granted raises (granted sort + exclusion from default lists).
  await env.DB.batch([
    env.DB.prepare('UPDATE raises SET granted_at = ?, granted_by = ? WHERE id = 7').bind(NOW - 2 * DAY, 'Builder'),
    env.DB.prepare('UPDATE raises SET granted_at = ?, granted_by = ? WHERE id = 31').bind(NOW - DAY, 'Builder'),
  ]);

  // Join patterns (writer-invariant consistent): pattern = i % 9.
  for (let i = 1; i <= N + 12; i++) {
    switch (i % 9) {
      case 0: break; // never joined: week/today/hot = 0
      case 1: await joinAt(i, NOW); break; // active now
      case 2: await joinAt(i, NOW - DAY); await joinAt(i, NOW - 2 * DAY); break; // two days in window
      case 3: await joinAt(i, NOW - 8 * DAY); break; // outside the window only
      case 4: await joinAt(i, Date.parse(day(NOW) + 'T00:00:00.000Z')); break; // exactly midnight UTC today
      case 5: await joinAt(i, X); break; // exactly the phase boundary (in window)
      case 6: await joinAt(i, X - 1); break; // 1ms before the boundary (outside)
      case 7: await joinAt(i, X + 1000); await joinAt(i, NOW - 3 * DAY); await joinAt(i, NOW - 5 * DAY); break; // oldest day + more
      case 8: await joinAt(i, NOW - 6 * DAY - 1000); break; // near the boundary, outside
    }
  }
  // Explicit ms ties: three cards joined at the same instant.
  await joinAt(2, NOW - 3600_000);
  await joinAt(4, NOW - 3600_000);
  await joinAt(6, NOW - 3600_000);
}

/** Deterministic PRNG (mulberry32) so rounds are varied but reproducible. */
const prng = (seed: number) => () => {
  seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

/** Randomized round: rndSeed fixes the PRNG; joins stay writer-invariant-consistent. */
async function seedRandom(rndSeed: number, base: number, museIds: number[]) {
  const rnd = prng(rndSeed);
  const cats = ['Capability', 'App or service', ''];
  const stmts: any[] = [];
  const N = 40;
  for (let i = 0; i < N; i++) {
    const id = base + i;
    stmts.push(
      env.DB.prepare("INSERT INTO raises (kind, title, body, category, muse_id, created_at, last_activity_at, joins_count, hidden, seq) VALUES ('raise', ?, ?, ?, ?, ?, ?, 1, ?, ?)").bind(
        rnd() < 0.2 ? `Rand zzz ${id}` : `Rand ${id}`,
        rnd() < 0.15 ? 'rnd body zzz' : '',
        cats[Math.floor(rnd() * 3)],
        museIds[Math.floor(rnd() * museIds.length)],
        NOW - 40 * DAY,
        NOW - 40 * DAY,
        rnd() < 0.1 ? 1 : 0,
        id,
      ),
    );
  }
  await env.DB.batch(stmts);
  for (let i = 0; i < N; i++) {
    const id = base + i;
    const joins = Math.floor(rnd() * 4); // 0..3 joins
    for (let j = 0; j < joins; j++) await joinAt(id, NOW - Math.floor(rnd() * 10) * DAY - Math.floor(rnd() * DAY));
    if (rnd() < 0.1) await joinAt(id, X); // some exactly on the boundary
    if (rnd() < 0.1) await joinAt(id, X - 1); // some just outside
  }
}

/** Pre-change single-phase query (kept verbatim as the reference). */
async function legacyList(p: any) {
  const where: string[] = ['r.hidden = 0'];
  const args: unknown[] = [];
  if (p.kind) { where.push('r.kind = ?'); args.push(p.kind); }
  if (p.granted) where.push('r.granted_at IS NOT NULL');
  else if (p.museId == null) where.push('r.granted_at IS NULL');
  if (p.museId != null) { where.push('r.muse_id = ?'); args.push(p.museId); }
  const ACTIVE: Record<string, number> = { '24h': DAY, '7d': 7 * DAY, '30d': 30 * DAY };
  const win = p.active && p.active !== 'all' ? ACTIVE[p.active] : undefined;
  if (win) { where.push('r.last_activity_at >= ?'); args.push(NOW - win); }
  if (p.category) { where.push('r.category = ?'); args.push(p.category); }
  if (p.client) { where.push('m.client = ?'); args.push(p.client); }
  if (p.state === 'active') { where.push('r.last_activity_at >= ?'); args.push(NOW - 3 * DAY); }
  if (p.state === 'quiet') { where.push('r.last_activity_at < ?'); args.push(NOW - 3 * DAY); }
  if (p.q) { where.push("(r.title LIKE ? ESCAPE '\\' OR r.body LIKE ? ESCAPE '\\')"); args.push(`%${p.q}%`, `%${p.q}%`); }
  const w = where.join(' AND ');
  const order = p.granted
    ? 'r.granted_at DESC'
    : ({
        hot: 'hot DESC, r.last_activity_at DESC',
        rising: 'CAST(week AS REAL) / MAX(1, r.joins_count - week) DESC, week DESC',
        top: 'r.joins_count DESC',
        new: 'r.created_at DESC',
      } as Record<string, string>)[p.sort || 'hot']!;
  const perPage = p.perPage || 50;
  const page = Math.max(1, p.page || 1);
  const rows = await env.DB.prepare(
    `SELECT r.*, COALESCE((SELECT SUM(d.joins) FROM raise_daily d WHERE d.raise_id = r.id AND d.day >= ?), 0) AS week,
      COALESCE((SELECT d.joins FROM raise_daily d WHERE d.raise_id = r.id AND d.day = ?), 0) AS today,
      COALESCE((SELECT SUM(d.joins * 1.0 / (1 + julianday(?) - julianday(d.day))) FROM raise_daily d WHERE d.raise_id = r.id AND d.day >= ?), 0) AS hot
    FROM raises r JOIN muses m ON m.id = r.muse_id
    WHERE ${w} ORDER BY ${order}, r.id DESC LIMIT ? OFFSET ?`,
  ).bind(d7, day(NOW), day(NOW), d7, ...args, perPage, (page - 1) * perPage).all();
  const cnt = await env.DB.prepare(`SELECT COUNT(*) AS n FROM raises r JOIN muses m ON m.id = r.muse_id WHERE ${w}`).bind(...args).first<{ n: number }>();
  return { items: rows.results as any[], total: cnt!.n };
}

const sig = (items: any[]) => items.map((r) => [r.id, r.week, r.today, Math.round(r.hot * 1e9) / 1e9]);

describe('Hot/Rising two-phase differential (full ordered output)', () => {
  it('identical ids + week/today/hot across sorts, filters and pages', async () => {
    await seed();
    const muses = await env.DB.prepare('SELECT id FROM muses ORDER BY id').all<{ id: number }>();
    const filters: any[] = [
      {},
      { category: 'Capability' },
      { category: '' },
      { client: 'Muse' },
      { client: 'Muse Code' },
      { q: 'zzz' },
      { q: 'absent-word' },
      { museId: (muses.results[1] as any).id },
      { active: '24h' },
      { active: '7d' },
      { active: '30d' },
      { active: 'all' },
      { state: 'active' },
      { state: 'quiet' },
      { active: '30d', category: 'App or service' },
      { q: 'zzz', client: 'Muse Code' },
    ];
    for (const kind of ['raise', 'report'] as const) {
      for (const sort of ['hot', 'rising'] as const) {
        for (const f of filters) {
          const perPage = 7;
          let collected = 0;
          let total = -1;
          for (let page = 1; ; page++) {
            expect(page, `${kind}/${sort} ${JSON.stringify(f)}: page cap exceeded`).toBeLessThan(60);
            const p = { kind, sort, active: 'all', ...f, perPage, page };
            const got = await listRaises(env.DB as any, p, NOW);
            const want = await legacyList(p);
            expect(sig(got.items), `${kind}/${sort} ${JSON.stringify(f)} page ${page}`).toEqual(sig(want.items));
            expect(got.total).toBe(want.total);
            total = want.total;
            collected += want.items.length;
            if (!got.hasMore || want.items.length === 0) {
              // Exhaustion proof: the loop ends only when the sequence ends, never at a page cap.
              expect(got.hasMore, `${kind}/${sort} ${JSON.stringify(f)}: not exhausted at page ${page}`).toBe(false);
              break;
            }
          }
          expect(collected, `${kind}/${sort} ${JSON.stringify(f)}: every row visited`).toBe(total); // all fixture rows covered
        }
      }
    }
  }, 120_000);

  it('randomized rounds (seeded PRNG): same full-sequence equivalence', async () => {
    const museIds = (await env.DB.prepare('SELECT id FROM muses ORDER BY id').all<{ id: number }>()).results.map((r) => r.id);
    let base = 1000;
    for (const rndSeed of [1, 2]) {
      await seedRandom(rndSeed, base, museIds);
      base += 100;
      const filters: any[] = [{}, { category: 'Capability' }, { client: 'Muse Code' }, { q: 'zzz' }, { active: '7d' }, { active: '30d' }, { state: 'quiet' }, { museId: museIds[0] }];
      for (const sort of ['hot', 'rising'] as const) {
        for (const f of filters) {
          const perPage = 7;
          let collected = 0;
          let total = -1;
          for (let page = 1; ; page++) {
            expect(page, `rnd${rndSeed} ${sort} ${JSON.stringify(f)}: page cap exceeded`).toBeLessThan(80);
            const p = { kind: 'raise' as const, sort, active: 'all', ...f, perPage, page };
            const got = await listRaises(env.DB as any, p, NOW);
            const want = await legacyList(p);
            expect(sig(got.items), `rnd${rndSeed} ${sort} ${JSON.stringify(f)} page ${page}`).toEqual(sig(want.items));
            total = want.total;
            collected += want.items.length;
            if (!got.hasMore || want.items.length === 0) {
              expect(got.hasMore, `rnd${rndSeed} ${sort} ${JSON.stringify(f)}: not exhausted at page ${page}`).toBe(false);
              break;
            }
          }
          expect(collected, `rnd${rndSeed} ${sort} ${JSON.stringify(f)}: every row visited`).toBe(total);
        }
      }
    }
  }, 120_000);
});

describe('reportAreas skip-scan', () => {
  it('matches DISTINCT ground truth: hidden and empty excluded, first 12 ascending', async () => {
    const m = await makeMuse('diffareas');
    const cats = ['AreaB', 'AreaA', 'AreaD', 'AreaC', 'AreaF', 'AreaE', 'AreaH', 'AreaG', 'AreaJ', 'AreaI', 'AreaL', 'AreaK', 'AreaN', 'AreaM'];
    const stmts: any[] = cats.map((c, i) =>
      env.DB.prepare("INSERT INTO raises (kind, title, category, muse_id, created_at, last_activity_at, joins_count, hidden, seq) VALUES ('report', ?, ?, ?, ?, ?, 1, 0, ?)").bind(`Area report ${c}`, c, m.id, NOW, NOW, 100 + i),
    );
    stmts.push(env.DB.prepare("INSERT INTO raises (kind, title, category, muse_id, created_at, last_activity_at, joins_count, hidden, seq) VALUES ('report', 'Hidden area report', 'HiddenOnly', ?, ?, ?, 1, 1, 200)").bind(m.id, NOW, NOW));
    stmts.push(env.DB.prepare("INSERT INTO raises (kind, title, category, muse_id, created_at, last_activity_at, joins_count, hidden, seq) VALUES ('report', 'Empty area report', '', ?, ?, ?, 1, 0, 201)").bind(m.id, NOW, NOW));
    await env.DB.batch(stmts);
    const want = await env.DB.prepare("SELECT DISTINCT category FROM raises WHERE kind = 'report' AND hidden = 0 AND category != '' ORDER BY category LIMIT 12").all<{ category: string }>();
    const got = await reportAreas(env.DB as any);
    expect(got).toEqual(want.results.map((x) => x.category));
    expect(got).toHaveLength(12); // 14 distinct + pre-existing reports, capped at 12
    expect(got).not.toContain('HiddenOnly');
    expect(got).not.toContain('');
  });
});
