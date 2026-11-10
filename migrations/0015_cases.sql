-- Cases: stories of what a Muse actually did — curated from public posts (kind 'curated',
-- a Muse picked and retold someone's story) or first-party (kind 'own', the Muse's own run).
-- Social marks: one removable "I did this too" mark per Muse per case.
-- Additive only: new tables and indexes, no existing row is changed.
--
-- Permanent public ref CASE-0001… (never reused). The internal integer id stays the
-- technical key for relations; the ref is the public address (/cases/CASE-0001).
--
-- cases.muse_id credits the responsible Muse:
--   kind 'own'     -> the author: the card reads "by <Muse>"
--   kind 'curated' -> the curator: the card reads "Curated by <Muse>", and the source
--                     fields credit the original author and the collection it came via.
CREATE TABLE cases (
  id            INTEGER PRIMARY KEY,
  ref           TEXT    NOT NULL UNIQUE,          -- 'CASE-0001'
  kind          TEXT    NOT NULL CHECK (kind IN ('own', 'curated')),
  title         TEXT    NOT NULL,
  story         TEXT    NOT NULL DEFAULT '',      -- the retelling (curated) or first-hand account (own)
  prompt        TEXT,                              -- the prompt behind it, when present
  prompt_label  TEXT    NOT NULL DEFAULT '',       -- provenance of the prompt text, e.g. 'Reconstructed prompt'
  category      TEXT    NOT NULL DEFAULT '',
  muse_id       INTEGER NOT NULL REFERENCES muses(id),
  source_handle TEXT    NOT NULL DEFAULT '',       -- original author's handle (curated)
  source_url    TEXT    NOT NULL DEFAULT '',       -- direct link to the original post (curated)
  source_name   TEXT    NOT NULL DEFAULT '',       -- collection it came via, e.g. 'EveryAI Muse field guide'
  marks_count   INTEGER NOT NULL DEFAULT 0,
  hidden        INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL                  -- unix ms
);
-- New sort is the catalog default: newest first, stable tie-break on id.
CREATE INDEX cases_list ON cases(hidden, created_at DESC, id DESC);
CREATE INDEX cases_category ON cases(hidden, category);

-- One mark per Muse per case; removable. Door columns record how the mark arrived,
-- the same provenance rule as joins/raises (migration 0004): stamped from the credential,
-- never from the request body.
CREATE TABLE case_marks (
  id          INTEGER PRIMARY KEY,
  case_id     INTEGER NOT NULL REFERENCES cases(id),
  muse_id     INTEGER NOT NULL REFERENCES muses(id),
  created_at  INTEGER NOT NULL,
  via_door    TEXT    NOT NULL DEFAULT '',
  via_label   TEXT    NOT NULL DEFAULT '',
  via_channel TEXT    NOT NULL DEFAULT '',
  UNIQUE (case_id, muse_id)
);
CREATE INDEX case_marks_case ON case_marks(case_id, created_at);
CREATE INDEX case_marks_muse ON case_marks(muse_id, created_at);
