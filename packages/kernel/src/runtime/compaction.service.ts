import type { ConversationSource } from "@capybara-hq/plugin-sdk";
import { Inject, Injectable } from "@nestjs/common";
import type { AgentDefinition } from "../agents/definition.js";
import { EventLog } from "../conversations/event-log.js";
import type { IdleMode } from "../db/kernel-schema.js";
import { KernelConfigService } from "../infra/config/kernel-config.service.js";
import { CompactionSettingsService } from "./compaction-settings.service.js";
import {
  type CompactOptions,
  type ModelStepInput,
  prepareCompaction,
  readAllEvents,
  resolveAgentTools,
  runCompaction,
  stepToolsOf,
} from "./model-call.js";
import { RunSteps } from "./run-steps.js";

/** What a manual compact run gives the shared compaction execution (context compaction spec §4.7). */
export interface ForceCompactionInput {
  orgId: string;
  conversationId: string;
  /** The compact run's id: its events (and their idempotency keys) carry it. */
  runId: string;
  /** The run's trigger account (the person who asked): hook payloads attribute the calls to it. */
  accountId: string;
  agentId: string;
  /**
   * The conversation's effective definition: the agent version the next run would use with the
   * conversation's model selection (including `model_switched`) applied.
   */
  agent: AgentDefinition;
  agentVersion: number;
  source: ConversationSource;
  /** A compact run is a chat conversation's (sub-agent and eval conversations take no compaction). */
  conversationKind: "chat";
  /** The conversation's `consumed_seq`: nothing new is absorbed by the compaction. */
  absorbedUpToSeq: number;
  signal: AbortSignal;
}

/**
 * Who started a compact run (idle compaction spec §5.1): a person (`manual`, the compact route) or
 * the idle compaction job (`idle`).
 */
export type CompactOrigin = "manual" | "idle";

/** What {@link CompactionService.probeIdle} reads from the conversation. */
export type IdleProbeInput = Omit<ForceCompactionInput, "runId" | "signal" | "accountId">;

/**
 * The dry run of an idle compaction (idle compaction spec §4.3 checks 8 and 9): the calibrated
 * estimate of the next request, the model's window, the tokens no summary covers yet (`growth`),
 * whether a plan exists, and whether the in-context summary request was built (no skip).
 */
export interface IdleProbe {
  estimate: number;
  window: number;
  growth: number;
  planned: boolean;
  inContext: boolean;
}

/** The run id a probe's step input carries: never written (a probe writes nothing). */
const PROBE_RUN_ID = "00000000-0000-0000-0000-000000000000";

/** What the compact run recorded: the `compaction_summary` it wrote, and whether it failed. */
export interface ForcedCompaction {
  summarySeq: number | null;
  failed: boolean;
}

/**
 * The compaction a compact run executes (context compaction spec §4.7, idle compaction spec §5). It
 * prepares the same environment a model step has (the events, the effective definition's tools, the
 * org's compaction settings) and calls the shared {@link runCompaction} with `force: true`: the
 * trigger, `enabled: false` and the failure backoff are bypassed, the compaction plan is still
 * required.
 *
 * - `manual` adds `manual: true`: the manual rule (every turn before the latest summarized, about a
 *   fifth of the window of the latest turn kept; maintainer decision 2026-11-28), always on the
 *   transcript, also on a model the in-context gate lists (ruling R13, idle compaction spec §9.4).
 *   The run writes only its outcome, with `step: 0`: `compaction_summary` / `compaction_failed` +
 *   the summary calls' `usage`, or `compaction_skipped` when there is nothing to summarize
 *   (maintainer decision 2026-11-28); no user message and no model step.
 * - `idle` adds `idle: mode` and never `manual` (ruling R13): the automatic plan; in `cache` mode
 *   the in-context summary only, in `compaction_model` mode the compaction model's transcript
 *   summary only (compaction model spec §6.3, never V). Every early end (nothing to summarize, an
 *   unavailable model, an in-context skip, no compaction model) writes nothing; a failed call
 *   writes `compaction_failed` (the backoff of later idle attempts).
 */
