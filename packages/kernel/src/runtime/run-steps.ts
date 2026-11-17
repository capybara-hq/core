import { Inject, Injectable, Optional } from "@nestjs/common";
import { AttachmentsService } from "../conversations/attachments.service.js";
import { EventLog } from "../conversations/event-log.js";
import type { KernelSchemaDb } from "../db/kernel-schema.js";
import { ExtensionHost } from "../extensions/host.js";
import { KernelConfigService } from "../infra/config/kernel-config.service.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { KERNEL_LOGGER } from "../infra/tokens.js";
import type { KernelLogger } from "../log.js";
import {
  PERMISSION_CONTEXT_ACTIVATION,
  permissionContextActive,
} from "../sandbox/permission-context-types.js";
import { ToolPipeline } from "../tools/pipeline.js";
import { ToolRegistry } from "../tools/registry.js";
import { KyselyCheckpointSaver } from "./checkpointer.js";
import { CompactionProgressService } from "./compaction-progress.js";
import { CompactionSettingsService } from "./compaction-settings.service.js";
import { LangGraphLoop, type LoopDeps } from "./langgraph-loop.js";
import type { AgentLoop } from "./loop.js";
import { PermissionContextRecorder } from "./permission-context.service.js";
import { ProviderRegistry } from "./providers.js";
import { StepLog } from "./step-log.js";
import { SubagentsService } from "./subagents/subagents.service.js";

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
 * services. `deps` is a plain object (eval replays copy it without the hooks, the progress, the
 * fork dispatch and the live permission recorder). The live permission context recorder is wired
 * only when the paired activation gate is on ({@link PERMISSION_CONTEXT_ACTIVATION}).
 */
@Injectable()
export class RunSteps {
  readonly deps: LoopDeps;

  constructor(
    @Inject(KernelDb) kdb: KernelDb,
    @Inject(EventLog) eventLog: EventLog,
    @Inject(StepLog) stepLog: StepLog,
    @Inject(ProviderRegistry) registry: ProviderRegistry,
    @Inject(ToolRegistry) tools: ToolRegistry,
    @Inject(KernelConfigService) config: KernelConfigService,
    @Inject(KERNEL_LOGGER) log: KernelLogger,
    @Inject(ToolPipeline) toolPipeline: ToolPipeline,
    @Inject(ExtensionHost) host: ExtensionHost,
    @Inject(SubagentsService) subagents: SubagentsService,
    @Inject(AttachmentsService) attachments: AttachmentsService,
    @Inject(CompactionSettingsService) compactionSettings: CompactionSettingsService,
    @Inject(CompactionProgressService) compactionProgress: CompactionProgressService,
    @Inject(PermissionContextRecorder) permissionContext: PermissionContextRecorder,
    @Optional() @Inject(PERMISSION_CONTEXT_ACTIVATION) activation?: boolean,
  ) {
    this.deps = {
      get db(): KernelSchemaDb {
        return kdb.db;
      },
      eventLog,
      stepLog,
      registry,
      tools,
      config,
      compactionSettings,
      // ephemeral, display-only: the run's progress on its own conversation's stream
      compactionProgress,
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
      // the request boundary of the recorded permission context (spec B2): every agent-history
      // request construction records the root's current context first; dormant until the paired
      // activation (Task 8 phase 8.6) turns the gate on
      ...(permissionContextActive(activation) && {
        permissionContext: {
          beforeRequest: ({ orgId, conversationId, runId, accountId, signal }) =>
            permissionContext.record({ orgId, conversationId, runId, accountId }, signal),
        },
      }),
    };
  }
}
