import {
  applyDecorators,
  type ExecutionContext,
  Inject,
  Injectable,
  SetMetadata,
  UseGuards,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import {
  getOptionsToken,
  getStorageToken,
  ThrottlerGuard,
  type ThrottlerModuleOptions,
  type ThrottlerRequest,
  type ThrottlerStorage,
} from "@nestjs/throttler";
import type { FastifyReply } from "fastify";
import { ApiError } from "../../errors.js";
import { NAMED_THROTTLERS } from "./named-throttlers.js";

const THROTTLED = "kernel:throttled";

/** The throttler names selected for the route `context` runs (empty: none, the guard passes). */
export function selectedThrottlers(context: ExecutionContext): readonly string[] {
  return (
    Reflect.getMetadata(THROTTLED, context.getHandler()) ??
    Reflect.getMetadata(THROTTLED, context.getClass()) ??
    []
  );
}

/**
 * Opts a route (or controller) in to the named throttlers `names` (see `NAMED_THROTTLERS`).
 * Throttling is per-route opt-in because the kernel limits only credential-checking routes today;
 * health, SSE and extension routes stay unlimited.
 */
export const Throttled = (...names: string[]) => {
  for (const n of names) {
    if (!NAMED_THROTTLERS.some((t) => t.name === n)) throw new Error(`unknown throttler "${n}"`);
  }
  return applyDecorators(SetMetadata(THROTTLED, names), UseGuards(KernelThrottlerGuard));
};

/**
 * `@nestjs/throttler`'s guard with the kernel's error contract: the first named throttler of the
 * route at its limit answers 429 `auth.rate_limited` with its own message and `retry-after`
 * (seconds, 1..window), exactly as `LoginRateLimiter` did; no `x-ratelimit-*` headers (the
 * kernel sends none today). Which throttlers apply to a route is chosen by `@Throttled`.
 */
@Injectable()
export class KernelThrottlerGuard extends ThrottlerGuard {
  constructor(
    @Inject(getOptionsToken()) options: ThrottlerModuleOptions,
    @Inject(getStorageToken()) storage: ThrottlerStorage,
    @Inject(Reflector) reflector: Reflector,
  ) {
    super(options, storage, reflector);
  }

  protected override async handleRequest(props: ThrottlerRequest): Promise<boolean> {
    const { context, limit, ttl, throttler, blockDuration, getTracker, generateKey } = props;
    const http = context.switchToHttp();
    const name = throttler.name ?? "default";
    const tracker = await getTracker(http.getRequest(), context);
    const key = generateKey(context, tracker, name);
    const r = await this.storageService.increment(key, ttl, limit, blockDuration, name);
    if (!r.isBlocked) return true;
    http.getResponse<FastifyReply>().header("retry-after", String(r.timeToBlockExpire));
    const message = NAMED_THROTTLERS.find((t) => t.name === name)?.message ?? "Too many attempts";
    throw new ApiError("auth.rate_limited", message);
  }
}
