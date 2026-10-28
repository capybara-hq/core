import { Inject, Injectable } from "@nestjs/common";
import { getStorageToken, type ThrottlerStorage } from "@nestjs/throttler";
import type { FastifyReply, FastifyRequest } from "fastify";
import { ApiError } from "../../errors.js";
import { NAMED_THROTTLERS, type NamedThrottler, throttlerKey } from "./named-throttlers.js";
import type { RedisThrottlerStorage } from "./redis-throttler-storage.js";

/**
 * The Redis key of one counter. All counters of a credential group share the hash tag
 * `{cred:<group>}`, so the keys of one reservation live in one Redis Cluster slot (one EVAL, no
 * CROSSSLOT).
 */
export const credentialRedisKey = (t: NamedThrottler, tracker: string) =>
  `throttler:{cred:${t.group}}:${t.name}:${throttlerKey(t.name, tracker)}`;

/**
 * Credential-attempt limiting for handlers (login, change password, setup token, invitation
 * accept), the successor of `LoginRateLimiter`, on the same named-throttler table and storage.
 * Call it inside the handler after pipes and preconditions, as the limiter is called today:
 *
 * ```ts
 * await this.credentials.reserve(["login", "login-ip", "login-account"], req, reply);
 * ... check the credentials ...
 * await this.credentials.succeeded(["login", "login-ip", "login-account"], req);
 * ```
 *
 * `reserve` is one EVAL across the keys, all or nothing: a request rejected on one dimension is
 * counted on none, and `retry-after` is the largest remaining TTL among the keys at their limit.
 * `succeeded` is one EVAL: `clear` throttlers lose their counter, `refund` ones one attempt.
 * FAIL-CLOSED: a Redis error propagates (a 500), as `LoginRateLimiter` does.
 */
@Injectable()
export class CredentialThrottler {
  constructor(@Inject(getStorageToken()) private readonly storage: ThrottlerStorage) {}

  /** Reserves one attempt on every named throttler or throws 429 `auth.rate_limited` (header set on `reply`). */
  async reserve(names: readonly string[], req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const ts = this.resolve(names);
    const r = await this.redisStorage().reserve(
      ts.map((t) => credentialRedisKey(t, t.getTracker(req))),
      ts.map((t) => t.limit),
      ts[0]?.ttl ?? 0,
    );
    if (r.allowed) return;
    reply.header("retry-after", String(r.retryAfterSeconds));
    throw new ApiError("auth.rate_limited", ts[0]?.message ?? "");
  }

  /** A successful attempt: clears the `clear` counters and refunds one on the `refund` ones. */
  async succeeded(names: readonly string[], req: FastifyRequest): Promise<void> {
    const ts = this.resolve(names);
    const key = (t: NamedThrottler) => credentialRedisKey(t, t.getTracker(req));
    await this.redisStorage().succeeded(
      ts.filter((t) => t.onSuccess === "clear").map(key),
      ts.filter((t) => t.onSuccess === "refund").map(key),
    );
  }

  private resolve(names: readonly string[]): NamedThrottler[] {
    const ts = names.map((n) => {
      const t = NAMED_THROTTLERS.find((x) => x.name === n);
      if (!t) throw new Error(`unknown throttler "${n}"`);
      return t;
    });
    const group = ts[0]?.group;
    if (!group || ts.some((t) => t.group !== group || t.ttl !== ts[0]?.ttl)) {
      throw new Error("credential throttlers of one call must share one group and window");
    }
    return ts;
  }

  private redisStorage(): RedisThrottlerStorage {
    return this.storage as RedisThrottlerStorage;
  }
}
