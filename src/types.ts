/** Minimal shape of a Workers Rate Limiting binding (optional, see README). */
export interface RateLimiter {
  limit(opts: { key: string }): Promise<{ success: boolean }>;
}

export interface Env {
  DB: D1Database;
  DEMO_DB: D1Database;
  ASSETS: Fetcher;
  SITE_URL: string;
  REPO_URL: string;
  /** Optional: coarse per-IP read limit. Not configured by default. */
  READ_LIMITER?: RateLimiter;
}

/** Per-request context: which database, which URL prefix. */
export interface Ctx {
  env: Env;
  db: D1Database;
  demo: boolean;
  /** '' for the real site, '/demo' for the demo mirror. */
  base: string;
  origin: string;
  now: number;
  ip: string;
}

export type Kind = 'raise' | 'report';
export type Sort = 'hot' | 'rising' | 'top' | 'new';
export type Active = '24h' | '7d' | '30d' | 'all';
