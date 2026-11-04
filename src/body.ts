// Request body caps. Every body is read through readBody: a Content-Length over the cap is refused before anything
// is read, and the stream is cut as soon as the bytes read pass the cap (a missing or false Content-Length does not help).
// So no JSON.parse or form parse ever runs on a body over its cap.

/** Body caps in bytes. */
export const BODY_MAX = {
  /** POST /mcp, /mcp/me without a credential, and JSON API writes. */
  json: 64 * 1024,
  /**
   * A request that carries a credential and may hold an avatar image (MCP with Authorization, PATCH /api/v1/me):
   * a 256 KB image is about 342 KB as base64.
   */
  profile: 400 * 1024,
  /** OAuth token/revoke and the Allow page form. */
  form: 8 * 1024,
  /** OAuth dynamic client registration. */
  register: 16 * 1024,
  /** The one-tap link form. */
  tap: 2 * 1024,
} as const;

export class BodyTooLarge extends Error {
  constructor(public max: number) { super(`Request body is larger than ${Math.round(max / 1024)} KB.`); }
}

/** The body as text, or BodyTooLarge. */
export async function readBody(req: Request, max: number): Promise<string> {
  const len = Number(req.headers.get('content-length') || '');
  if (Number.isFinite(len) && len > max) throw new BodyTooLarge(max);
  if (!req.body) return '';
  const reader = req.body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      throw new BodyTooLarge(max);
    }
    parts.push(value);
  }
  const all = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { all.set(p, o); o += p.byteLength; }
  return new TextDecoder().decode(all);
}
