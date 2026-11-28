import { Inject, Injectable } from "@nestjs/common";
import type { ConversationEvent } from "../conversations/events.js";
import type { ConversationKind } from "../db/kernel-schema.js";
import { AccountsService } from "../identity/accounts.js";
import { COMPACTION_SETTINGS } from "../identity/settings.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { KERNEL_LOGGER } from "../infra/tokens.js";
import type { KernelLogger } from "../log.js";
import { ModelPurposesService } from "../models/purposes.js";
import {
  type CompactionModelPort,
  chooseSummarizer,
  compactionModelPort,
} from "./compaction-model.js";
import { CompactionSettingsService } from "./compaction-settings.service.js";
import { deriveCacheExpiry } from "./context/cache-expiry.js";
import {
  type IdleArmFacts,
  type IdleArmSkip,
  idleArmDecision,
  idleMinTokens,
  type RunStartedTrigger,
} from "./context/idle-compaction-rules.js";
import { inContextSummaryAllowed, unansweredAfterReply } from "./context/in-context-compaction.js";
import { type BoundProvider, ProviderRegistry, type ResolvedModelInfo } from "./providers.js";
import type { IdleCompactionIntent } from "./run-finish.js";

/** How a chat run ended, as the run worker's finish branches that write `run_finished` see it. */
export type IdleArmOutcome = IdleArmFacts["outcome"];

/**
 * Facts not read yet, set so that they pass: {@link idleArmDecision} over the facts read so far
 * plus these fails only on a fact already read, so the reads stop at the first failing one while
 * the rules stay in one place.
 */
const PASSING: IdleArmFacts = {
  conversationKind: "chat",
  trigger: undefined,
  automationRunId: null,
  outcome: "completed",
  settings: COMPACTION_SETTINGS.parse({}),
  mode: "cache",
  now: 0,
  personalOff: false,
  expiry: {
    callSeq: 0,
    t0: 0,
    ttl: Number.POSITIVE_INFINITY,
    expiresAt: Number.POSITIVE_INFINITY,
    fireAt: Number.POSITIVE_INFINITY,
    isMinimum: false,
  },
  lastCall: {
    provider: "",
    model: "",
    window: 0,
    input: Number.POSITIVE_INFINITY,
    cacheRead: 0,
    cacheWrite: 0,
    output: 0,
  },
  inContextAllowed: true,
  fitPlan: false,
  settled: true,
};

type EventRow = {
  conversation_id: string;
  seq: string;
  type: string;
  run_id: string | null;
  payload: unknown;
  created_at: Date;
};

const toEvent = (r: EventRow): ConversationEvent =>
  ({
    conversationId: r.conversation_id,
    seq: Number(r.seq),
    type: r.type,
    runId: r.run_id,
    payload: r.payload,
    createdAt: r.created_at,
  }) as ConversationEvent;

const EVENT_COLUMNS = [
  "conversation_id",
  "seq",
  "type",
  "run_id",
  "payload",
  "created_at",
] as const;

type ModelCall = Extract<ConversationEvent, { type: "model_call" }>;
type Usage = Extract<ConversationEvent, { type: "usage" }>;

const modelKey = (provider: string, model: string) => `${provider}\u0000${model}`;

/**
 * The arm decision of idle compaction at a chat run's finish (idle compaction spec §4.2, S4–S7):
 * gathers {@link IdleArmFacts} and asks {@link idleArmDecision} whether the run's terminal
 * transaction owes an `idle-compaction` job. The run worker calls it before `RunFinish.finish`,
 * outside any transaction (the model registry and the `compaction` purpose may list a provider's
 * models over the network).
 *
 * The job's mode (compaction model spec §6.1, §6.2): `compaction_model` when the summarizer a
 * compaction would choose now against the last step call's model is the compaction model (usable
 * and eligible, the same `chooseSummarizer` the compaction runs), else `cache`.
 */
@Injectable()
export class IdleArm {
  /** The org's `compaction` purpose, read from PG on every decision (nothing cached). */
  private readonly compactionModel: CompactionModelPort;

  constructor(
    @Inject(KernelDb) private readonly kdb: KernelDb,
    @Inject(CompactionSettingsService)
    private readonly compaction: Pick<CompactionSettingsService, "resolve">,
    @Inject(AccountsService) private readonly accounts: Pick<AccountsService, "idleCompactionOff">,
    @Inject(ProviderRegistry) private readonly models: Pick<ProviderRegistry, "resolve">,
    @Inject(ModelPurposesService) purposes: Pick<ModelPurposesService, "resolve">,
    @Inject(KERNEL_LOGGER) private readonly log: KernelLogger,
  ) {
    this.compactionModel = compactionModelPort(purposes);
  }

