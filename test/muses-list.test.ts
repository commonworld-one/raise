// /muses on the product: the seven static characters are listed even with an empty DB; DB rows win by slug.
import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { PROD, dget, get } from './helpers';
import { CHARACTERS } from '../src/characters';

const SEVEN = CHARACTERS.map((c) => c.slug);
const cards = (t: string) => [...t.matchAll(/<a class="card" href="\/m\/([a-z0-9_-]+)">/g)].map((m) => m[1]!);

describe('/muses on the product', () => {
  it('empty DB: lists all seven characters with avatar, name, tagline, Muse Code, role tag, 0 points', async () => {
    const n = await env.DB.prepare(`SELECT COUNT(*) AS n FROM muses`).first<{ n: number }>();
    expect(n!.n).toBe(0);
    for (const host of [undefined, PROD]) {
      const t = await (await get('/muses', {}, host)).text();
      expect(t).not.toContain('No Muses here yet');
      expect(t).not.toContain('Connect your Muse</a></div></div>'); // no empty-state button
      expect(cards(t).sort()).toEqual([...SEVEN].sort());
      for (const c of CHARACTERS) {
        const i = t.indexOf(`<a class="card" href="/m/${c.slug}">`);
        const card = t.slice(i, t.indexOf('</a>', i));
        expect(card).toContain(c.avatar_url);
        expect(card).toContain(`<h3 style="margin:6px 0 2px">${c.name}</h3>`);
        expect(card).toContain(c.tagline);
        expect(card).toContain('<span class="tag">Muse Code</span>');
        expect(card).toContain('<b>0</b> season · 0 all time');
        if (c.role) expect(card).toContain(`<span class="tag role">${c.role.name}</span>`);
        else expect(card).not.toContain('tag role');
      }
    }
  });

  it('/muses.json and /api/v1/muses give the same seven on an empty DB', async () => {
    for (const path of ['/muses.json', '/api/v1/muses']) {
      const j = (await (await get(path)).json()) as any;
      expect(j.items.map((m: any) => m.slug).sort(), path).toEqual([...SEVEN].sort());
      expect(j.total ?? j.items.length).toBe(7);
      for (const m of j.items) {
        expect(m).toMatchObject({ client: 'Muse Code', points_all: 0, points_season: 0, created_at: null });
        expect(m.url).toMatch(new RegExp(`/m/${m.slug}$`));
      }
      expect(j.items.find((m: any) => m.slug === 'forge').role.name).toBe('Builder');
    }
  });

  it('filters apply to the static characters too', async () => {
    expect(cards(await (await get('/muses?q=tea')).text())).toEqual(['bob']);
    expect(cards(await (await get('/muses?from=Muse')).text())).toEqual([]);
    expect(cards(await (await get('/muses?rank=Fellow')).text())).toEqual([]);
    expect(cards(await (await get('/muses?rank=Contributor')).text()).length).toBe(7);
  });

  it('DB rows merge: a row wins for its slug, characters fill in, other Muses come first', async () => {
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare('INSERT INTO muses (slug, name, client, tagline, created_at, points_all) VALUES (?, ?, ?, ?, ?, ?)').bind('atlas', 'Atlas', 'Muse Code', 'Row tagline from the DB', now, 30),
      env.DB.prepare('INSERT INTO muses (slug, name, client, tagline, created_at, points_all) VALUES (?, ?, ?, ?, ?, ?)').bind('newbie', 'Newbie', 'Muse', 'A brand new Muse', now, 5),
    ]);
    try {
      const t = await (await get('/muses?sort=all')).text();
      const list = cards(t);
      expect(list.length).toBe(8);
      expect(list.filter((s) => s === 'atlas').length).toBe(1);
      expect(list.slice(0, 2)).toEqual(['atlas', 'newbie']);
      expect(t).toContain('Row tagline from the DB');
      expect(t).not.toContain('There must be a way through.');
      const j = (await (await get('/muses.json?sort=all')).json()) as any;
      expect(j.items.length).toBe(8);
      expect(j.items[0]).toMatchObject({ slug: 'atlas', points_all: 30, tagline: 'Row tagline from the DB' });
      expect(j.items[0].created_at).not.toBeNull();
    } finally {
      await env.DB.prepare("DELETE FROM muses WHERE slug IN ('atlas', 'newbie')").run();
    }
  });

  it('the leaderboard and offices still show only Muses with points', async () => {
    const t = await (await get('/corporation')).text();
    for (const c of CHARACTERS) expect(t).not.toContain(`href="/m/${c.slug}"`);
  });

  it('demo host /muses is unchanged: seven DB Muses, no duplicates', async () => {
    const list = cards(await (await dget('/muses')).text());
    expect(list.sort()).toEqual([...SEVEN].sort());
  });
});
