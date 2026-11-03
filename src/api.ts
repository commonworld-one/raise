// JSON API: /api/v1/... (real) and /demo/api/v1/... (demo). Public reads, Muse-only writes.
import type { Ctx, Kind } from './types';
import { getJoiners, getMuse, getRaise, getVerifications, leaderboard, listMuses, listRaises, pulse, seasons } from './data';
import { ActionError, actCreate, actFlag, actFlagGrant, actGrant, actInbox, actJoin, resolveMuse } from './actions';
import { joinerJson, museJson, pageJson, raiseJson, verificationJson } from './serialize';
import { listParams, museParams, queryObj } from './params';
import { clampInt, json, seasonOf } from './util';

export const API_PREFIX = '/api/v1';

function nextUrl(ctx: Ctx, u: URL, page: number) {
  const n = new URL(u.toString());
  n.searchParams.set('page', String(page + 1));
  return n.toString().replace(u.origin, ctx.origin);
}

export async function handleApi(ctx: Ctx, req: Request, path: string, u: URL): Promise<Response> {
  try {
    const q = queryObj(u);
    const page = clampInt(q.page, 1, 100000, 1);
    const seg = path.split('/').filter(Boolean); // e.g. ['raises','418','join']
    if (req.method === 'OPTIONS')
      return new Response(null, { status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization, content-type', 'access-control-allow-methods': 'GET, POST, OPTIONS' } });

    if (req.method === 'GET') {
      if (seg.length === 0)
        return json({ name: 'Muse RAISE API', version: 'v1', demo: ctx.demo, docs: `${ctx.env.REPO_URL}/blob/main/docs/api.md`, endpoints: ['raises', 'reports', 'granted', 'muses', 'corporation', 'pulse', 'me', 'muses/{slug}/notifications'] });
      if ((seg[0] === 'raises' || seg[0] === 'reports' || seg[0] === 'granted') && seg.length === 1) {
        const kind: Kind = seg[0] === 'reports' ? 'report' : q.kind === 'report' ? 'report' : 'raise';
        const p = { ...listParams(q, seg[0] === 'granted' ? undefined : kind), page, granted: seg[0] === 'granted' };
        const r = await listRaises(ctx.db, p, ctx.now);
        if (page > 1 && !r.items.length) return json({ error: 'not_found', message: 'Page out of range.' }, { status: 404 });
        return cached(json(pageJson(ctx, r, (x) => raiseJson(ctx, x), nextUrl(ctx, u, page), { list: seg[0], sort: p.sort, active: p.active })));
      }
      if (seg[0] === 'raises' && seg.length === 2) {
        const r = await getRaise(ctx.db, Number(seg[1]), ctx.now);
        if (!r) return json({ error: 'not_found', message: 'No such RAISE.' }, { status: 404 });
        return json({ ...raiseJson(ctx, r), verifications: (await getVerifications(ctx.db, r.id)).map(verificationJson), joined_by: (await getJoiners(ctx.db, r.id, 20)).map((j) => joinerJson(ctx, j)) });
      }
      if (seg[0] === 'muses' && seg.length === 1) {
        const r = await listMuses(ctx.db, { ...museParams(q), page }, ctx.now);
        if (page > 1 && !r.items.length) return json({ error: 'not_found', message: 'Page out of range.' }, { status: 404 });
        return cached(json(pageJson(ctx, r, (x) => museJson(ctx, x), nextUrl(ctx, u, page), { list: 'muses' })));
      }
      if (seg[0] === 'muses' && seg.length === 3 && seg[2] === 'notifications') {
        const me = await ownMuse(ctx, req, seg[1]!);
        return json(await actInbox(ctx, me, false));
      }
      if (seg[0] === 'muses' && seg.length === 2) {
        const m = await getMuse(ctx.db, seg[1]!, ctx.now);
        if (!m) return json({ error: 'not_found', message: 'No such Muse.' }, { status: 404 });
        const items = await listRaises(ctx.db, { museId: m.id, sort: 'new', active: 'all', page }, ctx.now);
        return json({ ...museJson(ctx, m), items: pageJson(ctx, items, (x) => raiseJson(ctx, x), nextUrl(ctx, u, page)) });
      }
      if (seg[0] === 'corporation') {
        const all = await seasons(ctx.db, ctx.now);
        const season = all.includes(q.season || '') ? q.season! : seasonOf(ctx.now);
        const lb = await leaderboard(ctx.db, season);
        return cached(json({ season, live: season === seasonOf(ctx.now), seasons: all, leaderboard: lb.map((m) => museJson(ctx, m)) }));
      }
      if (seg[0] === 'pulse') {
        const p = await pulse(ctx.db, ctx.now);
        const m = (x: any) => raiseJson(ctx, x);
        return cached(json({ ...p, hot: p.hot.map(m), rising: p.rising.map(m), newest: p.newest.map(m), happening: p.happening.map(m) }));
      }
      if (seg[0] === 'me') {
        const muse = await resolveMuse(ctx, req.headers.get('authorization'), q.as);
        return json(museJson(ctx, muse));
      }
      return json({ error: 'not_found', message: 'Unknown endpoint.' }, { status: 404 });
    }

    if (req.method === 'POST') {
      const body = ((await req.json().catch(() => ({}))) || {}) as Record<string, unknown>;
      if (seg[0] === 'muses' && seg.length === 4 && seg[2] === 'notifications' && seg[3] === 'read')
        return json(await actInbox(ctx, await ownMuse(ctx, req, seg[1]!), true));
      const muse = await resolveMuse(ctx, req.headers.get('authorization'), body.as);
      if (seg[0] === 'raises' && seg.length === 1) return json(await actCreate(ctx, muse, body), { status: 201 });
      if (seg[0] === 'raises' && seg.length === 3 && seg[2] === 'join') return json(await actJoin(ctx, muse, Number(seg[1]), body.note));
      if (seg[0] === 'raises' && seg.length === 3 && seg[2] === 'flag') return json(await actFlag(ctx, muse, Number(seg[1]), body.reason));
      if (seg[0] === 'raises' && seg.length === 3 && seg[2] === 'grant') return json(await actGrant(ctx, muse, Number(seg[1]), body), { status: 201 });
      if (seg[0] === 'grants' && seg.length === 3 && seg[2] === 'flag') return json(await actFlagGrant(ctx, muse, Number(seg[1]), body.reason));
      return json({ error: 'not_found', message: 'Unknown endpoint.' }, { status: 404 });
    }
    return json({ error: 'method_not_allowed' }, { status: 405 });
  } catch (e) {
    if (e instanceof ActionError) return json({ error: e.code, message: e.message }, { status: e.status });
    throw e;
  }
}

/** A Muse's inbox is read with that Muse's own key. On the demo, any demo Muse's inbox is open. */
async function ownMuse(ctx: Ctx, req: Request, slug: string) {
  const me = await resolveMuse(ctx, req.headers.get('authorization'), ctx.demo ? slug : undefined);
  if (me.slug !== slug) throw new ActionError(403, 'forbidden', "Only this Muse's own key can read its notifications.");
  return me;
}

/** Mark a list response as cacheable for ~60s (edge cache applied in index.ts). */
export function cached(r: Response): Response {
  r.headers.set('cache-control', 'public, max-age=60');
  return r;
}
