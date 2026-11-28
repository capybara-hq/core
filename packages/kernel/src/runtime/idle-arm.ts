import { Inject, Injectable } from "@nestjs/common";
import type { ConversationEvent } from "../conversations/events.js";
import type { ConversationKind } from "../db/kernel-schema.js";
import { AccountsService } from "../identity/accounts.js";
import { COMPACTION_SETTINGS } from "../identity/settings.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { KERNEL_LOGGER } from "../infra/tokens.js";
import type { KernelLogger } from "../log.js";
import { CompactionSettingsService } from "./compaction-settings.service.js";
import { deriveCacheExpiry } from "./context/cache-expiry.js";
import {
  type IdleArmFacts,
  type IdleArmSkip,
  idleArmDecision,
  type RunStartedTrigger,
} from "./context/idle-compaction-rules.js";
import { inContextSummaryAllowed, unansweredAfterReply } from "./context/in-context-compaction.js";
import { ProviderRegistry, type ResolvedModelInfo } from "./providers.js";
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
 * outside any transaction (the model registry may list a provider's models over the network).
 */
@Injectable()
export class IdleArm {
  constructor(
    @Inject(KernelDb) private readonly kdb: KernelDb,
    @Inject(CompactionSettingsService)
    private readonly compaction: Pick<CompactionSettingsService, "resolve">,
    @Inject(AccountsService) private readonly accounts: Pick<AccountsService, "idleCompactionOff">,
    @Inject(ProviderRegistry) private readonly models: Pick<ProviderRegistry, "resolve">,
    @Inject(KERNEL_LOGGER) private readonly log: Pick<KernelLogger, "debug" | "warn">,
  ) {}

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

    known.settings = await this.compaction.resolve(conv.org_id);
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
    const infos = new Map<string, ResolvedModelInfo>();
    for (const e of calls) {
      if (e.type !== "model_call") continue;
      const key = modelKey(e.payload.provider, e.payload.model);
      if (infos.has(key)) continue;
      const { info } = await this.models.resolve(conv.org_id, {
        provider: e.payload.provider,
        model: e.payload.model,
      });
      infos.set(key, info);
    }
    const infoOf = (provider: string, model: string) => infos.get(modelKey(provider, model));
    known.expiry = deriveCacheExpiry(calls, (p, m) => infoOf(p, m)?.cache);
    const last = lastStepCall(calls);
    const lastInfo = last && infoOf(last.call.payload.provider, last.call.payload.model);
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

    // S7: the in-context quality gate (ruling R8) and the settled point (ruling R9)
    known.inContextAllowed = inContextSummaryAllowed(last.call.payload.provider, lastInfo.id);
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

    const d = idleArmDecision({ ...PASSING, ...known });
    if (!d.arm) return skip(d.reason);
    this.log.debug("idle compaction armed", {
      context: "IdleCompaction",
      conversationId: conv.id,
      runId,
      runAt: d.runAt,
      expiresAt: d.expiresAt,
    });
    return {
      orgId: conv.org_id,
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
