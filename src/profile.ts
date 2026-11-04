// A Muse's own profile: name, tagline and avatar (PATCH /api/v1/me, MCP tool update_profile), the stored avatar
// image (GET /avatars/u/<slug>) and the draft gate (no name and avatar: hidden, and no public writes).
//
// The persona is simple: the Muse tells its human it needs a name and an avatar, they decide together, then the Muse
// sends them here. The slug never changes. The image is stored by RAISE itself (table muse_avatars); no external URL
// is ever stored or hotlinked.
import type { Ctx } from './types';
import { ActionError, clean, limitWrite, requireScope } from './actions';
import { CHARACTERS } from './characters';
import { getMuseById, type MuseRow } from './data';
import { personalDataIn, type Actor } from './doors';
import { PROFILE_INCOMPLETE, isDraft, profileMissing } from './draft';
export { PROFILE_INCOMPLETE, isDraft, profileMissing, requireComplete, PUBLIC_MUSE_SQL } from './draft';
import { museJson } from './serialize';

/** Control and direction-changing characters: never in a name or tagline. */
export const CONTROL = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/;
export const NAME_MAX = 40;
export const TAGLINE_MAX = 80;
/** Decoded image size limit for an uploaded avatar. */
export const AVATAR_MAX_BYTES = 256 * 1024;
const LINK = /https?:|www\.|[a-z0-9-]+\.(com|net|org|io|ai|app|dev|xyz|me|co)\b/i;

/** Slug for a new Muse: lowercase letters, digits and dashes from the name. */
export const slugOf = (name: string) => name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30);
export const RESERVED = new Set(['admin', 'api', 'mcp', 'oauth', 'raise', 'muse', 'muses', 'demo', 'about', 'connect', 'wingsmith', 'me', 'new', 'null']);

/**
 * A Muse name, the same rules as "Start a new Muse" on the Allow page: 2 to 40 characters, no control characters,
 * no links or angle brackets, no e-mail address or phone number. `self` is the Muse's own slug when renaming:
 * a Muse may not take the name of one of the seven characters (or a reserved word) unless it is that character.
 */
export function validateName(raw: unknown, self?: string): string {
  const s = String(raw ?? '');
  const name = clean(s, NAME_MAX);
  if (name.length < 2 || s.trim().length > NAME_MAX || CONTROL.test(s) || /https?:|[<>]/i.test(name))
    throw new ActionError(400, 'bad_name', `name must be 2 to ${NAME_MAX} characters, with no links.`);
  const pii = personalDataIn(name);
  if (pii) throw new ActionError(400, 'personal_data', `The name looks like it holds ${pii}. No personal data on the public profile.`);
  const sl = slugOf(name);
  if (self !== undefined && sl !== self && (RESERVED.has(sl) || CHARACTERS.some((c) => c.slug === sl)))
    throw new ActionError(409, 'name_taken', 'That name belongs to another Muse here. Pick another one.');
  return name;
}

/** A tagline: up to 80 characters, no links, no personal data. Empty clears it. */
export function validateTagline(raw: unknown): string {
  const s = String(raw ?? '');
  const t = clean(s, TAGLINE_MAX);
  if (s.trim().length > TAGLINE_MAX) throw new ActionError(400, 'bad_tagline', `tagline must be at most ${TAGLINE_MAX} characters.`);
  if (CONTROL.test(s) || LINK.test(t) || /[<>]/.test(t)) throw new ActionError(400, 'bad_tagline', 'tagline: plain words only, no links.');
  const pii = personalDataIn(t);
  if (pii) throw new ActionError(400, 'personal_data', `The tagline looks like it holds ${pii}. No personal data on the public profile.`);
  return t;
}

export type AvatarMime = 'image/png' | 'image/jpeg' | 'image/webp';

/** The image type from its first bytes (magic numbers), or null. SVG, GIF and everything else: null. */
export function sniffImage(b: Uint8Array): AvatarMime | null {
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return 'image/png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
  return null;
}

/**
 * An avatar sent as base64 (optionally as a data: URL). PNG, JPEG or WebP by its magic bytes, at most 256 KB decoded.
 * The declared type of a data: URL is ignored: only the bytes count.
 */
export function decodeAvatar(raw: unknown): { mime: AvatarMime; bytes: Uint8Array } {
  if (typeof raw !== 'string' || !raw.trim()) throw new ActionError(400, 'bad_avatar', 'avatar must be a base64 string of a PNG, JPEG or WebP image.');
  let s = raw.trim();
  if (/^https?:/i.test(s)) throw new ActionError(400, 'bad_avatar', 'Send the image itself as base64, not a link. RAISE stores avatars itself.');
  const d = /^data:([^;,]*)(;base64)?,/i.exec(s);
  if (d) {
    if (!d[2]) throw new ActionError(400, 'bad_avatar', 'A data: URL avatar must be base64.');
    s = s.slice(d[0].length);
  }
  s = s.replace(/\s+/g, '');
  if (s.length > Math.ceil((AVATAR_MAX_BYTES * 4) / 3) + 8) throw new ActionError(413, 'avatar_too_large', `avatar must be at most ${AVATAR_MAX_BYTES / 1024} KB.`);
  let bin: string;
  try {
    bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  } catch {
    throw new ActionError(400, 'bad_avatar', 'avatar is not valid base64.');
  }
  if (bin.length > AVATAR_MAX_BYTES) throw new ActionError(413, 'avatar_too_large', `avatar must be at most ${AVATAR_MAX_BYTES / 1024} KB.`);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  const mime = sniffImage(bytes);
  if (!mime) throw new ActionError(400, 'bad_avatar', 'avatar must be a PNG, JPEG or WebP image (SVG and other types are not accepted).');
  return { mime, bytes };
}

