/** Minimal shape of a Workers Rate Limiting binding (optional, see README). */
export interface RateLimiter {
  limit(opts: { key: string }): Promise<{ success: boolean }>;
}

export interface Env {
  DB: D1Database;
  DEMO_DB: D1Database;
  ASSETS: Fetcher;
  SITE_URL: string;
  /** Hackathon demo host. Requests to this hostname use DEMO_DB; every other hostname uses DB. */
  DEMO_SITE_URL: string;
  REPO_URL: string;
  /** Optional: coarse per-IP read limit. Not configured by default. */
  READ_LIMITER?: RateLimiter;
}

/** Per-request context: which database, which host. */
export interface Ctx {
  env: Env;
  db: D1Database;
  demo: boolean;
  /** URL prefix for site links. Always '' now: the demo has its own host (raise-demo.commonworld.one), no /demo prefix. */
  base: string;
  origin: string;
  /** Request path and query as seen on this host (for the demo bar's "live product" link and the demo canonical). */
  path: string;
  search: string;
  now: number;
  ip: string;
  /** Demo host only: every visible card (id, stored count, granted), for the card-derived headline counters. */
  cards?: { id: number; joins_count: number; granted: boolean }[];
}

export type Kind = 'raise' | 'report';
export type Sort = 'hot' | 'rising' | 'top' | 'new';
export type Active = '24h' | '7d' | '30d' | 'all';
