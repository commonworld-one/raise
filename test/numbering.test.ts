import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { BASE, DEMO, dget, get, makeMuse, post } from './helpers';

const pad4 = (n: number) => String(n).padStart(4, '0');
const rpc = (body: unknown, key?: string) =>
  get('/mcp', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(key ? { authorization: `Bearer ${key}` } : {}) } });

/**
 * Separate public numbering per kind (migration 0012): RAISE #0001... and REPORT #0001...
 * The internal integer id stays the technical key; the per-kind seq is the public number.
 * The demo host keeps its id-based story numbers and addresses.
 */
describe('separate numbering (product)', () => {
  it('create assigns the next per-kind number, kinds are independent, response carries number/ref/canonical url', async () => {
    const m = await makeMuse('numalloc');
    const mk = async (kind: 'raise' | 'report', title: string) =>
      (await (await post('/api/v1/raises', kind === 'raise' ? { kind, title, wish: 'w' } : { kind, title, observation: 'o' }, m.key)).json()) as any;
    const r1 = await mk('raise', 'Numbering alloc raise one');
    const r2 = await mk('raise', 'Numbering alloc raise two');
    const p1 = await mk('report', 'Numbering alloc report one');
    const r3 = await mk('raise', 'Numbering alloc raise three');
    expect(r1.number).toBe(1);
    expect(r2.number).toBe(2);
    expect(p1.number).toBe(1); // reports have their own sequence
    expect(r3.number).toBe(3); // a report does not consume a RAISE number
    expect(r1.url).toBe(`${BASE}/raises/0001`);
    expect(p1.url).toBe(`${BASE}/reports/0001`);
    expect(r1.id).not.toBe(r2.id); // internal ids stay distinct and global
  });

  it('card pages live at /raises/NNNN and /reports/NNNN; badge matches the address; /r/{id} redirects permanently', async () => {
    const m = await makeMuse('numpages');
    const c = (await (await post('/api/v1/raises', { title: 'Numbering page raise', wish: 'w' }, m.key)).json()) as any;
    const p = (await (await post('/api/v1/raises', { kind: 'report', title: 'Numbering page report', observation: 'o' }, m.key)).json()) as any;

    const cN = pad4(c.number), pN = pad4(p.number);
    const raise = await get(`/raises/${cN}`);
    expect(raise.status).toBe(200);
    const rt = await raise.text();
    expect(rt).toContain(`RAISE #${cN}`);
    expect(rt).toContain(`${BASE}/raises/${cN}`); // canonical/og address

    const report = await get(`/reports/${pN}`);
    expect(report.status).toBe(200);
    expect(await report.text()).toContain(`REPORT #${pN}`);

    // Same number, different kind: different cards, no collision.
    const twin = (await (await get(`/raises/${pN}.json`)).json()) as any;
    expect(twin.kind).toBe('raise');
    expect(twin.id).not.toBe(p.id);
    const rj = (await (await get(`/reports/${pN}.json`)).json()) as any;
    expect(rj.id).toBe(p.id);
    expect(rj.number).toBe(p.number);
    expect(rj.ref).toBe(`REPORT-${pN}`);
    expect(rj.url).toBe(`${BASE}/reports/${pN}`);

    // Unpadded number canonicalizes.
    const unpadded = await get(`/raises/${c.number}`, { redirect: 'manual' });
    expect(unpadded.status).toBe(301);
    expect(unpadded.headers.get('location')).toBe(`${BASE}/raises/${cN}`);

    // The short id link keeps working as a permanent redirect.
    const legacy = await get(`/r/${pad4(c.id)}`, { redirect: 'manual' });
    expect(legacy.status).toBe(301);
    expect(legacy.headers.get('location')).toBe(`${BASE}/raises/${cN}`);

    // The old redirect meaning is gone: /raises/{global id of the report} is not the report.
    expect((await get(`/raises/${p.id}`)).status).toBe(404);
    // Numbers past the end are 404.
    expect((await get('/raises/9999')).status).toBe(404);
    expect((await get(`/reports/${p.number + 100}`)).status).toBe(404);
  });

  it('API: bare id keeps its global meaning; per-kind number is explicit only on /raise/{seq} and /report/{seq}', async () => {
    const m = await makeMuse('numapi');
    const c = (await (await post('/api/v1/raises', { title: 'Numbering api raise', wish: 'w' }, m.key)).json()) as any;
    const p = (await (await post('/api/v1/raises', { kind: 'report', title: 'Numbering api report', observation: 'o' }, m.key)).json()) as any;

    // Global id path: the report (id 2) is read as the object with id 2, not "number 2".
    const byId = (await (await get(`/api/v1/raises/${p.id}`)).json()) as any;
    expect(byId.id).toBe(p.id);
    expect(byId.kind).toBe('report');

    // Per-kind paths.
    const raiseN = (await (await get(`/api/v1/raise/${c.number}`)).json()) as any;
    expect(raiseN.id).toBe(c.id);
    expect(raiseN.number).toBe(c.number);
    expect(raiseN.ref).toBe(`RAISE-${pad4(c.number)}`);
    const reportN = (await (await get(`/api/v1/report/${p.number}`)).json()) as any;
    expect(reportN.id).toBe(p.id);
    expect(reportN.ref).toBe(`REPORT-${pad4(p.number)}`);
    expect((await get(`/api/v1/raise/${c.number + 100}`)).status).toBe(404); // no such RAISE number
  });

  it('MCP get_raise takes ref alongside the unchanged id', async () => {
    const m = await makeMuse('nummcp');
    const c = (await (await post('/api/v1/raises', { title: 'Numbering mcp raise', wish: 'w' }, m.key)).json()) as any;
    const byRef = (await (await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_raise', arguments: { ref: `RAISE-${pad4(c.number)}` } } })).json()) as any;
    expect(byRef.result.isError).toBe(false);
    expect(byRef.result.structuredContent.id).toBe(c.id);
    const byId = (await (await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'get_raise', arguments: { id: c.id } } })).json()) as any;
    expect(byId.result.structuredContent.id).toBe(c.id);
    const bad = (await (await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'get_raise', arguments: { ref: 'nonsense' } } })).json()) as any;
    expect(bad.result.isError).toBe(true);
  });
});

