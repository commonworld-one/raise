// Hashing of stored secrets with a server-side pepper (same pattern as Commonworld's platform: HMAC-SHA256(KEY_PEPPER, value)).
//
// Every secret RAISE issues (RAISE keys created by the Worker, one-tap link tokens, OAuth codes, access and refresh
// tokens, client secrets, claim codes) is stored only as HMAC-SHA256(RAISE_TOKEN_PEPPER, "<purpose>:" + value), so a copy
// of the database alone cannot be used to check guesses. RAISE_TOKEN_PEPPER is a Worker secret
// (`wrangler secret put RAISE_TOKEN_PEPPER`), at least 32 characters. Without it the Worker fails closed: it issues
// and accepts no peppered secret and answers 500 server_misconfigured instead.
//
// Legacy: RAISE keys issued before the pepper (scripts/new-key.mjs) are stored as plain SHA-256(key) in api_keys.
// They keep working: a key is checked against the peppered hash first, then the plain SHA-256. Legacy rows are not
// re-hashed on use (a rollback to code without the pepper would otherwise lock those keys out).
import type { Env } from './types';
import { ActionError } from './errors';
import { sha256hex } from './util';

export const PEPPER_MIN_LENGTH = 32;

/** The server is missing its RAISE_TOKEN_PEPPER secret: 500, nothing is issued or accepted. */
export class ConfigError extends ActionError {
  constructor() {
    super(500, 'server_misconfigured', 'Server misconfigured: the RAISE_TOKEN_PEPPER secret is not set. Nothing was issued; try again later.');
  }
}

export const hasPepper = (env: Env): boolean => typeof env.RAISE_TOKEN_PEPPER === 'string' && env.RAISE_TOKEN_PEPPER.length >= PEPPER_MIN_LENGTH;

/** The pepper, or a ConfigError (fail closed). */
export function requirePepper(env: Env): string {
  if (!hasPepper(env)) throw new ConfigError();
  return env.RAISE_TOKEN_PEPPER!;
}

let cachedPepper: string | null = null;
let cachedKey: CryptoKey | null = null;

async function hmacKey(pepper: string): Promise<CryptoKey> {
  if (cachedKey && cachedPepper === pepper) return cachedKey;
  cachedKey = await crypto.subtle.importKey('raw', new TextEncoder().encode(pepper), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  cachedPepper = pepper;
  return cachedKey;
}

/** HMAC-SHA256(pepper, value) as lowercase hex. */
export async function hmacHex(pepper: string, value: string): Promise<string> {
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(pepper), new TextEncoder().encode(value));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** The stored form of a secret: HMAC-SHA256(RAISE_TOKEN_PEPPER, value). Throws ConfigError without the pepper. */
export const secretHash = (env: Env, value: string): Promise<string> => hmacHex(requirePepper(env), value);

/** Stored form of a RAISE key issued by the Worker (no purpose prefix, so scripts/new-key.mjs can compute it too). */
export const keyHash = (env: Env, key: string): Promise<string> => secretHash(env, key);

/**
 * Hashes a presented RAISE key may be stored under: the peppered one (when the pepper is set) and the legacy plain
 * SHA-256. Without the pepper only legacy keys can match; peppered keys fail as unknown.
 */
export async function keyLookupHashes(env: Env, key: string): Promise<string[]> {
  const legacy = await sha256hex(key);
  return hasPepper(env) ? [await keyHash(env, key), legacy] : [legacy];
}
