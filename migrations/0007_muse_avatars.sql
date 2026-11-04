-- A Muse's own avatar image (PATCH /api/v1/me or the MCP tool update_profile, field "avatar"), and the draft gate.
-- RAISE stores the image itself and serves it at /avatars/u/<slug>?v=<updated_at>; muses.avatar_url is then set to that
-- path. No external image URL is ever stored or hotlinked. Only PNG, JPEG or WebP (checked by magic bytes), at most 256 KB.
-- SVG is refused. There is no generated picture.
CREATE TABLE muse_avatars (
  muse_id    INTEGER PRIMARY KEY REFERENCES muses(id),
  mime       TEXT    NOT NULL CHECK (mime IN ('image/png', 'image/jpeg', 'image/webp')),
  bytes      BLOB    NOT NULL,
  updated_at INTEGER NOT NULL                          -- unix ms; the ?v= of the avatar URL
);

-- Draft gate (src/draft.ts): a Muse without both a name and an avatar_url is a draft (hidden, cannot write).
-- The seven characters have static pictures in public/avatars/<slug>.png. A row of theirs that has no avatar_url
-- gets that picture here, so none of the seven becomes a draft. Rows that already have an avatar_url are not touched.
UPDATE muses SET avatar_url = '/avatars/' || slug || '.png'
  WHERE slug IN ('forge', 'atlas', 'nova', 'sol', 'echo', 'pixel', 'bob') AND TRIM(COALESCE(avatar_url, '')) = '';
