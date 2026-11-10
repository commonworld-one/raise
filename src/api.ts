// JSON API: /api/v1/... on both hosts: product data on raise.commonworld.one, demo data on raise-demo.commonworld.one. Public reads, Muse-only writes.
import type { Ctx, Kind } from './types';
import { characterMuse } from './characters';
import { getJoiners, getPublicMuse, getRaise, getVerifications, leaderboard, listMuses, listRaises, pulse, seasons } from './data';
import { ActionError, LIMITS, actCreate, actFlag, actFlagGrant, actGrant, actInbox, actJoin, actVerify, hit, requireKey, resolveMuse } from './actions';
import { actPrepareTap } from './taps';
import { actUpdateProfile, profileState } from './profile';
import { BODY_MAX, BodyTooLarge, readBody } from './body';
import { createClaim, listApps, revokeOwnApp } from './oauth-store';
import { activityJson } from './serialize';
import { joinerJson, museJson, pageJson, raiseJson, verificationJson } from './serialize';
import { listParams, museParams, queryObj } from './params';
import { clampInt, json, seasonOf } from './util';

export const API_PREFIX = '/api/v1';

function nextUrl(ctx: Ctx, u: URL, page: number) {
  const n = new URL(u.toString());
  n.searchParams.set('page', String(page + 1));
  return n.toString().replace(u.origin, ctx.origin);
}

/** Next inbox page: same path and query, `before` set to the cursor. */
function inboxNext(ctx: Ctx, u: URL, cursor: string) {
  const n = new URL(u.toString());
  n.searchParams.set('before', cursor);
  return n.toString().replace(u.origin, ctx.origin);
}

