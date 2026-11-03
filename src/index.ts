// Muse RAISE Worker. Product on raise.commonworld.one (DB), hackathon demo on raise-demo.commonworld.one (DEMO_DB).
// The hostname picks the database; the paths are the same on both hosts.
import type { Ctx, Env, Kind } from './types';
import { getJoiners, getMuse, getRaise, getVerifications, leaderboard, listMuses, listRaises, seasons } from './data';
import { API_PREFIX, cached, handleApi } from './api';
import { handleMcp, tools } from './mcp';
import { pageJson, museJson, raiseJson, verificationJson } from './serialize';
import { isFiltered, listParams, museParams, queryObj } from './params';
import * as V from './views';
import { demoSite, isDemoHost, json, pad, productUrl, sameOrigin, seasonOf } from './util';
import { characterMuse } from './characters';
import { applyLive } from './live';

const html = (body: string, status = 200, extra: Record<string, string> = {}) =>
  new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8', ...extra } });
const md = (body: string) => new Response(body, { headers: { 'content-type': 'text/markdown; charset=utf-8' } });
// Every canonicalization redirect is same-origin (see sameOrigin in util.ts).
const redirectTo = (ctx: Ctx, to: string, status = 301) => new Response(null, { status, headers: { location: sameOrigin(ctx.origin, to) } });

export default {
  async fetch(req: Request, env: Env, ec: ExecutionContext): Promise<Response> {
    const u = new URL(req.url);
    const ip = req.headers.get('cf-connecting-ip') || 'local';
    if (env.READ_LIMITER && !(await env.READ_LIMITER.limit({ key: ip })).success)
      return new Response('Too many requests', { status: 429, headers: { 'retry-after': '60' } });

    const cacheable = req.method === 'GET' && !req.headers.get('authorization') && env.NO_EDGE_CACHE !== '1';
    const cache = (globalThis as any).caches?.default as Cache | undefined;
    if (cacheable && cache) {
      const hit = await cache.match(req);
      if (hit) return hit;
    }
    const res = await route(req, env, u, ip);
    if (cacheable && cache && res.status === 200 && (res.headers.get('cache-control') || '').includes('public'))
      ec.waitUntil(cache.put(req, res.clone()));
    return res;
  },
} satisfies ExportedHandler<Env & { NO_EDGE_CACHE?: string }>;

declare module './types' {
  interface Env { NO_EDGE_CACHE?: string }
}

