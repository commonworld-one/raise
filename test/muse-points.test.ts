// Live Muse points on the demo host (src/live.ts museScript): big, ticking, derived from the live cards.
import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { LIVE, MUSE_JOIN_SHARE, MUSE_SEED, museAllPoints, musePointsSpec, museScript, museSeasonPoints } from '../src/live';
import { dget, get } from './helpers';

const H = LIVE.SEASON_MS;
const T0 = Date.UTC(2026, 10, 3, 0, 0, 0); // a season start (00:00 UTC)
const n = (s: string) => Number(s.replace(/,/g, ''));

describe('live Muse points formula', () => {
  const cards = [
    { id: 101, joins_count: 5, granted: false, muse_id: 1 },
    { id: 102, joins_count: 5, granted: false, muse_id: 1 },
    { id: 418, joins_count: 9, granted: false, muse_id: 1 }, // scenario: stays stored
    { id: 103, joins_count: 5, granted: false, muse_id: 2 },
  ];
  const p = musePointsSpec({ id: 1, season_points: 412, points_all: 1890 }, cards);

  it('season = stored + own live cards + share of joins made; scenario cards excluded', () => {
    expect(p.ids).toEqual([101, 102]);
    const t = T0 + 3600_000;
    expect(museSeasonPoints(p, t)).toBe(412 + LIVE.count(101, t) + LIVE.count(102, t) + Math.floor(MUSE_JOIN_SHARE * LIVE.count(MUSE_SEED + 1, t)));
  });

  it('season and all time restart with the daily season; all time is bounded and never below the season', () => {
    // Both counters include the stored bases (points_all / stored season points), so this compares the
    // numbers a visitor actually sees, not just the live-count deltas.
    for (let t = T0; t < T0 + 2 * H; t += 97_000) {
      const a = museAllPoints(p, t), s = museSeasonPoints(p, t);
      expect(a).toBeGreaterThanOrEqual(s);
    }
    // Explicitly at the boundary instants: just after the daily restart the season drops near its stored
    // base while all time keeps its larger stored base, so all time >= season holds through the reset.
    for (const t of [T0 + H - 1, T0 + H, T0 + H + 1, T0 + H + 60_000]) {
      expect(museAllPoints(p, t)).toBeGreaterThanOrEqual(museSeasonPoints(p, t));
    }
    expect(museSeasonPoints(p, T0 + H)).toBeLessThan(museSeasonPoints(p, T0 + H - 1));
    expect(museAllPoints(p, T0 + H)).toBeLessThan(museAllPoints(p, T0 + H - 1)); // bounded daily restart
    // conserved: a year later the all-time points are still in the same band, not grown without bound
    expect(museAllPoints(p, T0 + 365 * H)).toBeLessThan(museAllPoints(p, T0) + 4 * 5_000_000);
  });

  it('the browser script carries the same model and escapes "<"', () => {
    const s = museScript({ base: '', cards }, [{ id: 1, season_points: 0, points_all: 0 }], { 1: { slug: 'a', name: '</script>', av: '<img>' } });
    expect(s).toContain(String(MUSE_SEED));
    expect(s.indexOf('</script>')).toBe(s.length - '</script>'.length);
  });
});

describe('pages', () => {
  it('demo /corporation: big live points in the offices and the board, board in live order, offices = the top three', async () => {
    const r = await dget('/corporation');
    expect(r.status).toBe(200);
    const t = await r.text();
    expect(t).toContain('data-live-muses="s"');
    expect(t).toContain('class="opts"');
    const season = [...t.matchAll(/<b class="lpts" data-mp="(\d+)" data-k="s">([0-9,]+)<\/b>/g)].map((m) => ({ id: m[1], v: n(m[2]!) }));
    expect(season.length).toBeGreaterThan(2);
    expect(season.map((x) => x.v)).toEqual(season.map((x) => x.v).sort((a, b) => b - a));
    expect(season[0]!.v).toBeGreaterThan(10_000); // big: includes the live cards
    const offices = [...t.matchAll(/data-office="(\d)" data-muse="(\d+)"/g)].map((m) => m[2]);
    expect(offices).toEqual(season.slice(0, offices.length).map((x) => x.id));
    expect(t).not.toMatch(/[0-9] season pts<\/div>/); // old small office line gone
  });

  it('demo /muses: big live points per card; /m/atlas: big live points', async () => {
    const t = await (await dget('/muses')).text();
    expect(t).not.toMatch(/<b>[0-9,]+<\/b> season · /);
    expect([...t.matchAll(/class="pn" data-mp="\d+" data-k="s"/g)].length).toBeGreaterThan(2);
    expect(t).toContain('data-live-muses="s"');
    const a = await (await dget('/m/atlas')).text();
    expect(a).toContain('aria-label="Live demo points"');
    expect(a).toMatch(/class="hn" data-mp="\d+" data-k="s">[0-9,]+</);
  });

  it('product /corporation, /muses and profiles: stored numbers, no live points markup', async () => {
    await env.DB.prepare("INSERT INTO muses (slug, name, client, tagline, avatar_url, created_at, points_all) VALUES ('ptsprod', 'PtsProd', 'Muse', 'x', '/avatars/bob.png', 1, 77)").run();
    const id = (await env.DB.prepare("SELECT id FROM muses WHERE slug = 'ptsprod'").first<{ id: number }>())!.id;
    const season = new Date().toISOString().slice(0, 7);
    await env.DB.prepare('INSERT INTO muse_points (muse_id, season, points) VALUES (?, ?, 12)').bind(id, season).run();
    try {
      const c = await (await get('/corporation')).text();
      expect(c).toContain('<div class="m">12 season pts</div>');
      expect(c).toContain('<td><b>12</b></td><td>77</td>');
      for (const t of [c, await (await get('/muses')).text(), await (await get('/m/ptsprod')).text()]) {
        expect(t).not.toContain('data-mp=');
        expect(t).not.toContain('data-live-muses');
      }
    } finally {
      await env.DB.prepare('DELETE FROM muse_points WHERE muse_id = ?').bind(id).run();
      await env.DB.prepare('DELETE FROM muses WHERE id = ?').bind(id).run();
    }
  });
});