  /**
   * The intent `RunFinish.finishIn` owes the job from, or undefined when the run does not arm.
   * Never throws: any failure is logged at `warn` and arms nothing, so arming never fails or holds
   * up a finish (Review Focus 6). Reads cheapest first and stops at the first failing fact.
   */
  async decide(
    run: { id: string },
    conv: { id: string; org_id: string; kind: ConversationKind; account_id: string | null },
    outcome: IdleArmOutcome,
  ): Promise<IdleCompactionIntent | undefined> {
    try {
      return await this.decideOrSkip(run.id, conv, outcome);
    } catch (err) {
      this.log.warn("idle compaction arm failed; no job owed", {
        context: "IdleCompaction",
        conversationId: conv.id,
        runId: run.id,
        err,
      });
      return undefined;
    }
  }

  private async decideOrSkip(
    runId: string,
    conv: { id: string; org_id: string; kind: ConversationKind; account_id: string | null },
    outcome: IdleArmOutcome,
  ): Promise<IdleCompactionIntent | undefined> {
    const t = this.kdb.db;
    const known: Partial<IdleArmFacts> = { conversationKind: conv.kind, outcome };
    const skip = (reason: IdleArmSkip): undefined => {
      this.log.debug("idle compaction not armed", {
        context: "IdleCompaction",
        conversationId: conv.id,
        runId,
        reason,
      });
      return undefined;
    };
    const failing = (): IdleArmSkip | undefined => {
      const d = idleArmDecision({ ...PASSING, ...known });
      return d.arm ? undefined : d.reason;
    };
    let reason = failing();
    if (reason !== undefined) return skip(reason);

    // S5: the trigger and the automation lineage
    const row = await t
      .selectFrom("runs")
      .select("automation_run_id")
      .where("id", "=", runId)
      .executeTakeFirst();
    if (row === undefined) return undefined;
    const started = await t
      .selectFrom("conversation_events")
      .select("payload")
      .where("conversation_id", "=", conv.id)
      .where("run_id", "=", runId)
      .where("type", "=", "run_started")
      .executeTakeFirst();
    known.automationRunId = row.automation_run_id;
    known.trigger = (started?.payload as { trigger?: RunStartedTrigger } | undefined)?.trigger;
    reason = failing();
    if (reason !== undefined) return skip(reason);

    const settings = await this.compaction.resolve(conv.org_id);
    known.settings = settings;
    reason = failing();
    if (reason !== undefined) return skip(reason);

    known.personalOff =
      conv.account_id !== null && (await this.accounts.idleCompactionOff(conv.account_id));
    reason = failing();
    if (reason !== undefined) return skip(reason);

    // S6: the cache expiry over the run's step calls, and the last one's size
    const calls = (
      await t
        .selectFrom("conversation_events")
        .select(EVENT_COLUMNS)
        .where("conversation_id", "=", conv.id)
        .where("run_id", "=", runId)
        .where("type", "in", ["model_call", "usage"])
        .orderBy("seq")
        .execute()
    ).map(toEvent);
    const resolved = new Map<string, { provider: BoundProvider; info: ResolvedModelInfo }>();
    for (const e of calls) {
      if (e.type !== "model_call") continue;
      const key = modelKey(e.payload.provider, e.payload.model);
      if (resolved.has(key)) continue;
      resolved.set(
        key,
        await this.models.resolve(conv.org_id, {
          provider: e.payload.provider,
          model: e.payload.model,
        }),
      );
    }
    const infoOf = (provider: string, model: string) =>
      resolved.get(modelKey(provider, model))?.info;
    const last = lastStepCall(calls);
    const lastModel =
      last && resolved.get(modelKey(last.call.payload.provider, last.call.payload.model));
    const lastInfo = lastModel?.info;

    // a context under the size floor arms in neither mode: skip before the purpose read (and the
    // summarizer choice's fallback warnings) a small finish would otherwise pay every time
    if (last !== undefined && lastInfo !== undefined) {
      const u = last.usage.payload;
      const total = u.inputTokens + u.cacheReadTokens + u.cacheWriteTokens + u.outputTokens;
      if (total < idleMinTokens(lastInfo.contextWindow, settings)) return skip("small");
    }

    // compaction model spec §6.1, C2: the mode is the summarizer a compaction would choose now,
    // V = the last step call's model under the effective settings; a failed purpose read throws
    // (no job, logged by `decide`)
    if (last !== undefined && lastModel !== undefined) {
      const { summarizer } = await chooseSummarizer(
        { compactionModel: this.compactionModel, registry: this.models, log: this.log },
        conv.org_id,
        {
          ref: { provider: last.call.payload.provider, model: last.call.payload.model },
          provider: lastModel.provider,
          info: lastModel.info,
        },
        settings,
      );
      known.mode = summarizer.source === "compaction_model" ? "compaction_model" : "cache";
    }
    // C4: the run's end is not written yet; the terminal transaction follows within milliseconds
    known.now = Date.now();
    known.expiry = deriveCacheExpiry(calls, (p, m) => infoOf(p, m)?.cache);
    known.lastCall =
      last && lastInfo
        ? {
            provider: last.call.payload.provider,
            model: last.call.payload.model,
            window: lastInfo.contextWindow,
            input: last.usage.payload.inputTokens,
            cacheRead: last.usage.payload.cacheReadTokens,
            cacheWrite: last.usage.payload.cacheWriteTokens,
            output: last.usage.payload.outputTokens,
          }
        : null;
    reason = failing();
    if (reason !== undefined || last === undefined || lastInfo === undefined) {
      return skip(reason ?? "no_cache");
    }
    if (known.mode === "compaction_model") return this.armed(runId, conv, known);

    // S7: the in-context quality gate (ruling R8) and the settled point (ruling R9)
    known.inContextAllowed = inContextSummaryAllowed(last.call.payload.provider, lastInfo.id);
    // a fit plan reshaped the last request's prefix: the fire-time in-context build skips it
    known.fitPlan = last.call.payload.request.fit !== undefined;
    reason = failing();
    if (reason !== undefined) return skip(reason);

    const latestCallSeq = Math.max(
      ...calls.filter((e) => e.type === "model_call").map((e) => e.seq),
    );
    const tail = (
      await t
        .selectFrom("conversation_events")
        .select(EVENT_COLUMNS)
        .where("conversation_id", "=", conv.id)
        .where("seq", ">=", String(latestCallSeq))
        .orderBy("seq")
        .execute()
    ).map(toEvent);
    // at the run's end: anything after the last reply the model has not answered (a tool result,
    // a message or finished task the run did not absorb) is unsettled
    known.settled = !unansweredAfterReply(tail, {
      coversUpToSeq: Number.POSITIVE_INFINITY,
      absorbedUpToSeq: Number.POSITIVE_INFINITY,
      openers: [],
    });

    return this.armed(runId, conv, known);
  }