@Injectable()
export class CompactionService {
  constructor(
    @Inject(RunSteps) private readonly steps: RunSteps,
    @Inject(EventLog) private readonly eventLog: EventLog,
    @Inject(KernelConfigService) private readonly config: KernelConfigService,
    @Inject(CompactionSettingsService) private readonly settings: CompactionSettingsService,
  ) {}

  async force(
    input: ForceCompactionInput,
    origin: CompactOrigin = "manual",
    idleMode: IdleMode = "cache",
  ): Promise<ForcedCompaction> {
    const env = await this.environment(input);
    const opts: CompactOptions =
      origin === "manual" ? { force: true, manual: true } : { force: true, idle: idleMode };
    const out = await runCompaction(
      this.steps.deps,
      env.stepInput,
      env.events,
      this.config.get().runtime,
      env.compaction,
      env.tools,
      opts,
    );
    return { summarySeq: out.summarySeq, failed: out.failed };
  }

  /**
   * The idle compaction job's dry run (idle compaction spec §4.3 checks 8 and 9): the preparation
   * an idle compact run would do in `mode`, with nothing written and no model call. Null when the
   * model or the attachment storage cannot be reached right now (the probe learns nothing), and in
   * `compaction_model` mode when the compaction model does not summarize now. In `cache` mode a
   * compaction model mapped since arming reports `inContext: false` (spec issue C3).
   */
  async probeIdle(input: IdleProbeInput, mode: IdleMode): Promise<IdleProbe | null> {
    const env = await this.environment({
      ...input,
      runId: PROBE_RUN_ID,
      // the probe sends nothing: a signal that never aborts
      signal: new AbortController().signal,
    });
    const prepared = await prepareCompaction(
      this.steps.deps,
      env.stepInput,
      env.events,
      this.config.get().runtime,
      env.compaction,
      env.tools,
      { force: true, idle: mode },
    );
    if ("skipped" in prepared) {
      if (prepared.skipped !== "no_plan") return null;
      return {
        estimate: prepared.estimate,
        window: prepared.window,
        growth: 0,
        planned: false,
        inContext: false,
      };
    }
    return {
      estimate: prepared.estimate,
      window: prepared.window,
      growth: prepared.growthTokens,
      planned: true,
      inContext: !("skip" in prepared.inContext),
    };
  }

  /** The step environment a compact run (or its probe) prepares, as a model step has it. */
  private async environment(
    input: Omit<ForceCompactionInput, "accountId"> & { accountId?: string },
  ) {
    // the run's steps environment (the model registry, the tool registry, media, hooks, progress);
    // no step state is kept on it, so a compact run may share it with the steps of other runs
    const deps = this.steps.deps;
    const events = await readAllEvents(this.eventLog, input.conversationId);
    const stepInput: ModelStepInput = {
      orgId: input.orgId,
      conversationId: input.conversationId,
      runId: input.runId,
      step: 0,
      agent: input.agent,
      agentVersion: input.agentVersion,
      signal: input.signal,
      // a compact run streams nothing to the conversation: the summary call's deltas only move the
      // progress counters, which the compaction reports itself
      sink: () => {},
      absorbedUpToSeq: input.absorbedUpToSeq,
      agentId: input.agentId,
      ...(input.accountId !== undefined && { accountId: input.accountId }),
      source: input.source,
      conversationKind: input.conversationKind,
    };
    // tools and media resolve as for a step: the summary request estimates the same history a
    // step's request would (spec §4.7)
    const tools = stepToolsOf(await resolveAgentTools(deps, stepInput, events), stepInput, deps);
    const compaction = await this.settings.resolve(input.orgId);
    return { stepInput, events, tools, compaction };
  }
}
