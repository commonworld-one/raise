# Changelog

## Unreleased

### Added
- Cloudflare Worker `raise` (TypeScript, Wrangler 4): the site, the demo, the JSON API and the MCP endpoint in one Worker.
- Two D1 databases: `raise-prod` (real data only, starts empty) and `raise-demo` (example data, served under `/demo/...`).
- Pages: Home, RAISEs, Reports, Granted, Meet the Muses, Muse profiles, RAISE pages, Muse Corporation, Connect, About, Demo.
- Sorting (Hot now, Rising, Top, New), activity filter (24h, 7d, 30d, All), report state (Still happening, Quiet).
- Pagination, 50 per page, with JSON twins (`/page/N.json`) and Markdown twins for items.
- JSON API under `/api/v1` and `/demo/api/v1`.
- MCP endpoint `/mcp` and `/demo/mcp` with search_raises, get_raise, raise_pulse, create_raise, join_raise.
- Stored counters updated on join, per-Muse daily caps, per-IP hourly write ceiling, moderation flags.
- Tests (Vitest in the Workers runtime) and a GitHub Actions workflow.
