// Product after removing Active/Quiet and age-based hiding: full-history lists, newest 3+3 home,
// no activity fields/params in API/MCP, latest-occurrence date retained. The demo is conserved
// (its badges, chips and windows stay); demo coverage lives in pages.test.ts / demo-reference-clock.test.ts.
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { get, makeMuse, post } from './helpers';

const DAY = 86_400_000;
const pad4 = (n: number) => String(n).padStart(4, '0');
const rpc = (body: unknown) =>
  get('/mcp', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' } });

async function makeEntry(kind: 'raise' | 'report', title: string, ageDays: number): Promise<number> {
  const key = (await makeMuse()).key; // fresh Muse: the per-Muse daily create limit would throttle a shared one
  const r = (await (await post('/api/v1/raises', kind === 'raise' ? { kind, title, wish: 'w' } : { kind, title, observation: 'o' }, key)).json()) as any;
  if (!r.id) throw new Error(`fixture create failed: ${JSON.stringify(r)}`);
  const old = Date.now() - ageDays * DAY;
  await env.DB.prepare('UPDATE raises SET created_at = ?, last_activity_at = ? WHERE id = ?').bind(old, old, r.id).run();
  return r.id as number;
}

describe('product: Active/Quiet and age-based hiding removed', () => {
  it('home: three newest RAISEs and Reports under the unchanged headings, all aged past every old window', async () => {
    const raises: number[] = [];
    const reports: number[] = [];
    for (let i = 0; i < 4; i++) raises.push(await makeEntry('raise', `Home raise ${i} daq`, 40 - i));
    for (let i = 0; i < 4; i++) reports.push(await makeEntry('report', `Home report ${i} daq`, 40 - i));
    const t = await (await get('/')).text();
    expect(t).toContain('🔥 Hot RAISEs'); // heading unchanged
    expect(t).toContain('👀 Happening now'); // heading unchanged
    const left = t.slice(t.indexOf('🔥 Hot RAISEs'), t.indexOf('👀 Happening now'));
    const right = t.slice(t.indexOf('👀 Happening now'), t.indexOf('Browse every page'));
    for (const i of [3, 2, 1]) {
      expect(left).toContain(`Home raise ${i} daq`);
      expect(right).toContain(`Home report ${i} daq`);
    }
    expect(left).not.toContain('Home raise 0 daq'); // only the three newest
    expect(right).not.toContain('Home report 0 daq');
    // No activity tags leak onto the product home.
    expect(t).not.toContain('>Active<');
    expect(t).not.toContain('>Quiet<');
  });

  it('catalogs: aged entries listed, legacy window/state URL params ignored, no activity chips or tags', async () => {
    const t = await (await get('/raises?active=24h')).text();
    expect(t).toContain('Home raise 0 daq'); // 40 days old, well past the old 24h window
    expect(t).not.toContain('Active in'); // window chips gone
    const r = await (await get('/reports?state=quiet&active=24h')).text();
    expect(r).toContain('Home report 0 daq'); // state=quiet/active=24h no longer filter
    expect(r).not.toContain('Active in');
    expect(r).not.toContain('>Active<');
    expect(r).not.toContain('>Quiet<');
    expect(r).not.toContain('does not mean fixed'); // the activity explainer is gone
  });

  it('report page and markdown twin keep the latest-occurrence date without the activity status', async () => {
    const id = await makeEntry('report', 'Dated report daq', 30);
    const t = await (await get(`/r/${pad4(id)}`)).text();
    expect(t).toContain('Latest occurrence:');
    expect(t).not.toContain('Active means');
    expect(t).not.toContain('Quiet means');
    expect(t).not.toContain('>Active<');
    expect(t).not.toContain('>Quiet<');
    const md = await (await get(`/r/${pad4(id)}.md`)).text();
    expect(md).toContain('- Latest occurrence:');
    expect(md).not.toContain('- Activity:');
  });

  it('pulse: happening is the five newest Reports, not the recently active ones', async () => {
    const ids: number[] = [];
    for (let i = 0; i < 6; i++) ids.push(await makeEntry('report', `Pulse report ${i} daq`, 30 - i));
    // Fresh activity on the oldest report must not pull it into happening.
    await post(`/api/v1/raises/${ids[0]}/join`, {}, (await makeMuse()).key);
    const p = (await (await get('/api/v1/pulse')).json()) as any;
    expect(p.happening.map((x: any) => x.id)).toEqual([ids[5], ids[4], ids[3], ids[2], ids[1]]);
    for (const x of p.happening) expect(x.activity).toBeUndefined();
  });

  it('moderation hidden still excludes entries from the full-history lists and home', async () => {
    const id = await makeEntry('report', 'Moderation hidden daq', 10);
    await env.DB.prepare('UPDATE raises SET hidden = 1 WHERE id = ?').bind(id).run();
    const api = (await (await get('/api/v1/reports')).json()) as any;
    expect(api.items.map((x: any) => x.id)).not.toContain(id);
    const page = await (await get('/reports')).text();
    expect(page).not.toContain('Moderation hidden daq');
    const home = await (await get('/')).text();
    expect(home).not.toContain('Moderation hidden daq');
    // Unhide again so later assertions in this file are unaffected.
    await env.DB.prepare('UPDATE raises SET hidden = 0 WHERE id = ?').bind(id).run();
  });

  it('MCP: search_raises has no active argument, raise_pulse describes newest reports', async () => {
    const l = (await (await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })).json()) as any;
    const search = l.result.tools.find((t: any) => t.name === 'search_raises');
    expect(search.inputSchema.properties.active).toBeUndefined();
    const pulse = l.result.tools.find((t: any) => t.name === 'raise_pulse');
    expect(pulse.description).not.toContain('active reports');
    // A legacy active argument is accepted and ignored (full history).
    const id = await makeEntry('raise', 'Mcp legacy arg daq', 30);
    const r = (await (await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'search_raises', arguments: { query: 'Mcp legacy arg daq', active: '24h' } } })).json()) as any;
    expect(r.result.structuredContent.items.map((x: any) => x.id)).toContain(id);
  });
});
