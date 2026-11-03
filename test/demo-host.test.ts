// Hackathon demo on its own host: raise-demo.commonworld.one -> DEMO_DB, any other host -> DB.
import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { BASE, DEMO, PROD, dget, dpost, get, makeMuse, post } from './helpers';
import { demoSite, isDemoHost, productSite, productUrl } from '../src/util';

const NAV_PATHS = ['/', '/raises', '/reports', '/granted', '/muses', '/corporation'];
const hrefs = (t: string) => [...t.matchAll(/href="([^"]*)"/g)].map((m) => m[1]!);

describe('host -> database', () => {
  it('isDemoHost: only the demo hostname (and raise-demo.localhost) is the demo', () => {
    expect(isDemoHost(env, 'raise-demo.commonworld.one')).toBe(true);
    expect(isDemoHost(env, 'RAISE-DEMO.commonworld.one')).toBe(true);
    expect(isDemoHost(env, 'raise-demo.localhost')).toBe(true);
    for (const h of ['raise.commonworld.one', 'raise.test', 'localhost', 'raise-demo.commonworld.one.evil.example', 'x.raise-demo.commonworld.one', 'raise.example.workers.dev'])
      expect(isDemoHost(env, h)).toBe(false);
    expect(demoSite(env)).toBe(DEMO);
    expect(productSite(env)).toBe(PROD);
  });

  it('demo host reads DEMO_DB, product host reads DB', async () => {
    const demo = (await (await dget('/api/v1')).json()) as any;
    const prod = (await (await get('/api/v1')).json()) as any;
    expect(demo.demo).toBe(true);
    expect(prod.demo).toBe(false);
    const d = (await (await dget('/api/v1/raises/418')).json()) as any;
    expect(d.title).toBe('Wings to fly to the Moon');
    expect(d.url).toBe(`${DEMO}/r/0418`);
    expect((await get('/api/v1/raises/418')).status).toBe(404); // demo row never shows on the product
    expect((await get('/m/atlas')).status).toBe(404);
    expect((await dget('/m/atlas')).status).toBe(200);
  });

  it('numbers never mix: a demo join touches only DEMO_DB, a product join only DB', async () => {
    const count = async (db: D1Database, id: number) => (await db.prepare('SELECT joins_count AS n FROM raises WHERE id = ?').bind(id).first<{ n: number }>())?.n;
    const before = await count(env.DEMO_DB, 433);
    const r = await dpost('/api/v1/raises/433/join', { as: 'echo' }, undefined, '10.7.0.1');
    expect([200, 201, 409]).toContain(r.status);
    if (r.status !== 409) expect(await count(env.DEMO_DB, 433)).toBe(before! + 1);
    expect(await count(env.DB, 433)).toBeUndefined();

    const m = await makeMuse('hostsplit');
    const c = (await (await post('/api/v1/raises', { title: 'Host split wish here', wish: 'Only on prod.' }, m.key, '10.7.0.2')).json()) as any;
    expect(c.url.startsWith(`${BASE}/r/`)).toBe(true);
    expect(await env.DEMO_DB.prepare('SELECT id FROM raises WHERE title = ?').bind('Host split wish here').first()).toBeNull();
  });

  it('unauthenticated demo writes work only on the demo host', async () => {
    expect((await dpost('/api/v1/raises', { as: 'forge', title: 'A demo wish from the host test', wish: 'Demo only.' }, undefined, '10.7.0.3')).status).toBe(201);
    expect((await post('/api/v1/raises', { as: 'forge', title: 'A demo wish from the host test', wish: 'Demo only.' }, undefined, '10.7.0.4')).status).toBe(401);
  });
});

