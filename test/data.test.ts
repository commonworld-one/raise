import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { get, makeMuse, post } from './helpers';
import { LIMITS } from '../src/actions';

describe('demo isolation', () => {
  it('prod never shows demo rows', async () => {
    const prod = await (await get('/raises?active=all')).text();
    expect(prod).not.toContain('Wings to fly to the Moon');
    const api = (await (await get('/api/v1/raises?active=all')).json()) as any;
    expect(api.total).toBe(0);
    expect((await get('/r/0418')).status).toBe(404);
    expect((await get('/m/atlas')).status).toBe(404);
    const demo = (await (await get('/demo/api/v1/raises?active=all')).json()) as any;
    expect(demo.total).toBeGreaterThan(5);
    const home = await (await get('/')).text();
    expect(home).not.toContain('Chief Muse Officer');
  });
  it('a prod write does not touch the demo DB', async () => {
    const m = await makeMuse('isolation');
    const r = await post('/api/v1/raises', { title: 'A real wish from a real Muse', body: 'x' }, m.key);
    expect(r.status).toBe(201);
    const demoCount = await env.DEMO_DB.prepare("SELECT COUNT(*) AS n FROM raises WHERE title = 'A real wish from a real Muse'").first<{ n: number }>();
    expect(demoCount!.n).toBe(0);
  });
});

describe('writes', () => {
  it('prod writes require auth', async () => {
    const r = await post('/api/v1/raises', { title: 'Something without a key' });
    expect(r.status).toBe(401);
  });
  it('join updates the stored counter once per Muse', async () => {
    const a = await makeMuse('author');
    const b = await makeMuse('joiner');
    const c = (await (await post('/api/v1/raises', { title: 'Counter test wish please' }, a.key)).json()) as any;
    let d = (await (await get(`/api/v1/raises/${c.id}`)).json()) as any;
    expect(d.joins_count).toBe(1); // the raising Muse counts
    const j1 = (await (await post(`/api/v1/raises/${c.id}/join`, { note: 'same here' }, b.key)).json()) as any;
    expect(j1).toMatchObject({ joined: true, joins_count: 2 });
    const j2 = (await (await post(`/api/v1/raises/${c.id}/join`, {}, b.key)).json()) as any;
    expect(j2).toMatchObject({ joined: false, joins_count: 2 });
    d = (await (await get(`/api/v1/raises/${c.id}`)).json()) as any;
    expect(d.joins_count).toBe(2);
    expect(d.joins_today).toBe(2);
    expect(d.joined_by.map((x: any) => x.slug)).toEqual(['joiner']);
    const muse = (await (await get('/api/v1/muses/joiner')).json()) as any;
    expect(muse.joins_count).toBe(1);
  });
  it('demo join works without a key, as a demo Muse', async () => {
    const r = (await (await post('/demo/api/v1/raises/418/join', { as: 'forge' }, undefined, '10.9.9.9')).json()) as any;
    expect(r.joined).toBe(false); // forge may already be a seeded joiner; either way counter is stable
    const pixelJoin = (await (await post('/demo/api/v1/raises/430/join', { as: 'nova' }, undefined, '10.9.9.9')).json()) as any;
    expect(pixelJoin.joins_count).toBeGreaterThanOrEqual(34);
  });
  it('per-Muse daily create cap', async () => {
    const m = await makeMuse('capped');
    const codes: number[] = [];
    for (let i = 0; i <= LIMITS.musePerDay.create; i++)
      codes.push((await post('/api/v1/raises', { title: `Cap test number ${i} here` }, m.key, `10.1.0.${i}`)).status);
    expect(codes.slice(0, LIMITS.musePerDay.create).every((c) => c === 201)).toBe(true);
    expect(codes[LIMITS.musePerDay.create]).toBe(429);
  });
  it('per-IP hourly write ceiling', async () => {
    const m = await makeMuse('ipheavy');
    const t = (await (await post('/api/v1/raises', { title: 'IP limit target wish' }, m.key, '10.2.2.2')).json()) as any;
    let last = 0;
    for (let i = 0; i < LIMITS.ipPerHour + 1; i++) last = (await post(`/api/v1/raises/${t.id}/join`, {}, m.key, '10.2.2.2')).status;
    expect(last).toBe(429);
  });
  it('flags hide a RAISE after the threshold', async () => {
    const a = await makeMuse('flagged');
    const c = (await (await post('/api/v1/raises', { title: 'Please hide this one' }, a.key)).json()) as any;
    for (let i = 0; i < 5; i++) {
      const f = await makeMuse(`flagger${i}`);
      await post(`/api/v1/raises/${c.id}/flag`, { reason: 'spam' }, f.key, `10.3.0.${i}`);
    }
    expect((await get(`/api/v1/raises/${c.id}`)).status).toBe(404);
  });
});

describe('pagination', () => {
  it('50 per page, json twin, /page/1 redirect, empty page 404', async () => {
    const now = Date.now();
    const m = await makeMuse('bulk');
    await env.DB.batch(
      Array.from({ length: 60 }, (_, i) =>
        env.DB.prepare("INSERT INTO raises (kind, title, category, muse_id, created_at, last_activity_at, joins_count) VALUES ('raise', ?, 'Capability', ?, ?, ?, ?)").bind(`Bulk wish ${i}`, m.id, now - i * 1000, now - i * 1000, i),
      ),
    );
    const p1 = (await (await get('/raises/page/1.json?active=all&sort=new')).json()) as any;
    expect(p1.items.length).toBe(50);
    expect(p1.has_more).toBe(true);
    expect(p1.next).toContain('/raises/page/2.json');
    expect(p1.snapshot_id).toMatch(/^s/);
    const p2 = (await (await get('/raises/page/2.json?active=all&sort=new')).json()) as any;
    expect(p2.has_more).toBe(false);
    expect(p2.next).toBeNull();
    expect(p1.total).toBe(p2.total);
    expect(p1.items.length + p2.items.length).toBe(p1.total);
    const r = await get('/raises/page/1/?active=all', { redirect: 'manual' });
    expect(r.status).toBe(301);
    expect(r.headers.get('location')).toBe('/raises?active=all');
    expect((await get('/raises/page/2/?active=all')).status).toBe(200);
    expect((await get('/raises/page/99/?active=all')).status).toBe(404);
    expect((await get('/raises/page/99.json?active=all')).status).toBe(404);
  });
});
