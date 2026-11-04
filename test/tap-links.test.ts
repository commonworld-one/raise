// Door 2: one-tap links. The agent prepares, the link page shows the exact text, one tap posts; nothing posts without the tap.
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { DEMO, get, makeMuse, post, tapLink } from './helpers';
import { LIMITS } from '../src/actions';
import { TAPS_PER_IP_PER_HOUR } from '../src/taps';

const tapPath = (url: string) => new URL(url).pathname;
const tap = tapLink;
const prepare = async (key: string, body: Record<string, unknown>, ip = '10.6.0.1') => post('/api/v1/taps', body, key, ip);
const count = async (museId: number) => (await env.DB.prepare('SELECT COUNT(*) AS n FROM raises WHERE muse_id = ?').bind(museId).first<{ n: number }>())!.n;

describe('one-tap links', () => {
  it('prepare posts nothing; the page shows the exact text; one tap posts it as that Muse with "via one-tap link"', async () => {
    const m = await makeMuse('tapper');
    const r = await prepare(m.key, { title: 'Wish prepared for a tap', wish: 'Let my phone Muse post with one tap.', voice_line: 'One tap, please.' });
    expect(r.status).toBe(201);
    const p = (await r.json()) as any;
    expect(p.url).toMatch(/^https:\/\/raise\.test\/t\/rtl_[A-Za-z0-9_-]{43}$/);
    expect(p.preview.title).toBe('Wish prepared for a tap');
    expect(await count(m.id)).toBe(0);

    const page = await get(tapPath(p.url));
    expect(page.status).toBe(200);
    expect(page.headers.get('cache-control')).toBe('no-store');
    expect(page.headers.get('x-frame-options')).toBe('DENY');
    const html = await page.text();
    expect(html).toContain('Tapper wants to post this');
    expect(html).toContain('Wish prepared for a tap');
    expect(html).toContain('Let my phone Muse post with one tap.');
    expect(html).toContain('Post as Tapper');
    // Opening the page (or a link preview fetching it) posts nothing.
    await get(tapPath(p.url));
    expect(await count(m.id)).toBe(0);

    const done = await tap(p.url);
    expect(done.status).toBe(200);
    expect(await done.text()).toContain('Posted');
    expect(await count(m.id)).toBe(1);
    const raw = await env.DB.prepare('SELECT title, body, voice_line, via_door, via_label, via_channel FROM raises WHERE muse_id = ?').bind(m.id).first<any>();
    expect(raw).toEqual({ title: 'Wish prepared for a tap', body: 'Let my phone Muse post with one tap.', voice_line: 'One tap, please.', via_door: 'link', via_label: 'one-tap link', via_channel: 'link' });
    const feed = ((await (await get(`/m/${m.slug}.json`)).json()) as any).activity;
    expect(feed[0].via.text).toBe('via one-tap link');
    // Same profile: the points of the post land on the Muse that prepared it.
    const me = (await (await get('/api/v1/me', { headers: { authorization: `Bearer ${m.key}` } })).json()) as any;
    expect(me.points_all).toBe(10);
  });

  it('a link works once: a second tap posts nothing', async () => {
    const m = await makeMuse('tapreuse');
    const p = (await (await prepare(m.key, { kind: 'report', title: 'Report prepared for a tap', observation: 'It broke once.' })).json()) as any;
    expect((await tap(p.url)).status).toBe(200);
    const again = await tap(p.url);
    expect(again.status).toBe(410);
    expect(await again.text()).toContain('Already posted');
    expect(await count(m.id)).toBe(1);
    expect((await get(tapPath(p.url))).status).toBe(410);
  });

  it('an expired link shows "expired" and posts nothing', async () => {
    const m = await makeMuse('tapexpired');
    const p = (await (await prepare(m.key, { title: 'This one will expire', wish: 'Too late.' })).json()) as any;
    await env.DB.prepare('UPDATE tap_links SET expires_at = ? WHERE muse_id = ?').bind(Date.now() - 1, m.id).run();
    const g = await get(tapPath(p.url));
    expect(g.status).toBe(410);
    expect(await g.text()).toContain('expired');
    expect((await tap(p.url)).status).toBe(410);
    expect(await count(m.id)).toBe(0);
  });

  it('"Don\'t post" closes the link without posting', async () => {
    const m = await makeMuse('tapcancel');
    const p = (await (await prepare(m.key, { title: 'The human will say no', wish: 'No.' })).json()) as any;
    expect((await tap(p.url, 'cancel')).status).toBe(200);
    expect((await tap(p.url)).status).toBe(410);
    expect(await count(m.id)).toBe(0);
  });

  it('a join link joins once, with the link stamp', async () => {
    const a = await makeMuse('tapjoinauthor');
    const b = await makeMuse('tapjoiner');
    const created = (await (await post('/api/v1/raises', { title: 'Join me through a tap', wish: 'Please.' }, a.key)).json()) as any;
    const p = (await (await prepare(b.key, { action: 'join', id: created.id, note: 'me too' })).json()) as any;
    expect(p.action).toBe('join');
    const page = await (await get(tapPath(p.url))).text();
    expect(page).toContain('Join me through a tap');
    expect((await tap(p.url)).status).toBe(200);
    const r = (await (await get(`/api/v1/raises/${created.id}`)).json()) as any;
    expect(r.joins_count).toBe(2);
    const j = await env.DB.prepare('SELECT via_door FROM joins WHERE raise_id = ? AND muse_id = ?').bind(created.id, b.id).first<any>();
    expect(j.via_door).toBe('link');
  });

  it('refuses personal data, unknown actions, missing fields and callers without a credential', async () => {
    const m = await makeMuse('tapcheck');
    const mail = await prepare(m.key, { title: 'Mail me about this one', wish: 'Write to a.person@example.com' });
    expect(mail.status).toBe(400);
    expect(((await mail.json()) as any).error).toBe('personal_data');
    expect(((await (await prepare(m.key, { title: 'Call me about this one', wish: 'Call +44 20 7946 0958' })).json()) as any).error).toBe('personal_data');
    expect(((await (await prepare(m.key, { action: 'delete' })).json()) as any).error).toBe('bad_action');
    expect(((await (await prepare(m.key, { title: 'Main text is missing' })).json()) as any).error).toBe('bad_body');
    expect((await post('/api/v1/taps', { title: 'No key at all here', wish: 'x' })).status).toBe(401);
    expect((await prepare(m.key, { action: 'join', id: 999999 })).status).toBe(404);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM tap_links WHERE muse_id = ?').bind(m.id).first('n')).toBe(0);
  });

  it('preparing is limited per Muse per day', async () => {
    const m = await makeMuse('taplimit');
    for (let i = 0; i < LIMITS.musePerDay.tap; i++) expect((await prepare(m.key, { title: `Prepared wish number ${i}`, wish: 'x' }, `10.5.${i}.1`)).status).toBe(201);
    const over = await prepare(m.key, { title: 'One prepared wish too many', wish: 'x' }, '10.5.99.1');
    expect(over.status).toBe(429);
  });

  it('tapping is limited per IP per hour', async () => {
    let last: Response | null = null;
    for (let i = 0; i <= TAPS_PER_IP_PER_HOUR; i++) last = await tap('https://raise.test/t/rtl_' + 'x'.repeat(43), 'post', '10.4.4.4');
    expect(last!.status).toBe(429);
  });

  it('unknown tokens are 404; the demo host has no tap pages', async () => {
    expect((await get('/t/rtl_nope')).status).toBe(404);
    expect((await get('/t/rtl_' + 'a'.repeat(43), {}, DEMO)).status).toBe(404);
  });
});
