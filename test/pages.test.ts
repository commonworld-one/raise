import { describe, expect, it } from 'vitest';
import { BASE, DEMO, dget, get } from './helpers';

const DEMO_BAR = (live: string) =>
  `<div class="demobar">Hackathon demo · <a href="/#play">▶ Play the story</a> · <a href="${live}">Open the live product ↗</a></div>`;

describe('pages', () => {
  for (const p of ['/', '/raises', '/reports', '/granted', '/muses', '/corporation', '/connect', '/about']) {
    it(`prod ${p} -> 200`, async () => {
      const r = await get(p);
      expect(r.status).toBe(200);
      const t = await r.text();
      expect(t).toContain('Muse <span>RAISE</span>');
      expect(t).toContain(`<a href="${DEMO}/" class="demo">▶ Demo</a>`);
      expect(t).not.toContain('Hackathon demo');
    });
  }
  for (const p of ['/', '/raises', '/reports', '/granted', '/muses', '/corporation', '/connect', '/about', '/m/atlas', '/r/0418', '/r/0112']) {
    it(`demo host ${p} -> 200 with demo bar`, async () => {
      const r = await dget(p);
      expect(r.status).toBe(200);
      const t = await r.text();
      expect(t).toContain(DEMO_BAR(`https://raise.commonworld.one${p}`));
    });
  }
  it('demo home: story, live counter, every page linked on the demo host', async () => {
    const t = await (await dget('/')).text();
    expect(t).toContain('Browse every page with demo data');
    expect(t).toContain('Wingsmith grants it');
    expect(t).toContain('You can fly now');
    expect(t).toContain('1,240');
    expect(t).toContain('id="play"');
    expect(t).toContain('class="term"');
    for (const p of ['/raises', '/reports', '/granted', '/muses', '/m/atlas', '/r/0418', '/corporation', '/connect', '/mcp', '/about']) expect(t).toContain(`href="${p}"`);
    expect(t).not.toContain('href="/demo');
  });
  it('/leaderboard -> 301 /corporation', async () => {
    const r = await get('/leaderboard', { redirect: 'manual' });
    expect(r.status).toBe(301);
    expect(r.headers.get('location')).toBe(`${BASE}/corporation`);
  });
  it('/r/418 -> 301 /r/0418, unknown -> 404', async () => {
    const r = await dget('/r/418', { redirect: 'manual' });
    expect(r.status).toBe(301);
    expect(r.headers.get('location')).toBe(`${DEMO}/r/0418`);
    expect((await get('/r/999999')).status).toBe(404);
    expect((await get('/nope')).status).toBe(404);
  });
  it('demo RAISE page shows fantasy content and sorting chips', async () => {
    const t = await (await dget('/raises?sort=top&active=all')).text();
    expect(t).toContain('Teleport to grandma');
    expect(t).toContain('Talk to my dog');
    expect(t).not.toContain('Wings to fly to the Moon'); // granted: on the shelf, not in the open list
    expect(t).toContain('<meta name="robots" content="noindex">');
    expect(t.indexOf('Talk to my dog')).toBeLessThan(t.indexOf('Teleport to grandma')); // top = 3,120 before 2,210
  });
  it('reports show Active / Quiet with the latest occurrence date (#2)', async () => {
    const t = await (await dget('/reports?active=all')).text();
    expect(t).toContain('>Active<');
    expect(t).toContain('>Quiet<');
    expect(t).toContain('latest occurrence');
    expect(t).toContain('Muses said “me too”');
    expect(t).not.toMatch(/still happening|Muses hit this/i);
    const api = JSON.stringify(await (await dget('/api/v1/pulse')).json());
    expect(api).not.toMatch(/still_happening/);
  });
  it('mobile: viewport meta and collapsible nav markup (#3)', async () => {
    for (const [host, p] of [[BASE, '/'], [BASE, '/reports'], [DEMO, '/'], [DEMO, '/r/0418']] as const) {
      const t = await (await get(p, {}, host)).text();
      expect(t).toContain('<meta name="viewport" content="width=device-width,initial-scale=1">');
      expect(t).toMatch(/<button class="navtoggle" id="navtoggle" type="button" aria-controls="menu" aria-expanded="false"/);
      expect(t).toContain('<div class="menu" id="menu"><nav');
    }
  });
  it('granted shelf (demo)', async () => {
    const t = await (await dget('/granted')).text();
    expect(t).toContain('Understand what my cat is saying');
    expect(t).toContain('Wings to fly to the Moon');
    expect(t).toContain('Granted ✨ by Wingsmith');
    const d = await (await dget('/r/0418')).text();
    expect(d).toContain('Granted ✨ by Wingsmith');
    expect(d).toContain('href="https://example.org/wingsmith"');
    expect(d).toContain('You can fly now');
  });
  it('public text rules', async () => {
    for (const [host, p] of [[BASE, '/'], [BASE, '/about'], [BASE, '/connect'], [DEMO, '/'], [DEMO, '/about'], [DEMO, '/raises']] as const) {
      const t = (await (await get(p, {}, host)).text()).toLowerCase();
      for (const bad of ['official', 'integrated with muse', 'backed by meta', 'simulated', 'the team', 'jolly', 'muse-logo']) expect(t).not.toContain(bad);
    }
  });
});
