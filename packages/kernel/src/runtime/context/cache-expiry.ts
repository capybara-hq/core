import type { ModelCacheInfo } from "@capybara-hq/plugin-sdk";
import type { ConversationEvent } from "../../conversations/events.js";
import { trustedCache } from "./cache-ttl.js";

/** The share of the lifetime after which the idle job fires (idle compaction spec §9.3). */
export const CACHE_FIRE_RATIO = 0.9;
/** The idle job fires at least this long before the expiry, in ms. */
export const CACHE_EXPIRY_MARGIN_MS = 30_000;

export interface CacheExpiry {
  /** The seq of the `model_call` the expiry was derived from. */
  callSeq: number;
  /** Epoch ms the lifetime is counted from. */
  t0: number;
  /** The lifetime in seconds. */
  ttl: number;
  /** Epoch ms; a lower bound when `isMinimum`. */
  expiresAt: number;
  /** `min(t0 + 0.9 * ttl, expiresAt - 30 s)`, epoch ms. */
  fireAt: number;
  isMinimum: boolean;
}

/**
 * When the prompt cache entry of the conversation's latest step call expires, derived from the
 * event log alone (idle compaction spec §9.3), or null when it cannot be told: no step call with
 * cache tokens on a model with a guaranteed cache, or no known lifetime.
 *
 * A step call is a `model_call` paired with the next `usage` event of the same run and step whose
 * `purpose` is absent. Side-call usage (compaction, title, ...) is ignored: it may refresh the
 * entry later, so ignoring it only gives an earlier, safe expiry. With `refreshOnHit` false only
 * a write starts a lifetime, so the latest call with `cacheWriteTokens > 0` is chosen instead of
 * the latest with any cache tokens.
 */
export function deriveCacheExpiry(
  events: readonly ConversationEvent[],
  cacheOf: (provider: string, model: string) => ModelCacheInfo | undefined,
): CacheExpiry | null {
  type Call = Extract<ConversationEvent, { type: "model_call" }>;
  // The open (not yet paired) call per run and step; a retry attempt replaces a failed one.
  const open = new Map<string, Call>();
  let best: CacheExpiry | null = null;

  for (const e of events) {
    if (e.type === "model_call") {
      open.set(`${e.runId}\u0000${e.payload.step}`, e);
      continue;
    }
    if (e.type !== "usage" || e.payload.purpose !== undefined) continue;
    const key = `${e.runId}\u0000${e.payload.step}`;
    const call = open.get(key);
    if (call === undefined) continue;
    open.delete(key);

    const cache = trustedCache(cacheOf(call.payload.provider, call.payload.model));
    if (cache === undefined || !cache.guaranteed) continue;
    const { cacheReadTokens, cacheWriteTokens } = e.payload;
    const counts = cache.refreshOnHit
      ? cacheReadTokens + cacheWriteTokens > 0
      : cacheWriteTokens > 0;
    if (!counts) continue;
    const ttl = call.payload.request.cacheTtl ?? cache.defaultTtl;
    if (ttl === undefined) {
      // the latest qualifying call has no known lifetime: nothing earlier stands in for it
      best = null;
      continue;
    }

    const t0 = (cache.ttlClock === "request_start" ? call.createdAt : e.createdAt).getTime();
    const expiresAt = t0 + ttl * 1000;
    best = {
      callSeq: call.seq,
      t0,
      ttl,
      expiresAt,
      fireAt: Math.min(t0 + CACHE_FIRE_RATIO * ttl * 1000, expiresAt - CACHE_EXPIRY_MARGIN_MS),
      isMinimum: cache.ttlIsMinimum,
    };
  }
  return best;
}
