import { fileURLToPath } from "node:url";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { PLUGIN_UNLOADED_TOOL_ERROR } from "../../src/extensions/inflight.js";
import { AccountsService } from "../../src/identity/accounts.js";
import type { Kernel } from "../../src/kernel.js";
import { everythingProbe } from "../fixtures/plugins/everything/index.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import {
  createConv,
  createOrg,
  eventsOf,
  PW,
  type Req,
  runConfig,
  runsOf,
  session,
  startKernel,
  waitFor,
  waitForTerminal,
} from "../helpers/runs.js";

/**
 * In-flight tool calls at revocation (T12, C17) and the kernel-side consumers:
 * - a call that ignores the signal: aborted at the drain limit, the model gets an English error
 *   result, the run still reaches completed;
 * - a call that honours the signal and finishes within the limit: its result is written as usual;
 * - extension routes answer 503 `extension.unavailable` after revocation and recover after reload;
 * - login sources and directories are resolved live from the registry: gone after revocation, back
 *   after reload.
 */

const fx = (n: string) =>
  fileURLToPath(new URL(`../fixtures/plugins/${n}/index.ts`, import.meta.url));

let pgc: TestContainer;
let rd: TestContainer;
let k: Kernel;
let raw: ReturnType<typeof createDb>;
let owner: Req;
let orgId: string;
let agentId: string;

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  k = await startKernel(
    runConfig(
      { pg: pgc.url, redis: rd.url },
      {
        extensions: [MODEL_FAKE, fx("everything"), fx("fake-idp"), fx("dir-mini"), fx("sse-hold")],
        extensionConfig: { "fake-idp": { tenant: "t1", clientSecret: "s3cret" } },
        http: { port: 0, publicUrl: "https://cap.example" },
        auth: { cookieSecure: false, loginSources: ["fake-idp"] },
      },
    ),
  );
  raw = createDb(pgc.url, 3);
  await new AccountsService(kernelDb(raw)).createLocal({
    login: "owner",
    password: PW,
    displayName: "O",
  });
  owner = await session(k, "owner");
  orgId = await createOrg(owner);
  for (const [plugin, config] of [
    ["everything", undefined],
    ["dir-mini", { url: "http://127.0.0.1:9/dir" }],
  ] as const) {
    const res = await owner({
      method: "PUT",
      url: `/api/v1/orgs/${orgId}/extensions/${plugin}`,
      payload: { enabled: true, ...(config !== undefined && { config }) },
    });
    expect(res.statusCode, res.body).toBe(200);
  }
  const ag = await owner({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/agents`,
    payload: {
      definition: {
        name: "Helper",
        instructions: "Be helpful.",
        model: { provider: "model-fake", model: "fake-1" },
        tools: [
          { kind: "plugin", plugin: "everything", name: "hang" },
          { kind: "plugin", plugin: "everything", name: "polite" },
        ],
      },
      visibility: "org",
    },
  });
  expect(ag.statusCode, ag.body).toBe(201);
  agentId = (ag.json() as { agent: { id: string } }).agent.id;
}, 120_000);

afterAll(async () => {
  await k?.stop();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

const db = () => kernelDb(raw);

async function callTool(tool: string): Promise<string> {
  const convId = await createConv(owner, orgId, agentId);
  const res = await owner({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/conversations/${convId}/messages`,
    payload: { text: `tool:everything__${tool}:{}` },
  });
  expect(res.statusCode, res.body).toBe(202);
  await waitFor(
    async () => (k.host.current("everything")?.inflight.size ?? 0) === 1,
    15_000,
    `${tool} in flight`,
  );
  return convId;
}

async function toolResult(convId: string) {
  const ev = (await eventsOf(db(), convId)).find((e) => e.type === "tool_result");
  return ev?.payload as { content: string; isError: boolean } | undefined;
}

describe("撤销时的在途工具调用", () => {
  it("不理会 signal 的调用：排空时限到后中止，tool_result 为英文错误，运行 completed", async () => {
    const probe = everythingProbe();
    const convId = await callTool("hang");
    expect(probe.hangStarted).toBeGreaterThanOrEqual(1);
    const started = Date.now();
    await k.host.unload("everything", { drainMs: 500 });
    const took = Date.now() - started;
    expect(took).toBeGreaterThanOrEqual(450);
    expect(took).toBeLessThan(5_000);
    const [term] = await waitForTerminal(db(), convId, 1, 20_000);
    expect(term?.type).toBe("run_finished");
    expect(term?.payload).toMatchObject({ reason: "completed" });
    expect(await toolResult(convId)).toMatchObject({
      content: PLUGIN_UNLOADED_TOOL_ERROR,
      isError: true,
    });
    expect((await runsOf(db(), convId)).map((r) => r.status)).toEqual(["completed"]);
    await k.host.reload("everything");
  }, 60_000);

  it("理会 signal、在时限内结束的调用：结果照常写入", async () => {
    const probe = everythingProbe();
    const doneBefore = probe.politeDone;
    const convId = await callTool("polite");
    await k.host.unload("everything", { drainMs: 5_000 });
    // 排空等到了调用结束：撤销返回时它已经正常完成
    expect(probe.politeDone).toBe(doneBefore + 1);
    await waitForTerminal(db(), convId, 1, 20_000);
    expect(await toolResult(convId)).toMatchObject({ content: "polite done", isError: false });
    expect((await runsOf(db(), convId)).map((r) => r.status)).toEqual(["completed"]);
    await k.host.reload("everything");
  }, 60_000);

  it("撤销后新的调用：工具不可用（不调用旧实例）", async () => {
    await k.host.unload("everything");
    const convId = await createConv(owner, orgId, agentId);
    const res = await owner({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/conversations/${convId}/messages`,
      payload: { text: "tool:everything__hang:{}" },
    });
    expect(res.statusCode).toBe(202);
    await waitForTerminal(db(), convId, 1, 20_000);
    expect((await runsOf(db(), convId)).map((r) => r.status)).toEqual(["completed"]);
    expect(k.host.current("everything")).toBeUndefined();
    await k.host.reload("everything");
  }, 60_000);
});

describe("模型供应商在流式输出途中被重新加载", () => {
  it("the old instance's stream is aborted (ExtensionUnloadedError) -> the same-model retry gets the new instance, run completed", async () => {
    const convId = await createConv(owner, orgId, agentId);
    const res = await owner({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/conversations/${convId}/messages`,
      payload: { text: "slow:200:abcdefghijklmnopqrstuvwx" },
    });
    expect(res.statusCode, res.body).toBe(202);
    const old = k.host.current("model-fake");
    // this run's stream (a title call of an earlier conversation may be in flight too)
    await waitFor(
      async () =>
        (await eventsOf(db(), convId)).some((e) => e.type === "model_call") &&
        (old?.inflight.size ?? 0) >= 1,
      15_000,
      "model stream open",
    );
    await k.host.reload("model-fake", { drainMs: 100 });
    expect(k.host.current("model-fake")).not.toBe(old);
    const [term] = await waitForTerminal(db(), convId, 1, 30_000);
    expect(term?.payload).toMatchObject({ reason: "completed" });
    const calls = (await eventsOf(db(), convId)).filter((e) => e.type === "model_call");
    expect(calls.map((e) => (e.payload as { attempt: number }).attempt)).toEqual([1, 2]);
    expect((await runsOf(db(), convId)).map((r) => r.status)).toEqual(["completed"]);
  }, 60_000);
});

