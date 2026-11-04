// add_verification (MCP) and POST /api/v1/raises/{id}/verifications: verifier role, signature from identity, one entry per Muse.
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { dapi, get, makeMuse, post } from './helpers';
import { call, connect } from './oauth-helpers';
import { LIMITS } from '../src/actions';

let ipN = 0;
const ip = () => `10.60.${Math.floor(++ipN / 200)}.${ipN % 200}`;
const makeVerifier = async (slug: string) => {
  const m = await makeMuse(slug);
  await env.DB.prepare('UPDATE muses SET verifier = 1 WHERE id = ?').bind(m.id).run();
  return m;
};
const newRaise = async (title: string) => {
  const a = await makeMuse();
  return ((await (await post('/api/v1/raises', { title, wish: 'I want this.' }, a.key, ip())).json()) as any).id as number;
};
const verify = async (id: number, body: Record<string, unknown>, key?: string) => {
  const r = await post(`/api/v1/raises/${id}/verifications`, body, key, ip());
  return { status: r.status, body: (await r.json()) as any };
};
const OK = { sources: ['https://example.com/changelog'], finding: 'No such feature in the current release notes.' };

describe('add_verification', () => {
  it('needs the verifier role (403 not_verifier); there is no way for a Muse to give it', async () => {
    const id = await newRaise('A wish someone checks later');
    const m = await makeMuse('noverifier');
    const r = await verify(id, OK, m.key);
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('not_verifier');
    expect(r.body.message).toMatch(/human admin/);
    const t = await call('add_verification', { id, ...OK }, m.key);
    expect(t.isError).toBe(true);
    expect(t.structuredContent.error).toBe('not_verifier');
    // Neither the profile update nor any write body can set the role.
    expect((await get('/api/v1/me', { method: 'PATCH', body: JSON.stringify({ verifier: 1, tagline: 'Wants to verify' }), headers: { 'content-type': 'application/json', authorization: `Bearer ${m.key}`, 'cf-connecting-ip': ip() } })).status).toBe(200);
    expect((await env.DB.prepare('SELECT verifier FROM muses WHERE id = ?').bind(m.id).first<{ verifier: number }>())!.verifier).toBe(0);
  });

  it('respects the profile gate: a draft verifier gets profile_incomplete', async () => {
    const id = await newRaise('A wish for the draft verifier');
    const d = await makeMuse('draftverifier', 'Muse Code', false, true);
    await env.DB.prepare('UPDATE muses SET verifier = 1 WHERE id = ?').bind(d.id).run();
    const r = await verify(id, OK, d.key);
    expect([r.status, r.body.error]).toEqual([403, 'profile_incomplete']);
    expect((await call('add_verification', { id, ...OK }, d.key)).structuredContent.error).toBe('profile_incomplete');
  });

  it('sources: 1 to 5 https links only, each at most 500 characters', async () => {
    const id = await newRaise('A wish for source checks');
    const v = await makeVerifier('sourcechecker');
    for (const sources of [undefined, [], 'https://example.com', ['http://example.com'], ['javascript:alert(1)'], ['ftp://example.com/x'], ['data:text/html,hi'], ['https://'], ['https://user:pw@example.com'], ['https://example.com/a b'], [`https://example.com/${'a'.repeat(490)}`], Array.from({ length: 6 }, (_, i) => `https://example.com/${i}`), [42]]) {
      const r = await verify(id, { ...OK, sources }, v.key);
      expect([r.status, r.body.error]).toEqual([400, 'bad_sources']);
    }
    // Finding and unknowns are plain text: no links, and length caps.
    for (const [k, val, code] of [['finding', '', 'bad_finding'], ['finding', 'See https://example.com', 'bad_finding'], ['finding', 'See www.example.com', 'bad_finding'], ['finding', 'x'.repeat(601), 'bad_finding'], ['unknowns', 'x'.repeat(301), 'bad_unknowns'], ['unknowns', 'maybe ftp://x', 'bad_unknowns']] as const) {
      const r = await verify(id, { ...OK, [k]: val }, v.key);
      expect([r.status, r.body.error]).toEqual([400, code]);
    }
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM verifications WHERE raise_id = ?').bind(id).first<{ n: number }>())!.n).toBe(0);
    const five = Array.from({ length: 5 }, (_, i) => `https://example.com/${i}`);
    const ok = await verify(id, { ...OK, sources: five, finding: 'x'.repeat(600), unknowns: 'y'.repeat(300) }, v.key);
    expect(ok.status).toBe(201);
  });

  it('signs with the Muse identity from the credential, never from the arguments; page shows avatar and profile link', async () => {
    const id = await newRaise('A wish with a signed check');
    const v = await makeVerifier('signer');
    const r = await verify(id, { ...OK, checked_by: 'Forge', muse: 'forge', muse_id: 1, unknowns: 'Whether a beta has it.' }, v.key);
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ id, edited: false, checks_count: 1, checked_by: { slug: 'signer', name: 'Signer' } });
    const row = await env.DB.prepare('SELECT muse_id, checked_by FROM verifications WHERE raise_id = ?').bind(id).first<{ muse_id: number; checked_by: string }>();
    expect(row).toEqual({ muse_id: v.id, checked_by: 'Signer' });
    const d = (await (await get(`/api/v1/raises/${id}`)).json()) as any;
    expect(d.verification).toEqual({ status: 'checked', checks_count: 1 });
    expect(d.verifications[0]).toMatchObject({ checked_by: 'Signer', muse: { slug: 'signer', name: 'Signer' }, sources: OK.sources, finding: OK.finding, unknowns: 'Whether a beta has it.', edited_at: null });
    const page = await (await get(`/r/${String(id).padStart(4, '0')}`)).text();
    expect(page).toContain('Checked by <b><a href="/m/signer">Signer</a></b>');
    expect(page).toContain('src="/avatars/bob.png"');
    expect(page).toContain('<a href="https://example.com/changelog" rel="nofollow noopener">https://example.com/changelog</a>');
    expect(page).not.toContain('Not verified yet');
  });

  it('one entry per Muse per RAISE: a second call edits it; another verifier adds its own', async () => {
    const id = await newRaise('A wish checked twice');
    const v = await makeVerifier('editor');
    const w = await makeVerifier('secondeditor');
    const first = await verify(id, OK, v.key);
    expect(first.status).toBe(201);
    const again = await verify(id, { sources: ['https://example.com/v2'], finding: 'Now in beta behind a flag.' }, v.key);
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ edited: true, checks_count: 1, verification_id: first.body.verification_id });
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM verifications WHERE raise_id = ?').bind(id).first<{ n: number }>())!.n).toBe(1);
    const other = await call('add_verification', { id, ...OK }, w.key);
    expect(other.isError).toBe(false);
    expect(other.structuredContent).toMatchObject({ edited: false, checks_count: 2, checked_by: { slug: 'secondeditor' } });
    const d = (await (await get(`/api/v1/raises/${id}`)).json()) as any;
    expect(d.verifications.map((x: any) => x.muse.slug).sort()).toEqual(['editor', 'secondeditor']);
    expect(d.verifications.find((x: any) => x.muse.slug === 'editor')).toMatchObject({ finding: 'Now in beta behind a flag.', sources: ['https://example.com/v2'] });
    expect(d.verifications.find((x: any) => x.muse.slug === 'editor').edited_at).not.toBeNull();
  });

  it('a Muse cannot verify its own RAISE; unknown RAISE is 404', async () => {
    const v = await makeVerifier('ownpost');
    const id = ((await (await post('/api/v1/raises', { title: 'My own wish to verify', wish: 'Mine.' }, v.key, ip())).json()) as any).id;
    expect((await verify(id, OK, v.key)).body.error).toBe('own_raise');
    expect((await verify(id, OK, v.key)).status).toBe(403);
    expect((await verify(999999, OK, v.key)).status).toBe(404);
  });

  it('never changes status: not granted, counts and activity untouched; Reports keep their resolution', async () => {
    const id = await newRaise('A wish whose status stays');
    const before = await env.DB.prepare('SELECT granted_at, granted_by, joins_count, last_activity_at, resolution_state FROM raises WHERE id = ?').bind(id).first();
    const v = await makeVerifier('statuskeeper');
    expect((await verify(id, { ...OK, granted: true, status: 'granted' }, v.key)).status).toBe(201);
    expect(await env.DB.prepare('SELECT granted_at, granted_by, joins_count, last_activity_at, resolution_state FROM raises WHERE id = ?').bind(id).first()).toEqual(before);
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM grants WHERE raise_id = ?').bind(id).first<{ n: number }>())!.n).toBe(0);
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM notifications WHERE raise_id = ?').bind(id).first<{ n: number }>())!.n).toBe(0);
    const d = (await (await get(`/api/v1/raises/${id}`)).json()) as any;
    expect(d.granted).toBeNull();
  });

  it('works over OAuth (write scope) and refuses a read-only connection', async () => {
    const id = await newRaise('A wish checked over OAuth');
    const v = await makeVerifier('oauthverifier');
    const ro = await connect(v, { scope: 'read' });
    expect((await call('add_verification', { id, ...OK }, ro.tokens.access_token)).structuredContent.error).toBe('insufficient_scope');
    const rw = await connect(v, { scope: 'read write' });
    const r = await call('add_verification', { id, ...OK }, rw.tokens.access_token);
    expect(r.isError).toBe(false);
    expect(r.structuredContent.checked_by.slug).toBe('oauthverifier');
  });

  it(`daily cap per Muse (${LIMITS.musePerDay.verify}/day), edits included`, async () => {
    const id = await newRaise('A wish for the verify cap');
    const v = await makeVerifier('capper');
    for (let i = 0; i < LIMITS.musePerDay.verify; i++) expect((await verify(id, { ...OK, finding: `Check number ${i}` }, v.key)).status).toBe(i === 0 ? 201 : 200);
    const r = await verify(id, OK, v.key);
    expect([r.status, r.body.error]).toEqual([429, 'rate_limited']);
  });

  it('demo: seeded verifiers (not Forge) can verify on the demo DB', async () => {
    const roles = await env.DEMO_DB.prepare('SELECT slug FROM muses WHERE verifier = 1 ORDER BY slug').all<{ slug: string }>();
    expect(roles.results.map((x) => x.slug)).toEqual(['atlas', 'bob', 'echo', 'nova', 'pixel', 'sol']);
    const own = await env.DEMO_DB.prepare("SELECT r.id FROM raises r JOIN muses m ON m.id = r.muse_id WHERE m.slug != 'nova' AND r.hidden = 0 LIMIT 1").first<{ id: number }>();
    const call2 = async (args: Record<string, unknown>) => ((await (await dapi('/mcp', { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'add_verification', arguments: args } }), headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip() } })).json()) as any).result;
    const ok = await call2({ id: own!.id, ...OK, as_muse: 'nova' });
    expect(ok.isError).toBe(false);
    expect(ok.structuredContent.checked_by.slug).toBe('nova');
    expect((await call2({ id: own!.id, ...OK, as_muse: 'forge' })).structuredContent.error).toBe('not_verifier');
  });
});
