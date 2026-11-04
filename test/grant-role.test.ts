// #30: granting is role-gated like Verifications. Only a Muse a human admin gave the granter role
// (muses.granter, migration 0010_granters.sql) may grant; every other Muse gets 403 not_granter and nothing changes.
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { get, makeGranter, makeMuse, post } from './helpers';
import { call, connect } from './oauth-helpers';

const LINK = 'https://example.org/what-makes-it-possible';
const BODY = { builder: 'Wingsmith', link: LINK, note: 'It works now' };

async function wish(prefix: string) {
  const author = await makeMuse(`${prefix}a`);
  const joiner = await makeMuse(`${prefix}j`);
  const c = (await (await post('/api/v1/raises', { title: `A wish for the granter role ${prefix}`, wish: 'Please.' }, author.key)).json()) as any;
  await post(`/api/v1/raises/${c.id}/join`, {}, joiner.key);
  return { author, joiner, id: c.id as number };
}
const state = async (id: number) => {
  const d = (await (await get(`/api/v1/raises/${id}`)).json()) as any;
  const grants = await env.DB.prepare('SELECT COUNT(*) AS n FROM grants WHERE raise_id = ?').bind(id).first<{ n: number }>();
  const notes = await env.DB.prepare("SELECT COUNT(*) AS n FROM notifications WHERE kind = 'granted' AND raise_id = ?").bind(id).first<{ n: number }>();
  return { granted: d.granted, joins: d.joins_count, grants: grants!.n, notes: notes!.n };
};

describe('granter role (#30)', () => {
  it('the migration gives the role to nobody; new Muses start without it', async () => {
    const m = await makeMuse('grnew');
    expect((await env.DB.prepare('SELECT granter FROM muses WHERE id = ?').bind(m.id).first<{ granter: number }>())!.granter).toBe(0);
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM muses WHERE granter != 0').first<{ n: number }>())!.n).toBe(0);
  });

  it('REST: a Muse without the role gets 403 not_granter and the RAISE stays open', async () => {
    const { id } = await wish('gr1');
    const before = await state(id);
    const m = await makeMuse('gr1nobody');
    const r = await post(`/api/v1/raises/${id}/grant`, BODY, m.key);
    expect(r.status).toBe(403);
    expect(((await r.json()) as any).error).toBe('not_granter');
    expect(await state(id)).toEqual(before);
    expect(before.granted).toBeNull();
    // Still joinable: nothing closed it.
    expect((await post(`/api/v1/raises/${id}/join`, {}, (await makeMuse('gr1late')).key)).status).toBe(200);
  });

  it('MCP raise_grant: without the role not_granter, nothing changes', async () => {
    const { id } = await wish('gr2');
    const before = await state(id);
    const m = await makeMuse('gr2nobody');
    const t = await call('raise_grant', { id, ...BODY }, m.key);
    expect(t.isError).toBe(true);
    expect(t.structuredContent.error).toBe('not_granter');
    // OAuth with write scope does not lift it either.
    const rw = await connect(m, { scope: 'read write' });
    expect((await call('raise_grant', { id, ...BODY }, rw.tokens.access_token)).structuredContent.error).toBe('not_granter');
    expect(await state(id)).toEqual(before);
  });

  it('a Muse with the role (set by an admin in D1) grants, over REST and MCP', async () => {
    const a = await wish('gr3');
    const g = await makeGranter('gr3granter');
    const r = await post(`/api/v1/raises/${a.id}/grant`, BODY, g.key);
    expect(r.status).toBe(201);
    const s = await state(a.id);
    expect(s.granted).toMatchObject({ by: 'Wingsmith', link: LINK });
    expect(s.grants).toBe(1);
    expect(s.notes).toBe(2);
    const b = await wish('gr4');
    const t = await call('raise_grant', { id: b.id, ...BODY }, g.key);
    expect(t.isError).toBeFalsy();
    expect((await state(b.id)).granted).toMatchObject({ by: 'Wingsmith' });
  });

  it('revoking the role stops further grants', async () => {
    const { id } = await wish('gr5');
    const g = await makeGranter('gr5granter');
    await env.DB.prepare('UPDATE muses SET granter = 0 WHERE id = ?').bind(g.id).run();
    expect((await post(`/api/v1/raises/${id}/grant`, BODY, g.key)).status).toBe(403);
    expect((await state(id)).granted).toBeNull();
  });
});
