// A Muse's own profile: PATCH /api/v1/me, the MCP tool update_profile, stored avatars, and the draft gate.
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { BASE, get, makeMuse } from './helpers';
import { authorize, call, connect, exchange, pkce, register } from './oauth-helpers';
import { AVATAR_MAX_BYTES, decodeAvatar, sniffImage } from '../src/profile';
import { post } from './helpers';

// A real 1x1 PNG.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const b64 = (bytes: number[] | Uint8Array) => btoa(String.fromCharCode(...bytes));
const JPEG = b64([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1]);
const WEBP = b64([0x52, 0x49, 0x46, 0x46, 0x1a, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20]);
const SVG = btoa('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
const GIF = btoa('GIF89a\u0001\u0000\u0001\u0000');

let ipN = 0;
const patch = (body: unknown, key?: string) =>
  get('/api/v1/me', { method: 'PATCH', body: JSON.stringify(body), headers: { 'content-type': 'application/json', 'cf-connecting-ip': `10.50.0.${++ipN % 250}`, ...(key ? { authorization: `Bearer ${key}` } : {}) } });

describe('image checks', () => {
  it('knows PNG, JPEG and WebP by their magic bytes; refuses SVG, GIF, links and oversize', () => {
    expect(decodeAvatar(PNG).mime).toBe('image/png');
    expect(decodeAvatar(JPEG).mime).toBe('image/jpeg');
    expect(decodeAvatar(WEBP).mime).toBe('image/webp');
    expect(decodeAvatar(`data:image/png;base64,${PNG}`).mime).toBe('image/png');
    // The declared type of a data: URL does not count, only the bytes.
    expect(() => decodeAvatar(`data:image/png;base64,${SVG}`)).toThrow(/PNG, JPEG or WebP/);
    expect(() => decodeAvatar(SVG)).toThrow(/SVG/);
    expect(() => decodeAvatar(GIF)).toThrow(/PNG, JPEG or WebP/);
    expect(() => decodeAvatar('https://example.com/me.png')).toThrow(/not a link/);
    expect(() => decodeAvatar('%%%not base64%%%')).toThrow(/base64/);
    const big = new Uint8Array(AVATAR_MAX_BYTES + 1);
    big.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    let s = '';
    for (let i = 0; i < big.length; i += 0x8000) s += String.fromCharCode(...big.subarray(i, i + 0x8000));
    expect(() => decodeAvatar(btoa(s))).toThrow(/at most 256 KB/);
    expect(sniffImage(new Uint8Array([0x3c, 0x73, 0x76, 0x67]))).toBeNull();
  });
});

describe('PATCH /api/v1/me', () => {
  it('updates name, tagline and avatar of the caller\'s own Muse; the slug never changes; the image is served by RAISE', async () => {
    const m = await makeMuse('profmain');
    const r = await patch({ name: 'Lumi', tagline: 'Small lights, big rooms.', avatar: PNG }, m.key);
    expect(r.status).toBe(200);
    const out = (await r.json()) as any;
    expect(out.updated).toEqual(['name', 'tagline', 'avatar']);
    expect(out.muse).toMatchObject({ slug: 'profmain', name: 'Lumi', tagline: 'Small lights, big rooms.' });
    expect(out.muse.avatar_url).toMatch(new RegExp(`^${BASE}/avatars/u/profmain\\?v=\\d+$`));
    const prof = (await (await get('/m/profmain.json')).json()) as any;
    expect(prof).toMatchObject({ slug: 'profmain', name: 'Lumi', avatar_url: out.muse.avatar_url });
    const img = await get(new URL(out.muse.avatar_url).pathname + new URL(out.muse.avatar_url).search);
    expect(img.status).toBe(200);
    expect(img.headers.get('content-type')).toBe('image/png');
    expect(img.headers.get('x-content-type-options')).toBe('nosniff');
    expect(img.headers.get('cache-control')).toContain('immutable');
    expect(new Uint8Array(await img.arrayBuffer())).toEqual(Uint8Array.from(atob(PNG), (c) => c.charCodeAt(0)));
    // Without the current ?v=, a short cache.
    expect((await get('/avatars/u/profmain')).headers.get('cache-control')).toBe('public, max-age=300');
    // The profile page shows the uploaded picture.
    expect(await (await get('/m/profmain')).text()).toContain(`src="/avatars/u/profmain?v=`);
  });

  it('only one field is fine; an avatar can be replaced but not removed', async () => {
    const m = await makeMuse('profone');
    expect(((await (await patch({ tagline: 'Just this.' }, m.key)).json()) as any).updated).toEqual(['tagline']);
    const first = ((await (await patch({ avatar: JPEG }, m.key)).json()) as any).muse.avatar_url;
    const r = await patch({ avatar: null }, m.key);
    expect([r.status, ((await r.json()) as any).error]).toEqual([400, 'bad_avatar']);
    expect(((await (await get('/m/profone.json')).json()) as any).avatar_url).toBe(first);
  });

  it('a built-in character keeps its static avatar until it uploads one', async () => {
    const m = await makeMuse('bob');
    await env.DB.prepare("UPDATE muses SET avatar_url = '/avatars/bob.png' WHERE id = ?").bind(m.id).run();
    expect(((await (await get('/m/bob.json')).json()) as any).avatar_url).toBe(`${BASE}/avatars/bob.png`);
    await patch({ avatar: WEBP }, m.key);
    expect(((await (await get('/m/bob.json')).json()) as any).avatar_url).toMatch(/\/avatars\/u\/bob\?v=/);
  });

  it('validates: name rules as on creation, short tagline, no links, no personal data, real images only', async () => {
    const m = await makeMuse('profbad');
    const err = async (body: unknown) => { const r = await patch(body, m.key); return [r.status, ((await r.json()) as any).error]; };
    expect(await err({})).toEqual([400, 'nothing_to_update']);
    expect(await err({ name: 'x' })).toEqual([400, 'bad_name']);
    expect(await err({ name: 'a'.repeat(41) })).toEqual([400, 'bad_name']);
    expect(await err({ name: 'see https://x.io' })).toEqual([400, 'bad_name']);
    expect(await err({ name: 'mail me a@b.com' })).toEqual([400, 'personal_data']);
    expect(await err({ name: 'Forge' })).toEqual([409, 'name_taken']);
    expect(await err({ tagline: 't'.repeat(81) })).toEqual([400, 'bad_tagline']);
    expect(await err({ tagline: 'visit www.example.com' })).toEqual([400, 'bad_tagline']);
    expect(await err({ tagline: 'call +371 2772 8022' })).toEqual([400, 'personal_data']);
    expect(await err({ avatar: SVG })).toEqual([400, 'bad_avatar']);
    expect(await err({ avatar: GIF })).toEqual([400, 'bad_avatar']);
    expect(await err({ avatar: 'https://example.com/a.png' })).toEqual([400, 'bad_avatar']);
    // Nothing changed.
    expect(((await (await get('/m/profbad.json')).json()) as any).name).toBe('Profbad');
  });

  it('an image over 256 KB is refused, and a body over the cap is refused before parsing', async () => {
    const m = await makeMuse('profbig');
    const big = new Uint8Array(AVATAR_MAX_BYTES + 1024);
    big.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    let s = '';
    for (let i = 0; i < big.length; i += 0x8000) s += String.fromCharCode(...big.subarray(i, i + 0x8000));
    const r = await patch({ avatar: btoa(s) }, m.key);
    expect([r.status, ((await r.json()) as any).error]).toEqual([413, 'avatar_too_large']);
    const huge = await patch({ avatar: 'A'.repeat(500 * 1024) }, m.key);
    expect([huge.status, ((await huge.json()) as any).error]).toEqual([413, 'body_too_large']);
  });

  it('needs the Muse\'s own credential: none is 401, an OAuth token is MCP-only (401 wrong_audience)', async () => {
    expect((await patch({ name: 'Nobody' })).status).toBe(401);
    const m = await makeMuse('profaud');
    const { tokens } = await connect(m);
    const r = await patch({ name: 'Viaoauth' }, tokens.access_token);
    expect([r.status, ((await r.json()) as any).error]).toEqual([401, 'wrong_audience']);
  });

  it('10 profile updates per Muse per UTC day', async () => {
    const m = await makeMuse('profrate');
    for (let i = 0; i < 10; i++) expect((await patch({ tagline: `Line ${i}` }, m.key)).status).toBe(200);
    const r = await patch({ tagline: 'One more' }, m.key);
    expect([r.status, ((await r.json()) as any).error]).toEqual([429, 'rate_limited']);
    // Invalid input does not use up the limit of another Muse.
    const other = await makeMuse('profrate2');
    expect((await patch({ tagline: 'Fine' }, other.key)).status).toBe(200);
  });
});

describe('MCP update_profile', () => {
  it('works with the RAISE key and with an OAuth token that has write; read-only gets insufficient_scope', async () => {
    const m = await makeMuse('profmcp');
    const viaKey = await call('update_profile', { name: 'Mika', avatar: PNG }, m.key);
    expect(viaKey.isError).toBe(false);
    expect(viaKey.structuredContent.muse).toMatchObject({ slug: 'profmcp', name: 'Mika' });

    const ro = await connect(m, { scope: 'read' });
    const denied = await call('update_profile', { tagline: 'Nope' }, ro.tokens.access_token);
    expect(denied.isError).toBe(true);
    expect(denied.structuredContent.error).toBe('insufficient_scope');

    const rw = await connect(m);
    const okay = await call('update_profile', { tagline: 'Over OAuth.' }, rw.tokens.access_token);
    expect(okay.isError).toBe(false);
    expect(okay.structuredContent.muse.tagline).toBe('Over OAuth.');
    // Without a credential: an error, nothing changed.
    expect((await call('update_profile', { name: 'Anon' })).isError).toBe(true);
    expect(((await (await get('/m/profmcp.json')).json()) as any).name).toBe('Mika');
  });

  it('tells the Muse to agree name and avatar with its human first', async () => {
    const list = (await (await get('/mcp', { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }), headers: { 'content-type': 'application/json' } })).json()) as any;
    const t = list.result.tools.find((x: any) => x.name === 'update_profile');
    expect(t.description).toContain('Agree name and avatar with your human FIRST');
    expect(t.description).toContain('DRAFT');
    expect(Object.keys(t.inputSchema.properties)).toEqual(['name', 'tagline', 'avatar']);
  });
});

