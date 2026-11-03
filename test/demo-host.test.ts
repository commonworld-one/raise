// Hackathon demo on its own host: raise-demo.commonworld.one -> DEMO_DB, any other host -> DB.
import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { BASE, DEMO, PROD, dapi, dget, dpost, get, makeMuse, post } from './helpers';
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
    const prod = (await (await get('/api/v1')).json()) as any;
    expect(prod.demo).toBe(false);
    const d = await (await dget('/r/0418')).text();
    expect(d).toContain('Wings to fly to the Moon');
    expect((await get('/api/v1/raises/418')).status).toBe(404); // demo row never shows on the product
    expect((await get('/r/0418')).status).toBe(404);
    expect((await get('/m/no-such-muse')).status).toBe(404); // characters (e.g. /m/atlas) render from static data, see demo-stage.test.ts
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
  it('/demo is its own page (200), not a redirect', async () => {
    const r = await dget('/demo', { redirect: 'manual' });
    expect(r.status).toBe(200);
  });
  it('old /demo/... links drop the prefix, same host; /demo/ -> /demo', async () => {
    for (const [from, to] of [['/demo/', '/demo'], ['/demo/raises?sort=new', '/raises?sort=new'], ['/demo/r/0418', '/r/0418']]) {
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
      expect(t).toContain('<a href="/demo#play">▶ Play the story</a>');
    }
    expect(productUrl(env, '/raises', '?sort=top')).toBe(`${PROD}/raises?sort=top`);
    expect(productUrl(env, '//evil.example/x')).toBe(`${PROD}/evil.example/x`);
  });

  it('nav links on the demo host stay on the demo host, unprefixed', async () => {
    for (const p of ['/', '/raises', '/r/0418', '/m/atlas', '/corporation']) {
      const t = await (await dget(p)).text();
      const nav = t.slice(t.indexOf('<nav aria-label="Main">'), t.indexOf('</nav>'));
      for (const n of NAV_PATHS) expect(nav).toContain(`href="${n}"`);
      expect(nav).toContain('<a href="/demo" class="demo">▶ Demo</a>');
      const links = hrefs(t);
      expect(links.filter((h) => h.startsWith('/demo')).every((h) => h === '/demo' || h === '/demo#play')).toBe(true);
      // Links to the product: the demo bar and footer "live product" links (same path), "Connect" and "For agents (MCP)" (product only).
      const live = (PROD + p).replace(/&/g, '&amp;');
      const toProd = links.filter((h) => h.startsWith(PROD));
      expect(toProd.filter((h) => h === live).length).toBe(2);
      for (const h of toProd) expect([live, `${PROD}/connect`, `${PROD}/mcp`]).toContain(h); // MCP lives on the product only
      expect(links).not.toContain('/connect');
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

  it('demo-mode API urls name the demo host', async () => {
    const list = (await (await dapi('/api/v1/raises?active=all')).json()) as any;
    expect(list.items[0].url.startsWith(`${DEMO}/r/`)).toBe(true);
  });
});

describe('demo without API: the demo host serves human pages only', () => {
  const POINTER = { error: 'not_found', api: `${PROD}/api/v1`, mcp: `${PROD}/mcp` };

  it('JSON API paths 404 with a pointer to the product, for every method', async () => {
    for (const p of ['/api/v1', '/api/v1/', '/api/v1/raises', '/api/v1/raises/418', '/api/v1/muses/atlas/notifications', '/api/v1/pulse']) {
      const r = await dget(p);
      expect(r.status, p).toBe(404);
      expect(r.headers.get('content-type')).toContain('application/json');
      expect(await r.json()).toMatchObject(POINTER);
    }
    for (const method of ['POST', 'OPTIONS', 'PUT', 'DELETE']) {
      const r = await dget('/api/v1/raises', { method, body: method === 'POST' || method === 'PUT' ? JSON.stringify({ as: 'forge', title: 'Should never land', wish: 'x' }) : undefined, headers: { 'content-type': 'application/json' } });
      expect(r.status, method).toBe(404);
    }
    expect(await env.DEMO_DB.prepare("SELECT id FROM raises WHERE title = 'Should never land'").first()).toBeNull();
  });

  it('MCP 404s on the demo host (POST and GET, JSON and HTML); the HTML 404 points to the product', async () => {
    const rpc = await dget('/mcp', { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }), headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' } });
    expect(rpc.status).toBe(404);
    expect(await rpc.json()).toMatchObject(POINTER);
    const page = await dget('/mcp', { headers: { accept: 'text/html' } });
    expect(page.status).toBe(404);
    const t = await page.text();
    expect(t).toContain('<h1>Not on the demo</h1>');
    expect(t).toContain(`href="${PROD}/api/v1"`);
    expect(t).toContain(`href="${PROD}/mcp"`);
    expect(t).toContain('<meta name="robots" content="noindex">');
    // An HTML Accept does not turn an API path into a page.
    expect((await dget('/api/v1/raises', { headers: { accept: 'text/html' } })).status).toBe(404);
  });

  it('.json and .md twins 404 on the demo host; the human pages still render', async () => {
    for (const p of ['/raises.json', '/raises.md', '/reports/page/1.json', '/granted.json', '/muses.json', '/m/atlas.json', '/r/0418.json', '/r/0418.md']) {
      const r = await dget(p, { redirect: 'manual' });
      expect(r.status, p).toBe(404);
    }
    for (const p of ['/', '/demo', '/raises', '/reports', '/granted', '/muses', '/m/atlas', '/r/0418', '/r/0419', '/corporation', '/about'])
      expect((await dget(p)).status, p).toBe(200);
  });

  it('demo pages link to no API, MCP or .json path on the demo host', async () => {
    for (const p of ['/', '/raises', '/reports', '/r/0418', '/m/atlas', '/about', '/demo']) {
      const t = await (await dget(p)).text();
      const local = hrefs(t).filter((h) => h.startsWith('/') || h.startsWith(DEMO));
      for (const h of local) expect(h, `${p} -> ${h}`).not.toMatch(/\/api\/v1|\/mcp\b|\.json\b|\.md\b/);
      expect(t).not.toContain('rel="alternate" type="application/json"');
    }
    const home = await (await dget('/')).text();
    expect(home).not.toContain('JSON API');
    expect(home).toContain(`<a href="${PROD}/mcp">For agents (MCP)</a>`);
  });

  it('the product keeps its API, MCP and twins', async () => {
    expect(((await (await get('/api/v1')).json()) as any).name).toBe('Muse RAISE API');
    expect((await get('/raises.json')).status).toBe(200);
    const tl = (await (await get('/mcp', { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }), headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' } })).json()) as any;
    expect(tl.result.tools.length).toBeGreaterThan(0);
    expect((await get('/mcp', { headers: { accept: 'text/html' } })).status).toBe(200);
    const t = await (await get('/')).text();
    expect(t).toContain('<a href="/mcp">For agents (MCP)</a>');
  });
});
