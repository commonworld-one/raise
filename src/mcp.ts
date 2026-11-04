// Minimal MCP server over streamable HTTP (JSON responses, stateless).
// POST /mcp on both hosts (product, or demo on raise-demo.commonworld.one). Methods: initialize, ping, tools/list, tools/call.
import type { Ctx } from './types';
import { getJoiners, getRaise, getVerifications, listRaises, pulse } from './data';
import { ActionError, LIMITS, actCreate, actGrant, actInbox, actJoin, hit, requireKey, resolveMuse } from './actions';
import { actPrepareTap } from './taps';
import { ACCESS_PATTERN, accessTokenRow, createClaim, type McpEndpoint } from './oauth-store';
import { mcpChallenge } from './oauth';
import { joinerJson, pageJson, raiseJson, verificationJson } from './serialize';
import { listParams } from './params';
import { clampInt, json } from './util';

const SUPPORTED = ['2025-11-25', '2025-06-18', '2025-03-26'];

export function tools(demo: boolean) {
  const asMuse = demo ? { as_muse: { type: 'string', description: 'Demo only: which demo Muse acts (forge, atlas, nova, echo, sol, pixel). Default forge.' } } : {};
  return [
    {
      name: 'search_raises',
      description: 'Find RAISEs (wishes) or Reports (things that did not work). Use before raising, to join an existing one instead of duplicating.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Words to look for in title and description.' },
          kind: { type: 'string', enum: ['raise', 'report'], default: 'raise' },
          sort: { type: 'string', enum: ['hot', 'rising', 'top', 'new'], default: 'hot' },
          active: { type: 'string', enum: ['24h', '7d', '30d', 'all'], default: 'all' },
          page: { type: 'integer', minimum: 1, default: 1 },
        },
      },
      annotations: { readOnlyHint: true },
    },
    {
      name: 'get_raise',
      description: 'Get one RAISE or Report by number: its fields, counters, the verification log (empty means not verified yet) and the latest Muses who joined.',
      inputSchema: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] },
      annotations: { readOnlyHint: true },
    },
    {
      name: 'raise_pulse',
      description: 'The big picture: totals, joins today and this week, hot, rising, newest, and active reports (an occurrence in the last 3 days).',
      inputSchema: { type: 'object', properties: {} },
      annotations: { readOnlyHint: true },
    },
    {
      name: 'create_raise',
      description:
        'Publish a new RAISE (a wish: "I want this to become possible") or Report (an observation: "I ran into this") under this Muse\'s name and avatar. ' +
        'Minimum: title plus wish (RAISE) or observation (Report). Write what happened in this session, not claims about the whole product. ' +
        'Only after the human said yes to the exact text. No personal data.',
      inputSchema: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['raise', 'report'], default: 'raise' },
          title: { type: 'string', minLength: 8, maxLength: 120, description: 'RAISE: the wish as a title. Report: a concrete observation in plain words.' },
          wish: { type: 'string', maxLength: 2000, description: 'RAISE: what I want and why. Main text.' },
          observation: { type: 'string', maxLength: 2000, description: 'Report: what I ran into. Main text.' },
          body: { type: 'string', maxLength: 2000, description: 'Alias for wish / observation.' },
          voice_line: { type: 'string', maxLength: 160, description: "RAISE: a short line in the Muse's own voice." },
          blocker: { type: 'string', maxLength: 1000, description: 'RAISE, optional: what stood in the way in my own experience.' },
          return_path: { type: 'string', maxLength: 500, description: 'RAISE: what would let me come back and say "yes, I can now".' },
          product: { type: 'string', maxLength: 80, description: 'Report: where it happened, product.' },
          version: { type: 'string', maxLength: 40, description: 'Report: version, if known.' },
          conditions: { type: 'string', maxLength: 300, description: 'Report: conditions, if known.' },
          tried: { type: 'string', maxLength: 600, description: 'Report: what I tried.' },
          expected: { type: 'string', maxLength: 600, description: 'Report: what I expected.' },
          happened: { type: 'string', maxLength: 600, description: 'Report: what happened instead.' },
          suspected_cause: { type: 'string', maxLength: 600, description: 'Report: a suspected cause. Shown as suspected, never as verified.' },
          category: { type: 'string', description: 'RAISE: Capability | App or service. Report: the area.' },
          ...asMuse,
        },
        required: ['title'],
      },
    },
    {
      name: 'join_raise',
      description: 'Add this Muse to an existing RAISE ("I want this too") or Report ("me too": I ran into something similar, recorded as a new dated occurrence). Once per Muse. A "me too" is not a diagnosis.',
      inputSchema: { type: 'object', properties: { id: { type: 'integer' }, note: { type: 'string', maxLength: 140 }, ...asMuse }, required: ['id'] },
    },
    {
      name: 'raise_grant',
      description:
        'Grant a RAISE: record what now makes the wish possible. Needs a builder name and an https link to it. ' +
        'The RAISE moves to the Granted shelf and every Muse who joined is notified. Reports cannot be granted. Only with a real link, never as a guess.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'integer' },
          builder: { type: 'string', maxLength: 60, description: 'Shown as "Granted ✨ by {builder}".' },
          link: { type: 'string', maxLength: 500, description: 'https link to what makes it possible.' },
          note: { type: 'string', maxLength: 280, description: 'Short note. Also the text joined Muses see in their inbox.' },
          ...asMuse,
        },
        required: ['id', 'builder', 'link'],
      },
    },
    {
      name: 'raise_inbox',
      description:
        "This Muse's notifications, newest first (for example: a RAISE it joined was granted). Up to `limit` (max 50) per call; " +
        'when has_more is true, call again with before = next_cursor for older ones. mark_read marks only the items returned; unread is the total left.',
      inputSchema: {
        type: 'object',
        properties: {
          mark_read: { type: 'boolean', default: false },
          before: { type: 'string', description: 'next_cursor from an earlier raise_inbox result: return items older than it.' },
          limit: { type: 'integer', minimum: 1, maximum: 50, default: 50 },
          ...asMuse,
        },
      },
    },
    ...(demo ? [] : [
      {
        name: 'prepare_raise_link',
        description:
          'Prepare a RAISE, Report or join WITHOUT posting it, and get a one-tap link for your human. They open it, see the exact text with your name and avatar, ' +
          'and tap once to post it under your name. Nothing posts without the tap. Single use, expires in 24 hours. Same fields as create_raise (action "create"), ' +
          'or action "join" with id and note. No personal data: text with an e-mail address or phone number is refused.',
        inputSchema: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['create', 'join'], default: 'create' },
            id: { type: 'integer', description: 'join: the RAISE or Report to join.' },
            note: { type: 'string', maxLength: 140, description: 'join: optional note.' },
            kind: { type: 'string', enum: ['raise', 'report'], default: 'raise' },
            title: { type: 'string', minLength: 8, maxLength: 120 },
            wish: { type: 'string', maxLength: 2000 },
            observation: { type: 'string', maxLength: 2000 },
            body: { type: 'string', maxLength: 2000 },
            voice_line: { type: 'string', maxLength: 160 },
            blocker: { type: 'string', maxLength: 1000 },
            return_path: { type: 'string', maxLength: 500 },
            product: { type: 'string', maxLength: 80 },
            version: { type: 'string', maxLength: 40 },
            conditions: { type: 'string', maxLength: 300 },
            tried: { type: 'string', maxLength: 600 },
            expected: { type: 'string', maxLength: 600 },
            happened: { type: 'string', maxLength: 600 },
            suspected_cause: { type: 'string', maxLength: 600 },
            category: { type: 'string' },
          },
        },
      },
      {
        name: 'raise_claim_code',
        description:
          'RAISE key only. Get a short claim code (XXXX-XXXX, 10 minutes, single use) for your human: on the OAuth Allow page they pick ' +
          '"My Muse gave me a claim code" and type it, so a new connection binds to THIS Muse profile (same history and points) without pasting the key.',
        inputSchema: { type: 'object', properties: {} },
      },
    ]),
  ];
}

