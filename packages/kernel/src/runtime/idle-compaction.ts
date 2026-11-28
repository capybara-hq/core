import type { ConversationSource } from "@capybara-hq/plugin-sdk";
import { Inject, Injectable } from "@nestjs/common";
import { visibleTo } from "../agents/agent-lookup.js";
import { normalizeStoredDefinition } from "../agents/definition.js";
import { effectiveDefinition, readSelection, sameModel } from "../conversations/selection.js";
import { AccountsService } from "../identity/accounts.js";
import { COMPACTION_SETTINGS } from "../identity/settings.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { KERNEL_LOGGER } from "../infra/tokens.js";
import type { KernelLogger } from "../log.js";
import { ModelPurposesService } from "../models/purposes.js";
import { CompactionService } from "./compaction.service.js";
import {
  type CompactionModelPort,
  chooseSummarizer,
  compactionModelPort,
} from "./compaction-model.js";
import { CompactionSettingsService } from "./compaction-settings.service.js";
import { CACHE_EXPIRY_MARGIN_MS, CACHE_FIRE_RATIO } from "./context/cache-expiry.js";
import {
  type IdleFireFacts,
  type IdleFireOutcome,
  type IdleMode,
  idleFireDecision,
} from "./context/idle-compaction-rules.js";
import type { IdleCompactionJobInput } from "./idle-compaction-jobs.js";
import { type BoundProvider, ProviderRegistry, type ResolvedModelInfo } from "./providers.js";
import { ACTIVE_RUN_STATUSES } from "./run-jobs.js";
import { isLive, orgIsLive } from "./run-liveness.js";
import { RunQueue } from "./run-queue.js";

/**
 * Facts not read yet, set so that they pass: {@link idleFireDecision} over the facts read so far
 * plus these fails only on a fact already read, so the reads stop at the first failing check while
 * the rules stay in one place (as `IdleArm` does for the arm decision). `now` and `expiresAt` need
 * no read but join the known facts only at check 5 (`expiresAt` +∞ until then), so a late job that
 * also fails an earlier check reports that check's outcome (spec §4.3 order).
 */
const PASSING: IdleFireFacts = {
  live: true,
  stale: false,
  busy: false,
  enabled: true,
  now: 0,
  expiresAt: Number.POSITIVE_INFINITY,
  backoff: false,
  mode: "cache",
  modelReady: true,
  probe: {
    estimate: Number.POSITIVE_INFINITY,
    window: 0,
    growth: Number.POSITIVE_INFINITY,
    planned: true,
  },
  inContext: true,
  settings: COMPACTION_SETTINGS.parse({}),
};

/** What the job's one `info` line carries besides the outcome (idle compaction spec §7). */
interface FireLog {
  /** How the job compacts (compaction model spec §6.3); a row without one is a cache job (C5). */
  mode?: IdleMode;
  idleRunId?: string;
  estimate?: number;
  ttl?: number;
  lateMs?: number;
}

/**
 * One delivery of the delayed `idle-compaction` job (idle compaction spec §4.3, §5.1): re-reads
 * the conversation, decides through {@link idleFireDecision} and starts the idle compact run
 * through {@link RunQueue.startIdleCompaction}, which repeats the liveness, staleness and activity
 * checks under the conversation row lock. Runs in the maintenance processor (worker role only)
 * inside `runJob` with the job's org scope. Holds no state between deliveries: every fact comes
 * from the database and the event log, so a duplicate delivery on another replica sees the first
 * delivery's run (an event after `armedSeq`, or an active run) and ends `obsolete` or `busy`.
 *
 * The job's mode (compaction model spec §6.3): a `compaction_model` job has no expiry (a late
 * delivery still runs), requires the compaction model at fire time (`chooseSummarizer` against the
 * effective definition's model, read from PG on every delivery) and never falls back to the
 * conversation model or to cache mode; the run it starts carries the mode (`runs.idle_mode`).
 */
