import { RATE_LIMITER } from "../http/tokens.js"; // expect: kc-rate-limit
import type { LoginRateLimiter } from "./rate-limit.js"; // expect: kc-rate-limit

export async function hit(redis: Redis, key: string): Promise<number> {
  return redis.incr(key); // expect: kc-rate-limit
}
