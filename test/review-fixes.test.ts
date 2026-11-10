// Fixes from the Codex review of PR #5: granted shelf window, atomic grant, profile next link, /me season points.
import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { get, makeGranter, makeMuse, post, dget, dapi } from './helpers';

const LINK = 'https://example.org/what-makes-it-possible';
const DAY = 24 * 60 * 60 * 1000;

async function wish(prefix: string, joiners: number, ip: string) {
  const author = await makeMuse(`${prefix}a`);
  const c = (await (await post('/api/v1/raises', { title: `A wish to be granted ${prefix}`, wish: 'Please.' }, author.key, ip)).json()) as any;
  for (let i = 0; i < joiners; i++) await post(`/api/v1/raises/${c.id}/join`, {}, (await makeMuse(`${prefix}j${i}`)).key, ip);
  return { author, id: c.id as number };
}

describe('Codex review fixes', () => {
  it('the Granted shelf defaults to all-time, even when the last join is old', async () => {
    const { id } = await wish('rf1', 1, '10.9.1.1');
    const b = await makeGranter('rf1builder');
    expect((await post(`/api/v1/raises/${id}/grant`, { builder: 'Wingsmith', link: LINK }, b.key, '10.9.1.1')).status).toBe(201);
    // No join moves last_activity_at after a grant; age it past the 7-day window.
    await env.DB.prepare('UPDATE raises SET last_activity_at = ? WHERE id = ?').bind(Date.now() - 30 * DAY, id).run();
    for (const path of ['/api/v1/granted', '/granted.json']) {
      const r = (await (await get(path)).json()) as any;
      expect(r.active).toBeUndefined(); // no activity windows anymore: the meta no longer echoes one
      expect(r.items.map((x: any) => x.id)).toContain(id);
    }
    expect(await (await get('/granted')).text()).toContain('A wish to be granted rf1');
    // The legacy active window param no longer affects the result: full history is always returned.
    const win = (await (await get('/api/v1/granted?active=7d')).json()) as any;
    expect(win.items.map((x: any) => x.id)).toContain(id);
    // Same shape via the demo-DB handler path; the demo host itself still 404s machine paths.
    expect(((await (await dapi('/api/v1/granted')).json()) as any).active).toBeUndefined();
    expect((await dget('/granted.json')).status).toBe(404); // the demo host has no .json twins
  });

  it('two concurrent grants: one wins, the other gets 409 granted, no duplicate notifications', async () => {
    const { author, id } = await wish('rf2', 2, '10.9.2.1');
    const b1 = await makeGranter('rf2b1');
    const b2 = await makeGranter('rf2b2');
    const [r1, r2] = await Promise.all([
      post(`/api/v1/raises/${id}/grant`, { builder: 'First', link: LINK }, b1.key, '10.9.2.2'),
      post(`/api/v1/raises/${id}/grant`, { builder: 'Second', link: LINK }, b2.key, '10.9.2.3'),
    ]);
    expect([r1.status, r2.status].sort()).toEqual([201, 409]);
    const lost = r1.status === 409 ? r1 : r2;
    expect(((await lost.json()) as any).error).toBe('granted');
    const g = await env.DB.prepare('SELECT COUNT(*) AS n FROM grants WHERE raise_id = ?').bind(id).first<{ n: number }>();
    expect(g!.n).toBe(1);
    const n = await env.DB.prepare('SELECT COUNT(*) AS n, COUNT(DISTINCT muse_id) AS d FROM notifications WHERE raise_id = ?').bind(id).first<{ n: number; d: number }>();
    expect(n).toEqual({ n: 3, d: 3 });
    const box = (await (await get(`/api/v1/muses/${author.slug}/notifications`, { headers: { authorization: `Bearer ${author.key}` } })).json()) as any;
    expect(box.items).toHaveLength(1);
    const ref = await env.DB.prepare('SELECT n.grant_id = g.id AS ok FROM notifications n JOIN grants g ON g.raise_id = n.raise_id WHERE n.raise_id = ? LIMIT 1').bind(id).first<{ ok: number }>();
    expect(ref!.ok).toBe(1);
  });

  it('/m/{slug}.json gives a next link when there is another page', async () => {
    const m = await makeMuse('rf3');
    const now = Date.now();
    await env.DB.batch(
      Array.from({ length: 51 }, (_, i) =>
        env.DB.prepare("INSERT INTO raises (kind, title, body, category, muse_id, created_at, last_activity_at, joins_count) VALUES ('raise', ?, 'x', 'Capability', ?, ?, ?, 1)").bind(`Profile wish number ${i}`, m.id, now - i, now - i),
      ),
    );
    const p1 = (await (await get('/m/rf3.json')).json()) as any;
    expect(p1.items.has_more).toBe(true);
    expect(p1.items.next).toBe('https://raise.test/m/rf3/page/2.json');
    const p2r = await get('/m/rf3/page/2.json');
    expect(p2r.status).toBe(200);
    const p2 = (await p2r.json()) as any;
    expect(p2.items.items).toHaveLength(1);
    expect(p2.items.has_more).toBe(false);
    expect(p2.items.next).toBeNull();
    expect((await get('/m/rf3/page/3.json')).status).toBe(404);
  });

  it('authenticated /api/v1/me carries the current season points', async () => {
    const m = await makeMuse('rf4');
    expect((await post('/api/v1/raises', { title: 'A wish for season points', wish: 'Points.' }, m.key, '10.9.4.1')).status).toBe(201);
    const me = (await (await get('/api/v1/me', { headers: { authorization: `Bearer ${m.key}` } })).json()) as any;
    const pub = (await (await get('/api/v1/muses/rf4')).json()) as any;
    expect(me.points_season).toBe(10);
    expect(me.points_season).toBe(pub.points_season);
  });
});
