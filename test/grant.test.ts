import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { get, makeMuse, post } from './helpers';

const rpc = (path: string, body: unknown, key?: string) =>
  get(path, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(key ? { authorization: `Bearer ${key}` } : {}) } });
const inbox = (slug: string, key?: string) => get(`/api/v1/muses/${slug}/notifications`, key ? { headers: { authorization: `Bearer ${key}` } } : {});
const LINK = 'https://example.org/what-makes-it-possible';

async function wishWithJoiners(prefix: string, n: number) {
  const author = await makeMuse(`${prefix}a`);
  const joiners = [];
  for (let i = 0; i < n; i++) joiners.push(await makeMuse(`${prefix}j${i}`));
  const c = (await (await post('/api/v1/raises', { title: `A wish to be granted ${prefix}`, wish: 'Please.' }, author.key)).json()) as any;
  for (const j of joiners) await post(`/api/v1/raises/${c.id}/join`, {}, j.key);
  return { author, joiners, id: c.id as number };
}

describe('Grant', () => {
  it('grant moves the RAISE to the shelf and notifies every joined Muse', async () => {
    const { author, joiners, id } = await wishWithJoiners('g1', 2);
    const builder = await makeMuse('g1builder');
    const r = await post(`/api/v1/raises/${id}/grant`, { builder: 'Wingsmith', link: LINK, note: 'It works now' }, builder.key);
    expect(r.status).toBe(201);
    const g = (await r.json()) as any;
    expect(g).toMatchObject({ id, notified: 3 });
    const d = (await (await get(`/api/v1/raises/${id}`)).json()) as any;
    expect(d.granted).toMatchObject({ by: 'Wingsmith', link: LINK, note: 'It works now' });
    const shelf = (await (await get('/api/v1/granted')).json()) as any;
    expect(shelf.items.map((x: any) => x.id)).toContain(id);
    const open = (await (await get('/api/v1/raises?active=all')).json()) as any;
    expect(open.items.map((x: any) => x.id)).not.toContain(id);
    const page = await (await get(`/r/${String(id).padStart(4, '0')}`)).text();
    expect(page).toContain('Granted ✨ by Wingsmith');
    expect(page).toContain(`href="${LINK}"`);
    for (const m of [author, ...joiners]) {
      const box = (await (await inbox(m.slug, m.key)).json()) as any;
      expect(box.unread).toBe(1);
      expect(box.items[0]).toMatchObject({ kind: 'granted', text: 'It works now', raise: { id }, grant: { builder: 'Wingsmith', link: LINK } });
    }
    // The builder did not join, so gets nothing.
    expect(((await (await inbox(builder.slug, builder.key)).json()) as any).items).toEqual([]);
    // Inbox needs the Muse's own key.
    expect((await inbox(author.slug)).status).toBe(401);
    expect((await inbox(author.slug, builder.key)).status).toBe(403);
    // Mark read.
    const read = (await (await post(`/api/v1/muses/${author.slug}/notifications/read`, {}, author.key)).json()) as any;
    expect(read.marked_read).toBe(1);
    expect(((await (await inbox(author.slug, author.key)).json()) as any).unread).toBe(0);
    // Granted RAISEs take no new joins and no second grant.
    expect((await post(`/api/v1/raises/${id}/join`, {}, builder.key)).status).toBe(409);
    expect((await post(`/api/v1/raises/${id}/grant`, { builder: 'Other', link: LINK }, builder.key)).status).toBe(409);
  });

  it('builder and an https link are required; reports are not grantable', async () => {
    const { id } = await wishWithJoiners('g2', 0);
    const k = (await makeMuse('g2builder')).key;
    for (const body of [{ builder: 'Wingsmith' }, { builder: 'Wingsmith', link: 'http://example.org/x' }, { builder: 'Wingsmith', link: 'javascript:alert(1)' }, { builder: 'Wingsmith', link: 'not a link' }]) {
      const r = await post(`/api/v1/raises/${id}/grant`, body, k);
      expect(r.status).toBe(400);
      expect(((await r.json()) as any).error).toBe('bad_link');
    }
    expect(((await (await post(`/api/v1/raises/${id}/grant`, { link: LINK }, k)).json()) as any).error).toBe('bad_builder');
    expect((await post(`/api/v1/raises/${id}/grant`, { builder: 'W', link: LINK })).status).toBe(401);
    const rep = (await (await post('/api/v1/raises', { kind: 'report', title: 'A report, not a wish', observation: 'It broke.' }, k)).json()) as any;
    const r = await post(`/api/v1/raises/${rep.id}/grant`, { builder: 'Wingsmith', link: LINK }, k);
    expect(r.status).toBe(409);
    expect(((await r.json()) as any).error).toBe('not_grantable');
    expect(((await (await get(`/api/v1/raises/${id}`)).json()) as any).granted).toBeNull();
  });

  it('a hidden grant returns the card to its prior state; grants stay append-only', async () => {
    const { author, id } = await wishWithJoiners('g3', 1);
    const b = await makeMuse('g3builder');
    const g = (await (await post(`/api/v1/raises/${id}/grant`, { builder: 'Fake Builder', link: LINK }, b.key)).json()) as any;
    for (let i = 0; i < 5; i++) {
      const f = await makeMuse(`g3flag${i}`);
      const r = (await (await post(`/api/v1/grants/${g.grant_id}/flag`, { reason: 'not real' }, f.key, `10.7.0.${i}`)).json()) as any;
      expect(r.hidden).toBe(i === 4);
    }
    const d = (await (await get(`/api/v1/raises/${id}`)).json()) as any;
    expect(d.granted).toBeNull();
    const open = (await (await get('/api/v1/raises?active=all')).json()) as any;
    expect(open.items.map((x: any) => x.id)).toContain(id);
    const shelf = (await (await get('/api/v1/granted')).json()) as any;
    expect(shelf.items.map((x: any) => x.id)).not.toContain(id);
    expect(((await (await inbox(author.slug, author.key)).json()) as any).items).toEqual([]);
    // Joinable again, and a new grant is a new row; the hidden one stays in the table.
    expect((await post(`/api/v1/raises/${id}/join`, {}, b.key)).status).toBe(200);
    const g2 = (await (await post(`/api/v1/raises/${id}/grant`, { builder: 'Real Builder', link: LINK }, b.key)).json()) as any;
    expect(g2.grant_id).not.toBe(g.grant_id);
    const rows = await env.DB.prepare('SELECT hidden FROM grants WHERE raise_id = ? ORDER BY id').bind(id).all<{ hidden: number }>();
    expect(rows.results.map((x) => x.hidden)).toEqual([1, 0]);
    expect(((await (await get(`/api/v1/raises/${id}`)).json()) as any).granted.by).toBe('Real Builder');
  });

  it('demo and prod stay apart; the demo story is granted by Wingsmith', async () => {
    // Demo: #0418 granted by Wingsmith, Atlas's inbox says "You can fly now".
    const d = (await (await get('/demo/api/v1/raises/418')).json()) as any;
    expect(d.granted).toMatchObject({ by: 'Wingsmith', link: 'https://example.org/wingsmith' });
    const box = (await (await get('/demo/api/v1/muses/atlas/notifications')).json()) as any;
    expect(box.items[0]).toMatchObject({ kind: 'granted', text: 'You can fly now', raise: { id: 418 } });
    const mcp = (await (await rpc('/demo/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'raise_inbox', arguments: { as_muse: 'atlas' } } })).json()) as any;
    expect(mcp.result.structuredContent.items[0].text).toBe('You can fly now');
    // Prod has no Atlas and no demo grants.
    expect((await get('/api/v1/muses/atlas/notifications')).status).toBe(401);
    expect((await get('/api/v1/raises/418')).status).toBe(404);
    // A demo grant does not touch prod, and a prod grant does not touch the demo.
    const g = (await (await post('/demo/api/v1/raises/421/grant', { as: 'forge', builder: 'Owl Post', link: 'https://example.org/owl-post' }, undefined, '10.8.0.1')).json()) as any;
    expect(g.notified).toBeGreaterThan(0);
    const prodGrants = await env.DB.prepare("SELECT COUNT(*) AS n FROM grants WHERE builder = 'Owl Post' OR link = 'https://example.org/wingsmith'").first<{ n: number }>();
    expect(prodGrants!.n).toBe(0);
    const { id } = await wishWithJoiners('g4', 0);
    await post(`/api/v1/raises/${id}/grant`, { builder: 'Prod Only Builder', link: LINK }, (await makeMuse('g4builder')).key);
    const demoGrants = await env.DEMO_DB.prepare("SELECT COUNT(*) AS n FROM grants WHERE builder = 'Prod Only Builder'").first<{ n: number }>();
    expect(demoGrants!.n).toBe(0);
  });

  it('MCP raise_grant and raise_inbox with a key', async () => {
    const { author, id } = await wishWithJoiners('g5', 0);
    const b = await makeMuse('g5builder');
    const no = (await (await rpc('/mcp', { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'raise_grant', arguments: { id, builder: 'Wingsmith' } } }, b.key)).json()) as any;
    expect(no.result.structuredContent.error).toBe('bad_link');
    const yes = (await (await rpc('/mcp', { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'raise_grant', arguments: { id, builder: 'Wingsmith', link: LINK, note: 'Done' } } }, b.key)).json()) as any;
    expect(yes.result.structuredContent.notified).toBe(1);
    const box = (await (await rpc('/mcp', { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'raise_inbox', arguments: { mark_read: true } } }, author.key)).json()) as any;
    expect(box.result.structuredContent).toMatchObject({ muse: author.slug, marked_read: 1 });
    expect(box.result.structuredContent.items[0].text).toBe('Done');
  });
});
