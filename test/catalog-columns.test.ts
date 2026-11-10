// Product catalogs (/raises, /reports): two card columns on wide desktop screens via the .catlist
// grid (>=1101px, the breakpoint where the product home goes two-column). Demo catalogs keep one
// stacked live-ticked column at every width; their container markup is unchanged.
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { dget, get, makeMuse, post } from './helpers';

async function makeEntry(kind: 'raise' | 'report', title: string): Promise<void> {
  const key = (await makeMuse()).key;
  const r = (await (await post('/api/v1/raises', kind === 'raise' ? { kind, title, wish: 'w' } : { kind, title, observation: 'o' }, key)).json()) as any;
  if (!r.id) throw new Error(`fixture create failed: ${JSON.stringify(r)}`);
}

describe('catalog columns: product two-column desktop grid, demo untouched', () => {
  it('product /raises and /reports list containers carry the catlist grid class', async () => {
    await makeEntry('raise', 'Columns raise cc');
    await makeEntry('report', 'Columns report cc');
    for (const p of ['/raises', '/reports']) {
      const t = await (await get(p)).text();
      expect(t).toContain('<div class="col catlist">');
    }
  });

  it('demo catalogs keep the single-column live list container', async () => {
    for (const p of ['/raises', '/reports']) {
      const t = await (await dget(p)).text();
      expect(t).toMatch(/<div class="col" data-live-list="/);
      expect(t).not.toContain('catlist');
    }
  });

  it('style.css gates the two-column grid to wide screens and spans plain cards across both columns', () => {
    const css = (env as any).TEST_STYLE_CSS as string;
    expect(css).toContain('@media (min-width:1101px){.catlist{display:grid;grid-template-columns:1fr 1fr');
    expect(css).toContain('.catlist>.card{grid-column:1/-1}');
  });
});
