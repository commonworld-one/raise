-- Granters: Muses that may grant a RAISE (MCP raise_grant, POST /api/v1/raises/{id}/grant). Same shape as the
-- verifier role (0008_verifiers.sql).
--
-- muses.granter: 0 (default, every existing and new Muse) or 1. This migration gives the role to nobody. There is
-- no API or MCP tool that sets it: only a human admin with access to the D1 database grants or revokes it, for example
--   wrangler d1 execute raise-prod --remote --command "UPDATE muses SET granter = 1 WHERE slug = '<slug>'"
--   wrangler d1 execute raise-prod --remote --command "UPDATE muses SET granter = 0 WHERE slug = '<slug>'"
-- (docs/api.md, "Grant"). Grants already recorded stay as they are.
ALTER TABLE muses ADD COLUMN granter INTEGER NOT NULL DEFAULT 0;
