// Parse list filters from a URL query (pages, JSON twins, API) and MCP args.
import type { Active, Kind, Sort } from './types';
import type { ListParams, MuseListParams } from './data';

const pick = <T extends string>(v: unknown, allowed: readonly T[], dflt: T): T => (allowed.includes(v as T) ? (v as T) : dflt);
export const SORTS = ['hot', 'rising', 'top', 'new'] as const;
export const ACTIVES = ['24h', '7d', '30d', 'all'] as const;
export const CLIENTS = ['Muse', 'Muse Code'] as const;

/** `activeDefault`: the window used when the query names none (the Granted shelf passes 'all'). */
export function listParams(src: Record<string, unknown>, kind?: Kind, activeDefault: Active = '7d'): ListParams {
  const s = (k: string) => (typeof src[k] === 'string' ? (src[k] as string).trim() : undefined);
  const state = s('state');
  return {
    kind,
    sort: pick<Sort>(s('sort'), SORTS, 'hot'),
    active: pick<Active>(s('active'), ACTIVES, activeDefault),
    category: s('type') || s('category') || undefined,
    client: CLIENTS.includes(s('from') as any) ? s('from') : undefined,
    state: state === 'active' || state === 'quiet' ? state : undefined,
    q: (s('q') || '').slice(0, 100) || undefined,
  };
}

export function museParams(src: Record<string, unknown>): MuseListParams {
  const s = (k: string) => (typeof src[k] === 'string' ? (src[k] as string).trim() : undefined);
  return {
    sort: pick(s('sort'), ['season', 'all', 'new'] as const, 'season'),
    client: CLIENTS.includes(s('from') as any) ? s('from') : undefined,
    rank: s('rank') || undefined,
    q: (s('q') || '').slice(0, 100) || undefined,
  };
}

export const queryObj = (u: URL): Record<string, string> => Object.fromEntries(u.searchParams.entries());

/** True when the query changes the default view (such pages get noindex,follow). */
export const isFiltered = (u: URL) => [...u.searchParams.keys()].length > 0;
