// Product catalogs: badge row (.btags) spans the full card width so ref + category fit on one line,
// desktop and phone, untruncated - same rule the product home already uses. Card content (title, voice
// line, metadata, sparkline, counts) is preserved. Demo catalogs keep the original inline-badge markup.
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { dget, get, makeMuse, post } from './helpers';

const DAY = 86_400_000;
const pad4 = (n: number) => String(n).padStart(4, '0');

async function makeEntry(kind: 'raise' | 'report', title: string, ageDays: number): Promise<number> {
  const key = (await makeMuse()).key;
  const r = (await (await post('/api/v1/raises', kind === 'raise' ? { kind, title, wish: 'w' } : { kind, title, observation: 'o' }, key)).json()) as any;
  if (!r.id) throw new Error(`fixture create failed: ${JSON.stringify(r)}`);
  const old = Date.now() - ageDays * DAY;
  await env.DB.prepare('UPDATE raises SET created_at = ?, last_activity_at = ? WHERE id = ?').bind(old, old, r.id).run();
  return r.id as number;
}

describe('product catalogs: full-width one-line badge row', () => {
  it('RAISEs cards start with a full-width .btags row and keep all card content', async () => {
    const raiseId = await makeEntry('raise', 'Catalog badge raise cb', 2);
    const t = await (await get('/raises')).text();
    expect(t).toContain('item citem');
    // Badge row first inside the card: ref span directly followed by the category span.
    expect(t).toMatch(new RegExp(`<a class="item citem"[^>]*><div class="btags"><span class="tag raise">RAISE #${pad4(raiseId)}</span><span class="tag">[^<]+</span>`));
    // Content preserved: title, author/date metadata, counts.
    expect(t).toContain('Catalog badge raise cb');
    expect(t).toContain('raised by');
    expect(t).toMatch(/last join|no one else yet/);
    expect(t).toMatch(/Muses? wants? this/);
    expect(t).toContain('today');
  });

  it('Reports cards start with a full-width .btags row and keep all card content', async () => {
    const reportId = await makeEntry('report', 'Catalog badge report cb', 1);
    const t = await (await get('/reports')).text();
    expect(t).toContain('item citem');
    expect(t).toMatch(new RegExp(`<a class="item citem"[^>]*><div class="btags"><span class="tag report">REPORT #${pad4(reportId)}</span><span class="tag">[^<]+</span>`));
    expect(t).toContain('Catalog badge report cb');
    expect(t).toContain('reported by');
    expect(t).toContain('latest occurrence');
    expect(t).toContain('Muses said “me too”');
  });

  it('style.css parks the catalog avatar top-right with a protected badge lane', () => {
    const css = (env as any).TEST_STYLE_CSS as string;
    expect(css).toContain('.citem{position:relative}');
    expect(css).toContain('.citem>.av{position:absolute;top:20px;right:24px}');
    expect(css).toContain('.citem .btags{margin-right:68px;white-space:normal}');
  });

  it('demo catalogs keep the original inline-badge rows (conserved)', async () => {
    for (const path of ['/raises', '/reports']) {
      const demo = await (await dget(path)).text();
      expect(demo).not.toContain('citem');
      expect(demo).not.toContain('btags');
    }
    const demoRaises = await (await dget('/raises')).text();
    expect(demoRaises).toContain('raised by');
    const demoReports = await (await dget('/reports')).text();
    expect(demoReports).toContain('reported by');
    expect(demoReports).toContain('latest occurrence');
  });
});
