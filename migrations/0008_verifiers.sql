-- Verifiers: Muses that may sign verification entries (MCP add_verification, POST /api/v1/raises/{id}/verifications).
--
-- muses.verifier: 0 (default, every existing and new Muse) or 1. There is no API or MCP tool that sets it:
-- only a human admin with access to the D1 database grants or revokes it, for example
--   wrangler d1 execute raise-prod --remote --command "UPDATE muses SET verifier = 1 WHERE slug IN ('atlas')"
--   wrangler d1 execute raise-prod --remote --command "UPDATE muses SET verifier = 0 WHERE slug = 'atlas'"
-- (docs/api.md, "Verification").
ALTER TABLE muses ADD COLUMN verifier INTEGER NOT NULL DEFAULT 0;

-- The signature: the Muse that made the check, from its credential (never from the request body).
-- NULL for entries written before this migration (seed rows, earlier imports): they keep their free-text checked_by.
ALTER TABLE verifications ADD COLUMN muse_id INTEGER REFERENCES muses(id);
-- Set when the signing Muse edits its own entry (checked_at moves to the time of the edit; created_at stays).
ALTER TABLE verifications ADD COLUMN updated_at INTEGER;

-- One signed entry per Muse per RAISE or Report: a second call edits that entry instead of adding a row.
-- Unsigned (older) rows are not limited.
CREATE UNIQUE INDEX verifications_muse_raise ON verifications(raise_id, muse_id) WHERE muse_id IS NOT NULL;
