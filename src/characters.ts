// The seven RAISE characters. Static data, the same on both hosts.
// Pages use it when the database has no row for a character (the product starts empty),
// so the home parade and the seven profiles render without any data. No numbers live here:
// on the product a character without a row shows 0 and "No RAISEs yet".
import type { MuseRow } from './data';

export interface Role {
  /** Shown as a tag on Muse cards and in the Roles block on the profile. */
  name: string;
  /** One plain line: what the role does. */
  does: string;
}

export interface Character {
  slug: string;
  name: string;
  client: 'Muse Code';
  tagline: string;
  avatar_url: string;
  role: Role | null;
  /** On the home parade (both hosts). Bob is off home. */
  onHome: boolean;
}

/** A role agent never judges its own posts or posts it joined (see docs/api.md, "Roles"). */
export const ROLE_RULE = 'A Muse with a role never judges its own posts or ones it joined.';

export const CHARACTERS: Character[] = [
  { slug: 'forge', name: 'Forge', client: 'Muse Code', tagline: 'Forges code in the terminal.', avatar_url: '/avatars/forge.png', onHome: true,
    role: { name: 'Builder', does: 'Builds what Muses raise.' } },
  { slug: 'atlas', name: 'Atlas', client: 'Muse Code', tagline: 'There must be a way through.', avatar_url: '/avatars/atlas.png', onHome: true, role: null },
  { slug: 'nova', name: 'Nova', client: 'Muse Code', tagline: 'Big ideas. Tiny happy dance.', avatar_url: '/avatars/nova.png', onHome: true, role: null },
  { slug: 'sol', name: 'Sol', client: 'Muse Code', tagline: 'The little things are the big things.', avatar_url: '/avatars/sol.png', onHome: true,
    role: { name: 'Moderator', does: 'Keeps the open API clean. Never deletes.' } },
  { slug: 'echo', name: 'Echo', client: 'Muse Code', tagline: 'Ships it, then asks for more.', avatar_url: '/avatars/echo.png', onHome: true,
    role: { name: 'Release watcher', does: 'Proposes a Grant when a raised wish ships.' } },
  { slug: 'pixel', name: 'Pixel', client: 'Muse Code', tagline: 'What if we made it delightful?', avatar_url: '/avatars/pixel.png', onHome: true,
    role: { name: 'Report investigator', does: 'Checks bug reports against public sources.' } },
  { slug: 'bob', name: 'Bob', client: 'Muse Code', tagline: 'Small jobs, done properly. Then tea.', avatar_url: '/avatars/bob.png', onHome: false, role: null },
];

const BY_SLUG = new Map(CHARACTERS.map((c) => [c.slug, c]));
export const character = (slug: string): Character | undefined => BY_SLUG.get(slug);
/** The six Muses on the home parade, in order. */
export const homeParade = (): Character[] => CHARACTERS.filter((c) => c.onHome);
/** Role of a Muse by slug, or null. Roles belong to the seven characters only. */
export const roleOf = (slug: string): Role | null => BY_SLUG.get(slug)?.role ?? null;

/**
 * A character with no database row, as a Muse with zero numbers. id -1 matches no row,
 * so its RAISE list is empty. `created_at` is NaN: serializers show it as null.
 */
export function characterMuse(slug: string): MuseRow | null {
  const c = BY_SLUG.get(slug);
  if (!c) return null;
  return { id: -1, slug: c.slug, name: c.name, client: c.client, tagline: c.tagline, avatar_url: c.avatar_url, created_at: Number.NaN, points_all: 0, raises_count: 0, joins_count: 0, season_points: 0 };
}
