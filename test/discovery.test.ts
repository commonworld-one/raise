// #21 discovery files on both hosts: /sitemap.xml, /robots.txt, /llms-full.txt, /openapi.json,
// plus the .md twins of /muses and /m/{slug}.
import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { BASE, DEMO, dget, get, makeMuse, post } from './helpers';
import { LLMS_FULL } from '../src/discovery';
import { CHARACTERS } from '../src/characters';
import { pad } from '../src/util';
import llmsTxt from '../llms.txt';
import apiMd from '../docs/api.md';

const locs = (xml: string) => [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]!);

describe('/sitemap.xml', () => {
  it('product: lists, visible RAISEs and public Muses; no hidden RAISEs, no drafts', async () => {
    const a = await makeMuse('sitemapper');
    const draft = await makeMuse('sitemapdraft', 'Muse Code', false, true);
    const c1 = await post('/api/v1/raises', { title: 'A wish for the sitemap test', wish: 'I want to be found by crawlers.' }, a.key);
    const c2 = await post('/api/v1/raises', { title: 'A hidden wish for the sitemap test', wish: 'This one gets hidden.' }, a.key);
    const shown = ((await c1.json()) as any).id as number, hidden = ((await c2.json()) as any).id as number;
    await env.DB.prepare('UPDATE raises SET hidden = 1 WHERE id = ?').bind(hidden).run();

    const r = await get('/sitemap.xml');
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('application/xml');
    const xml = await r.text();
    expect(xml).toMatch(/^<\?xml version="1.0" encoding="UTF-8"\?>\n<urlset xmlns="http:\/\/www.sitemaps.org\/schemas\/sitemap\/0.9">/);
    const l = locs(xml);
    for (const p of ['/', '/raises', '/reports', '/granted', '/muses', '/agents', '/corporation', '/connect', '/about']) expect(l).toContain(BASE + p);
    expect(l).toContain(`${BASE}/r/${pad(shown)}`);
    expect(l).not.toContain(`${BASE}/r/${pad(hidden)}`);
    expect(l).toContain(`${BASE}/m/sitemapper`);
    expect(l).not.toContain(`${BASE}/m/${draft.slug}`);
    for (const c of CHARACTERS) expect(l).toContain(`${BASE}/m/${c.slug}`);
    expect(new Set(l).size).toBe(l.length);
    expect(l.every((u) => u.startsWith(BASE + '/'))).toBe(true);
    // Every listed page answers 200 (or 301 for nothing: canonical URLs only).
    for (const u of [`${BASE}/r/${pad(shown)}`, `${BASE}/m/sitemapper`, `${BASE}/agents`]) expect((await get(new URL(u).pathname)).status).toBe(200);
  });

  it('demo host: its own data and /demo, on its own origin, no /connect', async () => {
    const r = await dget('/sitemap.xml');
    expect(r.status).toBe(200);
    const l = locs(await r.text());
    expect(l).toContain(`${DEMO}/demo`);
    expect(l).toContain(`${DEMO}/raises`);
    expect(l).not.toContain(`${DEMO}/connect`);
    expect(l.every((u) => u.startsWith(DEMO + '/'))).toBe(true);
    const { results } = await env.DEMO_DB.prepare('SELECT id FROM raises WHERE hidden = 0').all<{ id: number }>();
    expect(results.length).toBeGreaterThan(0);
    for (const x of results) expect(l).toContain(`${DEMO}/r/${pad(x.id)}`);
    const hiddenDemo = await env.DEMO_DB.prepare('SELECT id FROM raises WHERE hidden = 1').all<{ id: number }>();
    for (const x of hiddenDemo.results) expect(l).not.toContain(`${DEMO}/r/${pad(x.id)}`);
  });
});

describe('/robots.txt', () => {
  it('allows all and names the host\'s own sitemap', async () => {
    for (const [r, origin] of [[await get('/robots.txt'), BASE], [await dget('/robots.txt'), DEMO]] as const) {
      expect(r.status).toBe(200);
      expect(r.headers.get('content-type')).toContain('text/plain');
      const t = await r.text();
      expect(t).toContain('User-agent: *');
      expect(t).toContain('Allow: /');
      expect(t).toContain(`Sitemap: ${origin}/sitemap.xml`);
    }
  });
});

describe('/llms-full.txt', () => {
  it('is llms.txt followed by docs/api.md, as text/plain, on both hosts', async () => {
    expect(LLMS_FULL).toBe(`${llmsTxt.trimEnd()}\n\n---\n\n${apiMd.trimEnd()}\n`);
    for (const r of [await get('/llms-full.txt'), await dget('/llms-full.txt')]) {
      expect(r.status).toBe(200);
      expect(r.headers.get('content-type')).toBe('text/plain; charset=utf-8');
      const t = await r.text();
      expect(t).toBe(LLMS_FULL);
      expect(t).toContain('# Muse RAISE API');
      expect(t).toContain('/llms-full.txt');
      // #29 usage receipt (from llms.txt and docs/api.md) reaches llms-full.txt too
      expect(t).toContain('bad_receipt');
      expect(t).toContain('receipt_source');
    }
  });
});

