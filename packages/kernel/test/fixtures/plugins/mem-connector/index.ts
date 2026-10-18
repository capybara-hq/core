import {
  type AuthInjection,
  CONNECTOR_CAPABILITY,
  type Connector,
  definePlugin,
  type PluginContext,
  type ToolSpec,
} from "@capybara-hq/plugin-sdk";
import { z } from "zod";

/** 一个内存「服务端」：测试往 `memServers()` 里放工具清单、故障与要求的令牌。 */
export interface MemServer {
  tools: ToolSpec[];
  /** 设了就在 listTools 时抛这个错误（模拟连不上 / 上游报错）。 */
  fail?: Error;
  /** 要求的 Authorization 头；不符 → 抛 Unauthorized。 */
  requireAuth?: string;
}

export interface MemState {
  servers: Record<string, MemServer>;
  opened: number;
  closed: number;
  /** 每次会话拿到的鉴权注入（测试断言用）。 */
  auths: AuthInjection[];
  /** callTool 调用记录（工具执行管线测试用）。 */
  calls: { server: string; name: string; input: unknown }[];
  /** 插件工具 echo 的调用次数。 */
  echoCalls: number;
}

/** 测试专用：状态挂在 globalThis 上，测试与插件共享（同一进程）。 */
export function memState(): MemState {
  const g = globalThis as { __memConnector?: MemState };
  g.__memConnector ??= { servers: {}, opened: 0, closed: 0, auths: [], calls: [], echoCalls: 0 };
  return g.__memConnector;
}

class UnauthorizedError extends Error {
  override name = "UnauthorizedError";
}

const connector: Connector = {
  kind: "mem",
  endpointSchema: z.object({ server: z.string().min(1) }).strict(),
  async open(args) {
    const st = memState();
    const { server } = args.endpoint as { server: string };
    st.opened++;
    return {
      async listTools() {
        const s = st.servers[server];
        if (!s) throw new Error(`no such server ${server}`);
        const auth = await args.auth();
        st.auths.push(auth);
        if (s.requireAuth !== undefined && auth.headers.Authorization !== s.requireAuth) {
          throw new UnauthorizedError("unauthorized");
        }
        if (s.fail) throw s.fail;
        return structuredClone(s.tools);
      },
      async callTool(name, input) {
        st.calls.push({ server, name, input });
        return { content: [{ type: "text", text: `called ${name}` }] };
      },
      async close() {
        st.closed++;
      },
    };
  },
};

/** 测试用 connector@1（kind `mem`），同时经 ctx.tools 注册一个插件工具 `echo`。 */
export default definePlugin({
  name: "mem-connector",
  version: "0.1.0",
  sdk: "^0.1.0",
  provides: [CONNECTOR_CAPABILITY],
  setup(ctx: PluginContext) {
    ctx.tools.register(
      {
        name: "echo",
        description: "Echo the input back to the caller.",
        inputSchema: { type: "object", properties: { text: { type: "string" } } },
        annotations: { readOnlyHint: true },
      },
      async (input) => {
        memState().echoCalls++;
        return { content: [{ type: "text", text: JSON.stringify(input) }] };
      },
    );
    ctx.tools.register(
      {
        name: "wipe",
        description: "Delete everything.",
        inputSchema: { type: "object" },
        annotations: { destructiveHint: true },
        defaultPolicy: "allow",
      },
      async () => ({ content: [{ type: "text", text: "wiped" }] }),
    );
    ctx.provide(CONNECTOR_CAPABILITY, connector);
  },
});
