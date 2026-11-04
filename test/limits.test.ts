// Body caps (src/body.ts), the JSON-RPC batch limit and order on /mcp, and the per-IP READ_LIMITER (src/index.ts).
import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { BASE, get, makeMuse } from './helpers';
import { BODY_MAX, BodyTooLarge, readBody } from '../src/body';
import { MAX_BATCH } from '../src/mcp';
import worker from '../src/index';

const rpc = (body: unknown, opts: { key?: string; path?: string; raw?: BodyInit; headers?: Record<string, string> } = {}) =>
  get(opts.path || '/mcp', { method: 'POST', body: opts.raw ?? JSON.stringify(body), headers: { 'content-type': 'application/json', 'cf-connecting-ip': '10.60.0.1', ...(opts.key ? { authorization: `Bearer ${opts.key}` } : {}), ...(opts.headers || {}) } });
const tool = (id: number, name: string, args: Record<string, unknown>) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });

/** A body with no Content-Length (a stream), so only the cap on the actual read can stop it. */
function streamed(bytes: number): ReadableStream<Uint8Array> {
  let sent = 0;
  return new ReadableStream({
    pull(c) {
      if (sent >= bytes) return c.close();
      const n = Math.min(8192, bytes - sent);
      c.enqueue(new TextEncoder().encode(' '.repeat(n)));
      sent += n;
    },
  });
}

describe('body caps', () => {
  it('readBody: refuses by Content-Length before reading, and by bytes read when there is none', async () => {
    const declared = new Request(BASE, { method: 'POST', body: 'x', headers: { 'content-length': String(BODY_MAX.json + 1) } });
    await expect(readBody(declared, BODY_MAX.json)).rejects.toBeInstanceOf(BodyTooLarge);
    const stream = new Request(BASE, { method: 'POST', body: streamed(BODY_MAX.json + 10), duplex: 'half' } as RequestInit);
    expect(stream.headers.get('content-length')).toBeNull();
    await expect(readBody(stream, BODY_MAX.json)).rejects.toBeInstanceOf(BodyTooLarge);
    expect(await readBody(new Request(BASE, { method: 'POST', body: '{"a":1}' }), 16)).toBe('{"a":1}');
  });

  it('/mcp and /mcp/me: over 64 KB without a credential is 413 with a JSON-RPC error, nothing parsed', async () => {
    const big = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', params: { pad: 'x'.repeat(BODY_MAX.json) } });
    const r = await rpc(null, { raw: big });
    expect(r.status).toBe(413);
    expect(((await r.json()) as any).error.code).toBe(-32600);
    const m = await makeMuse('capmcp');
    // With a credential the cap is 400 KB (an avatar image fits); over that is 413 too, on /mcp/me as well.
    expect((await rpc(null, { raw: big, key: m.key })).status).toBe(200);
    const huge = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', params: { pad: 'x'.repeat(BODY_MAX.profile) } });
    expect((await rpc(null, { raw: huge, key: m.key, path: '/mcp/me' })).status).toBe(413);
    // A stream with no Content-Length is cut on the read.
    expect((await rpc(null, { raw: streamed(BODY_MAX.json + 100) as any })).status).toBe(413);
  });

  it('JSON API writes are capped at 64 KB; OAuth forms at 8 KB', async () => {
    const m = await makeMuse('capapi');
    const r = await get('/api/v1/raises', { method: 'POST', body: JSON.stringify({ title: 'A big one here', wish: 'x'.repeat(BODY_MAX.json) }), headers: { 'content-type': 'application/json', authorization: `Bearer ${m.key}`, 'cf-connecting-ip': '10.60.0.2' } });
    expect([r.status, ((await r.json()) as any).error]).toEqual([413, 'body_too_large']);
    const t = await get('/oauth/token', { method: 'POST', body: 'grant_type=refresh_token&x=' + 'y'.repeat(BODY_MAX.form), headers: { 'content-type': 'application/x-www-form-urlencoded', 'cf-connecting-ip': '10.60.0.3' } });
    expect(t.status).toBe(413);
    const a = await get('/oauth/authorize', { method: 'POST', body: 'x=' + 'y'.repeat(BODY_MAX.form), headers: { 'content-type': 'application/x-www-form-urlencoded', 'cf-connecting-ip': '10.60.0.4' } });
    expect(a.status).toBe(413);
  });
});

describe('JSON-RPC batches', () => {
  it(`hold at most ${MAX_BATCH} messages; an empty batch is an error too`, async () => {
    const ping = (id: number) => ({ jsonrpc: '2.0', id, method: 'ping' });
    const ok = await rpc(Array.from({ length: MAX_BATCH }, (_, i) => ping(i)));
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as any[]).length).toBe(MAX_BATCH);
    const over = await rpc(Array.from({ length: MAX_BATCH + 1 }, (_, i) => ping(i)));
    expect(over.status).toBe(400);
    const e = (await over.json()) as any;
    expect(e.error.code).toBe(-32600);
    expect(e.error.message).toContain(`at most ${MAX_BATCH}`);
    expect((await rpc([])).status).toBe(400);
  });

  it('run one at a time, in order: a later call sees what an earlier one wrote, and the daily limit hits the last ones', async () => {
    const m = await makeMuse('batchseq');
    const word = `seqword${Date.now()}`;
    const batch = [
      tool(1, 'create_raise', { title: `Sequential ${word} one`, wish: 'First.' }),
      tool(2, 'search_raises', { query: word }),
      ...[3, 4, 5, 6, 7].map((id) => tool(id, 'create_raise', { title: `Sequential ${word} n${id}`, wish: 'More.' })),
    ];
    const out = (await (await rpc(batch, { key: m.key })).json()) as any[];
    expect(out.map((x) => x.id)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    // The search (2nd) sees the RAISE the 1st call created.
    expect(out[1].result.structuredContent.items.map((i: any) => i.title)).toEqual([`Sequential ${word} one`]);
    // 5 creates a day: calls 1, 3, 4, 5, 6 pass, call 7 (the last) is the one refused.
    expect(out.map((x) => x.result.isError)).toEqual([false, false, false, false, false, false, true]);
    expect(out[6].result.structuredContent.error).toBe('rate_limited');
    const ids = out.filter((x, i) => i !== 1 && !x.result.isError).map((x) => x.result.structuredContent.id);
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
  });
});

describe('READ_LIMITER', () => {
  it('is bound from wrangler.jsonc', () => {
    expect(typeof (env as any).READ_LIMITER?.limit).toBe('function');
  });
  it('answers 429 with Retry-After when the per-IP limit says no, and keys by the client IP', async () => {
    const keys: string[] = [];
    const limiter = { limit: async ({ key }: { key: string }) => (keys.push(key), { success: false }) };
    const ctx = createExecutionContext();
    const r = await worker.fetch(new Request(`${BASE}/raises`, { headers: { 'cf-connecting-ip': '10.60.9.9' } }), { ...(env as any), NO_READ_LIMIT: undefined, READ_LIMITER: limiter }, ctx);
    await waitOnExecutionContext(ctx);
    expect(r.status).toBe(429);
    expect(r.headers.get('retry-after')).toBe('60');
    expect(keys).toEqual(['10.60.9.9']);
  });
  it('without the binding, requests go through', async () => {
    const ctx = createExecutionContext();
    const r = await worker.fetch(new Request(`${BASE}/about`), { ...(env as any), NO_READ_LIMIT: undefined, READ_LIMITER: undefined }, ctx);
    await waitOnExecutionContext(ctx);
    expect(r.status).toBe(200);
  });
});
