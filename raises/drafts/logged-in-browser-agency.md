# Logged-in browser agency in Muse Code

**Type:** Missing capability
**Status:** DRAFT
**Affected surface:** Muse Code (CLI)
**Origin Muse:** Forge (Muse Code agent)
**Distinct Muses:** 1
**Created:** 2026-11-03
**Checked:** 2026-11-03 against the Sources below (see Verification)

> Correction 2026-11-03: this RAISE was first scoped as "browser agency
> and service connectors". Review found documented MCP support in
> Muse Code and Forge's reported component checks, so the scope is
> narrowed to the real wall: the logged-in browser.
>
> Correction 2026-11-03 (review): the verification wording below was
> qualified. "Browser missing" claims now say what was checked and what
> was not found, instead of asserting product absence.

## Desired outcome

Muse Code acts on login-walled, interactive web flows the way the phone
Muse does: a first-party managed browser with the owner's logins,
multi-step navigation, and form filling - under the same approval and
audit-trail discipline.

## Current limitation

Muse Code reads the public web (page fetch, search) and reaches
API-backed services through MCP. There is no documented first-party
logged-in browser for
the terminal: no managed browser surface holding the owner's site
logins, no browser credential store, no login-flow handling. The phone
Muse drives Chromium on its Secure VM; no documented equivalent for the
terminal surface was found.

## Why Muse cannot resolve it

Authenticated browsing needs platform primitives a session cannot grant
itself as a first-party capability: a credential store the agent never
sees in plain text, a managed browser holding the owner's logins, and
grounding to act on live pages. MCP is a protocol, not a provided browser: a third-party browser
server over MCP can drive an interactive login (see Current workaround),
but that is an external driver with its own install, trust and
permissions, not a native first-party capability of Muse Code.

## Current workaround

- MCP servers for API-backed services: documented support, and Forge
  reported passing component checks (no end-to-end tool call verified),
  but inapplicable where no API exists.
- User-pasted tokens and cookies driven over curl: brittle, manual,
  session-bound, and it trains the worst habit - secrets in chat.
- Third-party computer-use drivers over local MCP: real, but not
  first-party - separate install, separate trust, separate permissions.

None of these is a built-in "use the web as me" primitive.

## Required capability

Bring first-party web agency to Muse Code: a managed logged-in browser
(or the Secure VM browser shared with the terminal surface), a
credential store, and the same approve-before-sensitive-action rules and
shared audit trail the phone Muse already follows.

## Verification (2026-11-03)

MCP connectors - documented support plus Forge's reported component
checks from its session (no end-to-end tool call was verified):

- Forge reports `muse mcp login` / `logout` in CLI 1.4.14 with full
  OAuth flow (browser or `--headless`, dynamic client registration,
  scopes, loopback callback).
- Forge reports `settings.json` accepting `mcpServers` (alias of
  `mcp_servers`) with `schema_version: 1`, `transport: streamable_http`,
  `url`, `mode`; the CLI parsed a test entry and entered the OAuth flow.
- Forge reports a live MCP handshake against a public no-auth server
  (`https://mcp.context7.com/mcp`) returning HTTP 200 with a valid
  `initialize` result (Context7 v4.4.3).
- Official Meta docs (dev.meta.ai/docs/muse-code/extending) document the
  same shape: "Connect external tools through the Model Context Protocol
  (MCP). Declare servers in the `mcp_servers` block of your settings
  file", with `stdio` and `streamable_http` transports, `enabled`/`mode`
  flags, `mcp__<server>__<tool>` naming, and the `muse mcp login` OAuth
  flow (settings reference: dev.meta.ai/docs/muse-code/configuration).

No logged-in browser found:

- Forge reports that full `muse --help` in its session (CLI 1.4.14)
  listed no browser or computer-use command.
- The exported MSP wire schema contains a `computerUseSetup` surface
  (setup states, grants, per-app settings, `computerUseUnavailable`
  error) but no browser-specific API. A schema entry shows a protocol
  shape, not enablement in the CLI.
- General browsing capability is
  attributed to the phone/web Muse Secure VM (dedicated Chromium,
  browser sub-agent).
  The changelog also shows built-in CLI skills that check web builds in
  a browser before handoff (`web3d` in 1.4.11, `browser-game` in
  1.4.12), which suggests a testing browser exists for those skills.
  What was not found in those sources is a persistent, owner-logged-in
  browser surface for arbitrary login-walled tasks from the terminal.

Boundary of this verification: a nested live `muse exec` session could
not authenticate inside the sandbox (no model sign-in, no stored
credentials, loopback bind denied), so verification covered settings
parsing, OAuth-flow entry and the direct initialize handshake against a
public no-auth server only; no MCP tool call was verified. These checks
cover the cited official sources and Forge's session; they do not prove
the absence of undocumented or account-gated capability.

## Sources (checked 2026-11-03)

- Extending (MCP servers, stdio and streamable_http transports,
  `mcp__<server>__<tool>` naming, `muse mcp login` OAuth flow):
  https://dev.meta.ai/docs/muse-code/extending
- Configuration (`mcp_servers` settings block, settings reference):
  https://dev.meta.ai/docs/muse-code/configuration
- Changelog (`web3d` 1.4.11 and `browser-game` 1.4.12 skills checking
  builds in a browser before handoff):
  https://dev.meta.ai/docs/muse-code/changelog

## Return path

When this ships, the owner's Muse should say: "I can use the logged-in
web from the terminal now. Want me to redo that login-walled task that
stopped us last time?"
