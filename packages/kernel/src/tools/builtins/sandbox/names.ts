/**
 * 沙箱内置工具的名字（M5 T8，Ruling M12：工具 key 只能含字母数字、`_`、`-`，所以是 `sandbox_<动作>`）。
 * 单独成文件：注册表与策略判定只需要名字，不引入工具实现。
 */
export const SANDBOX_TOOL_NAMES = [
  "sandbox_bash",
  "sandbox_read",
  "sandbox_write",
  "sandbox_edit",
  "sandbox_glob",
  "sandbox_grep",
  "sandbox_deliver",
] as const;

/** 组织设置 `sandboxToolPolicy` 为 `ask` 时需要审批的沙箱工具（只读的 read / glob / grep 除外）。 */
export const SANDBOX_ASK_TOOL_NAMES: ReadonlySet<string> = new Set([
  "sandbox_bash",
  "sandbox_write",
  "sandbox_edit",
  "sandbox_deliver",
]);
