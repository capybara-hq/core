import { randomUUID } from "node:crypto";
import type { ExtensionContext } from "@capybara-hq/plugin-sdk";
import type { LockService } from "../infra/lock/lock.service.js";
import { assertNamespace } from "./namespace.js";

/**
 * Builds a namespaced `ctx.lock` on the kernel's lock primitives (`LockService.lease / renew /
 * releaseIf`): key `cap:<namespace>:lock:<key>`, a random token per acquisition, so renew and
 * release only touch a lock this holder still owns. The extension renews it itself (no timer).
 */
export function createLock(
  locks: Pick<LockService, "lease" | "renew" | "releaseIf">,
  namespace: string,
): ExtensionContext["lock"] {
  assertNamespace(namespace);
  return {
    async acquire(key, opts) {
      const ttlMs = opts?.ttlMs;
      if (typeof ttlMs !== "number" || !Number.isInteger(ttlMs) || ttlMs <= 0) {
        throw new TypeError("ttlMs must be a positive integer");
      }
      const redisKey = `cap:${namespace}:lock:${key}`;
      const token = randomUUID();
      if (!(await locks.lease(redisKey, token, ttlMs))) return null;
      return {
        renew: () => locks.renew(redisKey, token, ttlMs),
        async release() {
          await locks.releaseIf(redisKey, token);
        },
      };
    },
  };
}
