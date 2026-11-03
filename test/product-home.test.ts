// Product home (raise.commonworld.one): one hero button and a "Browse every page" block with product links only.
// The demo home (raise-demo.commonworld.one) keeps its own story, buttons and blocks.
import { describe, expect, it } from 'vitest';
import { DEMO, PROD, dget, get } from './helpers';
import { PRODUCT_PAGES } from '../src/views';

const between = (t: string, from: string, to: string) => {
  const i = t.indexOf(from);
  expect(i).toBeGreaterThan(-1);
  const j = t.indexOf(to, i);
  return t.slice(i, j === -1 ? undefined : j);
};
const hrefs = (t: string) => [...t.matchAll(/href="([^"]*)"/g)].map((m) => m[1]!);

describe('product home', () => {
  it('has no "See it in action"; the hero has exactly one button, "Connect your Muse"', async () => {
    const t = await (await get('/')).text();
    expect(t).not.toContain('See it in action');
    const hero = between(t, '<section class="hero">', '</section>');
    const btns = [...hero.matchAll(/<a class="btn[^"]*" href="([^"]*)">([^<]*)<\/a>/g)];
    expect(btns.map((m) => [m[1], m[2]])).toEqual([['/connect', 'Connect your Muse']]);
    // Header "▶ Demo" and the footer "Demo" link stay.
    expect(t).toContain(`<a href="${DEMO}/" class="demo">▶ Demo</a>`);
    expect(t).toContain(`<a href="${DEMO}/">Demo</a>`);
  });

  it('same on the real product hostname', async () => {
    const t = await (await get('/', {}, PROD)).text();
    expect(t).not.toContain('See it in action');
    expect(t).toContain('<h2>Browse every page</h2>');
  });

  it('"Browse every page" lists only relative product links, no demo host, no "demo"', async () => {
    const t = await (await get('/')).text();
    expect(t).toContain('<h2>Browse every page</h2>');
    expect(t).not.toContain('Browse every page with demo data');
    const block = between(t, '<h2>Browse every page</h2>', '</main>');
    const links = hrefs(block);
    expect(links).toEqual(PRODUCT_PAGES.map(([p]) => p));
    for (const h of links) {
      expect(h.startsWith('/')).toBe(true);
      expect(h.startsWith('//')).toBe(false);
      expect(h).not.toContain('raise-demo');
      expect(h.startsWith('/demo')).toBe(false);
    }
    expect(block).not.toContain('raise-demo');
    expect(block.toLowerCase()).not.toContain('demo');
    for (const p of ['/raises', '/reports', '/granted', '/muses', '/corporation', '/connect', '/mcp', '/api/v1', '/about']) expect(links).toContain(p);
  });

  it('every page in the block answers 200 on the product host', async () => {
    for (const [p] of PRODUCT_PAGES) {
      if (p === '/llms.txt') continue; // static asset, served by Workers Assets, not the Worker
      const r = await get(p, { headers: { accept: 'text/html' } });
      expect(r.status, p).toBe(200);
    }
  });
});

describe('demo home is unchanged', () => {
  it('keeps its story, play button, demo lists and its own "Browse every page with demo data"', async () => {
    const t = await (await dget('/')).text();
    expect(t).toContain('▶ See it in action · Hackathon demo');
    expect(t).toContain('One wish, many Muses.');
    expect(t).toContain('<button class="btn" type="button" id="play">▶ Play the story</button>');
    expect(t).toContain('Phone and terminal, side by side');
    expect(t).toContain('Browse every page with demo data');
    expect(t).not.toContain('<h2>Browse every page</h2>');
    expect(t).toContain('href="/m/atlas"');
    expect(t).toContain('href="/r/0418"');
    expect(t).toContain('Hackathon demo · <a href="/#play">▶ Play the story</a>');
  });
});
