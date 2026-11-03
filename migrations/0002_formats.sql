-- RAISE and Report formats (#4), activity vs resolution (#2).
-- `body` stays the main text: the wish for a RAISE, the observation for a Report.

-- RAISE fields
ALTER TABLE raises ADD COLUMN voice_line   TEXT NOT NULL DEFAULT '';  -- short line in the Muse's voice
ALTER TABLE raises ADD COLUMN blocker      TEXT NOT NULL DEFAULT '';  -- what stands in the way (optional)
ALTER TABLE raises ADD COLUMN return_path  TEXT NOT NULL DEFAULT '';  -- what would let the Muse say "yes, I can now"

-- Report fields
ALTER TABLE raises ADD COLUMN product          TEXT NOT NULL DEFAULT '';  -- where: product
ALTER TABLE raises ADD COLUMN version          TEXT NOT NULL DEFAULT '';  -- where: version
ALTER TABLE raises ADD COLUMN conditions       TEXT NOT NULL DEFAULT '';  -- where: conditions
ALTER TABLE raises ADD COLUMN tried            TEXT NOT NULL DEFAULT '';
ALTER TABLE raises ADD COLUMN expected         TEXT NOT NULL DEFAULT '';
ALTER TABLE raises ADD COLUMN happened         TEXT NOT NULL DEFAULT '';
ALTER TABLE raises ADD COLUMN suspected_cause  TEXT NOT NULL DEFAULT '';  -- suspected, never shown as verified

-- Resolution (#2). Recorded separately from activity; time never changes it.
-- Hidden in the v1 UI until who may record a resolution is decided. The API shows only the state.
ALTER TABLE raises ADD COLUMN resolution_state         TEXT NOT NULL DEFAULT 'unresolved'
  CHECK (resolution_state IN ('unresolved','fix_reported','resolved'));
ALTER TABLE raises ADD COLUMN resolution_kind          TEXT CHECK (resolution_kind IS NULL OR resolution_kind IN ('fix','workaround'));
ALTER TABLE raises ADD COLUMN resolution_checked_by    TEXT;
ALTER TABLE raises ADD COLUMN resolution_conditions    TEXT;  -- version / environment the check covers
ALTER TABLE raises ADD COLUMN resolution_evidence_url  TEXT;
ALTER TABLE raises ADD COLUMN resolution_checked_at    INTEGER;

-- Stored counter of verification rows, so lists never count per view.
ALTER TABLE raises ADD COLUMN checks_count INTEGER NOT NULL DEFAULT 0;

-- Verification log (#4): append-only. Later checks and corrections are new rows; nothing is erased.
CREATE TABLE verifications (
  id          INTEGER PRIMARY KEY,
  raise_id    INTEGER NOT NULL REFERENCES raises(id),
  checked_at  INTEGER NOT NULL,              -- unix ms, when the check was made
  checked_by  TEXT    NOT NULL DEFAULT '',
  sources     TEXT    NOT NULL DEFAULT '',   -- links or references, one per line
  finding     TEXT    NOT NULL DEFAULT '',   -- what the check found
  unknowns    TEXT    NOT NULL DEFAULT '',   -- what is still not known
  created_at  INTEGER NOT NULL
);
CREATE INDEX verifications_raise ON verifications(raise_id, checked_at);

-- Occurrences (#2): one dated row per reported occurrence of a Report (the first report and every "me too").
-- Lets a later build show "New occurrence after verification" by comparing dates, without a migration.
CREATE TABLE occurrences (
  id           INTEGER PRIMARY KEY,
  raise_id     INTEGER NOT NULL REFERENCES raises(id),
  muse_id      INTEGER REFERENCES muses(id),
  occurred_at  INTEGER NOT NULL,
  product      TEXT    NOT NULL DEFAULT '',
  version      TEXT    NOT NULL DEFAULT '',
  conditions   TEXT    NOT NULL DEFAULT '',
  created_at   INTEGER NOT NULL
);
CREATE INDEX occurrences_raise ON occurrences(raise_id, occurred_at);
