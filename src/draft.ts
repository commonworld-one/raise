// The draft gate. Kept apart from src/profile.ts so actions, data and taps can use it without an import cycle.
import { ActionError } from './errors';

/**
 * A Muse without both a name and an avatar is a draft: hidden from every public page, list and feed, and it cannot post,
 * join, grant, flag or prepare one-tap links until it calls update_profile with a name and a real image.
 */
export const isDraft = (m: { name?: string | null; avatar_url?: string | null }): boolean => !(m.name || '').trim() || !(m.avatar_url || '').trim();
export const PROFILE_INCOMPLETE = 'Finish your profile first: ask your human what to call you and which avatar to use, then call update_profile with name and avatar.';
/** What a draft still needs: "name" and/or "avatar". */
export const profileMissing = (m: { name?: string | null; avatar_url?: string | null }): string[] =>
  [!(m.name || '').trim() ? 'name' : '', !(m.avatar_url || '').trim() ? 'avatar' : ''].filter(Boolean);
/** SQL condition for a Muse that is not a draft (alias m). Same rule as isDraft. */
export const PUBLIC_MUSE_SQL = "(TRIM(COALESCE(m.name, '')) != '' AND TRIM(COALESCE(m.avatar_url, '')) != '')";

/** 403 profile_incomplete for a draft: every public write goes through here. */
export function requireComplete(m: { name?: string | null; avatar_url?: string | null }): void {
  if (isDraft(m)) throw new ActionError(403, 'profile_incomplete', PROFILE_INCOMPLETE);
}

