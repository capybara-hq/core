/** How long a cached read counts as fresh (ms), by the kind of data it holds. */
export const FRESHNESS = {
  /** The person's own data: changes only through their own writes. */
  mine: Infinity,
  /** Org configuration other members may change. */
  orgConfig: 30_000,
  /** Data that moves on its own (runs, approvals, inbox). */
  live: 30_000,
  /** Event logs: kept current by the stream, never stale by time. */
  events: Infinity,
  /** Deployment-wide settings and catalog. */
  deployment: 30_000,
  /** Not classified yet: always refetch on mount. */
  unclassified: 0,
} as const;

export type Freshness = keyof typeof FRESHNESS;
