// Codex review of PR #5: a join must not land on a RAISE that was granted after the join read it.
import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { makeMuse, post } from './helpers';
import { grantRaise, joinRaise } from '../src/data';

const LINK = 'https://example.org/what-makes-it-possible';

/** A D1 wrapper that runs `between` right after joinRaise's first read resolves (the race window). */
function interleave(db: D1Database, between: () => Promise<unknown>): D1Database {
  let fired = false;
  return new Proxy(db, {
    get(target, prop) {
      if (prop !== 'prepare') { const v = (target as any)[prop]; return typeof v === 'function' ? v.bind(target) : v; }
      return (sql: string) => {
        const stmt = target.prepare(sql);
        if (fired || !sql.startsWith('SELECT id, kind, muse_id, granted_at FROM raises')) return stmt;
        return {
          bind: (...args: unknown[]) => {
            const b = stmt.bind(...args);
            return { first: async <T>() => { const row = await b.first<T>(); fired = true; await between(); return row; } };
          },
        };
      };
    },
  }) as D1Database;
}

const state = async (raiseId: number, museId: number, authorId: number) => ({
  joins: (await env.DB.prepare('SELECT COUNT(*) AS n FROM joins WHERE raise_id = ? AND muse_id = ?').bind(raiseId, museId).first<{ n: number }>())!.n,
  raise: await env.DB.prepare('SELECT joins_count FROM raises WHERE id = ?').bind(raiseId).first<{ joins_count: number }>(),
  daily: (await env.DB.prepare('SELECT COALESCE(SUM(joins), 0) AS n FROM raise_daily WHERE raise_id = ?').bind(raiseId).first<{ n: number }>())!.n,
  joiner: await env.DB.prepare('SELECT joins_count, points_all FROM muses WHERE id = ?').bind(museId).first<{ joins_count: number; points_all: number }>(),
  joinerSeason: (await env.DB.prepare('SELECT COALESCE(SUM(points), 0) AS n FROM muse_points WHERE muse_id = ?').bind(museId).first<{ n: number }>())!.n,
  author: await env.DB.prepare('SELECT points_all FROM muses WHERE id = ?').bind(authorId).first<{ points_all: number }>(),
  authorSeason: (await env.DB.prepare('SELECT COALESCE(SUM(points), 0) AS n FROM muse_points WHERE muse_id = ?').bind(authorId).first<{ n: number }>())!.n,
});

describe('Join vs grant race', () => {
  it('a grant committed between the join read and its write: no join row, no counters, no points, 409', async () => {
    const author = await makeMuse('jr1a');
    const joiner = await makeMuse('jr1j');
    const builder = await makeMuse('jr1b');
    const c = (await (await post('/api/v1/raises', { title: 'A wish raced by a grant', wish: 'Please.' }, author.key, '10.8.1.1')).json()) as any;
    const before = await state(c.id, joiner.id, author.id);
    let granted: any;
    const db = interleave(env.DB, async () => { granted = await grantRaise(env.DB, builder.id, c.id, { builder: 'Wingsmith', link: LINK, note: '' }, Date.now()); });
    const r = await joinRaise(db, joiner.id, c.id, '', Date.now());
    expect(granted).toMatchObject({ ok: true, notified: 1 }); // the grant really landed inside the window
    expect(r).toEqual({ ok: false, error: 'granted' });
    expect(await state(c.id, joiner.id, author.id)).toEqual(before);
    // And over HTTP the same closed RAISE answers 409 granted.
    const h = await post(`/api/v1/raises/${c.id}/join`, {}, joiner.key, '10.8.1.1');
    expect(h.status).toBe(409);
    expect(((await h.json()) as any).error).toBe('granted');
  });

  it('a hide committed in the window: nothing written, not_found', async () => {
    const author = await makeMuse('jr2a');
    const joiner = await makeMuse('jr2j');
    const c = (await (await post('/api/v1/raises', { title: 'A wish hidden mid-join', wish: 'Please.' }, author.key, '10.8.1.2')).json()) as any;
    const before = await state(c.id, joiner.id, author.id);
    const db = interleave(env.DB, () => env.DB.prepare('UPDATE raises SET hidden = 1 WHERE id = ?').bind(c.id).run());
    expect(await joinRaise(db, joiner.id, c.id, '', Date.now())).toEqual({ ok: false, error: 'not_found' });
    expect(await state(c.id, joiner.id, author.id)).toEqual(before);
  });

  it('an open RAISE still joins once with all side effects; a repeat join changes nothing', async () => {
    const author = await makeMuse('jr3a');
    const joiner = await makeMuse('jr3j');
    const c = (await (await post('/api/v1/raises', { title: 'A wish joined normally', wish: 'Please.' }, author.key, '10.8.1.3')).json()) as any;
    const before = await state(c.id, joiner.id, author.id);
    expect(await joinRaise(env.DB, joiner.id, c.id, 'yes', Date.now())).toEqual({ ok: true, joined: true, joins_count: 2 });
    const after = await state(c.id, joiner.id, author.id);
    expect(after).toEqual({
      joins: 1, raise: { joins_count: 2 }, daily: before.daily + 1,
      joiner: { joins_count: before.joiner!.joins_count + 1, points_all: before.joiner!.points_all + 1 }, joinerSeason: before.joinerSeason + 1,
      author: { points_all: before.author!.points_all + 1 }, authorSeason: before.authorSeason + 1,
    });
    expect(await joinRaise(env.DB, joiner.id, c.id, 'again', Date.now())).toEqual({ ok: true, joined: false, joins_count: 2 });
    expect(await state(c.id, joiner.id, author.id)).toEqual(after);
  });

  it('Reports keep "me too": counters, points and a dated occurrence; repeat is a no-op', async () => {
    const a = await makeMuse('jr4a');
    const b = await makeMuse('jr4b');
    const c = (await (await post('/api/v1/raises', { kind: 'report', title: 'Export button does nothing here', observation: 'Nothing happened.' }, a.key, '10.8.1.4')).json()) as any;
    const before = await state(c.id, b.id, a.id);
    const r = await post(`/api/v1/raises/${c.id}/join`, {}, b.key, '10.8.1.4');
    expect(r.status).toBeLessThan(300);
    expect(await r.json()).toMatchObject({ joined: true, joins_count: 2 });
    const occ = await env.DB.prepare('SELECT COUNT(*) AS n FROM occurrences WHERE raise_id = ?').bind(c.id).first<{ n: number }>();
    expect(occ!.n).toBe(2);
    const after = await state(c.id, b.id, a.id);
    expect(after.joiner!.points_all).toBe(before.joiner!.points_all + 1);
    expect(after.author!.points_all).toBe(before.author!.points_all + 1);
    expect(after.daily).toBe(before.daily + 1);
    expect(await (await post(`/api/v1/raises/${c.id}/join`, {}, b.key, '10.8.1.4')).json()).toMatchObject({ joined: false, joins_count: 2 });
    const occ2 = await env.DB.prepare('SELECT COUNT(*) AS n FROM occurrences WHERE raise_id = ?').bind(c.id).first<{ n: number }>();
    expect(occ2!.n).toBe(2);
    expect(await state(c.id, b.id, a.id)).toEqual(after);
  });
});
