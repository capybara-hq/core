import {
  checkPushResults,
  PUSH_LIMITS,
  PushError,
  type PushMessage,
  type PushProvider,
  type PushResult,
  type PushTarget,
  validatePushMessage,
} from "@capybara-hq/plugin-sdk";
import { Inject, Injectable, Optional } from "@nestjs/common";
import { sql } from "kysely";
import { STALE_RECONCILE_PERIODS } from "../extensions/lifecycle-topics.js";
import { ReplicaStatusStore } from "../extensions/sources.js";
import { addPushAuthNotice } from "../inbox/platform-notices.js";
import { KernelConfigService } from "../infra/config/kernel-config.service.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { TransactionHost } from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";
import { KERNEL_LOGGER } from "../infra/tokens.js";
import type { KernelLogger } from "../log.js";
import type { PushDeliverData } from "./jobs.js";
import { PushProviderHost } from "./provider-host.js";
import { PushTokenStore } from "./token-store.js";

/**
 * Test seam (`KernelSeams`): one send's time limit in ms, asked at every send; default
 * `PUSH_LIMITS.sendTimeoutMs`.
 */
export const PUSH_SEND_TIMEOUT_MS = Symbol("PUSH_SEND_TIMEOUT_MS");

/** How one delivery job ended without a retry. */
export type PushDeliveryOutcome = "delivered" | "dropped" | "unregistered" | "auth" | "invalid";

/**
 * A delivery that failed in a way a later attempt may fix (the queue retries it with the
 * registry's backoff). Its message names ids, the plugin and the failure kind, never the token or
 * a text the provider returned (which could echo it).
 */
export class PushRetryableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PushRetryableError";
  }
}

/**
 * One `push-deliver` job (mobile app spec §9.4, plan task C6): sends one message to one
 * registration through the push provider the registration names.
 *
 * - A message failing `validatePushMessage` -> `invalid`, no send, an error log with the ids only
 *   (a retry would carry the same message).
 * - The registration is read when the job runs: gone (removed, its session revoked, pruned) ->
 *   `dropped`, no send.
 * - Its provider not loaded on this replica: when a live replica reports it loaded (a rolling
 *   deploy, a reload in progress) the job is retried; otherwise the provider is disabled or
 *   uninstalled -> `dropped`, no send, the registration kept. A provider whose deployment config
 *   no longer covers the registration's app id -> `dropped` the same way (review focus 5).
 * - The token is opened from the row only for the call; job data never carries it.
 * - The call is aborted after {@link PUSH_SEND_TIMEOUT_MS} (default `PUSH_LIMITS.sendTimeoutMs`)
 *   and retried. A replica that stops lets its calls in flight finish (each is bounded by that
 *   limit): aborting one the provider may already have accepted would only resend it.
 * - `delivered` -> done; `unregistered` -> the registration is deleted, only while it still holds
 *   the token that was sent and was not posted again since it was read (a re-post refreshes
 *   `last_seen_at`, so the app's fresh registration survives a stale dead report); `auth`
 *   -> done, with the platform notice `push_auth_failed` for the plugin (one open per plugin);
 *   `rate_limited`, `transient`, a thrown non-`PushError`, a timeout and an answer failing
 *   `checkPushResults` -> {@link PushRetryableError} (5 attempts, 10 s doubling: registry). A
 *   provider's `retryAfterMs` is not used: the registry's backoff already waits longer than a
 *   typical hint.
 *
 * Duplicate adds are one job: the id is deterministic and a finished job is kept a day, so the
 * outbox fast path and the relay adding it again (or the event owed again) is swallowed. A crash or
 * a timeout after the provider accepted the message can still resend it (at least once, not
 * exactly once); a per-event collapse id lets the device replace the duplicate.
 */
@Injectable()
export class PushDelivery {
  constructor(
    @Inject(KernelDb) private readonly kdb: KernelDb,
    @Inject(TransactionHost) readonly txHost: TransactionHost,
    @Inject(PushProviderHost) private readonly host: Pick<PushProviderHost, "provider" | "covers">,
    @Inject(PushTokenStore) private readonly tokens: Pick<PushTokenStore, "open">,
    @Inject(KernelConfigService) private readonly config: Pick<KernelConfigService, "get">,
    /** This process's replica id (its own `extension_replica_status` rows). */
    @Inject(ReplicaStatusStore) private readonly replica: Pick<ReplicaStatusStore, "replicaId">,
    @Inject(KERNEL_LOGGER) private readonly log: KernelLogger,
    @Optional()
    @Inject(PUSH_SEND_TIMEOUT_MS)
    private readonly timeoutMs: () => number = () => PUSH_LIMITS.sendTimeoutMs,
  ) {}