@Injectable()
export class IdleCompactionJob {
  /** The org's `compaction` purpose, read from PG on every delivery (nothing cached). */
  private readonly compactionModel: CompactionModelPort;

  constructor(
    @Inject(KernelDb) private readonly kdb: KernelDb,
    @Inject(CompactionSettingsService)
    private readonly compaction: Pick<CompactionSettingsService, "resolve">,
    @Inject(AccountsService) private readonly accounts: Pick<AccountsService, "idleCompactionOff">,
    @Inject(ProviderRegistry) private readonly models: Pick<ProviderRegistry, "resolve">,
    @Inject(ModelPurposesService) purposes: Pick<ModelPurposesService, "resolve">,
    @Inject(CompactionService) private readonly compactions: Pick<CompactionService, "probeIdle">,
    @Inject(RunQueue) private readonly runs: Pick<RunQueue, "startIdleCompaction">,
    @Inject(KERNEL_LOGGER)
    private readonly log: Pick<KernelLogger, "info" | "warn" | "error" | "debug">,
  ) {
    this.compactionModel = compactionModelPort(purposes);
  }

  /**
   * One delivery of `idle-compact-<runId>` (spec §4.3): gathers {@link IdleFireFacts} cheapest
   * first, stopping at the first failing check, decides, and starts the run. Logs one `info` line,
   * context=IdleCompaction. A database failure throws (BullMQ retries the job within its attempts).
   */
  async fire(data: IdleCompactionJobInput, now = Date.now()): Promise<IdleFireOutcome | "started"> {
    // a row owed before `mode` existed is a cache-mode job (compaction model spec §6.3, C5)
    const extra: FireLog = { mode: data.mode ?? "cache" };
    const outcome = await this.decide(data, now, extra);
    this.log.info("idle compaction job", {
      context: "IdleCompaction",
      outcome,
      orgId: data.orgId,
      conversationId: data.conversationId,
      runId: data.runId,
      ...extra,
    });
    return outcome;
  }

