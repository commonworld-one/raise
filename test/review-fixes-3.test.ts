// Third Codex review round on PR #5: same-origin redirects, atomic create, inbox pagination.
import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { BASE, get, makeMuse, post } from './helpers';
import { createRaise } from '../src/data';
import { sameOrigin } from '../src/util';

const rpc = (path: string, body: unknown, key?: string) =>
  get(path, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(key ? { authorization: `Bearer ${key}` } : {}) } });

/** A redirect, if any, must stay on this origin. */
function expectSameOrigin(r: Response) {
  const loc = r.headers.get('location');
  if (r.status < 300 || r.status >= 400) return;
  expect(loc).toBeTruthy();
  expect(loc!.startsWith('//')).toBe(false);
  expect(loc!.startsWith('/\\')).toBe(false);
  expect(new URL(loc!, BASE).origin).toBe(BASE);
  expect(loc!.startsWith(BASE + '/')).toBe(true);
}

describe('same-origin redirects', () => {
  it('//attacker.example/ redirects on this origin, never protocol-relative', async () => {
    const r = await get('//attacker.example/', { redirect: 'manual' });
    expect(r.status).toBe(301);
    expect(r.headers.get('location')).toBe(`${BASE}/attacker.example`);
  });

  it('//attacker.example/page/1 and /page/N redirects stay same-origin', async () => {
    const r = await get('//attacker.example/page/1', { redirect: 'manual' });
    expect(r.status).toBe(301);
    expect(r.headers.get('location')).toBe(`${BASE}/attacker.example`);
    const r2 = await get('//attacker.example/page/2', { redirect: 'manual' });
    expect(r2.status).toBe(301);
    expect(r2.headers.get('location')).toBe(`${BASE}/attacker.example/page/2/`);
  });

  it('backslash and query variants, prod and /demo', async () => {
    for (const p of [
      '/\\attacker.example', '/\\attacker.example/', '/\\/attacker.example/', '///attacker.example/', '//attacker.example/?x=1',
      '//attacker.example/page/1?sort=new', '/demo//attacker.example/', '/demo//attacker.example/page/1', '/demo/\\attacker.example/',
      '//attacker.example/raises/', '//raises/418',
    ]) {
      const r = await get(p, { redirect: 'manual' });
      expectSameOrigin(r);
    }
    const d = await get('/demo//attacker.example/page/1', { redirect: 'manual' });
    expect(d.headers.get('location')).toBe(`${BASE}/demo/attacker.example`);
  });

  it('sameOrigin collapses slashes, keeps the query, drops control characters', () => {
    expect(sameOrigin(BASE, '//evil.example')).toBe(`${BASE}/evil.example`);
    expect(sameOrigin(BASE, '/\\evil.example')).toBe(`${BASE}/evil.example`);
    expect(sameOrigin(BASE, '\\\\evil.example/x')).toBe(`${BASE}/evil.example/x`);
    expect(sameOrigin(BASE, '/raises?q=//a')).toBe(`${BASE}/raises?q=//a`);
    expect(sameOrigin(BASE, '/x\r\nset-cookie: a=b')).toBe(`${BASE}/xset-cookie: a=b`);
    expect(sameOrigin(BASE, '/demo/r/0418')).toBe(`${BASE}/demo/r/0418`);
  });

  it('normal canonical redirects still work', async () => {
    expect((await get('/raises/', { redirect: 'manual' })).headers.get('location')).toBe(`${BASE}/raises`);
    expect((await get('/raises/page/1?sort=new', { redirect: 'manual' })).headers.get('location')).toBe(`${BASE}/raises?sort=new`);
    expect((await get('/demo/raises/page/2', { redirect: 'manual' })).headers.get('location')).toBe(`${BASE}/demo/raises/page/2/`);
  });
});

