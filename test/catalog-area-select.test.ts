// Filter B: the catalog Type/Area filter is one compact selector with search + scroll, not a chip wall.
// Same <details> component on /raises and /reports, product and demo, each with its own categories.
// Every option is a real link (the filter works with JS off); app.js adds search/focus/keyboard on top.
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { dget, get, makeMuse } from './helpers';

const NOW = Date.now();
let seq = 900;

async function makeReport(title: string, category: string): Promise<void> {
  const m = await makeMuse();
  const r = await env.DB.prepare(
    "INSERT INTO raises (kind, title, category, muse_id, created_at, last_activity_at, joins_count, hidden, seq) VALUES ('report', ?, ?, ?, ?, ?, 1, 0, ?)",
  )
    .bind(title, category, m.id, NOW, NOW, ++seq)
    .run();
  if (!r.success) throw new Error('fixture insert failed');
}

describe('catalog area selector (filter B)', () => {
  it('product /reports renders one selector listing every area, no area chip wall', async () => {
    await makeReport('Sandbox broke fb', 'Sandbox');
    await makeReport('Zebra area report fb', 'Zebra');
    const t = await (await get('/reports')).text();
    expect(t).toContain('<span class="lbl">Area</span><details class="asel">');
    expect(t).toContain('All areas');
    expect(t).toContain('class="asel-i" href="/reports?type=Sandbox"');
    expect(t).toContain('class="asel-i" href="/reports?type=Zebra"');
    expect(t).toMatch(/class="asel-n" data-total="\d+" data-noun="areas">\d+ areas<\/div>/);
    // The old rendering was a row of chip links straight to ?type=...; that wall is gone.
    expect(t).not.toContain('class="chip" href="/reports?type=');
    // Sort / From stay chips.
    expect(t).toContain('class="chip" href="/reports?sort=rising"');
    expect(t).toContain('class="chip" href="/reports?from=Muse"');
  });

  it('selected area shows on the toggle and is marked in the list; the rest of the query is carried over', async () => {
    await makeReport('Sandbox broke fb2', 'Sandbox');
    await makeReport('Zebra area report fb2', 'Zebra');
    const t = await (await get('/reports?type=Sandbox&q=wobb')).text();
    expect(t).toContain('<summary class="chip asel-t on"><span class="asel-v">Sandbox</span>');
    expect(t).toContain('class="asel-i on" aria-current="true" href="/reports?type=Sandbox&amp;q=wobb"');
    // "All areas" clears the filter but keeps the search query.
    expect(t).toContain('class="asel-i" href="/reports?q=wobb"');
    // Another area keeps the search query too.
    expect(t).toContain('class="asel-i" href="/reports?type=Zebra&amp;q=wobb"');
  });

  it('area names are HTML-escaped in the toggle, options and hrefs', async () => {
    await makeReport('Odd area report fb', 'Odd & <Areas>');
    const t = await (await get('/reports?type=' + encodeURIComponent('Odd & <Areas>'))).text();
    expect(t).toContain('Odd &amp; &lt;Areas&gt;');
    expect(t).not.toContain('Odd & <Areas>');
  });

  it('product /raises uses the same selector with its own types', async () => {
    const t = await (await get('/raises')).text();
    expect(t).toContain('<span class="lbl">Type</span><details class="asel">');
    expect(t).toContain('All types');
    expect(t).toContain('href="/raises?type=Capability"');
    expect(t).toContain('href="/raises?type=App+or+service"');
    expect(t).toContain('data-noun="types">2 types</div>');
  });

  it('demo /reports gets the selector with the demo categories; the demo window chips stay chips', async () => {
    const t = await (await dget('/reports')).text();
    expect(t).toContain('<details class="asel">');
    expect(t).toContain('href="/reports?type=Teleport"');
    expect(t).toContain('class="chip" href="/reports?active=24h"');
    expect(t).not.toContain('class="chip" href="/reports?type=');
  });

  it('style.css styles the selector and app.js drives search, focus, scroll and keys', async () => {
    const css = (env as any).TEST_STYLE_CSS as string;
    expect(css).toContain('.asel-p{position:absolute');
    expect(css).toContain('.asel-l{');
    expect(css).toContain('overflow-y:auto');
    expect(css).toContain('.asel-i.on{');
    const js = (env as any).TEST_APP_JS as string;
    expect(js).toContain("querySelectorAll('details.asel')");
    expect(js).toContain('scrollIntoView');
    expect(js).toContain('ArrowDown');
    expect(js).toContain('Escape');
    expect(js).toContain("addEventListener('input'");
  });
});
