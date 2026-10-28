import { defineExtension } from "@capybara-hq/plugin-sdk";

/**
 * 测试用：两个会计数的工具（整轮回放测试据此证明工具处理函数一次都没被调用）。
 * - `count`：只读注解，默认策略 allow（真实运行里直接执行）；
 * - `ask`：没有注解，默认策略 ask（真实管线会建审批）。
 * 计数挂在 globalThis 上，测试与插件共享（同一进程）。
 */
export interface ToolsCountState {
  count: number;
  ask: number;
}

export function toolsCountState(): ToolsCountState {
  const g = globalThis as { __toolsCount?: ToolsCountState };
  g.__toolsCount ??= { count: 0, ask: 0 };
  return g.__toolsCount;
}

const n = (input: unknown) => (input as { n?: unknown } | null)?.n;

export default defineExtension({
  name: "tools-count",
  version: "0.1.0",
  sdk: "^0.1.0-rc.0",
  provides: [],
  permissions: { tools: ["count", "ask"] },
  setup(ctx) {
    ctx.tools.register(
      {
        name: "count",
        description: "Counts how many times it was called. Returns the given number.",
        inputSchema: { type: "object", properties: { n: { type: "number" } } },
        annotations: { readOnlyHint: true },
      },
      async (input) => {
        toolsCountState().count++;
        return { content: [{ type: "text", text: `counted ${String(n(input))}` }] };
      },
    );
    ctx.tools.register(
      {
        name: "ask",
        description: "A tool that needs approval. Returns the given number.",
        inputSchema: { type: "object", properties: { n: { type: "number" } } },
      },
      async (input) => {
        toolsCountState().ask++;
        return { content: [{ type: "text", text: `asked ${String(n(input))}` }] };
      },
    );
  },
});