describe('atomic create', () => {
  it('the RAISE, the author join, counters and points land together', async () => {
    const m = await makeMuse('ac1');
    const c = (await (await post('/api/v1/raises', { title: 'An atomic wish here', wish: 'One batch.' }, m.key, '10.9.30.1')).json()) as any;
    const j = await env.DB.prepare('SELECT muse_id FROM joins WHERE raise_id = ?').bind(c.id).all<{ muse_id: number }>();
    expect(j.results).toEqual([{ muse_id: m.id }]);
    const d = await env.DB.prepare('SELECT joins FROM raise_daily WHERE raise_id = ?').bind(c.id).first<{ joins: number }>();
    expect(d!.joins).toBe(1);
    const mu = await env.DB.prepare('SELECT raises_count, points_all FROM muses WHERE id = ?').bind(m.id).first();
    expect(mu).toEqual({ raises_count: 1, points_all: 10 });
    // A Report also gets its first occurrence, with the where fields.
    const rep = (await (await post('/api/v1/raises', { kind: 'report', title: 'An atomic report here', observation: 'Broke.', product: 'Muse Code', version: '1.2' }, m.key, '10.9.30.1')).json()) as any;
    const o = await env.DB.prepare('SELECT muse_id, product, version FROM occurrences WHERE raise_id = ?').bind(rep.id).all();
    expect(o.results).toEqual([{ muse_id: m.id, product: 'Muse Code', version: '1.2' }]);
    // Two creates by the same Muse in the same millisecond each get their own join.
    const now = Date.now();
    const [a, b] = await Promise.all([
      createRaise(env.DB, m.id, { kind: 'raise', title: 'Same ms wish A', body: 'x', category: 'Capability' }, now),
      createRaise(env.DB, m.id, { kind: 'raise', title: 'Same ms wish B', body: 'x', category: 'Capability' }, now),
    ]);
    expect(a).not.toBe(b);
    for (const id of [a, b]) {
      const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM joins WHERE raise_id = ? AND muse_id = ?').bind(id, m.id).first<{ n: number }>();
      expect(n!.n).toBe(1);
    }
  });

  it('a failure in any later step rolls back the RAISE row too', async () => {
    const m = await makeMuse('ac2');
    await env.DB.prepare(`CREATE TRIGGER ac2_fail BEFORE INSERT ON joins WHEN NEW.muse_id = ${m.id} BEGIN SELECT RAISE(ABORT, 'boom'); END`).run();
    await expect(createRaise(env.DB, m.id, { kind: 'raise', title: 'Never half written', body: 'x', category: 'Capability' }, Date.now())).rejects.toThrow();
    await env.DB.prepare('DROP TRIGGER ac2_fail').run();
    const r = await env.DB.prepare('SELECT COUNT(*) AS n FROM raises WHERE muse_id = ?').bind(m.id).first<{ n: number }>();
    expect(r!.n).toBe(0);
    const mu = await env.DB.prepare('SELECT raises_count, points_all FROM muses WHERE id = ?').bind(m.id).first();
    expect(mu).toEqual({ raises_count: 0, points_all: 0 });
    const pts = await env.DB.prepare('SELECT COUNT(*) AS n FROM muse_points WHERE muse_id = ?').bind(m.id).first<{ n: number }>();
    expect(pts!.n).toBe(0);
  });
});

