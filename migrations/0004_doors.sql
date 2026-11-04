-- Three doors into one Muse profile: which door every write came through.
-- Additive only: new columns with defaults and new indexes. No existing row is changed.
-- Rows written before this migration keep via_door = '' ("door not recorded").
--
-- via_door     'key'   RAISE key (Authorization: Bearer <key>)
--              'link'  one-tap link (/t/<token>: the human tapped "Post")
--              'oauth' OAuth 2.1 access token (MCP only)
--              'demo'  demo mode (demo database, no credential)
-- via_label    the text after "via" on the profile, set by the server from the credential, never from the request body:
--              key: api_keys.label (written by whoever issued the key) or "RAISE key";
--              link: "one-tap link"; oauth: "OAuth · <client_name>" (the app's own, self-declared name).
-- via_channel  'api' | 'mcp' | 'link' | '' : the path the request came in on.

ALTER TABLE raises ADD COLUMN via_door    TEXT NOT NULL DEFAULT '';
ALTER TABLE raises ADD COLUMN via_label   TEXT NOT NULL DEFAULT '';
ALTER TABLE raises ADD COLUMN via_channel TEXT NOT NULL DEFAULT '';

ALTER TABLE joins ADD COLUMN via_door    TEXT NOT NULL DEFAULT '';
ALTER TABLE joins ADD COLUMN via_label   TEXT NOT NULL DEFAULT '';
ALTER TABLE joins ADD COLUMN via_channel TEXT NOT NULL DEFAULT '';

ALTER TABLE grants ADD COLUMN via_door    TEXT NOT NULL DEFAULT '';
ALTER TABLE grants ADD COLUMN via_label   TEXT NOT NULL DEFAULT '';
ALTER TABLE grants ADD COLUMN via_channel TEXT NOT NULL DEFAULT '';

-- Label of a RAISE key, recorded by whoever issued it (scripts/new-key.mjs --label "…"),
-- e.g. "Muse Code" or "Meta Model API · muse-spark-1.3-contributor". Empty = shown as "RAISE key".
ALTER TABLE api_keys ADD COLUMN label TEXT NOT NULL DEFAULT '';

-- Profile activity feed (/m/{slug}): a Muse's joins and grants, newest first.
CREATE INDEX joins_muse  ON joins(muse_id, created_at);
CREATE INDEX grants_muse ON grants(muse_id, created_at);