  // runs under the job's org scope (`runJob`); every org-owned row is read with that org
  private async decide(
    data: IdleCompactionJobInput,
    now: number,
    extra: FireLog,
  ): Promise<IdleFireOutcome | "started"> {
    const t = this.kdb.db;
    const { orgId, conversationId, armedSeq } = data;
    // a row owed before `mode` existed is a cache-mode job (compaction model spec §6.3, C5)
    const cache = data.mode === "compaction_model" ? undefined : data;
    const mode: IdleMode = cache === undefined ? "compaction_model" : "cache";
    const known: Partial<IdleFireFacts> = { mode };
    const failing = (): IdleFireOutcome | undefined => {
      const d = idleFireDecision({ ...PASSING, ...known });
      return d.fire ? undefined : d.outcome;
    };

    // cache mode: the armed call, its lifetime (for the log) and its model (check 7)
    const call =
      cache &&
      (await t
        .selectFrom("conversation_events")
        .select("payload")
        .where("conversation_id", "=", conversationId)
        .where("seq", "=", String(cache.cacheCallSeq))
        .where("type", "=", "model_call")
        .executeTakeFirst());
    const armed = call?.payload as
      | { provider: string; model: string; request?: { cacheTtl?: number } }
      | undefined;
    const lifetime = (ttl: number | undefined) => {
      if (cache === undefined || ttl === undefined || extra.ttl !== undefined) return;
      extra.ttl = ttl;
      // the arm decision's fire time, `min(t0 + 0.9 L, expiresAt - 30 s)` with t0 = expiresAt - L
      const t0 = cache.expiresAt - ttl * 1000;
      const runAt = Math.min(
        t0 + CACHE_FIRE_RATIO * ttl * 1000,
        cache.expiresAt - CACHE_EXPIRY_MARGIN_MS,
      );
      extra.lateMs = now - runAt;
    };
    lifetime(armed?.request?.cacheTtl);

    // check 1: org, conversation (chat), agent; the owner can still send in it
    const { conv, agent } = await this.readLive(orgId, conversationId);
    known.live = conv !== undefined && agent !== undefined;
    let outcome = failing();
    if (outcome !== undefined || !conv || conv.account_id === null || !agent) {
      return outcome ?? "gone";
    }

    // check 2 (S1): an event after the armed seq other than a run-less side-call usage
    const stale = () => this.staleAfter(conversationId, armedSeq);
    known.stale = await stale();
    outcome = failing();
    if (outcome !== undefined) return outcome;

    // check 3 (S14): an active run (queued, running, waiting), an unconsumed message, a queue head
    const [active, unconsumed, head] = await Promise.all([
      t
        .selectFrom("runs")
        .select("id")
        .where("conversation_id", "=", conversationId)
        .where("status", "in", ACTIVE_RUN_STATUSES)
        .limit(1)
        .executeTakeFirst(),
      t
        .selectFrom("conversation_events")
        .select("seq")
        .where("conversation_id", "=", conversationId)
        .where("type", "=", "user_message")
        .where("seq", ">", conv.consumed_seq)
        .limit(1)
        .executeTakeFirst(),
      t
        .selectFrom("conversation_queue")
        .select("id")
        .where("conversation_id", "=", conversationId)
        .limit(1)
        .executeTakeFirst(),
    ]);
    known.busy = active !== undefined || unconsumed !== undefined || head !== undefined;
    outcome = failing();
    if (outcome !== undefined) return outcome;

    // check 4: the effective settings and the owner's preference, read live
    const settings = await this.compaction.resolve(orgId);
    known.settings = settings;
    known.enabled =
      settings.enabled &&
      settings.idleEnabled &&
      !(await this.accounts.idleCompactionOff(conv.account_id));
    outcome = failing();
    if (outcome !== undefined) return outcome;

    // check 5 (cache mode only) needs no read: the job's time against the armed call's expiry
    known.now = now;
    if (cache) known.expiresAt = cache.expiresAt;
    outcome = failing();
    if (outcome !== undefined) return outcome;

    // check 6: the latest compaction record after the latest summary is a failure
    const latest = await t
      .selectFrom("conversation_events")
      .select("type")
      .where("conversation_id", "=", conversationId)
      .where("type", "in", ["compaction_summary", "compaction_failed"])
      .orderBy("seq", "desc")
      .limit(1)
      .executeTakeFirst();
    known.backoff = latest?.type === "compaction_failed";
    outcome = failing();
    if (outcome !== undefined) return outcome;

    // check 7: the effective definition (the agent's current version under the conversation's
    // model selection, what the idle run will use) resolves and is enabled; in cache mode it is the
    // armed call's model, in compaction-model mode the compaction model summarizes for it (C6: a
    // model switch since arming does not end the job, the probe sizes against the new model)
    const version = await t
      .selectFrom("agent_versions")
      .select("definition")
      .where("agent_id", "=", conv.agent_id)
      .where("version", "=", agent.current_version)
      .executeTakeFirst();
    const definition =
      version &&
      effectiveDefinition(
        normalizeStoredDefinition(version.definition),
        await readSelection(t, conversationId),
      );
    let ready = false;
    if (definition && (cache === undefined || (armed && sameModel(definition.model, armed)))) {
      let model: { provider: BoundProvider; info: ResolvedModelInfo } | undefined;
      try {
        model = await this.models.resolve(orgId, definition.model);
      } catch (err) {
        // unknown, disabled, or a provider list that failed: no model to compact with now
        this.log.warn("idle compaction model not available", {
          context: "IdleCompaction",
          conversationId,
          model: definition.model,
          err,
        });
      }
      if (model && cache) {
        lifetime(model.info.cache?.defaultTtl);
        ready = true;
      } else if (model) {
        // the same choice the idle run makes; a cleared, disabled, unavailable or too small
        // compaction model ends the job (never V, never cache mode); a failed purpose read throws
        const { summarizer } = await chooseSummarizer(
          { compactionModel: this.compactionModel, registry: this.models, log: this.log },
          orgId,
          { ref: definition.model, provider: model.provider, info: model.info },
          settings,
        );
        ready = summarizer.source === "compaction_model";
      }
    }
    known.modelReady = ready;
    outcome = failing();
    if (outcome !== undefined || !definition) return outcome ?? "no_model";

    // checks 8 and 9 (S13): the compaction's dry run in the job's mode (reads every event and the
    // media: last); in compaction-model mode a null probe (C gone since check 7) is `small`, and
    // in cache mode a compaction model mapped since arming reports no in-context build (C3)
    const probe = await this.compactions.probeIdle(
      {
        orgId,
        conversationId,
        agentId: conv.agent_id,
        agent: definition,
        agentVersion: agent.current_version,
        source: conv.source as ConversationSource,
        conversationKind: "chat",
        absorbedUpToSeq: Number(conv.consumed_seq),
      },
      mode,
    );
    // an unavailable model or storage during the dry run: nothing to compact with now
    known.probe = probe;
    known.inContext = probe?.inContext ?? false;
    if (probe) extra.estimate = probe.estimate;
    outcome = failing();
    if (outcome !== undefined) return outcome;

    // §5.1: the run, under the conversation row lock (checks 1-3 again); a refusal is a message,
    // a run or a queued message that arrived in between
    const idleRunId = await this.runs.startIdleCompaction(conversationId, armedSeq, mode);
    if (idleRunId === null) {
      // label the refusal by the first check it now fails (the order of checks 1-3)
      if ((await this.readLive(orgId, conversationId)).agent === undefined) return "gone";
      return (await stale()) ? "obsolete" : "busy";
    }
    extra.idleRunId = idleRunId;
    return "started";
  }

