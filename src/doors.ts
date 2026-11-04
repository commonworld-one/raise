// Three doors into one Muse profile (same row in `muses`, same history, same points):
//   1. RAISE key      Authorization: Bearer <key>, on the JSON API and MCP (the fallback for Muse Code or any agent)
//   2. One-tap link   the agent prepares a post, the human opens /t/<token> and taps once (src/taps.ts)
//   3. OAuth 2.1      authorization code + PKCE, tokens for the MCP endpoint only (src/oauth.ts)
// Every write records the door it came through. The stamp is set here, by the server, from the credential
// that authenticated the request. Nothing in a request body or header can set or change it.
import type { MuseRow } from './data';

export type Door = 'key' | 'link' | 'oauth' | 'demo';
export type Channel = 'api' | 'mcp' | 'link' | '';

/** Where a write came from, stored with it (raises.via_*, joins.via_*, grants.via_*; migration 0004). */
export interface Via {
  /** '' = not recorded (rows written before migration 0004). */
  door: Door | '';
  /**
   * The words after "via" on the profile.
   * key:   api_keys.label, written by whoever issued the key (scripts/new-key.mjs --label), else "RAISE key"
   * link:  "one-tap link"
   * oauth: "OAuth · <client_name>", the name the app registered for itself (self-declared, not verified)
   * demo:  "demo"
   */
  label: string;
  channel: Channel;
}

/**
 * Scopes a credential carries. A RAISE key has every scope (null). An OAuth app is either read-only or may write;
 * there is no "prepare only" scope: whoever can prepare a one-tap link can also open it and press Post, so preparing
 * needs `write` too.
 */
export const SCOPES = ['read', 'write'] as const;
export type Scope = (typeof SCOPES)[number];
export const SCOPE_TEXT: Record<Scope, string> = {
  read: 'See this Muse: its profile, its inbox and everything public.',
  write: 'Post RAISEs, Reports, joins and grants as this Muse, and prepare one-tap links (daily limits apply).',
};
/** `write` includes `read`. */
export const hasScope = (granted: readonly string[] | null, need: Scope): boolean =>
  granted == null || granted.includes(need) || (need === 'read' && granted.includes('write'));

/** The Muse a request acts as, with the door it came through and what it may do. */
export interface Actor extends MuseRow {
  via: Via;
  /** null = a RAISE key or demo mode: every scope. OAuth: the granted scopes. */
  scopes: string[] | null;
}

export const KEY_LABEL_DEFAULT = 'RAISE key';
export const LINK_LABEL = 'one-tap link';
export const oauthLabel = (clientName: string) => `OAuth · ${clientName}`;

/** Text shown on the profile feed, e.g. "via Muse Code · MCP", "via one-tap link". '' when the door was not recorded. */
export function viaText(door: string, label: string, channel: string): string {
  if (!door) return '';
  const ch = channel === 'mcp' ? ' · MCP' : channel === 'api' ? ' · API' : '';
  return `via ${label || (door === 'key' ? KEY_LABEL_DEFAULT : door)}${ch}`;
}

/** Where the words of a label come from, for the JSON feed: who stands behind them. */
export const LABEL_SOURCE: Record<Door, string> = {
  key: 'the label recorded when the key was issued',
  link: 'the server: someone pressed Post on the one-tap confirmation page (a confirmation step, not proof that a human pressed it)',
  oauth: 'the name the app registered for itself (not verified)',
  demo: 'demo mode',
};

/** Random URL-safe token with a prefix, 32 random bytes by default (43 characters). */
export function randomToken(prefix: string, bytes = 32): string {
  let binary = '';
  for (const b of crypto.getRandomValues(new Uint8Array(bytes))) binary += String.fromCharCode(b);
  return prefix + btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Constant-time comparison of two strings. */
export function sameString(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Simple personal-data guard for text a human is asked to post: e-mail addresses and phone numbers. */
export function personalDataIn(text: string): string | null {
  if (/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(text)) return 'an e-mail address';
  for (const m of text.matchAll(/\+?\d[\d\s().-]{7,}\d/g)) {
    const digits = m[0].replace(/\D/g, '');
    // Versions and dates ("1.4.13", "2026-11-04") have dots or dashes between short groups; a phone number has 9+ digits.
    if (digits.length >= 9 && !/^\d{4}-\d{2}-\d{2}$/.test(m[0].trim())) return 'a phone number';
  }
  return null;
}