  /** The final decision over every fact gathered: the intent, or undefined with the skip logged. */
  private armed(
    runId: string,
    conv: { id: string; org_id: string },
    known: Partial<IdleArmFacts>,
  ): IdleCompactionIntent | undefined {
    const d = idleArmDecision({ ...PASSING, ...known });
    const fields = { context: "IdleCompaction", conversationId: conv.id, runId };
    if (!d.arm) {
      this.log.debug("idle compaction not armed", { ...fields, reason: d.reason });
      return undefined;
    }
    if (d.mode === "compaction_model") {
      this.log.debug("idle compaction armed", { ...fields, mode: d.mode, runAt: d.runAt });
      return { orgId: conv.org_id, mode: "compaction_model", runAt: d.runAt };
    }
    this.log.debug("idle compaction armed", {
      ...fields,
      mode: d.mode,
      runAt: d.runAt,
      expiresAt: d.expiresAt,
    });
    return {
      orgId: conv.org_id,
      mode: "cache",
      cacheCallSeq: d.cacheCallSeq,
      expiresAt: d.expiresAt,
      runAt: d.runAt,
    };
  }
}

/**
 * The run's latest step call with its usage: a `model_call` paired with the next `usage` of the
 * same step whose `purpose` is absent (as `deriveCacheExpiry` pairs them; a retry attempt replaces
 * a failed one).
 */
function lastStepCall(
  events: readonly ConversationEvent[],
): { call: ModelCall; usage: Usage } | undefined {
  const open = new Map<number, ModelCall>();
  let last: { call: ModelCall; usage: Usage } | undefined;
  for (const e of events) {
    if (e.type === "model_call") {
      open.set(e.payload.step, e);
      continue;
    }
    if (e.type !== "usage" || e.payload.purpose !== undefined) continue;
    const call = open.get(e.payload.step);
    if (call === undefined) continue;
    open.delete(e.payload.step);
    last = { call, usage: e };
  }
  return last;
}
