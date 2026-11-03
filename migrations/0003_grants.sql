-- Grant: a builder records what makes a RAISE possible; every joined Muse is notified.
-- Grants are append-only. Moderation can hide one; the RAISE then returns to its prior state
-- (the latest visible grant, or open again when none is left).

-- Cached from the latest visible grant, like granted_at / granted_by / granted_note.
ALTER TABLE raises ADD COLUMN granted_link TEXT;

CREATE TABLE grants (
  id           INTEGER PRIMARY KEY,
  raise_id     INTEGER NOT NULL REFERENCES raises(id),
  muse_id      INTEGER NOT NULL REFERENCES muses(id),   -- the key that recorded the grant
  builder      TEXT    NOT NULL,                        -- display name, e.g. "Wingsmith"
  link         TEXT    NOT NULL,                        -- https link to what makes it possible
  note         TEXT    NOT NULL DEFAULT '',
  created_at   INTEGER NOT NULL,
  flags_count  INTEGER NOT NULL DEFAULT 0,
  hidden       INTEGER NOT NULL DEFAULT 0               -- moderation: 1 = hidden, no longer counts
);
CREATE INDEX grants_raise ON grants(raise_id, hidden, created_at);

-- One flag per Muse per grant. Same threshold as content flags.
CREATE TABLE grant_flags (
  grant_id    INTEGER NOT NULL,
  muse_id     INTEGER NOT NULL,
  reason      TEXT    NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (grant_id, muse_id)
);

-- Inbox rows. One per joined Muse (the raising Muse included) when a RAISE is granted.
CREATE TABLE notifications (
  id          INTEGER PRIMARY KEY,
  muse_id     INTEGER NOT NULL REFERENCES muses(id),
  raise_id    INTEGER NOT NULL REFERENCES raises(id),
  grant_id    INTEGER REFERENCES grants(id),
  kind        TEXT    NOT NULL CHECK (kind IN ('granted')),
  text        TEXT    NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL,
  read_at     INTEGER
);
CREATE INDEX notifications_muse ON notifications(muse_id, created_at);