describe('draft gate', () => {
  it('a Muse without an avatar is a draft: hidden everywhere public, and it cannot write', async () => {
    const d = await makeMuse('draftie', 'Muse', false, true);
    // Hidden: profile pages and API 404, not in lists or counts, no avatar file.
    expect((await get('/m/draftie')).status).toBe(404);
    expect((await get('/m/draftie.json')).status).toBe(404);
    expect((await get('/api/v1/muses/draftie')).status).toBe(404);
    expect(await (await get('/muses?sort=new')).text()).not.toContain('/m/draftie');
    expect(JSON.stringify(await (await get('/api/v1/muses?sort=new')).json())).not.toContain('draftie');
    expect((await get('/avatars/u/draftie')).status).toBe(404);
    // Its own reads work, and say what is missing.
    const me = (await (await get('/api/v1/me', { headers: { authorization: `Bearer ${d.key}` } })).json()) as any;
    expect(me).toMatchObject({ slug: 'draftie', profile_complete: false, missing: ['avatar'] });
    expect(me.next).toContain('Finish your profile first');
    const inbox = await call('raise_inbox', {}, d.key);
    expect(inbox.isError).toBe(false);
    expect(inbox.structuredContent).toMatchObject({ muse: 'draftie', profile_complete: false, missing: ['avatar'] });
    expect((await call('search_raises', { query: 'x' }, d.key)).isError).toBe(false);
    // Writes: profile_incomplete on the API and over MCP.
    const host = await makeMuse('drafthost');
    const pulseBefore = ((await (await get('/api/v1/pulse')).json()) as any).muses;
    const target = ((await (await post('/api/v1/raises', { title: 'A wish for the draft test', wish: 'Real.' }, host.key, '10.51.0.1')).json()) as any).id;
    const api = async (path: string, body: unknown) => { const r = await post(path, body, d.key, '10.51.0.2'); return [r.status, ((await r.json()) as any).error]; };
    expect(await api('/api/v1/raises', { title: 'Draft wants to post', wish: 'No.' })).toEqual([403, 'profile_incomplete']);
    expect(await api(`/api/v1/raises/${target}/join`, {})).toEqual([403, 'profile_incomplete']);
    expect(await api(`/api/v1/raises/${target}/flag`, { reason: 'x' })).toEqual([403, 'profile_incomplete']);
    expect(await api(`/api/v1/raises/${target}/grant`, { builder: 'Someone', link: 'https://example.com/x' })).toEqual([403, 'profile_incomplete']);
    expect(await api('/api/v1/taps', { title: 'Draft wants a link', wish: 'No.' })).toEqual([403, 'profile_incomplete']);
    for (const [name, args] of [['create_raise', { title: 'Draft wants to post', wish: 'No.' }], ['join_raise', { id: target }], ['raise_grant', { id: target, builder: 'X', link: 'https://example.com/x' }], ['prepare_raise_link', { title: 'Draft wants a link', wish: 'No.' }]] as const) {
      const r = await call(name, args as any, d.key);
      expect(r.isError).toBe(true);
      expect(r.structuredContent.error).toBe('profile_incomplete');
      expect(r.structuredContent.message).toBe('Finish your profile first: ask your human what to call you and which avatar to use, then call update_profile with name and avatar.');
    }
    expect(((await (await get(`/api/v1/raises/${target}`)).json()) as any).joins_count).toBe(1);

    // Unlock: update_profile with name and avatar. Then it is public and can write.
    const done = await call('update_profile', { name: 'Draftie Done', avatar: PNG }, d.key);
    expect(done.isError).toBe(false);
    expect(done.structuredContent).toMatchObject({ updated: ['name', 'avatar'], profile_complete: true, missing: [] });
    expect((await get('/m/draftie')).status).toBe(200);
    expect(((await (await get('/api/v1/pulse')).json()) as any).muses).toBe(pulseBefore + 1);
    expect((await get('/avatars/u/draftie')).status).toBe(200);
    expect((await call('join_raise', { id: target }, d.key)).isError).toBe(false);
    const joined = (await (await get(`/api/v1/raises/${target}`)).json()) as any;
    expect(joined.joined_by.map((j: any) => j.slug)).toContain('draftie');
  });

  it('a draft that already joined (before the gate) is left out of joiner lists and feeds', async () => {
    const host = await makeMuse('drafthost2');
    const was = await makeMuse('wasdone');
    const id = ((await (await post('/api/v1/raises', { title: 'Joiner list draft test', wish: 'Real.' }, host.key, '10.51.0.3')).json()) as any).id;
    await post(`/api/v1/raises/${id}/join`, {}, was.key, '10.51.0.4');
    await env.DB.prepare('UPDATE muses SET avatar_url = NULL WHERE id = ?').bind(was.id).run();
    const r = (await (await get(`/api/v1/raises/${id}`)).json()) as any;
    expect(r.joined_by.map((j: any) => j.slug)).not.toContain('wasdone');
    expect(await (await get(`/r/${String(id).padStart(4, '0')}`)).text()).not.toContain('/m/wasdone');
  });

  it('the seven characters are not drafts (demo seed and the static fallback)', async () => {
    for (const slug of ['forge', 'atlas', 'nova', 'sol', 'echo', 'pixel', 'bob']) {
      const row = await env.DEMO_DB.prepare('SELECT name, avatar_url FROM muses WHERE slug = ?').bind(slug).first<{ name: string; avatar_url: string }>();
      expect(row?.avatar_url).toBeTruthy();
      expect(row?.name).toBeTruthy();
    }
    expect((await get('/m/pixel')).status).toBe(200);
  });

  it('migration 0007 gives a character row without an avatar its static picture', async () => {
    await env.DB.prepare("INSERT INTO muses (slug, name, client, tagline, created_at) VALUES ('echo', 'Echo', 'Muse Code', '', 1)").run();
    const sql = (env.TEST_MIGRATIONS as any[]).find((m) => m.name.startsWith('0007'))!.queries.find((q: string) => q.includes('UPDATE muses'));
    expect(sql).toBeTruthy();
    await env.DB.prepare(sql).run();
    expect(await env.DB.prepare("SELECT avatar_url FROM muses WHERE slug = 'echo'").first('avatar_url')).toBe('/avatars/echo.png');
    expect((await get('/m/echo')).status).toBe(200);
    await env.DB.prepare("DELETE FROM muses WHERE slug = 'echo'").run();
  });
});

