// Live demo numbers (src/live.ts): a pure function of (card seed, time), demo host only.
import { describe, expect, it } from 'vitest';
import { LIVE, SCENARIO_RAISE_ID, applyLive, liveModel, liveScript } from '../src/live';
import type { RaiseRow } from '../src/data';
import { dget, get } from './helpers';

const H = LIVE.SEASON_MS;
const T0 = Date.UTC(2026, 10, 3, 12, 0, 0); // a season start (12:00 UTC)
const SEEDS = Array.from({ length: 40 }, (_, i) => 400 + i);

describe('live formula', () => {
  it('is deterministic: same seed and time, same numbers, also from a fresh copy of the model', () => {
    const other = liveModel();
    for (const s of SEEDS) for (const t of [T0, T0 + 1234567, T0 + H - 1]) {
      expect(LIVE.count(s, t)).toBe(LIVE.count(s, t));
      expect(other.count(s, t)).toBe(LIVE.count(s, t));
      expect(other.spark(s, t)).toEqual(LIVE.spark(s, t));
    }
  });

  it('never goes down within a season (sampled every 17 s)', () => {
    for (const s of SEEDS) {
      let prev = -1;
      for (let t = T0; t < T0 + H; t += 17_000) {
        const c = LIVE.count(s, t);
        expect(c).toBeGreaterThanOrEqual(prev);
        prev = c;
      }
    }
  });

  it('seasons are 6 h aligned to UTC: start in the tens of thousands, leaders end at 2-5 million, then start over', () => {
    expect(T0 % H).toBe(0);
    expect(LIVE.seasonStart(T0 + 5 * 3600_000)).toBe(T0);
    expect(LIVE.seasonNo(T0 + H)).toBe(LIVE.seasonNo(T0) + 1);
    const ends = SEEDS.map((s) => LIVE.count(s, T0 + H - 1));
    for (const s of SEEDS) {
      const start = LIVE.count(s, T0);
      expect(start).toBeGreaterThanOrEqual(10_000);
      expect(start).toBeLessThan(60_000);
      expect(LIVE.count(s, T0 + H)).toBeLessThan(LIVE.count(s, T0 + H - 1)); // new season
    }
    expect(Math.max(...ends)).toBeGreaterThanOrEqual(2_000_000);
    expect(Math.max(...ends)).toBeLessThanOrEqual(5_000_000);
    expect(Math.min(...ends)).toBeGreaterThanOrEqual(200_000);
  });

  it('has three characters, "+N today" since the season start, and a sparkline ending at the count', () => {
    expect(new Set(SEEDS.map((s) => LIVE.character(s)))).toEqual(new Set(['steady', 'sleeper', 'fader']));
    const t = T0 + 3 * 3600_000 + 777;
    for (const s of SEEDS.slice(0, 5)) {
      expect(LIVE.today(s, t)).toBe(LIVE.count(s, t) - LIVE.count(s, T0));
      const sp = LIVE.spark(s, t);
      expect(sp).toHaveLength(7);
      expect(sp[6]).toBe(LIVE.count(s, t));
      expect(sp[0]).toBe(LIVE.count(s, T0));
    }
  });

  it('the browser copy is the same function source, with the __name shim', () => {
    const js = liveScript();
    expect(js).toContain(liveModel.toString());
    expect(js).toContain('var __name=');
    expect(js).toContain('visibilitychange');
    expect(js).toContain('prefers-reduced-motion');
  });
});

describe('applyLive', () => {
  const row = (id: number) => ({ id, joins_count: 7, today: 2, spark: [1, 2, 3, 4, 5, 6, 7] }) as unknown as RaiseRow;
  it('product host: stored values, untouched', () => {
    const items = [row(1), row(2)];
    const out = applyLive({ demo: false }, items, T0 + 1000);
    expect(out).toBe(items);
    expect(out.map((x) => x.joins_count)).toEqual([7, 7]);
  });
  it('demo host: formula values; the scenario RAISE #0418 keeps its stored numbers', () => {
    const [a, s] = applyLive({ demo: true }, [row(5), row(SCENARIO_RAISE_ID)], T0 + 1000);
    expect(a!.joins_count).toBe(LIVE.count(5, T0 + 1000));
    expect(a!.today).toBe(LIVE.today(5, T0 + 1000));
    expect(s).toMatchObject({ joins_count: 7, today: 2 });
  });
});

describe('pages', () => {
  it('product /raises and /reports: stored counts, no live script, no season label', async () => {
    for (const p of ['/raises', '/reports', '/raises?sort=top']) {
      const t = await (await get(p)).text();
      expect(t).not.toContain('data-live-seed');
      expect(t).not.toContain('data-live-list');
      expect(t).not.toContain('data-season');
    }
  });
  it('demo /raises and /reports: live cards, Season label, footer totals, script', async () => {
    for (const [p, foot] of [['/raises', 'wishes open'], ['/reports', 'reports open']] as const) {
      const t = await (await dget(p)).text();
      expect(t).toContain('data-live-seed="');
      expect(t).toMatch(/data-season>Season \d+</);
      expect(t).toContain(foot);
      expect(t).toContain('data-foot-today');
      expect(t).toContain('SEASON_MS');
      expect(t).not.toContain(`data-live-seed="${SCENARIO_RAISE_ID}"`);
    }
  });
  it('demo /raises?sort=top renders in live order', async () => {
    const t = await (await dget('/raises?sort=top&active=all')).text();
    expect(t).toContain('data-live-list="top"');
    const counts = [...t.matchAll(/data-count="(\d+)"/g)].map((m) => Number(m[1]));
    expect(counts.length).toBeGreaterThan(2);
    expect(counts).toEqual([...counts].sort((a, b) => b - a));
  });
});
