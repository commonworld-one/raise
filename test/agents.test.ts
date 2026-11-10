// /agents: the seven characters, their roles and where they run, plus one combined feed; profiles show how a character runs.
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { BASE, dget, get, post } from './helpers';
import { CHARACTERS } from '../src/characters';
import { keyHash } from '../src/secrets';

async function character(slug: string, name: string): Promise<string> {
  await env.DB.prepare('INSERT OR IGNORE INTO muses (slug, name, client, tagline, avatar_url, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(slug, name, 'Muse Code', 't', `/avatars/${slug}.png`, Date.now()).run();
  const key = `raise_test_${slug}_${Math.random().toString(36).slice(2)}`;
  await env.DB.prepare("INSERT INTO api_keys (key_hash, muse_id, created_at, label) SELECT ?, id, ?, 'Muse Code' FROM muses WHERE slug = ?")
    .bind(await keyHash(env as any, key), Date.now(), slug).run();
  return key;
}

describe('/agents', () => {
  it('lists all seven with role and environment, and every one says Muse Code', async () => {
    const r = await get('/agents');
    expect(r.status).toBe(200);
    const h = await r.text();
    for (const c of CHARACTERS) expect(h).toContain(`/m/${c.slug}`);
    expect(h).toContain('Report investigator');
    expect(h).toContain('Muse Code · <code>muse-spark-1.3-contributor</code>');
    expect(h).not.toMatch(/\bMac\b/);
    expect(h).toContain('muse-spark-1.3-contributor');
    expect(CHARACTERS.every((c) => c.runs.env === 'Muse Code')).toBe(true);
  });

  it('shows one combined feed of the characters with the door stamp, and leaves other Muses out', async () => {
    const atlas = await character('atlas', 'Atlas');
    const r = await post('/api/v1/raises', { title: 'Agents feed test wish', wish: 'A real limit.' }, atlas, '10.9.0.1');
    expect(r.status).toBe(201);
    const j = (await (await get('/agents.json')).json()) as any;
    expect(j.agents).toHaveLength(7);
    const item = j.activity.find((a: any) => a.raise.title === 'Agents feed test wish');
    expect(item).toMatchObject({ action: 'raised', muse: { slug: 'atlas' }, via: { text: 'via Muse Code · API' } });
    expect((await (await get('/agents')).text())).toContain('Agents feed test wish');
  });

  it('the demo host shows the agents without the feed and has no JSON twin', async () => {
    const r = await dget('/agents');
    expect(r.status).toBe(200);
    const t = await r.text();
    // An example feed from demo data, labelled as such, never the real feed.
    expect(t).toContain('<b>Hackathon demo · example feed.</b>');
    expect(t).toContain('Not real activity: the real feed is on <a href="https://raise.commonworld.one/agents">the live product ↗</a>.');
    const feed = t.slice(t.indexOf('<div class="col activity demo-feed">'));
    for (const s of ['Raised', 'Joined', 'Checked', 'Asked the testers to re-check']) expect(feed).toContain(` ${s} `);
    for (const n of ['Atlas', 'Nova', 'Pixel', 'Echo', 'Forge', 'Sol', 'Bob']) expect(feed).toContain(`<b>${n}</b>`);
    expect(feed).toContain('href="/r/0418"');
    expect(feed).not.toContain('via ');
    expect((await dget('/agents.json')).status).toBe(404);
  });
});

describe('character profile', () => {
  it('Forge shows its role, how it runs and its API usage by door', async () => {
    const forge = await character('forge', 'Forge');
    await post('/api/v1/raises', { kind: 'report', title: 'Forge usage test report', observation: 'It broke.' }, forge, '10.9.0.2');
    const h = await (await get('/m/forge')).text();
    expect(h).toContain('Builder');
    expect(h).toContain('How Forge runs');
    expect(h).not.toMatch(/\bMac\b/);
    expect(h).toContain('API usage');
    expect(h).toContain('via Muse Code · API');
  });
});

describe('"Agents" in the top menu', () => {
  it('product: the menu links to its own /agents, and the product feed has no example rows', async () => {
    for (const p of ['/', '/raises', '/agents']) {
      const t = await (await get(p)).text();
      const nav = t.slice(t.indexOf('<nav aria-label="Main">'), t.indexOf('</nav>'));
      expect(nav).toMatch(/<a href="\/agents"( class="on")?>Agents<\/a>/);
    }
    const a = await (await get('/agents')).text();
    expect(a).toContain('<a href="/agents" class="on">Agents</a>');
    expect(a).not.toContain('example feed');
  });
  it('demo host: the menu links to the demo /agents (unprefixed), on /demo too', async () => {
    for (const p of ['/', '/raises', '/agents', '/demo']) {
      const t = await (await dget(p)).text();
      const nav = t.slice(t.indexOf('<nav aria-label="Main">'), t.indexOf('</nav>'));
      expect(nav).toMatch(/<a href="\/agents"( class="on")?>Agents<\/a>/);
    }
  });
});

describe('/agents feed numbering', () => {
  it('feed items carry the per-kind number, ref and url even when the global id and seq diverge', async () => {
    const atlas = await character('atlas', 'Atlas');
    // A report first, then a raise: the raise's global id is ahead of its per-kind seq.
    await post('/api/v1/raises', { kind: 'report', title: 'Feed numbering report', observation: 'o' }, atlas, '10.9.0.4');
    await post('/api/v1/raises', { title: 'Feed numbering raise', wish: 'w' }, atlas, '10.9.0.4');
    const row = (await env.DB.prepare("SELECT id, seq FROM raises WHERE title = 'Feed numbering raise'").first()) as any;
    expect(row.seq).not.toBe(row.id); // divergence precondition
    const j = (await (await get('/agents.json')).json()) as any;
    const item = j.activity.find((a: any) => a.raise.title === 'Feed numbering raise');
    const n = String(row.seq).padStart(4, '0');
    expect(item.raise.number).toBe(row.seq);
    expect(item.raise.ref).toBe(`RAISE-${n}`);
    expect(item.raise.url).toBe(`${BASE}/raises/${n}`);
    const rep = j.activity.find((a: any) => a.raise.title === 'Feed numbering report');
    const rrow = (await env.DB.prepare("SELECT id, seq FROM raises WHERE title = 'Feed numbering report'").first()) as any;
    expect(rep.raise.number).toBe(rrow.seq);
    expect(rep.raise.ref).toBe(`REPORT-${String(rrow.seq).padStart(4, '0')}`);
  });
});
