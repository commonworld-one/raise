// Demo month pin: the demo host reads seasons at the reference clock (seasonOf(ageNow) = '2026-11'),
// so /corporation, /muses and /m/{slug} stay in the recorded November 2026 season whatever the wall
// clock says. Rendered here at wall clocks in Dec 2026, Jan 2027 and 2030 through the same call
// sequence src/index.ts uses (seasons/leaderboard/listMuses/getPublicMuse with ctx.ageNow), against
// the recording-era seed. The generator pins the current-season bucket to '2026-11'
// (scripts/gen_demo_seed.py), so a reseed after November still populates the month the demo reads;
// the guard below locks that pin. Controls show what the pin prevents: at a December wall clock the
// live season would drift to an empty '2026-12'.
import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { DEMO } from './helpers';
import { DEMO_REFERENCE_MS, seasonOf } from '../src/util';
import { getPublicMuse, leaderboard, listMuses, seasons } from '../src/data';
import { corporation } from '../src/views';

async function seedRecordingEra() {
  const seed = (env as any).TEST_DEMO_SEED as string;
  expect(seed).toContain('1793743506000');
  // The current-season bucket must be pinned to the recording month, not apply-time:
  // an apply-time bucket after November 2026 would land in a season the pinned demo never reads.
  expect(seed).toContain("'2026-11'");
  expect(seed).not.toContain("strftime('%Y-%m','now')");
  const stmts = seed
    .split(/;\s*\n/)
    .map((s: string) => s.replace(/^--.*$/gm, '').trim())
    .filter(Boolean);
  await env.DEMO_DB.batch(stmts.map((s: string) => env.DEMO_DB.prepare(s)));
}

const FUTURE_WALL_CLOCKS = [Date.UTC(2026, 11, 1), Date.UTC(2027, 0, 1), Date.UTC(2030, 5, 15)];

const ctxAt = (wallClock: number): any => ({
  env, db: env.DEMO_DB, demo: true, base: '', origin: DEMO, path: '/corporation', search: '',
  now: wallClock, ageNow: DEMO_REFERENCE_MS, ip: 'local', cards: [],
});

// Same read-only card query as demoCards in src/index.ts (a local function there).
async function demoCardRows(db: D1Database) {
  const r = await db.prepare('SELECT id, joins_count, granted_at, muse_id FROM raises WHERE hidden = 0 LIMIT 1000').all<{ id: number; joins_count: number; granted_at: number | null; muse_id: number }>();
  return r.results.map((x) => ({ id: x.id, joins_count: x.joins_count, granted: x.granted_at != null, muse_id: x.muse_id }));
}

describe('demo month pin', () => {
  it('the pinned season is November 2026 at the reference clock', () => {
    expect(seasonOf(DEMO_REFERENCE_MS)).toBe('2026-11');
  });

  it('/corporation stays on the recorded season at far-future wall clocks, with its recorded points', async () => {
    await seedRecordingEra();
    for (const wc of FUTURE_WALL_CLOCKS) {
      const ctx = ctxAt(wc);
      // Same steps as the /corporation route (src/index.ts), with ctx.ageNow as the season clock.
      const all = await seasons(ctx.db, ctx.ageNow);
      const live = seasonOf(ctx.ageNow);
      const lb = await leaderboard(ctx.db, live);
      ctx.cards = await demoCardRows(ctx.db);
      expect(live).toBe('2026-11');
      expect(all[0]).toBe('2026-11');
      expect(lb.length).toBeGreaterThan(0);
      expect(lb[0]!.season_points).toBeGreaterThan(0);
      const html = corporation(ctx, live, live, all, lb, []);
      expect(html).toContain('Muse Corporation · November 2026 · live');
      expect(html).toContain('Chief Muse Officer');
      expect(html).not.toContain('No points yet this season');
    }
  });

  it('control: without the pin the season drifts to an empty month (what the pin prevents)', async () => {
    await seedRecordingEra();
    const dec1 = Date.UTC(2026, 11, 1);
    expect(seasonOf(dec1)).toBe('2026-12');
    // The seed has no points in the drifted month: season reads at the wall clock would come back empty.
    expect(await leaderboard(env.DEMO_DB, seasonOf(dec1))).toEqual([]);
    const drifted = await listMuses(env.DEMO_DB, { sort: 'season' }, dec1);
    expect(drifted.items.length).toBeGreaterThan(0);
    expect(drifted.items.every((m) => !m.season_points)).toBe(true);
  });

  it('muse list and profile keep their recorded season points at far-future wall clocks', async () => {
    await seedRecordingEra();
    for (const wc of FUTURE_WALL_CLOCKS) {
      const page = await listMuses(env.DEMO_DB, { sort: 'season' }, ctxAt(wc).ageNow);
      const top = page.items.find((m) => (m.season_points || 0) > 0);
      expect(top, 'a recorded season scorer exists').toBeTruthy();
      const one = await getPublicMuse(env.DEMO_DB, top!.slug, ctxAt(wc).ageNow);
      expect(one!.season_points).toBe(top!.season_points);
    }
  });
});