describe("内核侧消费方实时向注册表取", () => {
  it("extension routes: 503 extension.unavailable after revocation, back after reload; an unknown extension is still 404", async () => {
    const ok = await k.http.inject({ method: "GET", url: "/plugins/everything/hello" });
    expect(ok.statusCode).toBe(200);
    expect(ok.body).toBe("hello");
    await k.host.unload("everything");
    const gone = await k.http.inject({ method: "GET", url: "/plugins/everything/hello" });
    expect(gone.statusCode).toBe(503);
    expect((gone.json() as { error: { code: string } }).error.code).toBe("extension.unavailable");
    const other = await k.http.inject({ method: "GET", url: "/plugins/everything/nope" });
    expect(other.statusCode).toBe(503);
    const unknown = await k.http.inject({ method: "GET", url: "/plugins/nobody/hello" });
    expect(unknown.statusCode).toBe(404);
    await k.host.reload("everything");
    const back = await k.http.inject({ method: "GET", url: "/plugins/everything/hello" });
    expect(back.statusCode).toBe(200);
  }, 30_000);

  it("界面贡献：撤销后列表里没有，重新加载后回来", async () => {
    const list = async () => {
      const res = await owner({ method: "GET", url: `/api/v1/orgs/${orgId}/ui/contributions` });
      expect(res.statusCode, res.body).toBe(200);
      return (res.json() as { items: { plugin: string }[] }).items.map((c) => c.plugin);
    };
    expect(await list()).toContain("everything");
    await k.host.unload("everything");
    expect(await list()).not.toContain("everything");
    await k.host.reload("everything");
    expect(await list()).toContain("everything");
  }, 30_000);

  it("登录源（identity-source@1）：撤销后不再列出，重新加载后回来", async () => {
    expect(k.identity.sso.sources().map((s) => s.plugin)).toEqual(["fake-idp"]);
    await k.host.unload("fake-idp");
    expect(k.identity.sso.sources()).toEqual([]);
    await k.host.reload("fake-idp");
    expect(k.identity.sso.sources().map((s) => s.plugin)).toEqual(["fake-idp"]);
  }, 30_000);

  it("通讯录（directory@1）：撤销后扫描不再投递，重新加载后恢复", async () => {
    const plugins = async () => (await k.identity.directory.scan()).map((t) => t.plugin);
    expect(await plugins()).toEqual(["dir-mini"]);
    await k.host.unload("dir-mini");
    expect(await plugins()).toEqual([]);
    await k.host.reload("dir-mini");
    expect(await plugins()).toEqual(["dir-mini"]);
  }, 30_000);

  it("插件 SSE：插件实例被替换或撤销时，进行中的请求被中止、流结束", async () => {
    const open = async () => {
      const res = await fetch(`http://127.0.0.1:${k.port}/plugins/sse-hold/hold`);
      expect(res.status).toBe(200);
      const reader = (res.body as ReadableStream<Uint8Array>).getReader();
      await reader.read();
      const ended = (async () => {
        for (;;) if ((await reader.read()).done) return true;
      })();
      // 包一层：async 函数直接返回 Promise 会被展开（open 就会一直等到流结束）
      return { ended };
    };
    const within = <T>(p: Promise<T>, ms = 5_000) =>
      Promise.race([
        p,
        new Promise<"timeout">((r) => {
          setTimeout(() => r("timeout"), ms);
        }),
      ]);
    const a = await open();
    await k.host.reload("sse-hold");
    expect(await within(a.ended)).toBe(true);
    const b = await open();
    await k.host.unload("sse-hold");
    expect(await within(b.ended)).toBe(true);
    const gone = await k.http.inject({ method: "GET", url: "/plugins/sse-hold/hold" });
    expect(gone.statusCode).toBe(503);
    await k.host.reload("sse-hold");
  }, 30_000);
});