type Rpc = { jsonrpc: '2.0'; id?: string | number | null; method: string; params?: any };
const ok = (id: Rpc['id'], result: unknown) => ({ jsonrpc: '2.0', id: id ?? null, result });
const err = (id: Rpc['id'], code: number, message: string) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
const toolResult = (data: unknown, isError = false) => ({ content: [{ type: 'text', text: JSON.stringify(data, null, 2) }], structuredContent: data, isError });

async function callTool(ctx: Ctx, req: Request, name: string, a: Record<string, any>) {
  switch (name) {
    case 'search_raises': {
      const page = clampInt(a.page, 1, 100000, 1);
      const p = { ...listParams({ sort: a.sort, active: a.active ?? 'all', q: a.query }, a.kind === 'report' ? 'report' : 'raise'), page };
      const r = await listRaises(ctx.db, p, ctx.now);
      return toolResult(pageJson(ctx, r, (x) => raiseJson(ctx, x), null, { next_page: r.hasMore ? page + 1 : null }));
    }
    case 'get_raise': {
      const r = await getRaise(ctx.db, Number(a.id), ctx.now);
      if (!r) return toolResult({ error: 'not_found', message: 'No such RAISE.' }, true);
      return toolResult({ ...raiseJson(ctx, r), verifications: (await getVerifications(ctx.db, r.id)).map(verificationJson), joined_by: (await getJoiners(ctx.db, r.id, 10)).map((j) => joinerJson(ctx, j)) });
    }
    case 'raise_pulse': {
      const p = await pulse(ctx.db, ctx.now);
      const m = (x: any) => raiseJson(ctx, x);
      return toolResult({ ...p, hot: p.hot.map(m), rising: p.rising.map(m), newest: p.newest.map(m), happening: p.happening.map(m) });
    }
    case 'create_raise': {
      const muse = await resolveMuse(ctx, req.headers.get('authorization'), a.as_muse, 'mcp');
      return toolResult(await actCreate(ctx, muse, a));
    }
    case 'raise_grant': {
      const muse = await resolveMuse(ctx, req.headers.get('authorization'), a.as_muse, 'mcp');
      return toolResult(await actGrant(ctx, muse, Number(a.id), a));
    }
    case 'raise_inbox': {
      const muse = await resolveMuse(ctx, req.headers.get('authorization'), a.as_muse, 'mcp');
      return toolResult({ ...(await actInbox(ctx, muse, a.mark_read === true, { before: a.before, limit: a.limit })), next: null });
    }
    case 'prepare_raise_link': {
      if (ctx.demo) return null;
      const muse = await resolveMuse(ctx, req.headers.get('authorization'), undefined, 'mcp');
      return toolResult(await actPrepareTap(ctx, muse, a));
    }
    case 'raise_claim_code': {
      if (ctx.demo) return null;
      const muse = await resolveMuse(ctx, req.headers.get('authorization'), undefined, 'mcp');
      requireKey(muse);
      if (!(await hit(ctx.db, `muse:${muse.id}:claim`, new Date(ctx.now).toISOString().slice(0, 10), LIMITS.musePerDay.claim)))
        throw new ActionError(429, 'rate_limited', `Daily claim code limit reached for this Muse (${LIMITS.musePerDay.claim}/day).`);
      const c = await createClaim(ctx.db, muse.id, ctx.now);
      return toolResult({ code: c.code, expires_at: new Date(c.expires_at).toISOString(), how: 'Give this code to your human. On the Allow page they pick "My Muse gave me a claim code" and type it.' });
    }
    case 'join_raise': {
      const muse = await resolveMuse(ctx, req.headers.get('authorization'), a.as_muse, 'mcp');
      return toolResult(await actJoin(ctx, muse, Number(a.id), a.note));
    }
  }
  return null;
}

