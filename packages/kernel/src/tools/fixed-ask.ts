import { R3_FIXED_ASK_TOOL_KEYS, R3_SHARED_AGENT_ONLY_TOOL_KEYS } from "./builtin-names.js";
import type { ResolvedTool } from "./registry.js";

/**
 * 是否属于 R3 固定询问（清单或工具声明需要用户交互）。`visibility` 为 agent 当前的可见性：
 * {@link R3_SHARED_AGENT_ONLY_TOOL_KEYS} 里的内置工具在私有 agent 上不算固定询问，
 * 除非 agent 当前版本的 `skills.writePolicy` 为 `ask`（`skillWritePolicy`）；不知道可见性时按共享处理（更严）。
 */
export function isFixedAsk(
  tool: ResolvedTool,
  visibility?: "private" | "org" | "members" | undefined,
  skillWritePolicy?: "allow" | "ask" | undefined,
): boolean {
  if (tool.spec.annotations?.requiresUserInteraction === true) return true;
  if (!R3_FIXED_ASK_TOOL_KEYS.has(tool.key)) return false;
  const builtinOnly =
    tool.source.kind === "builtin" && R3_SHARED_AGENT_ONLY_TOOL_KEYS.has(tool.key);
  // 私有 agent：缺省 / allow 不问（R4），负责人设为 ask（D10）时与共享 agent 一样固定询问
  return !(builtinOnly && visibility === "private" && skillWritePolicy !== "ask");
}