  /**
   * Check 1's reads: the conversation (live, chat, owned), and its agent when the org is live, the
   * owner's account active and the agent visible to them (the idle run runs as the owner:
   * `RunQueue`'s rule for a person's message); `agent` undefined = not live.
   */
  private async readLive(orgId: string, conversationId: string) {
    const t = this.kdb.db;
    const conv = await t
      .selectFrom("conversations")
      .select(["account_id", "agent_id", "kind", "consumed_seq", "source", "deleted_at"])
      .where("id", "=", conversationId)
      .where("org_id", "=", orgId)
      .executeTakeFirst();
    let agent: { current_version: number } | undefined;
    if (conv && isLive(conv.deleted_at) && conv.kind === "chat" && conv.account_id !== null) {
      const ownerId = conv.account_id;
      const [orgLive, owner, row] = await Promise.all([
        orgIsLive(t, orgId),
        t
          .selectFrom("accounts")
          .select("id")
          .where("id", "=", ownerId)
          .where("status", "=", "active")
          .executeTakeFirst(),
        t
          .selectFrom("agents")
          .select("current_version")
          .where("id", "=", conv.agent_id)
          .where("org_id", "=", orgId)
          .where("deleted_at", "is", null)
          .where(visibleTo(ownerId))
          .executeTakeFirst(),
      ]);
      if (orgLive && owner !== undefined) agent = row;
    }
    return { conv, agent };
  }

  /** S1: an event after `armedSeq` that `isIdleNeutralEvent` rejects, in SQL. */
  private async staleAfter(conversationId: string, armedSeq: number): Promise<boolean> {
    const later = await this.kdb.db
      .selectFrom("conversation_events")
      .select("seq")
      .where("conversation_id", "=", conversationId)
      .where("seq", ">", String(armedSeq))
      .where((eb) => eb.not(eb.and([eb("type", "=", "usage"), eb("run_id", "is", null)])))
      .limit(1)
      .executeTakeFirst();
    return later !== undefined;
  }
}