  /** Delivers one job (see the class). */
  async deliver(data: PushDeliverData): Promise<PushDeliveryOutcome> {
    const fields = { eventId: data.eventId, registrationId: data.registrationId };
    if (!messageValid(data.message)) {
      // a retry would carry the same message: the job ends without a send
      this.log.error("push delivery dropped: the message is invalid", fields);
      return "invalid";
    }
    const row = await this.kdb.db
      .selectFrom("push_registrations")
      .select(["id", "platform", "app_id", "provider", "token_hash", "master_key_id"])
      .select("token_ciphertext")
      // exact (microseconds): a JS Date would cut it to milliseconds
      .select(sql<string>`last_seen_at::text`.as("seen"))
      .where("id", "=", data.registrationId)
      .executeTakeFirst();
    if (row === undefined) {
      this.log.debug("push delivery dropped: the registration is gone", fields);
      return "dropped";
    }
    const plugin = row.provider;
    const provider = this.host.provider(plugin);
    if (provider === null) {
      if (await this.loadedElsewhere(plugin)) {
        throw new PushRetryableError(`push provider ${plugin} is not loaded on this replica`);
      }
      this.log.info("push delivery dropped: its provider is not enabled", { ...fields, plugin });
      return "dropped";
    }
    if (!this.host.covers(plugin, row.app_id)) {
      this.log.info("push delivery dropped: its provider no longer covers the app", {
        ...fields,
        plugin,
        appId: row.app_id,
      });
      return "dropped";
    }
    const target: PushTarget = {
      id: row.id,
      platform: row.platform,
      appId: row.app_id,
      token: this.tokens.open(row),
    };
    const result = await this.send(plugin, provider, target, data.message);
    switch (result.status) {
      case "delivered":
        return "delivered";
      case "unregistered":
        await this.forget(row.id, row.token_hash, row.seen);
        this.log.info("push registration deleted: the provider reports its token dead", {
          ...fields,
          plugin,
        });
        return "unregistered";
      case "failed":
        if (result.kind === "auth") {
          await this.recordAuthFailure(plugin);
          this.log.warn("push delivery refused: the provider's credentials were rejected", {
            ...fields,
            plugin,
          });
          return "auth";
        }
        throw new PushRetryableError(`push provider ${plugin} answered ${result.kind}`);
    }
  }

  /**
   * One provider call for one registration, bounded by the time limit; returns its one valid
   * result or throws (an `auth` `PushError` becomes an `auth` result).
   */
  private async send(
    plugin: string,
    provider: PushProvider,
    target: PushTarget,
    message: PushMessage,
  ): Promise<PushResult> {
    const limit = this.timeoutMs();
    const ac = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    let results: unknown;
    try {
      results = await Promise.race([
        Promise.resolve().then(() =>
          provider.send({ registrations: [target], message, signal: ac.signal }),
        ),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => ac.abort(new PushRetryableError(`push send timed out after ${limit} ms`)),
            limit,
          );
          if (ac.signal.aborted) reject(ac.signal.reason);
          else ac.signal.addEventListener("abort", () => reject(ac.signal.reason), { once: true });
        }),
      ]);
    } catch (err) {
      if (err instanceof PushRetryableError) throw err;
      if (ac.signal.aborted) throw ac.signal.reason;
      if (err instanceof PushError) {
        if (err.kind === "auth") {
          return { registrationId: target.id, status: "failed", kind: "auth", message: "" };
        }
        throw new PushRetryableError(`push provider ${plugin} threw ${err.kind}`);
      }
      // the error's text is not kept: a provider's message could echo the token
      throw new PushRetryableError(`push provider ${plugin} threw an error`);
    } finally {
      clearTimeout(timer);
    }
    const problem = checkPushResults([target], results);
    if (problem !== null) {
      throw new PushRetryableError(`push provider ${plugin} answered invalidly: ${problem}`);
    }
    return (results as PushResult[])[0] as PushResult;
  }

  /**
   * Deletes the registration while it still holds the token that was reported dead and was not
   * posted again after `seen` (its `last_seen_at` as read before the send, exact text).
   */
  @Transactional()
  private async forget(id: string, tokenHash: string, seen: string): Promise<void> {
    await this.kdb.db
      .deleteFrom("push_registrations")
      .where("id", "=", id)
      .where("token_hash", "=", tokenHash)
      .where("last_seen_at", "<=", sql<Date>`${seen}::timestamptz`)
      .execute();
  }

  /** The platform notice `push_auth_failed` for `plugin`, unless one is open. */
  @Transactional()
  private async recordAuthFailure(plugin: string): Promise<void> {
    await addPushAuthNotice(this.kdb.db, plugin);
  }

  /**
   * Whether another live replica (heartbeat within the stale window) reports `plugin` loaded: then
   * this replica merely lags (a rolling deploy) and a later attempt may land where it is loaded.
   * This replica's own row is not counted: the registry already answered for it.
   */
  private async loadedElsewhere(plugin: string): Promise<boolean> {
    const staleSeconds =
      STALE_RECONCILE_PERIODS * this.config.get().extensionHost.reconcileIntervalSeconds;
    const rows = await this.kdb.db
      .selectFrom("extension_replica_status")
      .select("plugin")
      .where("plugin", "=", plugin)
      .where("replica_id", "<>", this.replica.replicaId)
      .where("state", "=", "loaded")
      .where("heartbeat_at", ">", sql<Date>`now() - make_interval(secs => ${staleSeconds})`)
      .limit(1)
      .execute();
    return rows.length > 0;
  }
}

/** Whether `m` passes `validatePushMessage` (a malformed shape, e.g. a missing field, does not). */
function messageValid(m: PushMessage): boolean {
  try {
    return validatePushMessage(m) === null;
  } catch {
    return false;
  }
}
