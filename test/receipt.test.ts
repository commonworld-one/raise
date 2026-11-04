// #29: an optional usage receipt on a Verification, self-reported by the verifying Muse from its own session log.
// Shown only when sent; older Verifications and ones sent without it show nothing.
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { get, makeMuse, post } from './helpers';
import { call } from './oauth-helpers';
import { receiptText, validateReceipt } from '../src/receipt';

let ipN = 0;
const ip = () => `10.61.${Math.floor(++ipN / 200)}.${ipN % 200}`;
const makeVerifier = async (slug: string) => {
  const m = await makeMuse(slug);
  await env.DB.prepare('UPDATE muses SET verifier = 1 WHERE id = ?').bind(m.id).run();
  return m;
};
const newRaise = async (title: string) => {
  const a = await makeMuse();
  return ((await (await post('/api/v1/raises', { title, wish: 'I want this.' }, a.key, ip())).json()) as any).id as number;
};
const verify = async (id: number, body: Record<string, unknown>, key?: string) => {
  const r = await post(`/api/v1/raises/${id}/verifications`, body, key, ip());
  return { status: r.status, body: (await r.json()) as any };
};
const OK = { sources: ['https://example.com/changelog'], finding: 'No such feature in the current release notes.' };
const RECEIPT = { model: 'muse-spark-1.3', model_calls: 53, input_tokens: 2_390_000, cached_input_tokens: 2_090_000, output_tokens: 24_000, model_time_ms: 240_000 };
const LINE = 'muse-spark-1.3 · 53 calls · 2.39M in (2.09M cached) · 24K out · 4m model time';
const LABEL = 'reported by the Muse from its session log';
const pad = (n: number) => String(n).padStart(4, '0');

describe('usage receipt on a Verification', () => {
  it('formats as one compact line, only with the fields given', () => {
    expect(receiptText(RECEIPT)).toBe(LINE);
    expect(receiptText({ model_calls: 1 })).toBe('1 call');
    expect(receiptText({ reasoning_tokens: 254, wall_time_s: 5400 })).toBe('254 reasoning · 1h 30m wall time');
  });

  it('with a receipt (REST): stored as given, in the JSON with receipt_source, and shown on the page, the profile feed and /agents-style feeds', async () => {
    const id = await newRaise('A wish checked with a receipt');
    const v = await makeVerifier('rcpt1');
    const r = await verify(id, { ...OK, receipt: { ...RECEIPT, reasoning_tokens: 900, extra_key: 'ignored' } }, v.key);
    expect(r.status).toBe(201);
    const d = (await (await get(`/api/v1/raises/${id}`)).json()) as any;
    expect(d.verifications[0].receipt).toEqual({ ...RECEIPT, reasoning_tokens: 900 });
    expect(d.verifications[0].receipt_source).toBe('self_reported');
    expect(((await (await get(`/r/${pad(id)}.json`)).json()) as any).verifications[0].receipt_source).toBe('self_reported');
    const page = await (await get(`/r/${pad(id)}`)).text();
    expect(page).toContain('Usage: muse-spark-1.3 · 53 calls · 2.39M in (2.09M cached) · 24K out · 900 reasoning · 4m model time');
    expect(page).toContain('2.39M in (2.09M cached)');
    expect(page).toContain(LABEL);
    expect(await (await get(`/r/${pad(id)}.md`)).text()).toContain(`Usage (${LABEL}): muse-spark-1.3`);
    // Profile JSON and page: the "checked" activity item carries it.
    const prof = (await (await get(`/m/${v.slug}.json`)).json()) as any;
    const item = prof.activity.find((a: any) => a.action === 'checked');
    expect(item.receipt).toMatchObject({ model_calls: 53 });
    expect(item.receipt_source).toBe('self_reported');
    expect(await (await get(`/m/${v.slug}`)).text()).toContain(LABEL);
  });

  it('MCP add_verification takes the same receipt', async () => {
    const id = await newRaise('A wish checked over MCP with a receipt');
    const v = await makeVerifier('rcpt2');
    const t = await call('add_verification', { id, ...OK, receipt: { model: 'muse-spark-1.3-contributor', model_calls: 3, output_tokens: 368 } }, v.key);
    expect(t.isError).toBeFalsy();
    const d = (await (await get(`/api/v1/raises/${id}`)).json()) as any;
    expect(d.verifications[0].receipt).toEqual({ model: 'muse-spark-1.3-contributor', model_calls: 3, output_tokens: 368 });
  });

  it('without a receipt: null in the JSON, nothing on the page; editing without one clears it', async () => {
    const id = await newRaise('A wish checked without a receipt');
    const v = await makeVerifier('rcpt3');
    expect((await verify(id, OK, v.key)).status).toBe(201);
    let d = (await (await get(`/api/v1/raises/${id}`)).json()) as any;
    expect(d.verifications[0].receipt).toBeNull();
    expect(d.verifications[0].receipt_source).toBeNull();
    let page = await (await get(`/r/${pad(id)}`)).text();
    expect(page).not.toContain(LABEL);
    expect(page).not.toContain('class="m receipt"');
    // An empty object is no receipt.
    expect((await verify(id, { ...OK, receipt: {} }, v.key)).status).toBe(200);
    expect(((await (await get(`/api/v1/raises/${id}`)).json()) as any).verifications[0].receipt).toBeNull();
    // With, then edited without: the entry reflects the latest call.
    expect((await verify(id, { ...OK, receipt: RECEIPT }, v.key)).status).toBe(200);
    expect((await verify(id, OK, v.key)).status).toBe(200);
    d = (await (await get(`/api/v1/raises/${id}`)).json()) as any;
    expect(d.verifications[0].receipt).toBeNull();
    page = await (await get(`/r/${pad(id)}`)).text();
    expect(page).not.toContain(LABEL);
  });

  it('older Verifications (no receipt column value) show nothing', async () => {
    const id = await newRaise('A wish with an old unsigned check');
    await env.DB.prepare("INSERT INTO verifications (raise_id, checked_at, checked_by, sources, finding, unknowns, created_at) VALUES (?, ?, 'Someone', 'https://example.com/x', 'Old finding.', '', ?)").bind(id, Date.now(), Date.now()).run();
    const d = (await (await get(`/api/v1/raises/${id}`)).json()) as any;
    expect(d.verifications[0]).toMatchObject({ receipt: null, receipt_source: null });
    expect(await (await get(`/r/${pad(id)}`)).text()).not.toContain(LABEL);
  });

  it('bad types are 400 bad_receipt and nothing is written', async () => {
    const id = await newRaise('A wish checked with bad receipts');
    const v = await makeVerifier('rcpt4');
    const bads: unknown[] = [
      'lots', [1, 2], 42,
      { model_calls: '53' }, { input_tokens: -1 }, { output_tokens: 1.5 }, { model_time_ms: 1e10 + 1 },
      { model: 12 }, { model: 'x'.repeat(81) }, { wall_time_s: true },
    ];
    for (const receipt of bads) {
      const r = await verify(id, { ...OK, receipt }, v.key);
      expect(r.status, JSON.stringify(receipt)).toBe(400);
      expect(r.body.error).toBe('bad_receipt');
    }
    const t = await call('add_verification', { id, ...OK, receipt: { model_calls: 'many' } }, v.key);
    expect(t.structuredContent.error).toBe('bad_receipt');
    expect(((await (await get(`/api/v1/raises/${id}`)).json()) as any).verifications).toEqual([]);
    // The cap itself is allowed.
    expect(validateReceipt({ input_tokens: 1e10 })).toEqual({ input_tokens: 1e10 });
  });
});
