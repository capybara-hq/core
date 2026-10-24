import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createDualReplicaHarness,
  type Harness,
  replicaOf,
  startTestPostgres,
  startTestRedis,
  startTestS3,
  type TestContainer,
  type TestS3,
} from "@capybara-hq/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AgentDefinition } from "../../src/agents/definition.js";
import type { ConversationEvent } from "../../src/conversations/events.js";
import { type KernelDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { AccountsService } from "../../src/identity/accounts.js";
import { buildModelRequest } from "../../src/runtime/context/build.js";
import { SANDBOX_STARTED_NOTICE } from "../../src/tools/builtins/sandbox/common.js";
import { testMembers } from "../helpers/members.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import { eventsOf, PW, waitFor, waitForTerminal } from "../helpers/runs.js";
import { MODEL } from "../runtime/context/fixtures.js";

/**
 * M5 第三段验收（双副本）：两个独立进程的内核副本（api / worker）共享 PG / Redis，加载 model-fake、
 * object-store-s3（SeaweedFS）与测试用假沙箱插件（两个副本共用一个 root 目录，相当于共用一个提供方），
 * 全部经 HTTP 操作，请求在两个副本之间交替：
 *
 * 1. 共享 agent 的 `skill_write`：R3 固定确认（发起人批准）→ 生成变更申请；发起对话可试用草稿，另一对话看不到；
 *    负责人在副本 B 上批准 → 另一对话（副本 A）下一次运行开始时追加目录快照（「新技能」提醒），`skill_load` 拿到内容；
 * 2. 第二版同样走一遍：批准前另一对话仍是 v1，批准后它在下一次运行开始时看到「Updated skills」提醒并加载到 v2；
 * 3. 带脚本的技能：`skill_load` 把文件复制进沙箱 `/skills/<name>/`，`sandbox_bash` 用 `sh` 执行脚本。
 */

const S3_PLUGIN = fileURLToPath(
  new URL("../../../../plugins/object-store-s3/src/index.ts", import.meta.url),
);
const SANDBOX_FAKE = fileURLToPath(
  new URL("../fixtures/plugins/sandbox-fake/index.ts", import.meta.url),
);

type Json = Record<string, unknown>;
type Res = { status: number; json: Json };
type User = "owner" | "member" | "other";
type ToolResult = Extract<ConversationEvent, { type: "tool_result" }>["payload"];
type CatalogEvent = Extract<ConversationEvent, { type: "skills_catalog" }>;
type ModelCallEvent = Extract<ConversationEvent, { type: "model_call" }>;

const ofType = <T extends ConversationEvent["type"]>(evs: ConversationEvent[], type: T) =>
  evs.filter((e): e is Extract<ConversationEvent, { type: T }> => e.type === type);

const skillInput = (version: string) => ({
  name: "fruit-sum",
  description: "Use to sum fruit quantities.",
  files: [
    { path: "SKILL.md", content: `# Fruit sum ${version}\nRun \`sh /skills/fruit-sum/run.sh\`.` },
    { path: "run.sh", content: `echo "fruit-sum ${version} ok"\n` },
  ],
});

describe("M5 第三段双副本验收（技能变更审批 + 技能脚本进沙箱）", () => {
  let pgc: TestContainer;
  let rdc: TestContainer;
  let s3: TestS3;
  let h: Harness;
  let raw: ReturnType<typeof createDb>;
  let db: KernelDb;
  let root: string;
  let base = "";
  const jars: Record<User, Map<string, string>> = {
    owner: new Map(),
    member: new Map(),
    other: new Map(),
  };

  /** 以某个用户身份打到指定副本（带该用户的 cookie）。 */
  async function at(u: User, i: 0 | 1, method: string, path: string, body?: unknown) {
    const jar = jars[u];
    const res = await fetch(`http://127.0.0.1:${h.replicas[i].port}${path}`, {
      method,
      redirect: "manual",
      headers: {
        "x-capybara-csrf": "1",
        cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; "),
        ...(body !== undefined && { "content-type": "application/json" }),
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
    expect(replicaOf(res)).toBe(i);
    for (const c of res.headers.getSetCookie()) {
      const [pair = ""] = c.split(";");
      const eq = pair.indexOf("=");
      jar.set(pair.slice(0, eq), pair.slice(eq + 1));
    }
    const text = await res.text();
    return { status: res.status, json: (text === "" ? {} : JSON.parse(text)) as Json } as Res;
  }

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "cap-m5-seg3-"));
    [pgc, rdc, s3] = await Promise.all([startTestPostgres(), startTestRedis(), startTestS3()]);
    h = await createDualReplicaHarness({
      extensions: [MODEL_FAKE, S3_PLUGIN, SANDBOX_FAKE],
      pgUrl: pgc.url,
      redisUrl: rdc.url,
      extensionConfig: {
        "object-store-s3": {
          endpoint: s3.endpoint,
          region: s3.region,
          bucket: s3.bucket,
          accessKeyId: s3.accessKey,
          secretAccessKey: s3.secretKey,
          forcePathStyle: true,
        },
        "sandbox-fake": { root },
      },
      config: { auth: { cookieSecure: false } },
    });
    raw = createDb(h.dbUrl, 3);
    db = kernelDb(raw);

    const accounts = new AccountsService(db);
    const ownerId = (await accounts.createLocal({ login: "owner", password: PW, displayName: "O" }))
      .id;
    const memberId = (await accounts.createLocal({ login: "mem", password: PW, displayName: "M" }))
      .id;
    const otherId = (await accounts.createLocal({ login: "oth", password: PW, displayName: "X" }))
      .id;
    for (const [u, login, i] of [
      ["owner", "owner", 0],
      ["member", "mem", 1],
      ["other", "oth", 0],
    ] as const) {
      const r = await at(u, i, "POST", "/api/v1/auth/login", { login, password: PW });
      expect(r.status, JSON.stringify(r.json)).toBe(200);
    }
    const org = await at("owner", 1, "POST", "/api/v1/orgs", { name: "Acme" });
    expect(org.status, JSON.stringify(org.json)).toBe(201);
    const orgId = (org.json.org as { id: string }).id;
    base = `/api/v1/orgs/${orgId}`;
    await testMembers(db).add(orgId, memberId, "member", ownerId);
    await testMembers(db).add(orgId, otherId, "member", ownerId);
  }, 300_000);

  afterAll(async () => {
    await h?.stop();
    await raw?.destroy();
    await Promise.all([pgc?.stop(), rdc?.stop(), s3?.stop()]);
    if (root) await rm(root, { recursive: true, force: true });
  }, 120_000);

  const terminal = async (convId: string, n: number) => {
    const term = await waitForTerminal(db, convId, n, 60_000);
    const last = term[n - 1] as ConversationEvent;
    expect(last.type, JSON.stringify(last.payload)).toBe("run_finished");
    const evs = (await eventsOf(db, convId)).filter((e) => e.runId === last.runId);
    return { runId: last.runId as string, evs, result: ofType(evs, "tool_result").at(-1)?.payload };
  };

  async function send(u: User, i: 0 | 1, convId: string, key: string, input: unknown) {
    const r = await at(u, i, "POST", `${base}/conversations/${convId}/messages`, {
      text: `tool:${key}:${JSON.stringify(input)}`,
    });
    expect(r.status, JSON.stringify(r.json)).toBe(202);
  }

  /** 发一条脚本消息并等第 n 个终态，返回这次运行的最后一个工具结果。 */
  async function call(u: User, i: 0 | 1, convId: string, key: string, input: unknown, n: number) {
    await send(u, i, convId, key, input);
    const t = await terminal(convId, n);
    expect(t.result?.toolKey).toBe(key);
    return { ...t, result: t.result as ToolResult };
  }

  /** 共享 agent 上的 skill_write：R3 固定确认 → 发起人在另一个副本上批准 → 等运行结束。 */
  async function sharedWrite(i: 0 | 1, convId: string, input: unknown, n: number) {
    await send("member", i, convId, "skill_write", input);
    const a = await waitFor(
      () =>
        db
          .selectFrom("approvals")
          .select(["id", "tool_key"])
          .where("conversation_id", "=", convId)
          .where("status", "=", "pending")
          .executeTakeFirst(),
      30_000,
      "skill_write approval",
    );
    expect(a.tool_key).toBe("skill_write");
    // 确认之前没有变更申请
    expect(await pendingChanges()).toHaveLength(0);
    const other: 0 | 1 = i === 0 ? 1 : 0;
    const d = await at("member", other, "POST", `${base}/approvals/${a.id}/decision`, {
      decision: "approve",
    });
    expect(d.status, JSON.stringify(d.json)).toBe(200);
    const t = await terminal(convId, n);
    expect(t.result?.toolKey).toBe("skill_write");
    return t.result as ToolResult;
  }

  const pendingChanges = () =>
    db.selectFrom("skill_change_requests").selectAll().where("status", "=", "pending").execute();

  const catalogs = async (convId: string) =>
    ofType(await eventsOf(db, convId), "skills_catalog") as CatalogEvent[];

  /** 由日志还原某次运行第一次模型请求的消息（Ruling M17：目录变化以提醒的形式出现在消息里）。 */
  async function firstRequestText(convId: string, runId: string, def: AgentDefinition) {
    const events = await eventsOf(db, convId);
    const c = ofType(events, "model_call").find((e) => e.runId === runId) as ModelCallEvent;
    expect(c).toBeDefined();
    const rebuilt = buildModelRequest({
      events: events.filter((e) => e.seq <= c.payload.request.toSeq),
      agent: def,
      agentVersion: 1,
      model: MODEL,
      step: c.payload.step,
    });
    expect(rebuilt.meta.systemHash).toBe(c.payload.request.systemHash);
    return JSON.stringify(rebuilt.request.messages);
  }

  it("共享 agent 写技能 → 负责人跨副本批准 → 另一对话下次运行生效；技能脚本复制进沙箱并执行", async () => {
    const ag = await at("owner", 0, "POST", `${base}/agents`, {
      definition: {
        name: "Fruit",
        instructions: "Use skills.",
        model: { provider: "model-fake", model: "fake-1" },
        tools: [
          { kind: "builtin", name: "skill_write" },
          { kind: "builtin", name: "sandbox_bash" },
        ],
      },
      visibility: "org",
    });
    expect(ag.status, JSON.stringify(ag.json)).toBe(201);
    const agentId = (ag.json.agent as { id: string }).id;
    const def = (
      await db
        .selectFrom("agent_versions")
        .select("definition")
        .where("agent_id", "=", agentId)
        .executeTakeFirstOrThrow()
    ).definition as unknown as AgentDefinition;
    const newConv = async (u: User, i: 0 | 1) => {
      const c = await at(u, i, "POST", `${base}/conversations`, { agentId });
      expect(c.status, JSON.stringify(c.json)).toBe(201);
      return (c.json.conversation as { id: string }).id;
    };
    const convM = await newConv("member", 0);
    const convX = await newConv("other", 1);

    // ---- 1. 新技能：R3 确认 → 变更申请 → 只在发起对话里试用 ----
    const w1 = await sharedWrite(0, convM, skillInput("v1"), 1);
    expect(w1.isError, w1.content).toBe(false);
    expect(w1.content).toMatch(/owner/i);
    const [req1] = await pendingChanges();
    expect(req1).toMatchObject({
      agent_id: agentId,
      skill_id: null,
      requested_in_conversation: convM,
    });
    expect(await db.selectFrom("skills").select("id").execute()).toHaveLength(0);

    const mine1 = await call("member", 1, convM, "skill_load", { name: "fruit-sum" }, 2);
    expect(mine1.result.isError, mine1.result.content).toBe(false);
    expect(mine1.result.content).toContain("Fruit sum v1");
    const theirs1 = await call("other", 0, convX, "skill_load", { name: "fruit-sum" }, 1);
    expect(theirs1.result.isError).toBe(true);
    expect(theirs1.result.content).not.toContain("Fruit sum v1");
    expect(await catalogs(convX)).toHaveLength(0);

    // 负责人在副本 B 上批准（收件箱里能看到）
    const inbox = await at("owner", 1, "GET", `${base}/inbox`);
    expect(inbox.status).toBe(200);
    expect((inbox.json.items as { type: string; id: string }[]).map((x) => [x.type, x.id])).toEqual(
      [["skill_change", req1?.id]],
    );
    const ok1 = await at("owner", 1, "POST", `${base}/skill-changes/${req1?.id}/decide`, {
      decision: "approve",
    });
    expect(ok1.status, JSON.stringify(ok1.json)).toBe(200);

    // 另一对话（副本 A）的下一次运行开始时追加快照，「新技能」提醒进消息，加载成功
    const x2 = await call("other", 0, convX, "skill_load", { name: "fruit-sum" }, 2);
    expect(x2.result.isError, x2.result.content).toBe(false);
    expect(x2.result.content).toContain("Fruit sum v1");
    expect(x2.result.content).toContain("version 1");
    // agent 有沙箱工具：skill_load 把脚本复制进沙箱，这是本对话首次使用沙箱
    expect(x2.result.content).toContain(SANDBOX_STARTED_NOTICE);
    const snapX2 = ofType(x2.evs, "skills_catalog");
    expect(snapX2).toHaveLength(1);
    expect(snapX2[0]?.payload.skills).toMatchObject([{ name: "fruit-sum", version: 1 }]);
    expect(await firstRequestText(convX, x2.runId, def)).toContain("New skills");

    // ---- 2. 第二版：批准前另一对话仍是 v1；批准后下一次运行看到「Updated skills」并加载到 v2 ----
    const w2 = await sharedWrite(1, convM, skillInput("v2"), 3);
    expect(w2.isError, w2.content).toBe(false);
    const [req2] = await pendingChanges();
    expect(req2?.skill_id).not.toBeNull();
    const mine2 = await call("member", 0, convM, "skill_load", { name: "fruit-sum" }, 4);
    expect(mine2.result.content).toContain("Fruit sum v2");
    const x3 = await call("other", 1, convX, "skill_load", { name: "fruit-sum" }, 3);
    expect(x3.result.content).toContain("Fruit sum v1");
    expect(x3.result.content).not.toContain("Fruit sum v2");
    expect(ofType(x3.evs, "skills_catalog")).toHaveLength(0);

    const ok2 = await at("owner", 1, "POST", `${base}/skill-changes/${req2?.id}/decide`, {
      decision: "approve",
    });
    expect(ok2.status, JSON.stringify(ok2.json)).toBe(200);
    const x4 = await call("other", 0, convX, "skill_load", { name: "fruit-sum" }, 4);
    expect(x4.result.isError, x4.result.content).toBe(false);
    expect(x4.result.content).toContain("Fruit sum v2");
    expect(x4.result.content).toContain("version 2");
    const snapX4 = ofType(x4.evs, "skills_catalog");
    expect(snapX4).toHaveLength(1);
    expect(snapX4[0]?.payload.skills).toMatchObject([{ name: "fruit-sum", version: 2 }]);
    // 快照在这次运行的第一次模型请求之前
    const firstCall = ofType(x4.evs, "model_call")[0] as ModelCallEvent;
    expect((snapX4[0] as CatalogEvent).seq).toBeLessThan(firstCall.seq);
    expect(await firstRequestText(convX, x4.runId, def)).toContain("Updated skills");

    // ---- 3. 脚本进沙箱：skill_load 复制到 /skills/fruit-sum/，sandbox_bash 用 sh 执行 ----
    // 上一步 skill_load 已把 v2 复制进同一个沙箱（覆盖 v1 的文件，沙箱不重建）
    expect(x4.result.content).not.toContain(SANDBOX_STARTED_NOTICE);
    const box = await db
      .selectFrom("sandboxes")
      .select("handle")
      .where("conversation_id", "=", convX)
      .executeTakeFirstOrThrow();
    const onDisk = await readFile(
      join(root, "instances", (box.handle as { id: string }).id, "fs", "skills/fruit-sum/run.sh"),
      "utf8",
    );
    expect(onDisk).toContain("fruit-sum v2 ok");
    const run = await call(
      "other",
      1,
      convX,
      "sandbox_bash",
      { command: "sh /skills/fruit-sum/run.sh" },
      5,
    );
    expect(run.result.isError, run.result.content).toBe(false);
    expect(run.result.content).toContain("fruit-sum v2 ok");

    // 没有遗留的活动运行，也没有待处理的申请
    const active = await db
      .selectFrom("runs")
      .select("id")
      .where("status", "in", ["queued", "running", "waiting"])
      .execute();
    expect(active).toEqual([]);
    expect(await pendingChanges()).toEqual([]);
  }, 300_000);
});
