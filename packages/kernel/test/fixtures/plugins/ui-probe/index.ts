import { definePlugin, type UiRenderArgs, type UiView } from "@capybara-hq/plugin-sdk";

/** 测试观察点（同进程的单副本测试读它）：slow 视图收到的中止信号次数、最近一次 render / action 的参数。 */
export interface UiProbeState {
  aborted: number;
  lastRender?: Omit<UiRenderArgs, "signal">;
  lastAction?: Record<string, unknown>;
}

const state = (): UiProbeState => {
  const g = globalThis as { __uiProbe?: UiProbeState };
  g.__uiProbe ??= { aborted: 0 };
  return g.__uiProbe;
};

const t = (zh: string, en: string) => ({ zh, en });

/** 不带 signal 的参数（可序列化，写进视图给测试核对）。 */
const plain = ({ signal: _signal, ...rest }: UiRenderArgs) => rest;

/**
 * 界面接口测试用插件：
 * - 对话视图 panel（回显参数）、boom（抛错）、slow（一直等到中止信号）、bad（返回非法视图）；
 * - 组织页面视图 orgpage，嵌入应用 board（路由 GET /ui/board）；
 * - panel 的动作：toast / view / bad / boom；
 * - 路由 POST /invalidate：按请求体调用 ctx.ui.invalidate（测试从指定副本触发刷新）。
 */
export default definePlugin({
  name: "ui-probe",
  version: "0.1.0",
  sdk: "^0.1.0",
  provides: [],
  ui: [
    { id: "panel", title: t("面板", "Panel"), place: "conversation", kind: "view" },
    { id: "boom", title: t("出错", "Boom"), place: "conversation", kind: "view" },
    { id: "slow", title: t("很慢", "Slow"), place: "conversation", kind: "view" },
    { id: "bad", title: t("非法", "Bad"), place: "conversation", kind: "view" },
    { id: "orgpage", title: t("组织页", "Org page"), place: "page", kind: "view" },
    { id: "board", title: t("看板", "Board"), place: "page", kind: "embed", path: "/ui/board" },
  ],
  permissions: {
    http: [
      { method: "GET", path: "/ui/board" },
      { method: "POST", path: "/invalidate" },
    ],
    ui: { views: ["panel", "boom", "slow", "bad", "orgpage"], embeds: ["board"] },
    tools: ["probe"],
  },
  setup(ctx) {
    // 工具显示摘要：input.bad 时给非法摘要（内核丢弃并告警），否则给合法摘要
    ctx.tools.register(
      {
        name: "probe",
        description: "Probe tool for display summaries.",
        inputSchema: { type: "object", properties: { bad: { type: "boolean" } } },
        defaultPolicy: "allow",
      },
      async (input) => ({
        content: [{ type: "text", text: "probed" }],
        display: (input as { bad?: boolean }).bad
          ? ({ summary: { zh: "", en: "x" } } as never)
          : { summary: { zh: "探测完成", en: "Probe done" } },
      }),
    );
    ctx.ui.view("panel", async (args): Promise<UiView> => {
      state().lastRender = plain(args);
      return {
        badge: "1/2",
        blocks: [
          { type: "heading", text: `panel ${args.locale}` },
          { type: "code", language: "json", text: JSON.stringify(plain(args)) },
          { type: "actions", buttons: [{ actionId: "toast", label: "Go", payload: { n: 1 } }] },
        ],
      };
    });
    ctx.ui.view("boom", async () => {
      throw new Error("render exploded with secret detail");
    });
    ctx.ui.view("slow", (args) => {
      // 不主动结束：等内核超时中止；记一次收到的中止信号
      args.signal.addEventListener("abort", () => {
        state().aborted++;
      });
      return new Promise<UiView>(() => {});
    });
    ctx.ui.view("bad", async () => ({ blocks: [{ type: "marquee", text: "nope" }] }) as never);
    ctx.ui.view("orgpage", async (args) => {
      state().lastRender = plain(args);
      return { blocks: [{ type: "text", markdown: `org ${args.orgId}` }] };
    });
    ctx.ui.action("panel", async (args) => {
      const { signal: _s, ...rest } = args;
      state().lastAction = rest as Record<string, unknown>;
      switch (args.actionId) {
        case "toast":
          return { toast: t("好了", "Done") };
        case "view":
          return { view: { badge: "2/2", blocks: [{ type: "heading", text: "after" }] } };
        case "bad":
          return { view: { blocks: "not a list" } } as never;
        default:
          throw new Error("action exploded");
      }
    });
    ctx.http.route("GET", "/ui/board", async () => new Response("board"));
    ctx.http.route("POST", "/invalidate", async (req) => {
      const body = (await req.json()) as {
        orgId: string;
        conversationId?: string;
        contribution: string;
      };
      await ctx.ui.invalidate(body);
      return new Response(null, { status: 204 });
    });
  },
});
