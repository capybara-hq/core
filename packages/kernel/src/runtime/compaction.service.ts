import type { ConversationSource } from "@capybara-hq/plugin-sdk";
import { Inject, Injectable } from "@nestjs/common";
import type { AgentDefinition } from "../agents/definition.js";
import { EventLog } from "../conversations/event-log.js";
import { KernelConfigService } from "../infra/config/kernel-config.service.js";
import { CompactionSettingsService } from "./compaction-settings.service.js";
import {
  type ModelStepInput,
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

/** What the compact run recorded: the `compaction_summary` it wrote, and whether it failed. */
export interface ForcedCompaction {
  summarySeq: number | null;
  failed: boolean;
}

/**
 * The manual compaction a compact run executes (context compaction spec §4.7). It prepares the same
 * environment a model step has (the events, the effective definition's tools, the org's compaction
 * settings) and calls the shared {@link runCompaction} with `force: true`: the trigger,
 * `enabled: false` and the failure backoff are bypassed, the compaction plan is still required.
 *
 * The run writes only `compaction_summary` / `compaction_failed` + the summary calls' `usage`, with
 * `step: 0`; no user message and no model step.
 */
@Injectable()
export class CompactionService {
  constructor(
    @Inject(RunSteps) private readonly steps: RunSteps,
    @Inject(EventLog) private readonly eventLog: EventLog,
    @Inject(KernelConfigService) private readonly config: KernelConfigService,
    @Inject(CompactionSettingsService) private readonly settings: CompactionSettingsService,
  ) {}

  async force(input: ForceCompactionInput): Promise<ForcedCompaction> {
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
      accountId: input.accountId,
      source: input.source,
      conversationKind: input.conversationKind,
    };
    // tools and media resolve as for a step: the summary request estimates the same history a
    // step's request would (spec §4.7)
    const tools = stepToolsOf(await resolveAgentTools(deps, stepInput, events), stepInput, deps);
    const compaction = await this.settings.resolve(input.orgId);
    const out = await runCompaction(
      deps,
      stepInput,
      events,
      this.config.get().runtime,
      compaction,
      tools,
      {
        force: true,
      },
    );
    return { summarySeq: out.summarySeq, failed: out.failed };
  }
}
