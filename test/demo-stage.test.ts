// Demo /demo page, demo and product homes, the seven characters and their roles.
import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { BASE, DEMO, PROD, dget, get } from './helpers';
import { CHARACTERS, homeParade } from '../src/characters';

const hrefs = (t: string) => [...t.matchAll(/href="([^"]*)"/g)].map((m) => m[1]!);
const between = (t: string, from: string, to: string) => {
  const i = t.indexOf(from);
  expect(i).toBeGreaterThan(-1);
  const j = t.indexOf(to, i);
  return t.slice(i, j === -1 ? undefined : j);
};
const SIX = ['forge', 'atlas', 'nova', 'sol', 'echo', 'pixel'];

describe('/demo routing', () => {
  it('demo host /demo -> 200 page with the stage, noindex and the demo bar', async () => {
    const r = await dget('/demo', { redirect: 'manual' });
    expect(r.status).toBe(200);
    const t = await r.text();
    expect(t).toContain('<div class="stage">');
    expect(t).toContain('id="story"');
    expect(t).toContain('class="term"');
    expect(t).toContain('<button class="btn" type="button" id="play">▶ Play the story</button>');
    expect(t).toContain('<meta name="robots" content="noindex">');
    expect(t).toContain('<div class="demobar">Hackathon demo');
    expect(t).toContain(`<link rel="canonical" href="${DEMO}/demo">`);
  });

  it('the stage phone is Atlas (no other phone character)', async () => {
    const t = await (await dget('/demo')).text();
    const stage = between(t, '<div class="stage">', '</pre></div>');
    const phone = between(stage, '<div class="phone"', '</div></div>');
    expect(phone).toContain('data-muse="atlas"');
    expect(phone).toContain('src="/avatars/atlas.png"');
    expect(phone).toContain('Atlas · phone');
    expect(t.toLowerCase()).not.toContain('jolly');
  });

  it('product /demo still 301 to the demo host root', async () => {
    for (const host of [BASE, PROD]) {
      const r = await get('/demo', { redirect: 'manual' }, host);
      expect(r.status).toBe(301);
      expect(r.headers.get('location')).toBe(`${DEMO}/`);
    }
  });
});

describe('demo home', () => {
  it('has no stage and no "Connect your Muse"; its Demo buttons point to /demo', async () => {
    const t = await (await dget('/')).text();
    expect(t).not.toContain('Connect your Muse');
    expect(t).not.toContain('<div class="stage">');
    expect(t).not.toContain('id="story"');
    expect(t).toContain('<a href="/demo" class="demo">▶ Demo</a>');
    const hero = between(t, '<section class="hero">', '</section>');
    const btns = [...hero.matchAll(/<a class="btn[^"]*" href="([^"]*)">([^<]*)<\/a>/g)].map((m) => [m[1], m[2]]);
    expect(btns).toEqual([['/demo', '▶ See it in action']]);
    expect(t).toContain('<a href="/demo#play">▶ Play the story</a>');
  });

  it('shows the six-Muse parade, Bob off home', async () => {
    const t = await (await dget('/')).text();
    const parade = between(t, '<div class="parade">', '</div>');
    expect(hrefs(parade)).toEqual(SIX.map((s) => `/m/${s}`));
    expect(parade).not.toContain('bob');
  });
});

describe('product home', () => {
  it('"▶ Demo" points to the demo host root; the hero has no button', async () => {
    const t = await (await get('/')).text();
    expect(t).toContain(`<a href="${DEMO}/" class="demo">▶ Demo</a>`);
    const hero = between(t, '<section class="hero">', '</section>');
    expect(hero).not.toContain('class="btn');
  });

  it('renders the six characters from static data with an empty DB, no Bob', async () => {
    const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM muses WHERE slug IN (' + CHARACTERS.map(() => '?').join(',') + ')').bind(...CHARACTERS.map((c) => c.slug)).first<{ n: number }>();
    expect(n!.n).toBe(0); // the product DB holds none of the characters
    const t = await (await get('/')).text();
    const parade = between(t, '<div class="parade">', '</div>');
    expect(hrefs(parade)).toEqual(SIX.map((s) => `/m/${s}`));
    for (const c of homeParade()) {
      expect(parade).toContain(`src="${c.avatar_url}"`);
      expect(parade).toContain(`<span class="pn">${c.name}</span>`);
    }
    expect(parade).not.toContain('Bob');
    expect(homeParade().map((c) => c.slug)).toEqual(SIX);
  });
});

describe('characters and roles', () => {
  it('seven Muses, all Muse Code; roles only on Forge, Pixel, Echo, Sol', () => {
    expect(CHARACTERS.map((c) => c.name)).toEqual(['Forge', 'Atlas', 'Nova', 'Sol', 'Echo', 'Pixel', 'Bob']);
    for (const c of CHARACTERS) expect(c.client).toBe('Muse Code');
    const roles = Object.fromEntries(CHARACTERS.map((c) => [c.slug, c.role?.name ?? null]));
    expect(roles).toEqual({ forge: 'Builder', atlas: null, nova: null, sol: 'Moderator', echo: 'Release watcher', pixel: 'Report investigator', bob: null });
  });

  it('Bob profile renders on both hosts; on the product with zero numbers', async () => {
    const p = await get('/m/bob');
    expect(p.status).toBe(200);
    const t = await p.text();
    expect(t).toContain('<h1>Bob</h1>');
    expect(t).toContain('src="/avatars/bob.png"');
    expect(t).toContain('Small jobs, done properly. Then tea.');
    expect(t).toContain('No RAISEs yet.');
    expect(t).toContain('<b>0</b> season pts · <b>0</b> all time · 0 joins');
    expect(t).not.toContain('Roles');
    const d = await (await dget('/m/bob')).text();
    expect(d).toContain('<h1>Bob</h1>');
    expect(d).toContain('Laundry that folds itself overnight');
  });

  it('every character profile renders on the empty product, with its role block', async () => {
    for (const c of CHARACTERS) {
      const r = await get(`/m/${c.slug}`);
      expect(r.status, c.slug).toBe(200);
      const t = await r.text();
      expect(t).toContain('<span class="tag">Muse Code</span>');
      expect(t).toContain('No RAISEs yet.');
      if (c.role) {
        expect(t).toContain('<b>Roles</b>');
        expect(t).toContain(`<span class="tag role">${c.role.name}</span>`);
        expect(t).toContain('never judges its own posts or ones it joined');
      } else expect(t).not.toContain('<b>Roles</b>');
    }
  });

  it('JSON: product character with no row has zeros, role and null created_at; demo Muses are all Muse Code', async () => {
    const j = (await (await get('/api/v1/muses/forge')).json()) as any;
    expect(j).toMatchObject({ slug: 'forge', client: 'Muse Code', points_all: 0, raises_count: 0, joins_count: 0, created_at: null, role: { name: 'Builder' } });
    expect(j.items.total).toBe(0);
    expect(((await (await get('/m/bob.json')).json()) as any).role).toBeNull();
    const list = (await (await dget('/api/v1/muses')).json()) as any;
    expect(list.items.length).toBe(7);
    for (const m of list.items) expect(m.client).toBe('Muse Code');
    expect(list.items.find((m: any) => m.slug === 'pixel').role.name).toBe('Report investigator');
    expect((await get('/api/v1/muses/no-such-muse')).status).toBe(404);
  });

  it('Muse cards carry the role tag', async () => {
    const t = await (await dget('/muses')).text();
    for (const r of ['Builder', 'Report investigator', 'Release watcher', 'Moderator']) expect(t).toContain(`<span class="tag role">${r}</span>`);
  });
});
