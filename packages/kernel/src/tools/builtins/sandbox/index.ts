import type { BuiltinTool } from "../../registry.js";
import { sandboxBashTool } from "./bash.js";
import type { SandboxToolDeps } from "./common.js";
import { sandboxDeliverTool } from "./deliver.js";
import { sandboxEditTool } from "./edit.js";
import { sandboxGlobTool } from "./glob.js";
import { sandboxGrepTool } from "./grep.js";
import { sandboxReadTool } from "./read.js";
import { sandboxWriteTool } from "./write.js";

export { BASH_SPILL_CHARS, formatExec } from "./bash.js";
export {
  assignAttachmentNames,
  SANDBOX_RECREATED_NOTICE,
  SANDBOX_SETUP_MARGIN_MS,
  SANDBOX_STARTED_NOTICE,
  SANDBOX_UNAVAILABLE_REASON,
  type SandboxToolDeps,
  sandboxBaseTimeoutMs,
  searchTimeoutMs,
  shellQuote,
} from "./common.js";
export { compileGlob, GlobPatternError, MAX_GLOB_STARS } from "./glob-match.js";
export { SANDBOX_ASK_TOOL_NAMES, SANDBOX_TOOL_NAMES } from "./names.js";

/**
 * 沙箱内置工具（M5 T8）：bash / read / write / edit / glob / grep / deliver，都在本对话的沙箱上执行
 * （`SandboxService.withSandbox`），执行前同步附件到 `/workspace/attachments`。没有沙箱提供方时报不可用。
 * 默认 allow；组织设置 `sandboxToolPolicy` 为 ask 时除 read / glob / grep 外需要审批（见 policy.ts）。
 */
export function sandboxTools(deps: SandboxToolDeps): BuiltinTool[] {
  return [
    sandboxBashTool(deps),
    sandboxReadTool(deps),
    sandboxWriteTool(deps),
    sandboxEditTool(deps),
    sandboxGlobTool(deps),
    sandboxGrepTool(deps),
    sandboxDeliverTool(deps),
  ];
}