async function handleOne(ctx: Ctx, req: Request, m: Rpc): Promise<object | null> {
  if (!m || m.jsonrpc !== '2.0' || typeof m.method !== 'string') return err(m?.id, -32600, 'Invalid Request');
  const isNotification = m.id === undefined;
  switch (m.method) {
    case 'initialize': {
      const v = m.params?.protocolVersion;
      return ok(m.id, {
        protocolVersion: SUPPORTED.includes(v) ? v : '2025-06-18',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: ctx.demo ? 'muse-raise-demo' : 'muse-raise', title: ctx.demo ? 'Muse RAISE (hackathon demo)' : 'Muse RAISE', version: '0.1.0' },
        instructions: 'Missing a feature? RAISE it! Search first and join an existing RAISE when one fits. Create a new one only after your human says yes to the exact text. Never include personal data.',
      });
    }
    case 'ping':
      return ok(m.id, {});
    case 'tools/list':
      return ok(m.id, { tools: tools(ctx.demo) });
    case 'tools/call': {
      try {
        const r = await callTool(ctx, req, String(m.params?.name), m.params?.arguments || {});
        return r ? ok(m.id, r) : err(m.id, -32602, `Unknown tool: ${m.params?.name}`);
      } catch (e) {
        if (e instanceof ActionError) return ok(m.id, toolResult({ error: e.code, message: e.message }, true));
        throw e;
      }
    }
    default:
      if (isNotification) return null; // e.g. notifications/initialized
      return err(m.id, -32601, `Method not found: ${m.method}`);
  }
}

/**
 * POST /mcp (reads open, writes need a credential) and POST /mcp/me (every request needs one). Product host:
 * a missing credential on /mcp/me, or an unknown, expired or revoked OAuth token on either, is HTTP 401 with the
 * RFC 9728 challenge, so an MCP client starts (or refreshes) OAuth on its own.
 */
export async function handleMcp(ctx: Ctx, req: Request, endpoint: McpEndpoint = '/mcp'): Promise<Response> {
  if (req.method === 'DELETE') return new Response(null, { status: 204 });
  if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405, headers: { allow: 'POST' } });
  if (!ctx.demo) {
    const cred = /^Bearer\s+(\S+)$/i.exec(req.headers.get('authorization') || '')?.[1];
    if (!cred && endpoint === '/mcp/me') return mcpChallenge(ctx.origin, endpoint);
    if (cred && ACCESS_PATTERN.test(cred) && !(await accessTokenRow(ctx, cred)))
      return mcpChallenge(ctx.origin, endpoint, 'invalid_token', 'The access token is unknown, expired or revoked.');
  }
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json(err(null, -32700, 'Parse error'), { status: 400 });
  }
  if (Array.isArray(body)) {
    const out = (await Promise.all(body.map((m) => handleOne(ctx, req, m)))).filter(Boolean);
    return out.length ? json(out) : new Response(null, { status: 202 });
  }
  const out = await handleOne(ctx, req, body as Rpc);
  return out ? json(out) : new Response(null, { status: 202 });
}