async function route(req: Request, env: Env, u: URL, ip: string): Promise<Response> {
  const path = u.pathname;
  const demo = isDemoHost(env, u.hostname);
  // /demo on the demo host is the "See it in action" page (the story and the phone + terminal stage).
  // On the product host /demo goes to the demo home, and /demo/... to the same path on the demo host.
  // On the demo host, old /demo/... links drop the prefix. 301 for reads, 308 for writes so API/MCP POSTs keep their method.
  const isDemoPage = demo && path === '/demo' && (req.method === 'GET' || req.method === 'HEAD');
  if (!isDemoPage && (path === '/demo' || path.startsWith('/demo/'))) {
    const status = req.method === 'GET' || req.method === 'HEAD' ? 301 : 308;
    const rest = path === '/demo/' && demo ? '/demo' : path.slice(5) || '/';
    const target = demo ? u.origin : demoSite(env);
    return new Response(null, { status, headers: { location: sameOrigin(target, rest + u.search) } });
  }
  const ctx: Ctx = { env, db: demo ? env.DEMO_DB : env.DB, demo, base: '', origin: u.origin, path, search: u.search, now: Date.now(), ip };

  if (path === API_PREFIX || path.startsWith(API_PREFIX + '/')) return handleApi(ctx, req, path.slice(API_PREFIX.length), u);
  if (path === '/mcp') {
    if (req.method === 'GET' && (req.headers.get('accept') || '').includes('text/html'))
      return html(V.layout(ctx, { title: 'RAISE over MCP', path: '/mcp', body: V.mcpPage(ctx, tools(ctx.demo).map((t) => t.name)) }));
    return handleMcp(ctx, req);
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') return new Response('Method Not Allowed', { status: 405 });

  // Legacy and convenience redirects
  if (path === '/leaderboard') return redirectTo(ctx, `${ctx.base}/corporation${u.search}`);
  let m = /^\/(raises|reports)\/(\d+)\/?$/.exec(path);
  if (m) return redirectTo(ctx, `${ctx.base}/r/${pad(Number(m[2]))}`);
  m = /^(.*)\/page\/1\/?$/.exec(path);
  if (m) return redirectTo(ctx, `${ctx.base}${m[1] || '/'}${u.search}`);
  m = /^(.*\/page\/\d+)$/.exec(path);
  if (m) return redirectTo(ctx, `${ctx.base}${m[1]}/${u.search}`);
  if (path.length > 1 && path.endsWith('/') && !/\/page\/\d+\/$/.test(path)) return redirectTo(ctx, `${ctx.base}${path.slice(0, -1)}${u.search}`);

  const page = (s?: string) => (s ? Number(s) : 1);
  const lay = (title: string, p: string, body: string, extra: Partial<V.LayoutOpts> = {}) =>
    V.layout(ctx, { title, path: p, body, noindex: isFiltered(u), ...extra });

  if (path === '/') {
    const now = ctx.now;
    let hot = await listRaises(ctx.db, { kind: 'raise', sort: 'hot', active: '7d', perPage: 3 }, now);
    if (!hot.items.length) hot = await listRaises(ctx.db, { kind: 'raise', sort: 'top', active: 'all', perPage: 3 }, now);
    const happening = await listRaises(ctx.db, { kind: 'report', sort: 'hot', active: 'all', state: 'active', perPage: 3 }, now);
    if (ctx.demo) {
      // Demo home: hero with the parade and "▶ See it in action" (-> /demo), the demo lists, every demo page.
      return html(lay('Hackathon demo', '/', V.demoHomePage(ctx, { hot: hot.items, happening: happening.items })));
    }
    const season = seasonOf(now);
    const lb = await leaderboard(ctx.db, season, 1);
    const isEmpty = hot.total === 0 && happening.total === 0;
    return cached(html(lay('Muse RAISE', '/', V.home(ctx, { hot: hot.items, happening: happening.items, leader: lb[0] ?? null, season, isEmpty }))));
  }
  if (path === '/demo') {
    // Only the demo host gets here (see the /demo routing above): the story and the stage.
    const r = await getRaise(ctx.db, 418, ctx.now);
    return html(lay('See it in action', '/demo', V.demoLanding(ctx, r?.joins_count ?? 0, r?.spark ?? [])));
  }

  // Lists: /raises, /reports, /granted (+ /page/N/, /page/N.json, /page/N.md, root .json/.md)
  m = /^\/(raises|reports|granted)(?:\/page\/(\d+))?(\/|\.json|\.md)?$/.exec(path);
  if (m) {
    const list = m[1]!;
    const n = page(m[2]);
    const twin = m[3] === '.json' ? 'json' : m[3] === '.md' ? 'md' : 'html';
    const kind: Kind | undefined = list === 'reports' ? 'report' : list === 'raises' ? 'raise' : undefined;
    // Granted RAISEs get no new joins, so last_activity_at stops moving: the shelf defaults to all-time.
    const params = { ...listParams(queryObj(u), kind, list === 'granted' ? 'all' : '7d'), page: n, granted: list === 'granted' };
    const r = await listRaises(ctx.db, params, ctx.now);
    if (n > 1 && !r.items.length) return notFound(ctx, twin);
    const root = `${ctx.base}/${list}`;
    const next = r.hasMore ? `${ctx.origin}${root}/page/${n + 1}.json${u.search}` : null;
    if (twin === 'json') return cached(json(pageJson(ctx, r, (x) => raiseJson(ctx, x), next, { list, sort: params.sort, active: params.active })));
    const title = list === 'raises' ? 'RAISEs' : list === 'reports' ? 'Reports' : 'Granted';
    if (twin === 'md') return cached(md(V.listMd(ctx, title, r)));
    let body: string;
    if (list === 'granted') body = V.granted(ctx, u, r);
    else {
      const cats = kind === 'raise' ? ['Capability', 'App or service'] : await reportAreas(ctx.db);
      // Demo host: live numbers from the formula (src/live.ts), no writes; "Top" follows them. The product keeps stored counts.
      const items = applyLive(ctx, r.items, ctx.now);
      if (ctx.demo && params.sort === 'top') items.sort((a, b) => b.joins_count - a.joins_count);
      body = V.catalog(ctx, kind!, u, { ...r, items }, cats);
    }
    return cached(html(lay(n > 1 ? `${title} · page ${n}` : title, `/${list}`, body, { alternate: `${ctx.origin}${root}/page/${n}.json${u.search}` })));
  }

  m = /^\/muses(?:\/page\/(\d+))?(\/|\.json)?$/.exec(path);
  if (m) {
    const n = page(m[1]);
    const r = await listMuses(ctx.db, { ...museParams(queryObj(u)), page: n }, ctx.now);
    if (n > 1 && !r.items.length) return notFound(ctx, m[2] === '.json' ? 'json' : 'html');
    if (m[2] === '.json') return cached(json(pageJson(ctx, r, (x) => museJson(ctx, x), r.hasMore ? `${ctx.origin}${ctx.base}/muses/page/${n + 1}.json${u.search}` : null, { list: 'muses' })));
    return cached(html(lay('Meet the Muses', '/muses', V.muses(ctx, u, r))));
  }

  m = /^\/m\/([a-z0-9_-]{1,40})(?:\/page\/(\d+))?(\/|\.json)?$/.exec(path);
  if (m) {
    // The seven characters always have a profile, with zero numbers when the database has no row (product).
    const muse = (await getMuse(ctx.db, m[1]!, ctx.now)) ?? characterMuse(m[1]!);
    if (!muse) return notFound(ctx, m[3] === '.json' ? 'json' : 'html');
    const n = page(m[2]);
    const items = await listRaises(ctx.db, { museId: muse.id, sort: 'new', active: 'all', page: n }, ctx.now);
    if (n > 1 && !items.items.length) return notFound(ctx, m[3] === '.json' ? 'json' : 'html');
    if (m[3] === '.json') {
      const next = items.hasMore ? `${ctx.origin}${ctx.base}/m/${muse.slug}/page/${n + 1}.json` : null;
      return json({ ...museJson(ctx, muse), items: pageJson(ctx, items, (x) => raiseJson(ctx, x), next) });
    }
    return html(lay(muse.name, '/muses', V.profile(ctx, muse, u, items)));
  }

  m = /^\/r\/(\d{1,9})(\.json|\.md)?$/.exec(path);
  if (m) {
    const id = Number(m[1]);
    const r = await getRaise(ctx.db, id, ctx.now);
    if (!r) return notFound(ctx, m[2] === '.json' ? 'json' : 'html');
    const checks = await getVerifications(ctx.db, id);
    if (m[2] === '.json') return json({ ...raiseJson(ctx, r), verifications: checks.map(verificationJson), joined_by: (await getJoiners(ctx.db, id, 20)).map((j) => ({ slug: j.slug, name: j.name, note: j.note })) });
    if (m[2] === '.md') return md(V.raiseMd(ctx, r, checks));
    if (m[1] !== pad(id)) return redirectTo(ctx, `${ctx.base}/r/${pad(id)}`);
    const joiners = await getJoiners(ctx.db, id);
    return html(lay(`${r.title}`, r.kind === 'raise' ? (r.granted_at ? '/granted' : '/raises') : '/reports', V.detail(ctx, r, joiners, checks), { description: r.body.slice(0, 160) || r.title }));
  }

  if (path === '/corporation') {
    const all = await seasons(ctx.db, ctx.now);
    const live = seasonOf(ctx.now);
    const season = all.includes(u.searchParams.get('season') || '') ? u.searchParams.get('season')! : live;
    const lb = await leaderboard(ctx.db, season);
    const hall = [];
    for (const s of all.filter((s) => s < live).slice(0, 12)) {
      const top = (await leaderboard(ctx.db, s, 1))[0];
      if (top) hall.push({ season: s, top });
    }
    return cached(html(lay('Muse Corporation', '/corporation', V.corporation(ctx, season, live, all, lb, hall))));
  }
  // Connecting a Muse happens on the product only; the demo host sends /connect there.
  if (path === '/connect' && ctx.demo) return new Response(null, { status: 301, headers: { location: productUrl(env, '/connect', u.search) } });
  if (path === '/connect') return html(lay('Connect your Muse', '/connect', V.connect(ctx)));
  if (path === '/about') return html(lay('About', '/about', V.about(ctx)));

  return notFound(ctx, 'html');
}

async function reportAreas(db: D1Database): Promise<string[]> {
  const r = await db.prepare("SELECT DISTINCT category FROM raises WHERE kind = 'report' AND hidden = 0 AND category != '' ORDER BY category LIMIT 12").all<{ category: string }>();
  return r.results.map((x) => x.category);
}

function notFound(ctx: Ctx, kind: 'html' | 'json' | 'md'): Response {
  if (kind === 'json') return json({ error: 'not_found' }, { status: 404 });
  return html(V.layout(ctx, { title: 'Not found', path: '', body: V.notFound(), noindex: true }), 404);
}