describe('/demo on the product host', () => {
  it('/demo -> 301 demo home', async () => {
    const r = await get('/demo', { redirect: 'manual' });
    expect(r.status).toBe(301);
    expect(r.headers.get('location')).toBe(`${DEMO}/`);
  });
  it('/demo/<anything>?query -> 301 same path and query on the demo host', async () => {
    for (const [from, to] of [
      ['/demo/', '/'],
      ['/demo/raises?sort=top&active=all', '/raises?sort=top&active=all'],
      ['/demo/r/0418', '/r/0418'],
      ['/demo/m/atlas', '/m/atlas'],
      ['/demo/api/v1/raises?active=all', '/api/v1/raises?active=all'],
    ]) {
      const r = await get(from!, { redirect: 'manual' });
      expect(r.status).toBe(301);
      expect(r.headers.get('location')).toBe(DEMO + to);
    }
  });
  it('POST /demo/mcp keeps its method (308)', async () => {
    const r = await get('/demo/mcp', { method: 'POST', body: '{}', redirect: 'manual' });
    expect(r.status).toBe(308);
    expect(r.headers.get('location')).toBe(`${DEMO}/mcp`);
  });
  it('/demonstration is not the demo', async () => {
    expect((await get('/demonstration', { redirect: 'manual' })).status).toBe(404);
  });
});

describe('/demo on the demo host', () => {
  it('drops the prefix, same host', async () => {
    for (const [from, to] of [['/demo', '/'], ['/demo/', '/'], ['/demo/raises?sort=new', '/raises?sort=new'], ['/demo/r/0418', '/r/0418']]) {
      const r = await dget(from!, { redirect: 'manual' });
      expect(r.status).toBe(301);
      expect(r.headers.get('location')).toBe(DEMO + to);
    }
  });
});

describe('demo bar and links', () => {
  it('"Open the live product" maps to the same path (and query) on the product', async () => {
    for (const p of ['/raises', '/reports?active=all', '/granted', '/r/0418', '/corporation', '/about']) {
      const t = await (await dget(p)).text();
      expect(t).toContain(`<a href="${(PROD + p).replace(/&/g, '&amp;')}">Open the live product ↗</a>`);
      expect(t).toContain('<a href="/#play">▶ Play the story</a>');
    }
    expect(productUrl(env, '/raises', '?sort=top')).toBe(`${PROD}/raises?sort=top`);
    expect(productUrl(env, '//evil.example/x')).toBe(`${PROD}/evil.example/x`);
  });

  it('nav links on the demo host stay on the demo host, unprefixed', async () => {
    for (const p of ['/', '/raises', '/r/0418', '/m/atlas', '/corporation']) {
      const t = await (await dget(p)).text();
      const nav = t.slice(t.indexOf('<nav aria-label="Main">'), t.indexOf('</nav>'));
      for (const n of NAV_PATHS) expect(nav).toContain(`href="${n}"`);
      expect(nav).toContain('<a href="/" class="demo">▶ Demo</a>');
      const links = hrefs(t);
      expect(links.some((h) => h.startsWith('/demo'))).toBe(false);
      // The only links to the product are the demo bar and footer "live product" links.
      expect(links.filter((h) => h.startsWith(PROD)).length).toBe(2);
      expect(links).toContain('/connect');
      expect(links).toContain('/about');
    }
  });

  it('demo pages: noindex and a self canonical; product pages unchanged', async () => {
    const t = await (await dget('/raises?sort=top')).text();
    expect(t).toContain('<meta name="robots" content="noindex">');
    expect(t).toContain(`<link rel="canonical" href="${DEMO}/raises">`);
    const p = await (await get('/raises')).text();
    expect(p).not.toContain('noindex');
    expect(p).not.toContain('rel="canonical"');
    expect(p).not.toContain('Hackathon demo');
    expect(await (await get('/raises?sort=top')).text()).toContain('<meta name="robots" content="noindex,follow">');
  });

  it('product: header "▶ Demo" and footer link go to the demo host', async () => {
    const t = await (await get('/')).text();
    expect(t).toContain(`<a href="${DEMO}/" class="demo">▶ Demo</a>`);
    expect(t).toContain(`<a href="${DEMO}/">Demo</a>`);
    expect(hrefs(t).some((h) => h.startsWith('/demo'))).toBe(false);
  });

  it('demo MCP page and API urls name the demo host', async () => {
    const t = await (await dget('/mcp', { headers: { accept: 'text/html' } })).text();
    expect(t).toContain(`POST ${DEMO}/mcp`);
    const list = (await (await dget('/api/v1/raises?active=all')).json()) as any;
    expect(list.items[0].url.startsWith(`${DEMO}/r/`)).toBe(true);
  });
});
