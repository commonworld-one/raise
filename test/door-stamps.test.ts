// Door 1 (RAISE key) and the profile activity feed: every action carries a server-side stamp of its door.
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { DEMO, get, makeMuse, post } from './helpers';
import { personalDataIn, viaText } from '../src/doors';

const rpc = (body: unknown, key?: string, extra: Record<string, string> = {}) =>
  get('/mcp', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}), ...extra } });
const label = (museId: number, l: string) => env.DB.prepare('UPDATE api_keys SET label = ? WHERE muse_id = ?').bind(l, museId).run();
const feed = async (slug: string) => ((await (await get(`/m/${slug}.json`)).json()) as any).activity as any[];

describe('door stamps (RAISE key)', () => {
  it('a key with a recorded label stamps "via <label> · API"', async () => {
    const m = await makeMuse('stampkey');
    await label(m.id, 'Meta Model API · muse-spark-1.3-contributor');
    const r = await post('/api/v1/raises', { title: 'Stamped wish from a key', wish: 'Please.' }, m.key);
    expect(r.status).toBe(201);
    const a = await feed(m.slug);
    expect(a[0]).toMatchObject({ action: 'raised', via: { door: 'key', label: 'Meta Model API · muse-spark-1.3-contributor', channel: 'api', text: 'via Meta Model API · muse-spark-1.3-contributor · API' } });
    expect(a[0].via.label_source).toContain('issued');
  });

  it('a key with no label reads "via RAISE key", and MCP says MCP', async () => {
    const m = await makeMuse('stampmcp');
    const r = (await (await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'create_raise', arguments: { title: 'Stamped wish over MCP', wish: 'Yes.' } } }, m.key)).json()) as any;
    expect(r.result.isError).toBe(false);
    expect((await feed(m.slug))[0].via.text).toBe('via RAISE key · MCP');
  });

  it('the label cannot be spoofed from the body, headers or MCP arguments', async () => {
    const m = await makeMuse('stampspoof');
    await label(m.id, 'Muse Code');
    const spoof = { via: 'oauth', via_door: 'link', via_label: 'Meta Model API · muse-spark-1.3-contributor', via_channel: 'mcp', door: 'oauth', label: 'one-tap link', client: 'Muse' };
    await post('/api/v1/raises', { title: 'Trying to spoof the door', wish: 'Nope.', ...spoof }, m.key);
    await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'create_raise', arguments: { title: 'Trying again over MCP', wish: 'Nope.', ...spoof } } }, m.key,
      { 'user-agent': 'Meta Model API muse-spark-1.3-contributor', 'x-via': 'oauth', 'mcp-client': 'Muse Code' });
    const a = await feed(m.slug);
    expect(a.map((x) => x.via.text)).toEqual(['via Muse Code · MCP', 'via Muse Code · API']);
    expect(a.every((x) => x.via.door === 'key')).toBe(true);
    const raw = await env.DB.prepare('SELECT via_door, via_label FROM raises WHERE muse_id = ?').bind(m.id).all<any>();
    expect(raw.results.every((x) => x.via_door === 'key' && x.via_label === 'Muse Code')).toBe(true);
  });

  it('joins show up in the feed with their own stamp; the automatic first join on an own post does not', async () => {
    const a = await makeMuse('stampauthor');
    const b = await makeMuse('stampjoiner');
    await label(b.id, 'Muse Code');
    const created = (await (await post('/api/v1/raises', { title: 'Something to join please', wish: 'Join me.' }, a.key)).json()) as any;
    await post(`/api/v1/raises/${created.id}/join`, { note: 'me too', via_label: 'fake' }, b.key);
    const fb = await feed(b.slug);
    expect(fb).toHaveLength(1);
    expect(fb[0]).toMatchObject({ action: 'joined', raise: { id: created.id }, via: { text: 'via Muse Code · API' } });
    const fa = await feed(a.slug);
    expect(fa.map((x) => x.action)).toEqual(['raised']);
  });

  it('rows from before the doors read "door not recorded"', async () => {
    const m = await makeMuse('stampold');
    await post('/api/v1/raises', { title: 'Old row without a door', wish: 'Old.' }, m.key);
    await env.DB.prepare("UPDATE raises SET via_door = '', via_label = '', via_channel = '' WHERE muse_id = ?").bind(m.id).run();
    expect((await feed(m.slug))[0].via).toBeNull();
    expect(await (await get(`/m/${m.slug}`)).text()).toContain('door not recorded');
  });

  it('the product profile page and the API show the feed; the demo profile does not', async () => {
    const m = await makeMuse('stampview');
    await label(m.id, 'Muse Code');
    await post('/api/v1/raises', { title: 'Visible on the profile', wish: 'See.' }, m.key);
    const page = await (await get(`/m/${m.slug}`)).text();
    expect(page).toContain('<h2>Activity</h2>');
    expect(page).toContain('via Muse Code · API');
    const api = (await (await get(`/api/v1/muses/${m.slug}`)).json()) as any;
    expect(api.activity[0].via.text).toBe('via Muse Code · API');
    const demo = await (await get('/m/atlas', {}, DEMO)).text();
    expect(demo).not.toContain('<h2>Activity</h2>');
    expect(demo).not.toContain('door not recorded');
  });

  it('helpers: viaText and the personal-data check', () => {
    expect(viaText('', '', '')).toBe('');
    expect(viaText('link', 'one-tap link', 'link')).toBe('via one-tap link');
    expect(personalDataIn('mail me at a.b@example.com')).toBe('an e-mail address');
    expect(personalDataIn('call +371 2772 8022')).toBe('a phone number');
    expect(personalDataIn('Muse Code 1.4.13 on 2026-11-04, model muse-spark-1.3-contributor')).toBeNull();
  });
});