describe('/openapi.json', () => {
  it('OpenAPI 3.1 on both hosts, server is the product API', async () => {
    for (const r of [await get('/openapi.json'), await dget('/openapi.json')]) {
      expect(r.status).toBe(200);
      expect(r.headers.get('content-type')).toContain('application/json');
      const o = (await r.json()) as any;
      expect(o.openapi).toBe('3.1.0');
      expect(o.servers[0].url).toBe('https://raise.commonworld.one/api/v1');
      expect(o.components.securitySchemes.raiseKey).toMatchObject({ type: 'http', scheme: 'bearer' });
      expect(o.components.securitySchemes.oauth.type).toBe('oauth2');
    }
  });

  it('every documented path and method is routed by src/api.ts (none answers "Unknown endpoint")', async () => {
    const o = (await (await get('/openapi.json')).json()) as any;
    const sample = (p: string) => p.replace('{id}', '1').replace('{slug}', 'forge');
    let n = 0;
    for (const [p, ops] of Object.entries<any>(o.paths)) {
      for (const method of Object.keys(ops)) {
        const init: RequestInit = { method: method.toUpperCase(), headers: { 'content-type': 'application/json' } };
        if (method !== 'get') init.body = '{}';
        const r = await get('/api/v1' + sample(p), init);
        const body = (await r.json()) as any;
        expect(`${method} ${p} -> ${body.message}`).not.toBe(`${method} ${p} -> Unknown endpoint.`);
        expect(r.status, `${method} ${p}`).not.toBe(405);
        n++;
      }
    }
    expect(n).toBeGreaterThanOrEqual(23);
  });

  it('prepareTap models both branches: the create body and a join', async () => {
    const o = (await (await get('/openapi.json')).json()) as any;
    expect(o.paths['/taps'].post.requestBody.content['application/json'].schema).toEqual({ $ref: '#/components/schemas/TapBody' });
    const [create, join] = o.components.schemas.TapBody.oneOf;
    expect(create.allOf).toContainEqual({ $ref: '#/components/schemas/CreateBody' });
    expect(join).toMatchObject({ required: ['action', 'id'], properties: { action: { const: 'join' } } });
    expect(o.components.schemas.CreateBody.properties).toHaveProperty('title');
    expect(o.components.schemas.CreateBody.properties).toHaveProperty('wish');
  });

  it('addVerification documents the optional usage receipt (#29) and Raise verifications carry receipt / receipt_source', async () => {
    const o = (await (await get('/openapi.json')).json()) as any;
    const post = o.paths['/raises/{id}/verifications'].post;
    const body = post.requestBody.content['application/json'].schema;
    expect(body.required).toEqual(['sources', 'finding']);
    expect(body.properties.receipt).toEqual({ $ref: '#/components/schemas/Receipt' });
    expect(post.responses['400'].description).toContain('bad_receipt');
    const R = o.components.schemas.Receipt;
    for (const k of ['model', 'model_calls', 'input_tokens', 'cached_input_tokens', 'output_tokens', 'reasoning_tokens', 'model_time_ms', 'wall_time_s']) expect(R.properties).toHaveProperty(k);
    expect(R.properties.model.maxLength).toBe(80);
    expect(R.properties.input_tokens).toMatchObject({ type: 'integer', minimum: 0, maximum: 10000000000 });
    expect(o.components.schemas.Raise.properties.verifications.items).toEqual({ $ref: '#/components/schemas/VerificationEntry' });
    expect(o.components.schemas.VerificationEntry.properties.receipt_source.enum).toContain('self_reported');
  });

  it('lists every endpoint name the API index advertises', async () => {
    const o = (await (await get('/openapi.json')).json()) as any;
    const idx = (await (await get('/api/v1')).json()) as any;
    for (const e of idx.endpoints as string[]) expect(Object.keys(o.paths)).toContain('/' + e);
  });
});

describe('.md twins of the Muse pages', () => {
  it('/muses.md and /m/{slug}.md on the product; 404 on the demo host', async () => {
    const list = await get('/muses.md');
    expect(list.status).toBe(200);
    expect(list.headers.get('content-type')).toContain('text/markdown');
    const t = await list.text();
    expect(t).toContain('# Meet the Muses');
    expect(t).toContain(`(${BASE}/m/forge)`);
    const one = await get('/m/forge.md');
    expect(one.status).toBe(200);
    const f = await one.text();
    expect(f).toContain('# Forge');
    expect(f).toContain('## RAISEs and Reports');
    expect((await get('/m/no-such-muse-here.md')).status).toBe(404);
    expect((await dget('/muses.md')).status).toBe(404);
  });
});

describe('request limit', () => {
  it('the discovery files count against READ_LIMITER like every other Worker route', async () => {
    const { createExecutionContext, waitOnExecutionContext } = await import('cloudflare:test');
    const worker = (await import('../src/index')).default;
    const limiter = { limit: async () => ({ success: false }) };
    for (const p of ['/sitemap.xml', '/robots.txt', '/llms-full.txt', '/openapi.json']) {
      const ctx = createExecutionContext();
      const r = await worker.fetch(new Request(BASE + p), { ...(env as any), NO_READ_LIMIT: undefined, READ_LIMITER: limiter }, ctx);
      await waitOnExecutionContext(ctx);
      expect(r.status, p).toBe(429);
    }
  });
});
