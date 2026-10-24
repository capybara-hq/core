import { fileURLToPath } from "node:url";
import { Redis } from "ioredis";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createDualReplicaHarness, type Harness, replicaOf } from "../src/dual-replica.js";
import { startTestPostgres, startTestRedis, type TestContainer } from "../src/index.js";

/**
 * M2 验收：两个独立进程的内核副本（角色都含 api / worker）共享 PG / Redis，加载 `model-fake`。
 * 初始化 → 建组织 → 建 agent → 跨副本 SSE 对话 → SIGKILL 正在执行运行的副本 → 存活副本续跑 →
 * 继续对话（会话锁与配额没有泄漏）→ 按 `model_call` 事件核对模型调用次数。
 */

const MODEL_FAKE = fileURLToPath(
  new URL("../../../plugins/model-fake/src/index.ts", import.meta.url),
);

let pgc: TestContainer;
let rdc: TestContainer;
let h: Harness | undefined;
const cleanups: (() => Promise<void> | void)[] = [];

beforeAll(async () => {
  [pgc, rdc] = await Promise.all([startTestPostgres(), startTestRedis()]);
});

afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
  await h?.stop();
  h = undefined;
});

afterAll(async () => {
  await Promise.all([pgc?.stop(), rdc?.stop()]);
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(cond: () => boolean | Promise<boolean>, ms: number, what: string) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await cond()) return;
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** 简单 Cookie 罐：只记 name=value；空值或 `Max-Age=0` 视为删除。 */
class Jar {
  readonly cookies = new Map<string, string>();

  store(res: Response): void {
    for (const raw of res.headers.getSetCookie()) {
      const [pair = "", ...attrs] = raw.split(";");
      const eq = pair.indexOf("=");
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      const removed = value === "" || attrs.some((a) => a.trim().toLowerCase() === "max-age=0");
      if (removed) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }

  header(): string {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  }
}

interface Ev {
  seq: number;
  type: string;
  runId: string | null;
  payload: Record<string, unknown>;
}

interface Delta {
  runId: string;
  step: number;
  delta: string;
  text?: string;
}

type Json = Record<string, unknown>;

const jsonInit = (jar: Jar, method: string, body?: unknown): RequestInit => ({
  method,
  headers: {
    "x-capybara-csrf": "1",
    cookie: jar.header(),
    ...(body !== undefined && { "content-type": "application/json" }),
  },
  ...(body !== undefined && { body: JSON.stringify(body) }),
});

/** 经 harness 交替入口发 JSON 请求，返回状态、JSON 与处理该请求的副本。 */
async function viaHarness(
  jar: Jar,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: Json; replica: number }> {
  const res = await (h as Harness).request(path, jsonInit(jar, method, body));
  jar.store(res);
  const text = await res.text();
  return { status: res.status, json: text === "" ? {} : JSON.parse(text), replica: res.replica };
}

/** 指定副本发 JSON 请求（不经交替入口）；校验响应头里的副本标识与目标一致。 */
async function at(
  index: 0 | 1,
  jar: Jar,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: Json }> {
  const port = (h as Harness).replicas[index].port;
  const res = await fetch(`http://127.0.0.1:${port}${path}`, jsonInit(jar, method, body));
  expect(replicaOf(res)).toBe(index);
  jar.store(res);
  const text = await res.text();
  return { status: res.status, json: text === "" ? {} : JSON.parse(text) };
}

/**
 * 最小 SSE 客户端：解析 `id` / `event` / `data` 帧，事件与增量追加到共享数组（重连后继续累积），
 * 连接断开时记下 `dropped`。
 */
class SseClient {
  readonly events: Ev[] = [];
  readonly deltas: Delta[] = [];
  readonly errors: string[] = [];
  lastId: string | undefined;
  replica: number | undefined;
  dropped = false;
  private ctrl: AbortController | undefined;

  async connect(port: number, path: string, jar: Jar): Promise<void> {
    this.ctrl = new AbortController();
    this.dropped = false;
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      headers: {
        cookie: jar.header(),
        accept: "text/event-stream",
        ...(this.lastId !== undefined && { "last-event-id": this.lastId }),
      },
      signal: this.ctrl.signal,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^text\/event-stream/);
    this.replica = replicaOf(res);
    const body = res.body;
    if (!body) throw new Error("no SSE body");
    void this.pump(body);
  }

  private async pump(body: ReadableStream<Uint8Array>): Promise<void> {
    const decoder = new TextDecoder();
    const reader = body.getReader();
    let buf = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        for (let i = buf.indexOf("\n\n"); i >= 0; i = buf.indexOf("\n\n")) {
          this.frame(buf.slice(0, i));
          buf = buf.slice(i + 2);
        }
      }
    } catch {
      // 副本被杀 / 主动关闭
    }
    this.dropped = true;
  }

  private frame(raw: string): void {
    let id: string | undefined;
    let event = "message";
    const data: string[] = [];
    for (const line of raw.split("\n")) {
      if (line.startsWith(":")) continue;
      const c = line.indexOf(":");
      const field = c < 0 ? line : line.slice(0, c);
      const value = c < 0 ? "" : line.slice(c + 1).replace(/^ /, "");
      if (field === "id") id = value;
      else if (field === "event") event = value;
      else if (field === "data") data.push(value);
    }
    if (data.length === 0) return;
    const parsed = JSON.parse(data.join("\n"));
    if (event === "event") {
      this.events.push(parsed as Ev);
      if (id !== undefined) this.lastId = id;
    } else if (event === "delta") this.deltas.push(parsed as Delta);
    else if (event === "error") this.errors.push(JSON.stringify(parsed));
  }

  close(): void {
    this.ctrl?.abort();
  }

  count(type: string): number {
    return this.events.filter((e) => e.type === type).length;
  }
}

