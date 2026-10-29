import { fileURLToPath } from "node:url";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { expect } from "vitest";
import type { KernelAppOptions } from "../../src/app.js";
import {
  type KernelConfig,
  KernelConfigSchema,
  MARKETPLACE_OFFICIAL_URL_DEFAULT,
} from "../../src/config/schema.js";
import type { ConversationEvent } from "../../src/conversations/events.js";
import type { KernelSchemaDb } from "../../src/db/kernel-schema.js";
import type { KernelHttp } from "../../src/http/app.js";
import { createKernel } from "../../src/kernel.js";
import { createLogger } from "../../src/log.js";
import { runJobId } from "../../src/runtime/run-queue.js";
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

/**
 * 等 IM 卡片的消息 id 记进 `channel_card_messages`。它在卡片发出之后的事务里才写，记下之前的点击按
 * 「卡片不在这个会话」处理（只回「不能处理」）——测试点卡片之前要等到这一步，不能只看平台收到了卡片。
 */
export async function cardRecorded(
  db: KernelSchemaDb,
  card: { messageId: string } | { kind: "approval" | "question" },
  timeoutMs = 20_000,
): Promise<void> {
  await waitFor(
    async () => {
      const q = db.selectFrom("channel_card_messages").select("card_id");
      const row = await ("messageId" in card
        ? q.where("message_id", "=", card.messageId)
        : q.where("card_kind", "=", card.kind)
      ).executeTakeFirst();
      return row !== undefined;
    },
    timeoutMs,
    "card message row",
  );
}

/** 运行测试的内核配置：加载 model-fake 与 model-looper；`runtime` 与其他字段可覆盖。 */
export function runConfig(
  urls: { pg: string; redis: string },
  overrides: Record<string, unknown> & {
    runtime?: Partial<KernelConfig["runtime"]>;
    marketplaces?: Record<string, unknown> & { official?: Record<string, unknown> };
  } = {},
): KernelConfig {
  const { runtime, marketplaces, ...rest } = overrides;
  return KernelConfigSchema.parse({
    db: { url: urls.pg, poolMax: 5 },
    redis: { url: urls.redis },
    masterKey: Buffer.alloc(32, 7).toString("base64"),
    http: { port: 0 },
    extensions: [MODEL_FAKE, MODEL_LOOPER],
    extensionPermissions: { autoApprove: true },
    runtime: { jobLockMs: 2000, stalledIntervalMs: 1000, ...runtime },
    // The official marketplace is on by default and on the internet: off unless a test turns it on
    // (other marketplace settings are merged in).
    marketplaces: { ...marketplaces, official: { enabled: false, ...marketplaces?.official } },
    ...rest,
  });
}

const silent = () => createLogger("error", { write: () => {} });

/** The kernel's Nest application. */
export type KernelApp = NestFastifyApplication;

/** A kernel a test started ({@link startKernel}); reach its services with `app.get(Class)`. */
export interface TestKernel {
  /** The kernel's Nest application. */
  readonly app: KernelApp;
  /** In-process HTTP: `inject` requests, list the routes. */
  readonly http: KernelHttp;
  /** The port listened on; undefined before the start finished and after the stop. */
  readonly port: number | undefined;
  /** Stops the kernel (the stop phases within their budgets, then Redis and the pool); idempotent. */
  close(): Promise<void>;
}

/** Transitional (nest kernel Task 5.1): the facade, until every test directory is converted. */
type Facade = Awaited<ReturnType<typeof createKernel>>;

/** A kernel built but not started ({@link buildKernel}). */
export interface BuiltKernel extends TestKernel {
  /** Runs the start sequence and listens on `config.http.port`; a failure closes the kernel. */
  start(): Promise<void>;
}

/** What the kernel test helpers take: the application options; `env` / `logger` have defaults. */
export type TestKernelOptions = KernelAppOptions & {
  /** Only for a test about the real default: allow the official marketplace at its real URL. */
  allowOfficialMarketplace?: boolean;
};

