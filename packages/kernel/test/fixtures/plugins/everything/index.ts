import { defineExtension, type ExtensionContext, type Lease } from "@capybara-hq/plugin-sdk";
import { z } from "zod";

/** 测试观察点（同进程读）：每次 setup 的 ctx、收到的任务与消息、dispose 次数与当时 signal 是否已中止。 */
export interface EverythingProbe {
  setups: number;
  ctxs: ExtensionContext[];
  jobs: unknown[];
  messages: unknown[];
  disposed: number;
  disposeSawAborted: boolean[];
  lease?: Lease | null;
  /** hang 工具开始执行的次数。 */
  hangStarted: number;
  /** polite 工具结束的次数。 */
  politeDone: number;
  /** slowjobs 任务开始的次数。 */
  slowStarted: number;
  /** slowjobs 任务结束时 ctx.signal 是否已中止（理会 signal：中止就提前结束）。 */
  slowDone: { aborted: boolean }[];
}

export const everythingProbe = (): EverythingProbe => {
  const g = globalThis as { __everything?: EverythingProbe };
  g.__everything ??= {
    setups: 0,
    ctxs: [],
    jobs: [],
    messages: [],
    disposed: 0,
    disposeSawAborted: [],
    hangStarted: 0,
    politeDone: 0,
    slowStarted: 0,
    slowDone: [],
  };
  return g.__everything;
};

const t = (zh: string, en: string) => ({ zh, en });

/**
 * 注册追踪与撤销的测试插件：每一种登记都做一遍——工具（hang 不理会 signal、永不返回；polite 300ms 后返回、
 * 中止时提前返回）、路由、队列 worker、bus 订阅、锁租约、界面视图与动作、provide。
 * 部署配置 `failAfterRegister` 为 true 时全部登记后在 setup 里抛错（测试 setup 失败的撤销）。
 */
export default defineExtension({
  name: "everything",
  version: "0.1.0",
  sdk: "^0.1.0-rc.0",
  provides: ["counter@1"],
  ui: [{ id: "panel", title: t("面板", "Panel"), place: "conversation", kind: "view" }],
  permissions: {
    tools: ["hang", "polite"],
    http: [{ method: "GET", path: "/hello" }],
    ui: { views: ["panel"] },
  },
  config: {
    deployment: z.object({ failAfterRegister: z.boolean().default(false) }).default({
      failAfterRegister: false,
    }),
  },
  async setup(ctx: ExtensionContext) {
    const probe = everythingProbe();
    probe.setups += 1;
    probe.ctxs.push(ctx);
    ctx.tools.register(
      {
        name: "hang",
        description: "Waits forever and ignores cancellation. Test fixture only.",
        inputSchema: { type: "object" },
        annotations: { readOnlyHint: true },
      },
      async () => {
        probe.hangStarted += 1;
        return new Promise(() => {});
      },
    );
    ctx.tools.register(
      {
        name: "polite",
        description: "Waits 300 ms (or until cancelled) and returns. Test fixture only.",
        inputSchema: { type: "object" },
        annotations: { readOnlyHint: true },
      },
      async (_input, c) => {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 300);
          c.signal.addEventListener("abort", () => {
            clearTimeout(timer);
            resolve();
          });
        });
        probe.politeDone += 1;
        return { content: [{ type: "text", text: "polite done" }] };
      },
    );
    ctx.http.route("GET", "/hello", async () => new Response("hello"));
    ctx.queue.define("jobs", async (data: unknown) => {
      probe.jobs.push(data);
    });
    // 理会 ctx.signal 的慢任务：300ms 后结束，ctx.signal 中止就提前结束
    ctx.queue.define("slowjobs", async () => {
      probe.slowStarted += 1;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 300);
        ctx.signal.addEventListener("abort", () => {
          clearTimeout(timer);
          resolve();
        });
      });
      probe.slowDone.push({ aborted: ctx.signal.aborted });
    });
    await ctx.bus.subscribe("ping", (p) => {
      probe.messages.push(p);
    });
    probe.lease = await ctx.lock.acquire("held", { ttlMs: 60_000 });
    ctx.ui.view("panel", async () => ({ blocks: [{ type: "heading", text: "Panel" }] }));
    ctx.ui.action("panel", async () => ({}));
    ctx.provide("counter@1", { from: "everything", setup: probe.setups });
    if ((ctx.config as { failAfterRegister?: boolean }).failAfterRegister) {
      throw new Error("setup failed after registering");
    }
  },
  dispose(ctx: ExtensionContext) {
    const probe = everythingProbe();
    probe.disposed += 1;
    probe.disposeSawAborted.push(ctx.signal.aborted);
  },
});