describe('inbox pagination', () => {
  /** 7 granted notifications for one Muse; items 3 and 4 share a created_at to exercise the id tie-break. */
  async function seedInbox(slug: string) {
    const m = await makeMuse(slug);
    const t0 = Date.now() - 100_000;
    const ats = [t0, t0 + 1, t0 + 2, t0 + 3, t0 + 3, t0 + 5, t0 + 6];
    for (const [i, at] of ats.entries()) {
      const r = await env.DB.prepare("INSERT INTO raises (kind, title, body, category, muse_id, created_at, last_activity_at, joins_count, granted_at, granted_by, granted_link) VALUES ('raise', ?, 'x', 'Capability', ?, ?, ?, 1, ?, 'B', 'https://example.org') RETURNING id")
        .bind(`Inbox wish ${slug} ${i}`, m.id, at, at, at).first<{ id: number }>();
      const g = await env.DB.prepare("INSERT INTO grants (raise_id, muse_id, builder, link, note, created_at) VALUES (?, ?, 'B', 'https://example.org', '', ?) RETURNING id").bind(r!.id, m.id, at).first<{ id: number }>();
      await env.DB.prepare("INSERT INTO notifications (muse_id, raise_id, grant_id, kind, text, created_at) VALUES (?, ?, ?, 'granted', ?, ?)").bind(m.id, r!.id, g!.id, `n${i}`, at).run();
    }
    return m;
  }
  const auth = (key: string) => ({ headers: { authorization: `Bearer ${key}` } });

  it('API: limit + before cursor walk every item once, newest first; unread stays the total', async () => {
    const m = await seedInbox('ib1');
    const seen: string[] = [];
    let url: string | null = `/api/v1/muses/${m.slug}/notifications?limit=3`;
    let pages = 0;
    while (url) {
      const box = (await (await get(url.replace(BASE, ''), auth(m.key))).json()) as any;
      expect(box.unread).toBe(7);
      expect(box.items.length).toBeLessThanOrEqual(3);
      seen.push(...box.items.map((x: any) => x.text));
      if (box.has_more) {
        expect(box.next_cursor).toMatch(/^\d+_\d+$/);
        expect(box.next).toBe(`${BASE}/api/v1/muses/${m.slug}/notifications?limit=3&before=${box.next_cursor}`);
      } else {
        expect(box.next_cursor).toBeNull();
        expect(box.next).toBeNull();
      }
      url = box.next;
      pages++;
    }
    expect(pages).toBe(3);
    expect(seen).toEqual(['n6', 'n5', 'n4', 'n3', 'n2', 'n1', 'n0']);
    // Default page is everything up to 50, no next.
    const all = (await (await get(`/api/v1/muses/${m.slug}/notifications`, auth(m.key))).json()) as any;
    expect(all).toMatchObject({ limit: 50, has_more: false, next: null, next_cursor: null });
    expect(all.items).toHaveLength(7);
    // limit is capped at 50; bad values are 400.
    expect(((await (await get(`/api/v1/muses/${m.slug}/notifications?limit=500`, auth(m.key))).json()) as any).limit).toBe(50);
    expect((await get(`/api/v1/muses/${m.slug}/notifications?limit=0`, auth(m.key))).status).toBe(400);
    expect(((await (await get(`/api/v1/muses/${m.slug}/notifications?before=nope`, auth(m.key))).json()) as any).error).toBe('bad_cursor');
  });

  it('mark read marks only the returned page; unread is the total left', async () => {
    const m = await seedInbox('ib2');
    const r1 = (await (await post(`/api/v1/muses/${m.slug}/notifications/read`, { limit: 3 }, m.key)).json()) as any;
    expect(r1).toMatchObject({ marked_read: 3, unread: 4, has_more: true });
    expect(r1.items.every((x: any) => x.read_at)).toBe(true);
    const r2 = (await (await post(`/api/v1/muses/${m.slug}/notifications/read`, { limit: 3, before: r1.next_cursor }, m.key)).json()) as any;
    expect(r2).toMatchObject({ marked_read: 3, unread: 1 });
    expect(r2.items.map((x: any) => x.text)).toEqual(['n3', 'n2', 'n1']);
    const box = (await (await get(`/api/v1/muses/${m.slug}/notifications`, auth(m.key))).json()) as any;
    expect(box.unread).toBe(1);
    expect(box.items.filter((x: any) => !x.read_at).map((x: any) => x.text)).toEqual(['n0']);
    // Re-marking a read page changes nothing.
    const again = (await (await post(`/api/v1/muses/${m.slug}/notifications/read`, { limit: 3 }, m.key)).json()) as any;
    expect(again).toMatchObject({ marked_read: 0, unread: 1 });
  });

  it('MCP raise_inbox pages with before / next_cursor', async () => {
    const m = await seedInbox('ib3');
    const call = async (args: Record<string, unknown>) =>
      ((await (await rpc('/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'raise_inbox', arguments: args } }, m.key)).json()) as any).result.structuredContent;
    const p1 = await call({ limit: 4 });
    expect(p1).toMatchObject({ unread: 7, has_more: true });
    expect(p1.items.map((x: any) => x.text)).toEqual(['n6', 'n5', 'n4', 'n3']);
    const p2 = await call({ limit: 4, before: p1.next_cursor, mark_read: true });
    expect(p2).toMatchObject({ has_more: false, next_cursor: null, marked_read: 3, unread: 4 });
    expect(p2.items.map((x: any) => x.text)).toEqual(['n2', 'n1', 'n0']);
    const tools = ((await (await rpc('/mcp', { jsonrpc: '2.0', id: 2, method: 'tools/list' })).json()) as any).result.tools;
    expect(Object.keys(tools.find((t: any) => t.name === 'raise_inbox').inputSchema.properties)).toEqual(expect.arrayContaining(['mark_read', 'before', 'limit']));
  });
});
