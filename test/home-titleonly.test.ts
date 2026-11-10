// Product home compact cards: full title/avatar/sparkline/counts kept, metadata lines moved out,
// badges on two consistent rows, demo-style column stretch, earlier mid-width stack. Prod home only:
// catalogs, detail pages and the demo keep their full metadata and markup.
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

describe('product home: compact title cards', () => {
  it('home cards keep ref/category/title/counts but no metadata lines; badges on two rows; stretch + stack classes present', async () => {
    const raiseId = await makeEntry('raise', 'Compact home raise ht', 2);
    const reportId = await makeEntry('report', 'Compact home report ht', 1);
    const t = await (await get('/')).text();
    expect(t).toContain('grid2 home-lists phome'); // demo-style stretch + prod-only earlier stack hook
    const left = t.slice(t.indexOf('🔥 Hot RAISEs'), t.indexOf('👀 Happening now'));
    const right = t.slice(t.indexOf('👀 Happening now'), t.indexOf('Browse every page'));
    // Full titles and counts stay.
    expect(left).toContain('Compact home raise ht');
    expect(right).toContain('Compact home report ht');
    expect(left).toContain(`RAISE #${pad4(raiseId)}`);
    expect(right).toContain(`REPORT #${pad4(reportId)}`);
    expect(left).toMatch(/Muses? wants? this/); // singular for a fresh fixture entry
    expect(right).toContain('Muses said “me too”');
    // Badges on two rows: the ref and the category are in separate divs.
    expect(left).toMatch(new RegExp(`<span class="tag raise">RAISE #${pad4(raiseId)}</span></div><div[^>]*><span class="tag">`));
    expect(right).toMatch(new RegExp(`<span class="tag report">REPORT #${pad4(reportId)}</span></div><div[^>]*><span class="tag">`));
    // No metadata lines on home cards.
    for (const col of [left, right]) {
      expect(col).not.toContain('raised by');
      expect(col).not.toContain('reported by');
      expect(col).not.toContain('latest occurrence');
      expect(col).not.toContain('last join');
      expect(col).not.toContain('voice-s');
    }
  });

  it('catalogs and detail pages keep the metadata lines', async () => {
    const reportId = await makeEntry('report', 'Metadata kept report ht', 1);
    const reports = await (await get('/reports')).text();
    expect(reports).toContain('latest occurrence');
    expect(reports).toContain('reported by');
    const detail = await (await get(`/r/${pad4(reportId)}`)).text();
    expect(detail).toContain('reported by');
    const raises = await (await get('/raises')).text();
    expect(raises).toContain('raised by');
  });

  it('demo home keeps full metadata rows and its markup (conserved)', async () => {
    const demo = await (await dget('/')).text();
    expect(demo).toContain('grid2 home-lists');
    expect(demo).not.toContain('phome');
    expect(demo).toContain('reported by');
    expect(demo).toContain('raised by');
    expect(demo).toContain('last join');
  });
});
