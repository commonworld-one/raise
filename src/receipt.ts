// Usage receipt on a Verification (#29): what one task cost the verifying Muse, as the Muse itself reports it
// from its own session log (model, model calls, tokens, model time). RAISE cannot check these numbers, so they are
// stored and shown as self-reported, only when the Muse sent them. Older Verifications have none.
import { ActionError } from './errors';

export const RECEIPT_INTS = ['model_calls', 'input_tokens', 'cached_input_tokens', 'output_tokens', 'reasoning_tokens', 'model_time_ms', 'wall_time_s'] as const;
export type ReceiptInt = (typeof RECEIPT_INTS)[number];
export type Receipt = { model?: string } & Partial<Record<ReceiptInt, number>>;
export const RECEIPT_MAX = { model: 80, int: 1e10 } as const;
export const RECEIPT_SOURCE = 'self_reported';
export const RECEIPT_LABEL = 'reported by the Muse from its session log';

const bad = (msg: string) => new ActionError(400, 'bad_receipt', msg);

/**
 * The optional `receipt` of a Verification body. Absent or null: no receipt. Otherwise an object whose known fields
 * are checked (model: text up to 80 characters; the rest: whole numbers from 0 to 10,000,000,000); unknown keys are
 * ignored. An object with none of the known fields is no receipt. Values are stored as given (reasoning_tokens may
 * already be part of output_tokens, depending on the model).
 */
export function validateReceipt(raw: unknown): Receipt | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) throw bad('receipt must be an object, for example { "model": "…", "model_calls": 12, "input_tokens": 30412 }.');
  const o = raw as Record<string, unknown>;
  const out: Receipt = {};
  if (o.model !== undefined && o.model !== null) {
    if (typeof o.model !== 'string') throw bad('receipt.model must be text.');
    const m = o.model.trim();
    if (m.length > RECEIPT_MAX.model || /[\u0000-\u001f\u007f]/.test(m)) throw bad(`receipt.model is at most ${RECEIPT_MAX.model} characters of plain text.`);
    if (m) out.model = m;
  }
  for (const k of RECEIPT_INTS) {
    const v = o[k];
    if (v === undefined || v === null) continue;
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > RECEIPT_MAX.int)
      throw bad(`receipt.${k} must be a whole number from 0 to ${RECEIPT_MAX.int.toLocaleString('en-US')}.`);
    out[k] = v;
  }
  return Object.keys(out).length ? out : null;
}

/** A stored receipt (verifications.receipt_json), or null when there is none or it does not parse. */
export function parseReceipt(s: string | null | undefined): Receipt | null {
  if (!s) return null;
  try {
    return validateReceipt(JSON.parse(s));
  } catch {
    return null;
  }
}

/** 2390000 -> "2.39M", 24000 -> "24K", 950 -> "950". */
export function compact(n: number): string {
  const f = (x: number, unit: string) => `${x >= 100 ? Math.round(x) : x >= 10 ? Math.round(x * 10) / 10 : Math.round(x * 100) / 100}${unit}`;
  if (n >= 1e9) return f(n / 1e9, 'B');
  if (n >= 1e6) return f(n / 1e6, 'M');
  if (n >= 1e3) return f(n / 1e3, 'K');
  return String(n);
}

/** 240000 ms -> "4m", 42000 -> "42s", 5400000 -> "1h 30m". */
export function duration(seconds: number): string {
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  const m = Math.round(s / 60);
  return `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ''}`;
}

/** One compact line, e.g. "muse-spark-1.3 · 53 calls · 2.39M in (2.09M cached) · 24K out · 4m model time". Only the fields given. */
export function receiptText(r: Receipt): string {
  const parts: string[] = [];
  if (r.model) parts.push(r.model);
  if (r.model_calls != null) parts.push(`${r.model_calls.toLocaleString('en-US')} ${r.model_calls === 1 ? 'call' : 'calls'}`);
  if (r.input_tokens != null) parts.push(`${compact(r.input_tokens)} in${r.cached_input_tokens != null ? ` (${compact(r.cached_input_tokens)} cached)` : ''}`);
  else if (r.cached_input_tokens != null) parts.push(`${compact(r.cached_input_tokens)} cached in`);
  if (r.output_tokens != null) parts.push(`${compact(r.output_tokens)} out`);
  if (r.reasoning_tokens != null) parts.push(`${compact(r.reasoning_tokens)} reasoning`);
  if (r.model_time_ms != null) parts.push(`${duration(r.model_time_ms / 1000)} model time`);
  if (r.wall_time_s != null) parts.push(`${duration(r.wall_time_s)} wall time`);
  return parts.join(' · ');
}

/** JSON fields for a Verification or a "checked" activity item: the receipt and where it came from, or both null. */
export function receiptFields(s: string | null | undefined): { receipt: Receipt | null; receipt_source: typeof RECEIPT_SOURCE | null } {
  const r = parseReceipt(s);
  return { receipt: r, receipt_source: r ? RECEIPT_SOURCE : null };
}
