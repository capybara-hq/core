import { R3_FIXED_ASK_TOOL_KEYS } from "./builtin-names.js";
import type { ResolvedTool } from "./registry.js";

/**
 * Whether the tool is a fixed ask: its spec declares `requiresUserInteraction`, or it is on the R3
 * list ({@link R3_FIXED_ASK_TOOL_KEYS}: the schedule writes). Its policy is at least `ask` and
 * remembered grants never let it through.
 */
export function isFixedAsk(tool: ResolvedTool): boolean {
  return (
    tool.spec.annotations?.requiresUserInteraction === true || R3_FIXED_ASK_TOOL_KEYS.has(tool.key)
  );
}
