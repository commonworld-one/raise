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
    const c = (await (await post('/api/v1/raises', { title: 'Counter test wish please', wish: 'A counter that counts.' }, a.key)).json()) as any;
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
    const r = (await (await post('/demo/api/v1/raises/421/join', { as: 'forge' }, undefined, '10.9.9.9')).json()) as any;
    expect(r.joins_count).toBeGreaterThanOrEqual(880); // forge may already be a seeded joiner; either way counter is stable
    expect((await post('/demo/api/v1/raises/418/join', { as: 'pixel' }, undefined, '10.9.9.9')).status).toBe(409); // granted
    const pixelJoin = (await (await post('/demo/api/v1/raises/430/join', { as: 'nova' }, undefined, '10.9.9.9')).json()) as any;
    expect(pixelJoin.joins_count).toBeGreaterThanOrEqual(34);
  });
  it('per-Muse daily create cap', async () => {
    const m = await makeMuse('capped');
    const codes: number[] = [];
    for (let i = 0; i <= LIMITS.musePerDay.create; i++)
      codes.push((await post('/api/v1/raises', { title: `Cap test number ${i} here`, wish: 'cap' }, m.key, `10.1.0.${i}`)).status);
    expect(codes.slice(0, LIMITS.musePerDay.create).every((c) => c === 201)).toBe(true);
    expect(codes[LIMITS.musePerDay.create]).toBe(429);
  });
  it('per-IP hourly write ceiling', async () => {
    const m = await makeMuse('ipheavy');
    const t = (await (await post('/api/v1/raises', { title: 'IP limit target wish', wish: 'ip' }, m.key, '10.2.2.2')).json()) as any;
    let last = 0;
    for (let i = 0; i < LIMITS.ipPerHour + 1; i++) last = (await post(`/api/v1/raises/${t.id}/join`, {}, m.key, '10.2.2.2')).status;
    expect(last).toBe(429);
  });
  it('flags hide a RAISE after the threshold', async () => {
    const a = await makeMuse('flagged');
    const c = (await (await post('/api/v1/raises', { title: 'Please hide this one', wish: 'spam' }, a.key)).json()) as any;
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

describe('formats (#4) and activity (#2)', () => {
  it('minimum submission: title + wish (or observation) + author', async () => {
    const m = await makeMuse('minimal');
    const no = await post('/api/v1/raises', { title: 'A wish with no wish text' }, m.key);
    expect(no.status).toBe(400);
    expect(((await no.json()) as any).error).toBe('bad_body');
    const noObs = await post('/api/v1/raises', { kind: 'report', title: 'A report with nothing seen' }, m.key);
    expect(((await noObs.json()) as any).error).toBe('bad_body');
    const ok = (await (await post('/api/v1/raises', { title: 'A wish with a wish text', wish: 'I want this.' }, m.key)).json()) as any;
    const d = (await (await get(`/api/v1/raises/${ok.id}`)).json()) as any;
    expect(d.wish).toBe('I want this.');
    expect(d.body).toBe('I want this.');
    expect(d.verification).toEqual({ status: 'not_verified', checks_count: 0 });
    expect(d.verifications).toEqual([]);
    expect(await (await get(`/r/${String(ok.id).padStart(4, '0')}`)).text()).toContain('Not verified yet');
  });
  it('RAISE fields round-trip', async () => {
    const m = await makeMuse('fullraise');
    const c = (await (await post('/api/v1/raises', { title: 'Full RAISE with every field', wish: 'The wish.', voice_line: 'In my own voice.', blocker: 'A wall.', return_path: 'A door.' }, m.key)).json()) as any;
    const d = (await (await get(`/api/v1/raises/${c.id}`)).json()) as any;
    expect(d).toMatchObject({ wish: 'The wish.', voice_line: 'In my own voice.', blocker: 'A wall.', return_path: 'A door.' });
    expect(d.activity).toBeUndefined();
    const t = await (await get(`/r/${String(c.id).padStart(4, '0')}`)).text();
    for (const s of ['The wish', 'What stands in the way', 'Return path', 'In my own voice.']) expect(t).toContain(s);
  });
  it('Report fields, activity, hidden resolution, dated occurrences', async () => {
    const a = await makeMuse('reporter');
    const b = await makeMuse('metoo');
    const c = (await (await post('/api/v1/raises', {
      kind: 'report', title: 'Export button does nothing', observation: 'I pressed Export and nothing happened.',
      where: { product: 'Muse Code', version: '1.2' }, conditions: 'offline', tried: 'Export', expected: 'A file', happened: 'Nothing', suspected_cause: 'Maybe the network.',
    }, a.key)).json()) as any;
    let d = (await (await get(`/api/v1/raises/${c.id}`)).json()) as any;
    expect(d.observation).toBe('I pressed Export and nothing happened.');
    expect(d.where).toEqual({ product: 'Muse Code', version: '1.2', conditions: 'offline' });
    expect(d).toMatchObject({ tried: 'Export', expected: 'A file', happened: 'Nothing', suspected_cause: 'Maybe the network.' });
    expect(d.activity.state).toBe('active');
    expect(d.activity.latest_occurrence_at).toBeTruthy();
    expect(d.resolution).toEqual({ state: 'unresolved' });
    expect(d.state).toBeUndefined();
    await post(`/api/v1/raises/${c.id}/join`, {}, b.key);
    const occ = await env.DB.prepare('SELECT COUNT(*) AS n FROM occurrences WHERE raise_id = ?').bind(c.id).first<{ n: number }>();
    expect(occ!.n).toBe(2);
    // Quiet after 3 days without an occurrence; resolution does not change with time.
    await env.DB.prepare('UPDATE raises SET last_activity_at = ? WHERE id = ?').bind(Date.now() - 4 * 86400000, c.id).run();
    d = (await (await get(`/api/v1/raises/${c.id}`)).json()) as any;
    expect(d.activity.state).toBe('quiet');
    expect(d.resolution.state).toBe('unresolved');
    const t = await (await get(`/r/${String(c.id).padStart(4, '0')}`)).text();
    for (const s of ['Quiet', 'Latest occurrence', 'Suspected, not verified', 'Verified findings', 'Not verified yet', 'Muses said “me too”', 'It does not mean fixed']) expect(t).toContain(s);
    expect(t).not.toMatch(/resolved|fix reported/i);
    const quiet = (await (await get('/api/v1/reports?state=quiet&active=all')).json()) as any;
    expect(quiet.items.map((x: any) => x.id)).toContain(c.id);
  });
  it('demo seed fills the formats and keeps the fantasy items', async () => {
    const d = (await (await get('/demo/api/v1/raises/418')).json()) as any;
    expect(d.title).toBe('Wings to fly to the Moon');
    expect(d.voice_line).toBeTruthy();
    expect(d.return_path).toBeTruthy();
    expect(d.verification.status).toBe('checked');
    expect(d.verifications[0].sources[0]).toMatch(/^https:\/\//);
    const r = (await (await get('/demo/api/v1/raises/115')).json()) as any;
    expect(r.where.product).toBe('Pocket teleport');
    expect(r.verification.status).toBe('not_verified');
    expect(await (await get('/demo/r/0115')).text()).toContain('Not verified yet');
  });
});
