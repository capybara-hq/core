import type { BuiltinTool } from "../../registry.js";
import { sandboxBashTool } from "./bash.js";
import type { SandboxToolDeps } from "./common.js";
import { sandboxDeliverTool } from "./deliver.js";
import { sandboxEditTool } from "./edit.js";
import { sandboxFetchAttachmentTool } from "./fetch-attachment.js";
import { sandboxGlobTool } from "./glob.js";
import { sandboxGrepTool } from "./grep.js";
import { sandboxReadTool } from "./read.js";
import { taskListTool } from "./task-list.js";
import { taskOutputTool } from "./task-output.js";
import { taskStopTool } from "./task-stop.js";
import { sandboxWriteTool } from "./write.js";

export { SANDBOX_ASK_TOOL_NAMES, SANDBOX_TOOL_NAMES } from "../../builtin-names.js";
export { BASH_SPILL_CHARS, formatExec } from "./bash.js";
export {
  assignAttachmentNames,
  RUN_DEADLINE_MARGIN_MS,
  runTimeLeftMs,
  SANDBOX_RESTARTED_NOTICE,
  SANDBOX_SETUP_MARGIN_MS,
  SANDBOX_STARTED_NOTICE,
  SANDBOX_UNAVAILABLE_REASON,
  type SandboxToolDeps,
  sandboxBaseTimeoutMs,
  sandboxStartedNotice,
  sandboxUsable,
  searchTimeoutMs,
  shellQuote,
} from "./common.js";
export { sandboxFetchAttachmentTool } from "./fetch-attachment.js";
export { compileGlob, GlobPatternError, MAX_GLOB_STARS } from "./glob-match.js";

/**
 * The sandbox builtins (M5 T8): Bash / Read / Write / Edit / Glob / Grep / Deliver / FetchAttachment,
 * all run in the conversation's device (`SandboxService.withSandbox`). Attachments are not copied
 * into it by a sandbox call: `FetchAttachment` is the only way in, writing one file under
 * `<workspace>/attachments/<conversation>` (the instance's roots, environments spec §13.1).
 * Unavailable without a provider for it. Allowed by default; with the org setting
 * `sandboxToolPolicy` set to ask, every one but Read / Glob / Grep / FetchAttachment needs approval
 * (see policy.ts).
 * `TaskOutput` and `TaskStop` read and stop background `Bash` tasks through
 * `SandboxService.ifRunning` (never creating or resuming a sandbox); `TaskList` lists them and the
 * conversation's sub-agents from PG; all three always allowed.
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
    sandboxFetchAttachmentTool(deps),
    taskOutputTool(deps),
    taskStopTool(deps),
    taskListTool(deps),
  ];
}
