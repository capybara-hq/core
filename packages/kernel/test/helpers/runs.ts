import { fileURLToPath } from "node:url";
import { expect } from "vitest";
import { type KernelConfig, KernelConfigSchema } from "../../src/config/schema.js";
import type { ConversationEvent } from "../../src/conversations/events.js";
import type { KernelDb } from "../../src/db/kernel-schema.js";
import { createKernel, type Kernel, type KernelOptions } from "../../src/kernel.js";
import { createLogger } from "../../src/log.js";
import { asUser, cookieJar } from "./http.js";
import { MODEL_FAKE } from "./model-plugins.js";

/**
 * 运行编排测试的公共辅助（Task 11；Task 12 换用 LangGraphLoop 时复用，把 loop 作为参数传入）。
 */

/** 测试用模型供应商 `model-looper`（每步都返回工具调用，见 fixture 注释）。 */
export const MODEL_LOOPER = fileURLToPath(
  new URL("../fixtures/plugins/model-looper/index.ts", import.meta.url),
);

export const PW = "correct horse battery";

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 轮询直到 fn 返回真值（非 null / undefined / false）；超时抛错。 */
export async function waitFor<T>(
  fn: () => Promise<T | null | undefined | false>,
  timeoutMs = 10_000,
  label = "condition",
  stepMs = 25,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v !== null && v !== undefined && v !== false) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await sleep(stepMs);
  }
}

/** 运行测试的内核配置：加载 model-fake 与 model-looper；`runtime` 与其他字段可覆盖。 */
export function runConfig(
  urls: { pg: string; redis: string },
  overrides: Record<string, unknown> & { runtime?: Partial<KernelConfig["runtime"]> } = {},
): KernelConfig {
  const { runtime, ...rest } = overrides;
  return KernelConfigSchema.parse({
    db: { url: urls.pg, poolMax: 5 },
    redis: { url: urls.redis },
    masterKey: Buffer.alloc(32, 7).toString("base64"),
    http: { port: 0 },
    plugins: [MODEL_FAKE, MODEL_LOOPER],
    runtime: { jobLockMs: 2000, stalledIntervalMs: 1000, ...runtime },
    ...rest,
  });
}

const silent = () => createLogger("error", { write: () => {} });

/** 创建并启动内核（日志静默）。 */
export async function startKernel(
  config: KernelConfig,
  opts: Omit<KernelOptions, "env" | "logger"> = {},
): Promise<Kernel> {
  const k = await createKernel(config, { env: {}, logger: silent(), ...opts });
  await k.start();
  return k;
}

export type Req = ReturnType<typeof asUser>;

export async function session(k: Kernel, login: string): Promise<Req> {
  const req = asUser(k.http, cookieJar());
  const res = await req({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { login, password: PW },
  });
  expect(res.statusCode).toBe(200);
  return req;
}

export async function createOrg(req: Req, name = "Acme"): Promise<string> {
  const res = await req({ method: "POST", url: "/api/v1/orgs", payload: { name } });
  expect(res.statusCode).toBe(201);
  return (res.json() as { org: { id: string } }).org.id;
}

export async function createAgent(
  req: Req,
  orgId: string,
  model: { provider: string; model: string } = { provider: "model-fake", model: "fake-1" },
): Promise<string> {
  const res = await req({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/agents`,
    payload: {
      // 显式不带工具：运行编排测试只看 M2 行为（model-fake 在请求带工具、消息不是脚本指令时会调用第一个工具，
      // 默认的内置工具 ask_user 会让普通消息变成提问）。带默认内置工具的 agent 见 test/tools/ask-user.test.ts。
      definition: { name: "Helper", instructions: "Be helpful.", model, tools: [] },
      visibility: "org",
    },
  });
  expect(res.statusCode, res.body).toBe(201);
  return (res.json() as { agent: { id: string } }).agent.id;
}

export async function createConv(req: Req, orgId: string, agentId: string): Promise<string> {
  const res = await req({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/conversations`,
    payload: { agentId },
  });
  expect(res.statusCode).toBe(201);
  return (res.json() as { conversation: { id: string } }).conversation.id;
}

/** 发一条消息，返回它的 seq。 */
export async function postMessage(
  req: Req,
  orgId: string,
  convId: string,
  text: string,
): Promise<number> {
  const res = await req({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/conversations/${convId}/messages`,
    payload: { text },
  });
  expect(res.statusCode).toBe(202);
  return (res.json() as { event: { seq: number } }).event.seq;
}

/** 读会话全部事件（直接查库）。 */
export async function eventsOf(db: KernelDb, convId: string): Promise<ConversationEvent[]> {
  const rows = await db
    .selectFrom("conversation_events")
    .select(["conversation_id", "seq", "type", "run_id", "payload", "created_at"])
    .where("conversation_id", "=", convId)
    .orderBy("seq")
    .execute();
  return rows.map(
    (r) =>
      ({
        conversationId: r.conversation_id,
        seq: Number(r.seq),
        type: r.type,
        runId: r.run_id,
        payload: r.payload,
        createdAt: r.created_at,
      }) as ConversationEvent,
  );
}

/** 等到会话里出现满足条件的事件，返回该事件。 */
export function waitForEvent(
  db: KernelDb,
  convId: string,
  pred: (e: ConversationEvent) => boolean,
  timeoutMs = 10_000,
  label = "event",
): Promise<ConversationEvent> {
  return waitFor(async () => (await eventsOf(db, convId)).find(pred), timeoutMs, label);
}

/** 等到会话的第 n 个终态事件（run_finished / run_failed / run_aborted）出现。 */
export function waitForTerminal(
  db: KernelDb,
  convId: string,
  n = 1,
  timeoutMs = 15_000,
): Promise<ConversationEvent[]> {
  return waitFor(
    async () => {
      const t = (await eventsOf(db, convId)).filter((e) =>
        ["run_finished", "run_failed", "run_aborted"].includes(e.type),
      );
      return t.length >= n ? t : null;
    },
    timeoutMs,
    `${n} terminal event(s)`,
  );
}

export async function consumedSeq(db: KernelDb, convId: string): Promise<number> {
  const r = await db
    .selectFrom("conversations")
    .select("consumed_seq")
    .where("id", "=", convId)
    .executeTakeFirstOrThrow();
  return Number(r.consumed_seq);
}

export async function runsOf(
  db: KernelDb,
  convId: string,
): Promise<{ id: string; status: string }[]> {
  return db
    .selectFrom("runs")
    .select(["id", "status"])
    .where("conversation_id", "=", convId)
    .orderBy("created_at")
    .execute();
}

/** 可从外部放行的闸门。 */
export function gate(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((r) => {
    open = r;
  });
  return { promise, open };
}