function assertOffline(config: KernelConfig, allowOfficialMarketplace: boolean | undefined): void {
  const o = config.marketplaces.official;
  if (
    allowOfficialMarketplace !== true &&
    o.enabled &&
    o.url === MARKETPLACE_OFFICIAL_URL_DEFAULT
  ) {
    throw new Error(
      "test kernel config would fetch the real official marketplace: set " +
        "marketplaces.official.enabled to false or point marketplaces.official.url at a fake " +
        "(runConfig does the first)",
    );
  }
}

/**
 * Builds a kernel without starting it (logs discarded unless `logger` is given): for tests that
 * reach the application before its start sequence, or that expect the start to fail.
 */
export async function buildKernel(
  config: KernelConfig,
  opts: TestKernelOptions = {},
): Promise<Facade & BuiltKernel> {
  const { allowOfficialMarketplace, ...appOpts } = opts;
  assertOffline(config, allowOfficialMarketplace);
  const k = await createKernel(config, { env: {}, logger: silent(), ...appOpts });
  return Object.assign(k as Facade & { app: KernelApp }, { close: () => k.stop() });
}

/** Creates and starts a kernel (logs discarded unless `logger` is given). */
export async function startKernel(
  config: KernelConfig,
  opts: TestKernelOptions = {},
): Promise<Facade & TestKernel> {
  const k = await buildKernel(config, opts);
  await k.start();
  return k;
}

export type Req = ReturnType<typeof asUser>;

export async function session(k: Pick<TestKernel, "http">, login: string): Promise<Req> {
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
export async function eventsOf(db: KernelSchemaDb, convId: string): Promise<ConversationEvent[]> {
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
  db: KernelSchemaDb,
  convId: string,
  pred: (e: ConversationEvent) => boolean,
  timeoutMs = 10_000,
  label = "event",
): Promise<ConversationEvent> {
  return waitFor(async () => (await eventsOf(db, convId)).find(pred), timeoutMs, label);
}

/** 等到会话的第 n 个终态事件（run_finished / run_failed / run_aborted）出现。 */
export function waitForTerminal(
  db: KernelSchemaDb,
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

export async function consumedSeq(db: KernelSchemaDb, convId: string): Promise<number> {
  const r = await db
    .selectFrom("conversations")
    .select("consumed_seq")
    .where("id", "=", convId)
    .executeTakeFirstOrThrow();
  return Number(r.consumed_seq);
}

export async function runsOf(
  db: KernelSchemaDb,
  convId: string,
): Promise<{ id: string; status: string }[]> {
  return db
    .selectFrom("runs")
    .select(["id", "status"])
    .where("conversation_id", "=", convId)
    .orderBy("created_at")
    .execute();
}

/**
 * Wait until the BullMQ job that ran `runId` has finished (run jobs use `removeOnComplete` /
 * `removeOnFail`, so finished = gone). The job id is `runs.job_id` for resumed runs, else derived from
 * the trigger message. Use it after a run reads `waiting`: `WaitsService.suspend()` sets `waiting`
 * first, then schedules the timeout and re-checks whether the wait is already settled (resuming if
 * so), all inside the job. Only once the job is gone is the run idle in `waiting`.
 */
export async function waitForRunJobDone(
  db: KernelSchemaDb,
  queue: { getJob(id: string): Promise<unknown> },
  runId: string,
  timeoutMs = 10_000,
): Promise<void> {
  const run = await db
    .selectFrom("runs")
    .select(["conversation_id", "trigger_seq", "job_id"])
    .where("id", "=", runId)
    .executeTakeFirstOrThrow();
  const jobId = run.job_id ?? runJobId(run.conversation_id, Number(run.trigger_seq));
  await waitFor(
    async () => (await queue.getJob(jobId)) == null,
    timeoutMs,
    `run job ${jobId} done`,
  );
}

/** A gate that can be opened from outside. */
export function gate(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((r) => {
    open = r;
  });
  return { promise, open };
}
