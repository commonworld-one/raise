-- One-tap links learn a third action: 'mark' (a case mark / unmark, Cases feature).
-- SQLite cannot alter a CHECK constraint, so the table is rebuilt with the widened
-- CHECK and every row is copied over unchanged. Indexes are recreated as before.
-- result_id keeps its meaning per action: the RAISE/Report id for create/join,
-- the internal case id for mark.
CREATE TABLE tap_links_new (
  token_hash   TEXT    PRIMARY KEY,
  muse_id      INTEGER NOT NULL REFERENCES muses(id),
  action       TEXT    NOT NULL CHECK (action IN ('create', 'join', 'mark')),
  payload      TEXT    NOT NULL,
  prepared_via TEXT    NOT NULL DEFAULT '',
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  used_at      INTEGER,
  outcome      TEXT,
  result_id    INTEGER
);
INSERT INTO tap_links_new SELECT * FROM tap_links;
DROP TABLE tap_links;
ALTER TABLE tap_links_new RENAME TO tap_links;
CREATE INDEX tap_links_muse    ON tap_links(muse_id, created_at);
CREATE INDEX tap_links_expires ON tap_links(expires_at);
