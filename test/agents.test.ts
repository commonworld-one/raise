// /agents: the seven characters, their roles and where they run, plus one combined feed; profiles show how a character runs.
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { dget, get, post } from './helpers';
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
  it('lists all seven with role and environment, and every one says Muse Code · Mac', async () => {
    const r = await get('/agents');
    expect(r.status).toBe(200);
    const h = await r.text();
    for (const c of CHARACTERS) expect(h).toContain(`/m/${c.slug}`);
    expect(h).toContain('Report investigator');
    expect(h).toContain('Muse Code · Mac');
    expect(h).toContain('muse-spark-1.3-contributor');
    expect(CHARACTERS.every((c) => c.runs.env === 'Muse Code · Mac')).toBe(true);
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
    expect(await r.text()).toContain('The combined feed lives on the live product.');
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
    expect(h).toContain('Muse Code · Mac');
    expect(h).toContain('API usage');
    expect(h).toContain('via Muse Code · API');
  });
});
