import type { Logger } from "@capybara-hq/plugin-sdk";
import { Inject, Injectable, Optional } from "@nestjs/common";
import { BackgroundTaskFinisher } from "../../background/finish.js";
import { BackgroundTaskStopper } from "../../background/stop.js";
import { BackgroundTaskStore } from "../../background/store.js";
import { AttachmentsService } from "../../conversations/attachments.service.js";
import { EventLog } from "../../conversations/event-log.js";
import { ConversationEnvironments } from "../../environments/conversation-environments.js";
import { ExtensionHost } from "../../extensions/host.js";
import { ExtensionPointDefaults } from "../../extensions/point-defaults.js";
import { KernelConfigService } from "../../infra/config/kernel-config.service.js";
import { KernelDb } from "../../infra/database/kernel-db.js";
import { KERNEL_LOGGER } from "../../infra/tokens.js";
import { ModelPurposesService } from "../../models/purposes.js";
import { readOrgSettings } from "../../orgs/settings.service.js";
import { PlatformActor } from "../../platform/actor.js";
import { AgentDocs } from "../../platform/agent-docs.js";
import { PlatformOperations } from "../../platform/registry.js";
import type { HookRunner } from "../../runtime/hook-calls.js";
import { conversationTimeZone, RUN_CONTEXT_CLOCK } from "../../runtime/run-context.service.js";
import { StepLog } from "../../runtime/step-log.js";
import { UsageReporter } from "../../runtime/usage-report.js";
import { SandboxService } from "../../sandbox/sandbox.service.js";
import { SkillChangesService } from "../../skills/changes.service.js";
import { StorageService } from "../../storage/storage.service.js";
import { ToolOutputs } from "../outputs.js";
import type { BuiltinTool } from "../registry.js";
import { agentTool } from "./agent.js";
import { askUserTool } from "./ask-user.js";
import { currentTimeTool } from "./current-time.js";
import { handbackTool } from "./handback.js";
import { platformTool } from "./platform.js";
import { readToolOutputTool } from "./read-tool-output.js";
import type { SandboxToolDeps } from "./sandbox/common.js";
import { sandboxTools } from "./sandbox/index.js";
import { sendMessageTool } from "./send-message.js";
import { skillLoadTool } from "./skill-load.js";
import { skillWriteTool } from "./skill-write.js";
import { toolSearchTool } from "./tool-search.js";
import { extractAnswer, WebPages, webTools } from "./web/index.js";

/**
 * The kernel's builtin tools, built once from the injected services (their specs: names,
 * descriptions and schemas, are the factories' own and unchanged). `ToolSearch` and `Skill`
 * are added to a run by the registry (`forAgent`: organization setting and threshold, a skills
 * catalog snapshot), not by agent definitions; `SkillWrite` only when a definition names it.
 */
@Injectable()
export class BuiltinTools {
  private readonly tools: readonly BuiltinTool[];

  constructor(
    @Inject(KernelDb) db: KernelDb,
    @Inject(KernelConfigService) config: KernelConfigService,
    @Inject(ToolOutputs) outputs: ToolOutputs,
    @Inject(StorageService) storage: StorageService,
    @Inject(SkillChangesService) skillChanges: SkillChangesService,
    @Inject(AttachmentsService) attachments: AttachmentsService,
    @Inject(EventLog) eventLog: EventLog,
    @Inject(SandboxService) sandbox: SandboxService,
    @Inject(ConversationEnvironments) environments: ConversationEnvironments,
    @Inject(ExtensionPointDefaults) points: ExtensionPointDefaults,
    @Inject(WebPages) webPages: WebPages,
    /** The WebFetch extraction call: the `web_fetch` purpose, its hooks, usage and denials. */
    @Inject(ModelPurposesService) purposes: ModelPurposesService,
    @Inject(ExtensionHost) host: { readonly hooks?: HookRunner } | undefined,
    @Inject(UsageReporter) usageReport: UsageReporter,
    @Inject(StepLog) stepLog: StepLog,
    @Inject(KERNEL_LOGGER) log: Logger,
    @Inject(BackgroundTaskStore) background: BackgroundTaskStore,
    @Inject(BackgroundTaskFinisher) finisher: BackgroundTaskFinisher,
    @Inject(BackgroundTaskStopper) stopper: BackgroundTaskStopper,
    @Inject(PlatformOperations) platformOps: PlatformOperations,
    @Inject(PlatformActor) platformActor: PlatformActor,
    @Inject(AgentDocs) agentDocs: AgentDocs,
    /** The clock `CurrentTime` reads (the run context's clock seam; `Date.now` by default). */
    @Optional() @Inject(RUN_CONTEXT_CLOCK) now?: () => number,
  ) {
    const sandboxDeps: SandboxToolDeps = {
      sandbox,
      environments,
      background,
      tasks: { finisher, stopper },
      attachments,
      storage,
      eventLog,
      config,
      log,
    };
    this.tools = [
      askUserTool({ config }),
      readToolOutputTool({ outputs, config }),
      toolSearchTool(),
      // dispatches sub-agents; the tool pipeline handles its calls (sub-agents spec §4, §7.1)
      agentTool,
      // messages between the agents of one tree; the registry offers them and the tool pipeline
      // handles their calls (agent map spec §4.2, §4.3)
      sendMessageTool,
      handbackTool,
      ...sandboxTools(sandboxDeps),
      // 技能加载：对话日志里有技能目录快照时由注册表自动加入（Ruling M17）
      skillLoadTool({
        storage,
        config,
        sandbox,
        environments,
        attachments,
        eventLog,
        log,
        get db() {
          return db.db;
        },
      }),
      // 自写技能：agent 定义显式引用才可用
      skillWriteTool({ changes: skillChanges }),
      // web search / fetch through the org's default provider (web tools spec §3); WebFetch answers
      // from the page with one call on the `web_fetch` purpose (§5), never returning the page
      ...webTools({
        points,
        config,
        cache: webPages,
        extract: (ctx, page, prompt) =>
          extractAnswer(
            { purposes, eventLog, stepLog, config, log, hooks: host?.hooks, usageReport },
            ctx,
            page,
            prompt,
          ),
      }),
      // the platform's own operations and docs, as the run's person (Platform tool spec)
      platformTool({
        ops: platformOps,
        actor: platformActor,
        docs: agentDocs,
        setting: async (orgId) => (await readOrgSettings(db.db, orgId)).platformTool,
        log,
      }),
      // the clock in the run context's time zone (the run context carries only the date)
      currentTimeTool({
        now: now ?? Date.now,
        timeZoneOf: ({ orgId, conversationId }) =>
          conversationTimeZone(db.db, orgId, conversationId),
      }),
    ];
  }

  /** The builtin tools, in a fixed order. */
  list(): readonly BuiltinTool[] {
    return this.tools;
  }
}