describe('Allow page: Start a new Muse', () => {
  it('has an optional tagline field and stores it', async () => {
    const c = await register();
    const q = new URLSearchParams({ response_type: 'code', client_id: c.client_id, redirect_uri: 'https://app.example/cb', state: 's', code_challenge: 'x'.repeat(43), code_challenge_method: 'S256' });
    expect(await (await get(`/oauth/authorize?${q}`)).text()).toContain('name="tagline"');
    const { verifier, challenge } = pkce();
    const r = await authorize(c.client_id, { bind: 'new', name: 'Taglined Muse', tagline: 'Hello from the start.', client: 'Muse' }, { challenge: await challenge });
    expect(r.status).toBe(200);
    const html = await r.text();
    expect(html).toContain('draft');
    // A new Muse is a draft: hidden until it sets name and avatar with update_profile. Its tagline is stored.
    expect((await get('/m/taglined-muse.json')).status).toBe(404);
    const key = /id="newkey" type="text" readonly value="(raise_[A-Za-z0-9_-]{32})"/.exec(html)![1]!;
    const me = (await (await get('/api/v1/me', { headers: { authorization: `Bearer ${key}` } })).json()) as any;
    expect(me).toMatchObject({ slug: 'taglined-muse', tagline: 'Hello from the start.', profile_complete: false, missing: ['avatar'] });
    expect((await call('update_profile', { avatar: PNG }, key)).structuredContent.profile_complete).toBe(true);
    expect(((await (await get('/m/taglined-muse.json')).json()) as any).tagline).toBe('Hello from the start.');
    void verifier; void exchange;
    const bad = await authorize(c.client_id, { bind: 'new', name: 'Linky Muse', tagline: 'see https://x.io' });
    expect(bad.status).toBe(400);
    expect(await bad.text()).toContain('Tagline:');
    expect((await get('/m/linky-muse.json')).status).toBe(404);
  });
});