const textOf = (e: Ev | undefined): string =>
  ((e?.payload.content ?? []) as { type: string; text?: string }[])
    .flatMap((b) => (b.type === "text" ? [b.text ?? ""] : []))
    .join("");

describe("M2 双副本端到端验收", () => {
  it("SSE 对话 → 杀掉正在执行运行的副本 → 存活副本续跑 → 继续对话", async () => {
    const redis = new Redis(rdc.url);
    cleanups.push(() => redis.disconnect());
    await redis.flushdb();
    h = await createDualReplicaHarness({
      plugins: [MODEL_FAKE],
      pgUrl: pgc.url,
      redisUrl: rdc.url,
      config: {
        auth: { cookieSecure: false },
        // 短锁期与 stalled 检测间隔：被杀副本持有的任务约 1.5 秒后由存活副本接手
        runtime: { jobLockMs: 1000, stalledIntervalMs: 500 },
      },
    });
    const db = new pg.Client({ connectionString: h.dbUrl });
    await db.connect();
    cleanups.push(() => db.end());
    const admin = new Jar();

    // 1. 初始化向导 → 建组织 → 建 agent（经交替入口；响应带副本标识）
    const s0 = await viaHarness(admin, "GET", "/api/v1/setup");
    expect(s0).toMatchObject({ status: 200, json: { needsSetup: true }, replica: 0 });
    const s1 = await viaHarness(admin, "POST", "/api/v1/setup", {
      login: "root",
      password: "correct horse battery staple",
      displayName: "Root",
      orgName: "Research",
    });
    expect(s1.status).toBe(201);
    expect(s1.replica).toBe(1);
    const org = await viaHarness(admin, "POST", "/api/v1/orgs", { name: "Acme" });
    expect(org.status).toBe(201);
    const orgId = (org.json.org as { id: string }).id;
    const ag = await viaHarness(admin, "POST", `/api/v1/orgs/${orgId}/agents`, {
      definition: {
        name: "Helper",
        instructions: "Be helpful.",
        model: { provider: "model-fake", model: "fake-1" },
      },
      visibility: "org",
    });
    expect(ag.status).toBe(201);
    const agentId = (ag.json.agent as { id: string }).id;
    const conv = await viaHarness(admin, "POST", `/api/v1/orgs/${orgId}/conversations`, {
      agentId,
    });
    expect(conv.status).toBe(201);
    const convId = (conv.json.conversation as { id: string }).id;
    const base = `/api/v1/orgs/${orgId}/conversations/${convId}`;

    // 2. 两个副本上各开一路 SSE（无论杀哪个副本，总有一路要按 Last-Event-ID 重连、一路不中断），
    //    在副本 1 上发消息：SSE 收到完整回复与 run_finished
    const streams = [new SseClient(), new SseClient()] as const;
    for (const c of streams) cleanups.push(() => c.close());
    await streams[0].connect(h.replicas[0].port, `${base}/stream?after=0`, admin);
    await streams[1].connect(h.replicas[1].port, `${base}/stream?after=0`, admin);
    expect(streams.map((c) => c.replica)).toEqual([0, 1]);
    const sse = streams[0];
    const m1 = await at(1, admin, "POST", `${base}/messages`, {
      text: "echo:first",
      clientMessageId: "m1",
    });
    expect(m1.status).toBe(202);
    await waitFor(
      () => streams.every((c) => c.count("run_finished") === 1),
      30_000,
      "first run_finished",
    );
    for (const c of streams) {
      expect(textOf(c.events.find((e) => e.type === "assistant_message"))).toBe("first");
    }

    // 3. 发一条慢速长回复；流到一半（assistant_message 出现之前）杀掉正在执行运行的副本
    const reply = "The quick brown fox jumps over the lazy dog. 0123456789 abcdefghij";
    const m2 = await at(1, admin, "POST", `${base}/messages`, {
      text: `slow:300:${reply}`,
      clientMessageId: "m2",
    });
    expect(m2.status).toBe(202);
    const seq2 = (m2.json.event as { seq: number }).seq;
    await waitFor(
      () => sse.count("run_started") === 2 && sse.deltas.some((d) => d.delta === "text"),
      30_000,
      "second run streaming",
    );
    const run2 = sse.events.filter((e) => e.type === "run_started")[1]?.runId as string;
    await waitFor(
      () => sse.deltas.filter((d) => d.runId === run2 && d.delta === "text").length >= 2,
      30_000,
      "text deltas of the slow run",
    );
    expect(sse.events.some((e) => e.type === "assistant_message" && e.runId === run2)).toBe(false);
    // 正在执行的副本：runs 行给出投递点 → BullMQ 任务记录的领取 worker（名字以 `-<pid>` 结尾）
    const running = await db.query<{ id: string; trigger_seq: string }>(
      "SELECT id, trigger_seq FROM capybara.runs WHERE conversation_id = $1 AND status = 'running'",
      [convId],
    );
    expect(running.rows.map((r) => r.id)).toEqual([run2]);
    expect(Number(running.rows[0]?.trigger_seq)).toBe(seq2);
    const processedBy = await redis.hget(`bull:cap-kernel-runs:run-${convId}-${seq2}`, "pb");
    const victim = h.replicas.find((r) => processedBy?.endsWith(`-${r.pid}`));
    expect(victim, `processedBy=${processedBy}`).toBeDefined();
    const victimIndex = (victim as { index: 0 | 1 }).index;
    const survivor: 0 | 1 = victimIndex === 0 ? 1 : 0;
    await h.kill(victimIndex);

    // 4. 连在被杀副本上的那一路 SSE 断开，按 Last-Event-ID 重连到存活副本；另一路不受影响
    const cut = streams[victimIndex];
    await waitFor(() => cut.dropped, 10_000, "SSE drop after kill");
    expect(streams[survivor].dropped).toBe(false);
    expect(cut.lastId).toBeDefined();
    await cut.connect(h.replicas[survivor].port, `${base}/stream`, admin);
    expect(cut.replica).toBe(survivor);
    await waitFor(
      () => streams.every((c) => c.count("run_finished") === 2),
      60_000,
      "resumed run_finished",
    );
    for (const c of streams) {
      // 存活副本续跑前先发 step_reset，之后重新流出完整回复
      const resetAt = c.deltas.findIndex((d) => d.runId === run2 && d.delta === "step_reset");
      expect(resetAt).toBeGreaterThanOrEqual(0);
      const after = c.deltas
        .slice(resetAt + 1)
        .filter((d) => d.runId === run2 && d.delta === "text");
      expect(after.map((d) => d.text ?? "").join("")).toBe(reply);
      // 重连回放不重复、不乱序：seq 严格递增
      const seqs = c.events.map((e) => e.seq);
      expect(seqs.every((v, i) => i === 0 || v > (seqs[i - 1] as number))).toBe(true);
    }

    const log1 = await at(survivor, admin, "GET", `${base}/events?after=0`);
    expect(log1.status).toBe(200);
    const evs1 = log1.json.events as Ev[];
    const run2Msgs = evs1.filter((e) => e.type === "assistant_message" && e.runId === run2);
    // 同一 (run, step) 恰好一条 assistant_message，内容是完整回复
    expect(run2Msgs.map((e) => e.payload.step)).toEqual([1]);
    expect(textOf(run2Msgs[0])).toBe(reply);
    expect(
      evs1
        .filter((e) => e.runId === run2 && e.type === "run_finished")
        .map((e) => e.payload.reason),
    ).toEqual(["completed"]);
    expect(evs1.filter((e) => e.runId === run2 && e.type === "run_started")).toHaveLength(1);

    // 5. 存活副本上继续对话：会话锁与组织配额没有泄漏
    const m3 = await at(survivor, admin, "POST", `${base}/messages`, {
      text: "echo:after-crash",
      clientMessageId: "m3",
    });
    expect(m3.status).toBe(202);
    await waitFor(
      () => streams.every((c) => c.count("run_finished") === 3),
      30_000,
      "third run_finished",
    );
    for (const c of streams) {
      const last = c.events.filter((e) => e.type === "assistant_message").at(-1);
      expect(textOf(last)).toBe("after-crash");
      expect(c.errors).toEqual([]);
    }
    // 两路 SSE 最终看到的事件序列与事件日志一致

    // 6. 模型调用次数（model_call 事件）：被杀的那一步最多两次，其余每步一次
    const log2 = await at(survivor, admin, "GET", `${base}/events?after=0`);
    const evs2 = log2.json.events as Ev[];
    for (const c of streams) expect(c.events.map((e) => e.seq)).toEqual(evs2.map((e) => e.seq));
    const calls = new Map<string, number>();
    for (const e of evs2) {
      if (e.type !== "model_call") continue;
      const k = `${e.runId}#${e.payload.step}`;
      calls.set(k, (calls.get(k) ?? 0) + 1);
    }
    const killedStep = `${run2}#1`;
    expect(calls.get(killedStep)).toBeGreaterThanOrEqual(1);
    expect(calls.get(killedStep)).toBeLessThanOrEqual(2);
    const runIds = evs2.filter((e) => e.type === "run_started").map((e) => e.runId);
    expect(runIds).toHaveLength(3);
    for (const [k, n] of calls) if (k !== killedStep) expect(n, k).toBe(1);
    // 每个运行都恰好一个模型步骤（echo / slow 都是单步回复）
    expect([...calls.keys()].sort()).toEqual(runIds.map((r) => `${r}#1`).sort());
    // 运行全部结束，没有残留的活跃运行
    const active = await db.query(
      "SELECT id FROM capybara.runs WHERE conversation_id = $1 AND status IN ('queued', 'running')",
      [convId],
    );
    expect(active.rows).toEqual([]);
  }, 180_000);
});
