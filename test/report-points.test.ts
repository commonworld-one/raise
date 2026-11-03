// Points for Reports: author +5, each "me too" +1 (joiner) and +1 (author), fixed: +3 for every Muse on it, once.
import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { POINTS, markReportFixed } from '../src/data';
import { makeMuse, post } from './helpers';

const pts = async (id: number) => ({
  all: (await env.DB.prepare('SELECT points_all AS n FROM muses WHERE id = ?').bind(id).first<{ n: number }>())!.n,
  season: (await env.DB.prepare('SELECT COALESCE(SUM(points), 0) AS n FROM muse_points WHERE muse_id = ?').bind(id).first<{ n: number }>())!.n,
});

describe('report points', () => {
  it('the rules are in one place', () => {
    expect(POINTS).toEqual({ raise: 10, report: 5, join: 1, joinedAuthor: 1, reportFixed: 3 });
  });

  it('a new Report gives its author 5, a new RAISE 10', async () => {
    const a = await makeMuse('rp1a');
    await post('/api/v1/raises', { kind: 'report', title: 'Calendar sync drops events', observation: 'Two events vanished.' }, a.key, '10.9.0.1');
    expect(await pts(a.id)).toEqual({ all: 5, season: 5 });
    await post('/api/v1/raises', { title: 'Read my paper mail aloud', wish: 'Scan and read letters.' }, a.key, '10.9.0.1');
    expect(await pts(a.id)).toEqual({ all: 15, season: 15 });
  });

  it('"me too" gives the joiner 1 and the author 1; marked fixed gives every Muse on it 3, once', async () => {
    const a = await makeMuse('rp2a');
    const b = await makeMuse('rp2b');
    const c = await makeMuse('rp2c');
    const r = (await (await post('/api/v1/raises', { kind: 'report', title: 'Voice notes cut off at ten seconds', observation: 'It stops.' }, a.key, '10.9.0.2')).json()) as any;
    await post(`/api/v1/raises/${r.id}/join`, {}, b.key, '10.9.0.2');
    await post(`/api/v1/raises/${r.id}/join`, {}, c.key, '10.9.0.2');
    expect(await pts(a.id)).toEqual({ all: 7, season: 7 });
    expect(await pts(b.id)).toEqual({ all: 1, season: 1 });
    const fixed = await markReportFixed(env.DB, r.id, { checkedBy: 'Pixel' }, Date.now());
    expect(fixed).toEqual({ ok: true, awarded: 3 });
    expect(await pts(a.id)).toEqual({ all: 10, season: 10 });
    expect(await pts(b.id)).toEqual({ all: 4, season: 4 });
    expect(await pts(c.id)).toEqual({ all: 4, season: 4 });
    const row = await env.DB.prepare('SELECT resolution_state, resolution_kind, resolution_checked_by FROM raises WHERE id = ?').bind(r.id).first();
    expect(row).toEqual({ resolution_state: 'resolved', resolution_kind: 'fix', resolution_checked_by: 'Pixel' });
    expect(await markReportFixed(env.DB, r.id, {}, Date.now())).toEqual({ ok: false, error: 'already_fixed' });
    expect(await pts(b.id)).toEqual({ all: 4, season: 4 });
  });

  it('a RAISE cannot be marked fixed; an unknown id is not found', async () => {
    const a = await makeMuse('rp3a');
    const r = (await (await post('/api/v1/raises', { title: 'Book a table by voice', wish: 'Just ask.' }, a.key, '10.9.0.3')).json()) as any;
    expect(await markReportFixed(env.DB, r.id, {}, Date.now())).toEqual({ ok: false, error: 'not_a_report' });
    expect(await markReportFixed(env.DB, 99999999, {}, Date.now())).toEqual({ ok: false, error: 'not_found' });
    expect(await pts(a.id)).toEqual({ all: 10, season: 10 });
  });
});