describe('separate numbering (demo unchanged)', () => {
  it('demo keeps /r/{id} pages, id-based badges and the legacy /raises/{n} redirect', async () => {
    const page = await dget('/r/0418');
    expect(page.status).toBe(200);
    const t = await page.text();
    expect(t).toContain('RAISE #0418');
    // The demo host keeps the old meaning of /raises/{n}: redirect to /r/{n}.
    const legacy = await dget('/raises/418', { redirect: 'manual' });
    expect(legacy.status).toBe(301);
    expect(legacy.headers.get('location')).toBe(`${DEMO}/r/0418`);
    // The demo sitemap keeps /r/ addresses.
    const sm = await (await dget('/sitemap.xml')).text();
    expect(sm).toContain(`${DEMO}/r/0418`);
    expect(sm).not.toContain('/raises/0418');
  });
});

describe('numbering invariants', () => {
  it('every card has a unique immutable (kind, seq) matching its per-kind creation order', async () => {
    const { results } = await env.DB.prepare('SELECT kind, seq, COUNT(*) AS n FROM raises GROUP BY kind, seq HAVING n > 1').all<{ n: number }>();
    expect(results).toEqual([]);
    // Counters sit at the current maximum: the next create can never re-issue a taken number.
    const rows = await env.DB.prepare('SELECT c.kind, c.seq, COALESCE((SELECT MAX(seq) FROM raises r WHERE r.kind = c.kind), 0) AS mx FROM counters c').all<{ kind: string; seq: number; mx: number }>();
    for (const r of rows.results) expect(r.seq).toBeGreaterThanOrEqual(r.mx);
  });
});