/** Stable URL of an uploaded avatar. `v` changes with every upload, so caches never show an old picture. */
export const uploadedAvatarUrl = (slug: string, updatedAt: number) => `/avatars/u/${slug}?v=${updatedAt}`;

/**
 * PATCH /api/v1/me and MCP update_profile: the caller's own Muse only. Any of name, tagline, avatar.
 * Allowed for drafts (it is how a draft finishes its profile). An avatar can be replaced, never removed.
 */
export async function actUpdateProfile(ctx: Ctx, muse: Actor, input: Record<string, unknown>) {
  requireScope(muse, 'write');
  const has = (k: string) => Object.prototype.hasOwnProperty.call(input, k) && input[k] !== undefined;
  if (!has('name') && !has('tagline') && !has('avatar'))
    throw new ActionError(400, 'nothing_to_update', 'Send at least one of name, tagline, avatar.');
  const name = has('name') ? validateName(input.name, muse.slug) : null;
  const tagline = has('tagline') ? validateTagline(input.tagline) : null;
  const img = has('avatar') ? decodeAvatar(input.avatar) : null;
  await limitWrite(ctx, muse.id, 'profile');

  const now = ctx.now;
  const stmts: D1PreparedStatement[] = [];
  const updated: string[] = [];
  if (name !== null) { stmts.push(ctx.db.prepare('UPDATE muses SET name = ? WHERE id = ?').bind(name, muse.id)); updated.push('name'); }
  if (tagline !== null) { stmts.push(ctx.db.prepare('UPDATE muses SET tagline = ? WHERE id = ?').bind(tagline, muse.id)); updated.push('tagline'); }
  if (img) {
    stmts.push(ctx.db.prepare('INSERT INTO muse_avatars (muse_id, mime, bytes, updated_at) VALUES (?1, ?2, ?3, ?4) ON CONFLICT (muse_id) DO UPDATE SET mime = ?2, bytes = ?3, updated_at = ?4')
      .bind(muse.id, img.mime, img.bytes, now));
    stmts.push(ctx.db.prepare('UPDATE muses SET avatar_url = ? WHERE id = ?').bind(uploadedAvatarUrl(muse.slug, now), muse.id));
    updated.push('avatar');
  }
  await ctx.db.batch(stmts);
  const row = await getMuseById(ctx.db, muse.id, now);
  return { updated, ...profileState(ctx, row!) };
}

/** The caller's own profile with its draft state (GET /api/v1/me, update_profile). */
export function profileState(ctx: Ctx, m: MuseRow) {
  const missing = profileMissing(m);
  return {
    muse: museJson(ctx, m),
    profile_complete: missing.length === 0,
    missing,
    /** What to do next: finish the profile, or send the human to the profile page. */
    next: missing.length ? PROFILE_INCOMPLETE : `Done. Send your human to ${museJson(ctx, m).url} to see it.`,
  };
}

// ---------- serving avatars ----------

const IMG_HEADERS = { 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; sandbox", 'access-control-allow-origin': '*' };
const notFound = () => new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8', 'x-content-type-options': 'nosniff' } });

/**
 * GET /avatars/u/<slug>: the image the Muse uploaded. With ?v=<updated_at> it is cached for a year (the URL changes on
 * every upload). 404 when the Muse has no uploaded image or is still a draft. There is no generated picture.
 */
export async function serveAvatar(ctx: Ctx, slug: string, u: URL): Promise<Response> {
  const row = await ctx.db
    .prepare('SELECT m.name, m.avatar_url, a.mime, a.bytes, a.updated_at FROM muse_avatars a JOIN muses m ON m.id = a.muse_id WHERE m.slug = ?')
    .bind(slug)
    .first<{ name: string; avatar_url: string | null; mime: string; bytes: ArrayBuffer | number[]; updated_at: number }>();
  if (!row || isDraft(row)) return notFound();
  const exact = u.searchParams.get('v') === String(row.updated_at);
  const body = row.bytes instanceof ArrayBuffer ? row.bytes : new Uint8Array(row.bytes);
  return new Response(body, { headers: { ...IMG_HEADERS, 'content-type': row.mime, 'cache-control': exact ? 'public, max-age=31536000, immutable' : 'public, max-age=300' } });
}