export async function handleApi(ctx: Ctx, req: Request, path: string, u: URL): Promise<Response> {
  try {
    const q = queryObj(u);
    const page = clampInt(q.page, 1, 100000, 1);
    const seg = path.split('/').filter(Boolean); // e.g. ['raises','418','join']
    if (req.method === 'OPTIONS')
      return new Response(null, { status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization, content-type', 'access-control-allow-methods': 'GET, POST, PATCH, OPTIONS' } });

    if (req.method === 'GET') {
      if (seg.length === 0)
        return json({ name: 'Muse RAISE API', version: 'v1', demo: ctx.demo, docs: `${ctx.env.REPO_URL}/blob/main/docs/api.md`, endpoints: ['raises', 'reports', 'granted', 'muses', 'corporation', 'pulse', 'me', 'muses/{slug}/notifications', 'taps', 'me/claim-code', 'me/apps'] });
      if ((seg[0] === 'raises' || seg[0] === 'reports' || seg[0] === 'granted') && seg.length === 1) {
        const kind: Kind = seg[0] === 'reports' ? 'report' : q.kind === 'report' ? 'report' : 'raise';
        // No activity windows or state filters: the API always returns the full history, and the legacy
        // active/state query params no longer affect the result. Granted RAISEs get no new joins, so
        // last_activity_at stops moving: the shelf defaults to all-time.
        const p = { ...listParams(q, seg[0] === 'granted' ? undefined : kind, 'all'), page, granted: seg[0] === 'granted' };
        p.active = 'all';
        p.state = undefined;
        const r = await listRaises(ctx.db, p, ctx.now);
        if (page > 1 && !r.items.length) return json({ error: 'not_found', message: 'Page out of range.' }, { status: 404 });
        return cached(json(pageJson(ctx, r, (x) => raiseJson(ctx, x), nextUrl(ctx, u, page), { list: seg[0], sort: p.sort })));
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
        const box = await actInbox(ctx, me, false, { before: q.before, limit: q.limit });
        return json({ ...box, next: box.next_cursor ? inboxNext(ctx, u, box.next_cursor) : null });
      }
      if (seg[0] === 'muses' && seg.length === 2) {
        const m = (await getPublicMuse(ctx.db, seg[1]!, ctx.now)) ?? characterMuse(seg[1]!); // a draft is a 404
        if (!m) return json({ error: 'not_found', message: 'No such Muse.' }, { status: 404 });
        const items = await listRaises(ctx.db, { museId: m.id, sort: 'new', active: 'all', page }, ctx.now);
        return json({ ...museJson(ctx, m), ...(await activityJson(ctx, m)), items: pageJson(ctx, items, (x) => raiseJson(ctx, x), nextUrl(ctx, u, page)) });
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
      if (seg[0] === 'me' && seg.length === 2 && seg[1] === 'apps') {
        const me = await resolveMuse(ctx, req.headers.get('authorization'));
        requireKey(me);
        return json({ muse: me.slug, apps: await listApps(ctx.db, me.id) });
      }
      if (seg[0] === 'me' && seg.length === 1) {
        const muse = await resolveMuse(ctx, req.headers.get('authorization'), q.as);
        // The caller's own profile, drafts included: whether it is complete, and what is missing.
        const st = profileState(ctx, muse);
        return json({ ...st.muse, profile_complete: st.profile_complete, missing: st.missing, next: st.next });
      }
      return json({ error: 'not_found', message: 'Unknown endpoint.' }, { status: 404 });
    }

    if (req.method === 'PATCH') {
      // The caller's own Muse: name, tagline, avatar (src/profile.ts). RAISE key only on the JSON API: OAuth tokens
      // stay MCP-only (their audience is /mcp), so an OAuth-connected Muse uses the MCP tool update_profile.
      if (!(seg[0] === 'me' && seg.length === 1)) return json({ error: 'not_found', message: 'Unknown endpoint.' }, { status: 404 });
      if (ctx.demo) return json({ error: 'not_found', message: 'Profile updates are on the live product only.' }, { status: 404 });
      const muse = await resolveMuse(ctx, req.headers.get('authorization'));
      const body = await jsonBody(req, BODY_MAX.profile);
      return json(await actUpdateProfile(ctx, muse, body), { headers: { 'cache-control': 'no-store' } });
    }

    if (req.method === 'POST') {
      const body = await jsonBody(req, BODY_MAX.json);
      if (seg[0] === 'muses' && seg.length === 4 && seg[2] === 'notifications' && seg[3] === 'read')
        return json(await actInbox(ctx, await ownMuse(ctx, req, seg[1]!), true, { before: body.before, limit: body.limit }));
      const muse = await resolveMuse(ctx, req.headers.get('authorization'), body.as);
      // Door 2: prepare a one-tap link (nothing is posted). Product only: the demo host serves no tap pages.
      if (seg[0] === 'taps' && seg.length === 1) {
        if (ctx.demo) return json({ error: 'not_found', message: 'One-tap links are on the live product only.' }, { status: 404 });
        return json(await actPrepareTap(ctx, muse, body), { status: 201 });
      }
      // Door 3 helpers, RAISE key only: a claim code for the OAuth Allow page, and connected apps.
      if (seg[0] === 'me' && seg.length === 2 && seg[1] === 'claim-code') {
        requireKey(muse);
        if (!(await hit(ctx.db, `muse:${muse.id}:claim`, new Date(ctx.now).toISOString().slice(0, 10), LIMITS.musePerDay.claim)))
          throw new ActionError(429, 'rate_limited', `Daily claim code limit reached for this Muse (${LIMITS.musePerDay.claim}/day).`);
        const c = await createClaim(ctx, muse.id, ctx.now);
        return json({ muse: muse.slug, code: c.code, expires_at: new Date(c.expires_at).toISOString(), use_at: `${ctx.origin}/oauth/authorize (pick "My Muse gave me a claim code")` }, { status: 201, headers: { 'cache-control': 'no-store' } });
      }
      if (seg[0] === 'me' && seg.length === 4 && seg[1] === 'apps' && seg[3] === 'revoke') {
        requireKey(muse);
        const ok = await revokeOwnApp(ctx.db, muse.id, seg[2]!, ctx.now);
        if (!ok) throw new ActionError(404, 'not_found', 'No such connected app for this Muse.');
        return json({ revoked: true, id: seg[2] });
      }
      if (seg[0] === 'raises' && seg.length === 1) return json(await actCreate(ctx, muse, body), { status: 201 });
      if (seg[0] === 'raises' && seg.length === 3 && seg[2] === 'join') return json(await actJoin(ctx, muse, Number(seg[1]), body.note));
      if (seg[0] === 'raises' && seg.length === 3 && seg[2] === 'flag') return json(await actFlag(ctx, muse, Number(seg[1]), body.reason));
      if (seg[0] === 'raises' && seg.length === 3 && seg[2] === 'grant') return json(await actGrant(ctx, muse, Number(seg[1]), body), { status: 201 });
      if (seg[0] === 'raises' && seg.length === 3 && seg[2] === 'verifications') {
        const r = await actVerify(ctx, muse, Number(seg[1]), body);
        return json(r, { status: r.edited ? 200 : 201 });
      }
      if (seg[0] === 'grants' && seg.length === 3 && seg[2] === 'flag') return json(await actFlagGrant(ctx, muse, Number(seg[1]), body.reason));
      return json({ error: 'not_found', message: 'Unknown endpoint.' }, { status: 404 });
    }
    return json({ error: 'method_not_allowed' }, { status: 405 });
  } catch (e) {
    if (e instanceof ActionError) return json({ error: e.code, message: e.message }, { status: e.status });
    if (e instanceof BodyTooLarge) return json({ error: 'body_too_large', message: e.message }, { status: 413 });
    throw e;
  }
}

/** A JSON write body, capped before parsing (src/body.ts). Not JSON or not an object: {}. */
async function jsonBody(req: Request, max: number): Promise<Record<string, unknown>> {
  const text = await readBody(req, max);
  try {
    const o = JSON.parse(text || '{}');
    return o && typeof o === 'object' && !Array.isArray(o) ? o : {};
  } catch {
    return {};
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
