import { Inject, Injectable, Optional } from "@nestjs/common";
import { AttachmentsService } from "../conversations/attachments.service.js";
import { EventLog } from "../conversations/event-log.js";
import type { KernelSchemaDb } from "../db/kernel-schema.js";
import { ExtensionHost } from "../extensions/host.js";
import { KernelConfigService } from "../infra/config/kernel-config.service.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { KERNEL_LOGGER } from "../infra/tokens.js";
import type { KernelLogger } from "../log.js";
import { ToolPipeline } from "../tools/pipeline.js";
import { ToolRegistry } from "../tools/registry.js";
import { KyselyCheckpointSaver } from "./checkpointer.js";
import { LangGraphLoop, type LoopDeps } from "./langgraph-loop.js";
import type { AgentLoop } from "./loop.js";
import { ProviderRegistry } from "./providers.js";
import { StepLog } from "./step-log.js";
import { SubagentsService } from "./subagents/subagents.service.js";
import { UsageReporter } from "./usage-report.js";

/**
 * Builds the agent loop a run executes (default {@link LangGraphLoop}: its checkpoints live in the
 * kernel's {@link KyselyCheckpointSaver}, so another replica resumes a crashed worker's run).
 * Tests override it with a provider for {@link AGENT_LOOP_FACTORY}.
 */
export type AgentLoopFactory = (deps: LoopDeps, checkpoints: KyselyCheckpointSaver) => AgentLoop;

/** Optional provider: the {@link AgentLoopFactory} runs use instead of the default (tests). */
export const AGENT_LOOP_FACTORY = Symbol("AGENT_LOOP_FACTORY");

/** The agent loops of chat runs and of eval full-run replays (one factory, one checkpoint store). */
@Injectable()
export class AgentLoops {
  constructor(
    @Inject(KyselyCheckpointSaver) private readonly checkpoints: KyselyCheckpointSaver,
    @Optional() @Inject(AGENT_LOOP_FACTORY) private readonly factory?: AgentLoopFactory,
  ) {}

  create(deps: LoopDeps): AgentLoop {
    return this.factory
      ? this.factory(deps, this.checkpoints)
      : new LangGraphLoop(this.checkpoints, deps);
  }
}

/**
 * What a run's steps use (`LoopDeps`: one model step plus the tool pipeline), over the injected
 * services. `deps` is a plain object (eval replays copy it without the hooks, the progress and the
 * fork dispatch).
 */
@Injectable()
export class RunSteps {
  readonly deps: LoopDeps;

  constructor(
    @Inject(KernelDb) kdb: KernelDb,
    @Inject(EventLog) eventLog: EventLog,
    @Inject(StepLog) stepLog: StepLog,
    @Inject(ProviderRegistry) registry: ProviderRegistry,
    @Inject(UsageReporter) usageReport: UsageReporter,
    @Inject(ToolRegistry) tools: ToolRegistry,
    @Inject(KernelConfigService) config: KernelConfigService,
    @Inject(KERNEL_LOGGER) log: KernelLogger,
    @Inject(ToolPipeline) toolPipeline: ToolPipeline,
    @Inject(ExtensionHost) host: ExtensionHost,
    @Inject(SubagentsService) subagents: SubagentsService,
    @Inject(AttachmentsService) attachments: AttachmentsService,
  ) {
    this.deps = {
      get db(): KernelSchemaDb {
        return kdb.db;
      },
      eventLog,
      stepLog,
      registry,
      usageReport,
      tools,
      config,
      log,
      toolPipeline,
      // plugin hooks for chat runs; the full-run replay drops them (P-18)
      hooks: host.hooks,
      // a sub-agent's steps on its parent's stream (sub-agents spec §14.2)
      subagentProgress: (s) => subagents.progress(s),
      // phase D: a person's fork invocation dispatches its sub-agent in the run's first prepare
      skillForks: subagents.skillForks,
      media: {
        info: (orgId, conversationId, ids) => attachments.mediaInfo(orgId, conversationId, ids),
        fetch: (orgId, conversationId, ids, caps) =>
          attachments.fetchMedia(orgId, conversationId, ids, caps),
      },
    };
  }
}
