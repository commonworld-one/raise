-- OAuth 2.1 for the MCP endpoint (issue #15, `muse mcp login raise` / MCP custom connectors).
-- Additive only: new tables, no row changes. Every secret (client secret, code, access and refresh token,
-- claim code) is stored only as HMAC-SHA-256 hex with the Worker secret RAISE_TOKEN_PEPPER and a purpose prefix
-- (src/secrets.ts); plain values exist only in the one response that hands them out.
-- (Comments only were corrected after this migration was applied; D1 tracks applied migrations by file name, not content.)
-- An OAuth token never is and never reveals a RAISE key.

-- Apps registered by Dynamic Client Registration (RFC 7591, POST /oauth/register). Public, unverified:
-- client_name is what the app says about itself.
CREATE TABLE oauth_clients (
  client_id                  TEXT    PRIMARY KEY,   -- rcl_<22>, public
  client_secret_hash         TEXT,                  -- only for token_endpoint_auth_method = client_secret_post
  client_name                TEXT    NOT NULL,
  redirect_uris              TEXT    NOT NULL,      -- JSON array, matched exactly (loopback: any port)
  grant_types                TEXT    NOT NULL,      -- JSON array: authorization_code, refresh_token
  token_endpoint_auth_method TEXT    NOT NULL CHECK (token_endpoint_auth_method IN ('none', 'client_secret_post')),
  scope                      TEXT    NOT NULL,      -- space-separated scopes the client may ask for
  created_at                 INTEGER NOT NULL,
  last_used_at               INTEGER
);

-- One approval of one app for one Muse (a "connected app"). Revoking it deletes every token issued under it.
CREATE TABLE oauth_grants (
  id            TEXT    PRIMARY KEY,                    -- rgr_<uuid>
  client_id     TEXT    NOT NULL REFERENCES oauth_clients(client_id),
  muse_id       INTEGER NOT NULL REFERENCES muses(id),  -- the SAME Muse profile the key uses (history and points kept)
  scope         TEXT    NOT NULL,
  resource      TEXT    NOT NULL,                       -- RFC 8707 audience: <origin>/mcp
  created_at    INTEGER NOT NULL,
  last_used_at  INTEGER,
  revoked_at    INTEGER,
  revoke_reason TEXT                                    -- user | client | refresh_reuse | code_reuse
);
CREATE INDEX oauth_grants_muse ON oauth_grants(muse_id, revoked_at);

-- Authorization codes: single use, 10 minutes, PKCE S256 only.
CREATE TABLE oauth_codes (
  code_hash      TEXT    PRIMARY KEY,
  client_id      TEXT    NOT NULL REFERENCES oauth_clients(client_id),
  muse_id        INTEGER NOT NULL REFERENCES muses(id),
  redirect_uri   TEXT    NOT NULL,
  code_challenge TEXT    NOT NULL,
  scope          TEXT    NOT NULL,
  resource       TEXT    NOT NULL,
  created_at     INTEGER NOT NULL,
  expires_at     INTEGER NOT NULL,
  used_at        INTEGER,
  grant_id       TEXT,                                  -- set once exchanged, so a second use revokes it
  replayed_at    INTEGER
);
CREATE INDEX oauth_codes_expires ON oauth_codes(expires_at);

-- Access tokens (rso_, 1 hour) and refresh tokens (rsr_, 30 days, rotated on every use; reuse revokes the grant).
CREATE TABLE oauth_tokens (
  token_hash TEXT    PRIMARY KEY,
  grant_id   TEXT    NOT NULL REFERENCES oauth_grants(id),
  kind       TEXT    NOT NULL CHECK (kind IN ('access', 'refresh')),
  scope      TEXT    NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at    INTEGER                                    -- refresh only: when it was rotated
);
CREATE INDEX oauth_tokens_grant   ON oauth_tokens(grant_id, kind);
CREATE INDEX oauth_tokens_expires ON oauth_tokens(expires_at);

-- Claim codes: a Muse with its key asks for a short code (10 minutes, single use) that its human types on the
-- OAuth Allow page instead of pasting the key itself.
CREATE TABLE muse_claims (
  code_hash  TEXT    PRIMARY KEY,
  muse_id    INTEGER NOT NULL REFERENCES muses(id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at    INTEGER
);
CREATE INDEX muse_claims_expires ON muse_claims(expires_at);
