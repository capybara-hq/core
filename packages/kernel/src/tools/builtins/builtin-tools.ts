import { Inject, Injectable } from "@nestjs/common";
import { KernelConfigService } from "../../infra/config/kernel-config.service.js";
import { KernelDb } from "../../infra/database/kernel-db.js";
import { LegacyPorts } from "../../lifecycle/legacy-ports.js";
import { SkillChangesService } from "../../skills/changes.service.js";
import { StorageService } from "../../storage/storage.service.js";
import { ToolOutputs } from "../outputs.js";
import type { BuiltinTool } from "../registry.js";
import { agentTool } from "./agent.js";
import { askUserTool } from "./ask-user.js";
import { readToolOutputTool } from "./read-tool-output.js";
import type { SandboxToolDeps } from "./sandbox/common.js";
import { sandboxTools } from "./sandbox/index.js";
import { skillLoadTool } from "./skill-load.js";
import { skillWriteTool } from "./skill-write.js";
import { toolSearchTool } from "./tool-search.js";

/**
 * The kernel's builtin tools, built once from the injected services (their specs: names,
 * descriptions and schemas, are the factories' own and unchanged). `tool_search` and `skill_load`
 * are added to a run by the registry (`forAgent`: organization setting and threshold, a skills
 * catalog snapshot), not by agent definitions; `skill_write` only when a definition names it.
 *
 * The sandbox, the attachments and the event log are still built by the legacy graph (Tasks 3.6,
 * 3.8): the tools read them through `LegacyPorts` at call time (R7), never at construction.
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
    @Inject(LegacyPorts) ports: LegacyPorts,
  ) {
    const sandboxDeps: SandboxToolDeps = {
      get sandbox() {
        return ports.sandbox;
      },
      get attachments() {
        return ports.attachments;
      },
      storage,
      get eventLog() {
        return ports.eventLog;
      },
      config,
    };
    this.tools = [
      askUserTool({ config }),
      readToolOutputTool({ outputs, config }),
      toolSearchTool(),
      // dispatches sub-agents; the tool pipeline handles its calls (sub-agents spec §4, §7.1)
      agentTool,
      ...sandboxTools(sandboxDeps),
      // 技能加载：对话日志里有技能目录快照时由注册表自动加入（Ruling M17）
      skillLoadTool({
        storage,
        config,
        get sandbox() {
          return ports.sandbox;
        },
        get attachments() {
          return ports.attachments;
        },
        get eventLog() {
          return ports.eventLog;
        },
        get db() {
          return db.db;
        },
      }),
      // 自写技能：agent 定义显式引用才可用
      skillWriteTool({ changes: skillChanges }),
    ];
  }

  /** The builtin tools, in a fixed order. */
  list(): readonly BuiltinTool[] {
    return this.tools;
  }
}
