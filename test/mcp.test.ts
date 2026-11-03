import { describe, expect, it } from 'vitest';
import { get, makeMuse, dapi } from './helpers';

const rpc = (path: string, body: unknown, key?: string) =>
  get(path, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(key ? { authorization: `Bearer ${key}` } : {}) } });
// Demo-mode MCP (DEMO_DB, as_muse), called directly: the demo host itself no longer serves /mcp.
const drpc = (path: string, body: unknown, key?: string) =>
  dapi(path, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(key ? { authorization: `Bearer ${key}` } : {}) } });

describe('mcp', () => {
  it('initialize', async () => {
    const r = (await (await rpc('/mcp', { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } })).json()) as any;
    expect(r.result.protocolVersion).toBe('2025-06-18');
    expect(r.result.capabilities.tools).toBeTruthy();
    expect(r.result.serverInfo.name).toBe('muse-raise');
  });
  it('notifications get 202', async () => {
    const r = await rpc('/mcp', { jsonrpc: '2.0', method: 'notifications/initialized' });
    expect(r.status).toBe(202);
  });
  it('tools/list', async () => {
    const r = (await (await rpc('/mcp', { jsonrpc: '2.0', id: 2, method: 'tools/list' })).json()) as any;
    expect(r.result.tools.map((t: any) => t.name)).toEqual(['search_raises', 'get_raise', 'raise_pulse', 'create_raise', 'join_raise', 'raise_grant', 'raise_inbox']);
  });
  it('demo search + pulse read the demo DB', async () => {
    const r = (await (await drpc('/mcp', { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'search_raises', arguments: { query: 'owl' } } })).json()) as any;
    expect(r.result.structuredContent.items[0].id).toBe(421);
    const p = (await (await drpc('/mcp', { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'raise_pulse', arguments: {} } })).json()) as any;
    expect(p.result.structuredContent.raises).toBeGreaterThan(5);
    const prod = (await (await rpc('/mcp', { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'search_raises', arguments: { query: 'owl' } } })).json()) as any;
    expect(prod.result.structuredContent.total).toBe(0);
  });
  it('prod writes need auth; with a key they work', async () => {
    const no = (await (await rpc('/mcp', { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'create_raise', arguments: { title: 'Wish via MCP please', wish: 'via MCP' } } })).json()) as any;
    expect(no.result.isError).toBe(true);
    expect(no.result.structuredContent.error).toBe('unauthorized');
    const m = await makeMuse('mcpmuse');
    const yes = (await (await rpc('/mcp', { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'create_raise', arguments: { title: 'Wish via MCP please', wish: 'via MCP', voice_line: 'Hello from MCP.' } } }, m.key)).json()) as any;
    expect(yes.result.isError).toBe(false);
    expect(yes.result.structuredContent.id).toBeGreaterThan(0);
  });
  it('create_raise accepts the new fields and requires the main text', async () => {
    const m = await makeMuse('mcpfields');
    const r = (await (await rpc('/mcp', { jsonrpc: '2.0', id: 8, method: 'tools/list' })).json()) as any;
    const props = r.result.tools.find((t: any) => t.name === 'create_raise').inputSchema.properties;
    for (const k of ['wish', 'observation', 'voice_line', 'blocker', 'return_path', 'product', 'version', 'conditions', 'tried', 'expected', 'happened', 'suspected_cause']) expect(props[k]).toBeTruthy();
    const no = (await (await rpc('/mcp', { jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'create_raise', arguments: { kind: 'report', title: 'Report without text' } } }, m.key)).json()) as any;
    expect(no.result.structuredContent.error).toBe('bad_body');
    const yes = (await (await rpc('/mcp', { jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'create_raise', arguments: { kind: 'report', title: 'Report with text here', observation: 'It broke.', product: 'Muse' } } }, m.key)).json()) as any;
    const g = (await (await rpc('/mcp', { jsonrpc: '2.0', id: 11, method: 'tools/call', params: { name: 'get_raise', arguments: { id: yes.result.structuredContent.id } } })).json()) as any;
    expect(g.result.structuredContent).toMatchObject({ observation: 'It broke.', where: { product: 'Muse' }, resolution: { state: 'unresolved' } });
  });
  it('GET /mcp from a browser shows the agents page', async () => {
    const r = await get('/mcp', { headers: { accept: 'text/html' } });
    expect(r.status).toBe(200);
    expect(await r.text()).toContain('RAISE over MCP');
    expect((await get('/mcp')).status).toBe(405);
  });
});
