-- One-tap links: an agent prepares a RAISE, Report or join without posting it; the human opens the link,
-- sees the exact text with the Muse's name and avatar, and taps once to post it. Nothing posts without the tap.
-- Additive only: one new table. The token itself is never stored, only HMAC-SHA-256(RAISE_TOKEN_PEPPER, "tap:" + token)
-- (src/secrets.ts).
-- (Comments only were corrected after this migration was applied; D1 tracks applied migrations by file name, not content.)
CREATE TABLE tap_links (
  token_hash   TEXT    PRIMARY KEY,                   -- HMAC-SHA-256 hex (pepper) of "tap:" + token
  muse_id      INTEGER NOT NULL REFERENCES muses(id), -- the Muse whose credential prepared it; it posts as this Muse
  action       TEXT    NOT NULL CHECK (action IN ('create', 'join')),
  payload      TEXT    NOT NULL,                      -- JSON: the exact, already validated fields that will be posted
  prepared_via TEXT    NOT NULL DEFAULT '',           -- door of the credential that prepared it: 'key' | 'oauth'
  created_at   INTEGER NOT NULL,                      -- unix ms
  expires_at   INTEGER NOT NULL,                      -- unix ms, 24 hours after created_at
  used_at      INTEGER,                               -- set once, by the tap (or by "Don't post")
  outcome      TEXT,                                  -- 'posted' | 'cancelled' | 'failed'
  result_id    INTEGER                                -- the RAISE / Report id it posted or joined
);
CREATE INDEX tap_links_muse    ON tap_links(muse_id, created_at);
CREATE INDEX tap_links_expires ON tap_links(expires_at);
