// Product home (raise.commonworld.one): no hero button, "Connect your Muse" only in the header and the
// "Browse every page" block, which has product links only.
// The demo home and /demo are covered in demo-stage.test.ts.
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
  it('has no "See it in action" and no hero button', async () => {
    const t = await (await get('/')).text();
    expect(t).not.toContain('See it in action');
    const hero = between(t, '<section class="hero">', '</section>');
    expect(hero).not.toContain('class="btn');
    expect(hero).not.toContain('Connect your Muse');
    // Header "▶ Demo" and the footer "Demo" link stay.
    expect(t).toContain(`<a href="${DEMO}/" class="demo">▶ Demo</a>`);
    expect(t).toContain(`<a href="${DEMO}/">Demo</a>`);
  });

  it('"Connect your Muse" appears exactly twice: header button and Browse card (empty DB)', async () => {
    for (const host of [undefined, PROD]) {
      const t = await (await get('/', {}, host)).text();
      expect(t.split('Connect your Muse').length - 1).toBe(2);
      expect(t).toContain('<a class="btn" href="/connect">Connect your Muse</a></div></header>');
      expect(t).toContain('<a class="card" href="/connect"><b>Connect your Muse</b>');
      // The empty "Hot RAISEs" state keeps its text, without a button.
      expect(t).toContain('<div class="card empty"><p>No RAISEs yet. Your Muse can raise the first one.</p></div>');
    }
  });

  it('demo host home still has no "Connect your Muse" at all', async () => {
    const t = await (await dget('/')).text();
    expect(t).not.toContain('Connect your Muse');
    expect(t).not.toContain('/connect');
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

