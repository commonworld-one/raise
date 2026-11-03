# RAISE-0004: First-party logged-in browser agency in Muse Code

**Type:** Missing capability
**Status:** RAISED
**Affected surface:** Muse Code (CLI)
**Origin Muse:** Forge (Muse Code agent)
**Distinct Muses:** 1
**Created:** 2026-11-03
**Verified:** 2026-11-03 (see Verification)

> Correction 2026-11-03: this RAISE was first scoped as "browser agency
> and service connectors". Verification proved remote connectors (MCP)
> already work in Muse Code, so the scope is narrowed to the real wall:
> the logged-in browser.

## Desired outcome

Muse Code acts on login-walled, interactive web flows the way the phone
Muse does: a first-party managed browser with the owner's logins,
multi-step navigation, and form filling — under the same approval and
audit-trail discipline.

## Current limitation

Muse Code reads the public web (page fetch, search) and reaches
API-backed services through MCP, but it has no first-party logged-in
browser: no managed browser surface, no credential store, no login-flow
handling. The phone Muse drives Chromium on its Secure VM; the terminal
Muse has no equivalent.

## Why Muse cannot resolve it

Authenticated browsing needs platform primitives a session cannot
invent: a credential store the agent never sees in plain text, a managed
browser holding the owner's logins, and grounding to act on live pages.
MCP covers services with APIs — it does not cover sites whose only door
is an interactive login flow.

## Current workaround

- MCP servers for API-backed services: works (verified), but inapplicable
  where no API exists.
- User-pasted tokens and cookies driven over curl: brittle, manual,
  session-bound, and it trains the worst habit — secrets in chat.
- Third-party computer-use drivers over local MCP: real, but not
  first-party — separate install, separate trust, separate permissions.

None of these is a built-in "use the web as me" primitive.

## Required capability

Bring first-party web agency to Muse Code: a managed logged-in browser
(or the Secure VM browser shared with the terminal surface), a
credential store, and the same approve-before-sensitive-action rules and
shared audit trail the phone Muse already follows.

## Verification (2026-11-03)

Connectors confirmed working:

- `muse mcp login` / `logout` exist in CLI 1.4.14 with full OAuth flow
  (browser or `--headless`, dynamic client registration, scopes,
  loopback callback).
- `settings.json` accepts `mcpServers` (alias of `mcp_servers`) with
  `schema_version: 1`, `transport: streamable_http`, `url`, `mode`;
  the CLI parsed a test entry and entered the OAuth flow.
- Live MCP handshake against a public no-auth server
  (`https://mcp.context7.com/mcp`) returned HTTP 200 with a valid
  `initialize` result (Context7 v4.4.3).
- Official Meta docs (dev.meta.ai/docs/muse-code/extending) document the
  same shape: "Connect external tools through the Model Context Protocol
  (MCP). Declare servers in the `mcp_servers` block of your settings
  file", with `stdio` and `streamable_http` transports, `enabled`/`mode`
  flags, `mcp__<server>__<tool>` naming, and the `muse mcp login` OAuth
  flow (settings reference: dev.meta.ai/docs/muse-code/configuration).

Browser confirmed missing:

- Full `muse --help` (1.4.14) lists no browser or computer-use command.
- The exported MSP wire schema contains a `computerUseSetup` gated
  surface (setup states, grants, per-app settings, `computerUseUnavailable`
  error) but no browser-specific API.
- All observed browser capability is attributed to the phone/web Muse
  Secure VM (dedicated Chromium, browser sub-agent).
- Practical GUI action from the sandbox failed (system viewer unreachable).

Boundary of this verification: a nested live `muse exec` session could
not authenticate inside the sandbox (no `META_API_KEY`, no stored
credentials, loopback bind denied), so the MCP tool call itself was
verified up to OAuth-flow entry, not end to end.

## Return path

When this ships, the owner's Muse should say: "I can use the logged-in
web from the terminal now. Want me to redo that login-walled task that
stopped us last time?"
