import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createDualReplicaHarness,
  fakeExtensionEntry,
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
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { buildModelRequest } from "../../src/runtime/context/build.js";
import { SANDBOX_STARTED_NOTICE } from "../../src/tools/builtins/sandbox/common.js";
import { onlyBuiltins } from "../helpers/disabled-tools.js";
import { accountsFor } from "../helpers/identity.js";
import { testMembers } from "../helpers/members.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import { eventsOf, PW, waitForTerminal } from "../helpers/runs.js";
import { MODEL } from "../runtime/context/fixtures.js";
import { makeZip } from "./zip.js";

/**
 * M5 第三段验收（双副本）：两个独立进程的内核副本（api / worker）共享 PG / Redis，加载 model-fake、
 * fake-object-store（SeaweedFS）与测试用假沙箱插件（两个副本共用一个 root 目录，相当于共用一个提供方），
 * 全部经 HTTP 操作，请求在两个副本之间交替：
 *
 * 1. The owner registers a skill package on a shared agent (upload, then register, on alternating
 *    replicas): the version is effective at once; another conversation (on the other replica) gets
 *    a first catalog snapshot at its next run start and `Skill` returns the content;
 * 2. A second version: the other conversation sees the "Updated skills" reminder at its next run
 *    start and loads v2;
 * 3. A skill with a script: `Skill` copies its files into the sandbox `/skills/<name>@<digest>/` and
 *    `Bash` runs the script with `sh`.
 */

const OBJECT_STORE = fakeExtensionEntry("fake-object-store");
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

const skillZip = (version: string) =>
  new Uint8Array(
    makeZip([
      {
        name: "SKILL.md",
        data: `---\nname: fruit-sum\ndescription: Use to sum fruit quantities.\n---\n# Fruit sum ${version}\nRun \`sh /skills/fruit-sum/run.sh\`.\n`,
      },
      { name: "run.sh", data: `echo "fruit-sum ${version} ok"\n` },
    ]),
  );

describe("M5 segment 3 dual-replica acceptance (agent skill registration + skill scripts in the sandbox)", () => {
  let pgc: TestContainer;
  let rdc: TestContainer;
  let s3: TestS3;
  let h: Harness;
  let raw: ReturnType<typeof createDb>;
  let db: KernelSchemaDb;
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
      extensions: [MODEL_FAKE, OBJECT_STORE, SANDBOX_FAKE],
      pgUrl: pgc.url,
      redisUrl: rdc.url,
      extensionConfig: {
        "fake-object-store": {
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

    const accounts = accountsFor(db);
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
  });

  afterAll(async () => {
    await h?.stop();
    await raw?.destroy();
    await Promise.all([pgc?.stop(), rdc?.stop(), s3?.stop()]);
    if (root) await rm(root, { recursive: true, force: true });
  });

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

  /** The owner registers a package on the agent through replica `i`: upload, put the bytes, register. */
  async function registerSkill(i: 0 | 1, agentId: string, zip: Uint8Array) {
    const up = await at("owner", i, "POST", `${base}/agents/${agentId}/skills/uploads`, {
      name: "skill.zip",
      size: zip.byteLength,
    });
    expect(up.status, JSON.stringify(up.json)).toBe(201);
    const u = up.json as {
      id: string;
      upload: {
        method: "PUT" | "POST";
        url: string;
        headers: Record<string, string>;
        fields?: Record<string, string>;
      };
    };
    let put: Response;
    if (u.upload.method === "PUT") {
      put = await fetch(u.upload.url, {
        method: "PUT",
        headers: u.upload.headers,
        body: Buffer.from(zip),
      });
    } else {
      const form = new FormData();
      for (const [key, v] of Object.entries(u.upload.fields ?? {})) form.append(key, v);
      form.append("file", new Blob([Buffer.from(zip)], { type: "application/zip" }));
      put = await fetch(u.upload.url, { method: "POST", headers: u.upload.headers, body: form });
    }
    expect(put.status).toBeLessThan(300);
    const reg = await at("owner", i, "POST", `${base}/agents/${agentId}/skills`, {
      uploadId: u.id,
    });
    expect(reg.status, JSON.stringify(reg.json)).toBe(200);
    return reg.json.skill as { kind: string; version: number };
  }

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

  it("the owner registers skill packages through the routes on alternating replicas, they take effect at once across replicas, and skill scripts are copied into the sandbox and run", async () => {
    const ag = await at("owner", 0, "POST", `${base}/agents`, {
      definition: {
        name: "Fruit",
        instructions: "Use skills.",
        model: { provider: "model-fake", model: "fake-1" },
        disabledTools: onlyBuiltins([{ kind: "builtin", name: "Bash" }]),
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
    const convX = await newConv("other", 1);

    // ---- 1. A new skill: registered by the owner, effective at once for every conversation ----
    expect(await registerSkill(0, agentId, skillZip("v1"))).toMatchObject({
      kind: "version",
      version: 1,
    });
    expect(await db.selectFrom("skills").select("id").execute()).toHaveLength(1);

    // The other conversation (replica A) gets its first catalog snapshot at its next run start and loads it
    const x2 = await call("other", 0, convX, "Skill", { skill: "fruit-sum" }, 1);
    expect(x2.result.isError, x2.result.content).toBe(false);
    expect(x2.result.content).toContain("Fruit sum v1");
    expect(x2.result.content).toContain("version 1");
    // the agent has sandbox tools: Skill copies the script into the sandbox, the first use here
    expect(x2.result.content).toContain(SANDBOX_STARTED_NOTICE);
    const snapX2 = ofType(x2.evs, "skills_catalog");
    expect(snapX2).toHaveLength(1);
    expect(snapX2[0]?.payload.skills).toMatchObject([{ name: "fruit-sum", version: 1 }]);

    // ---- 2. The second version: the other conversation sees "Updated skills" at its next run ----
    expect(await registerSkill(1, agentId, skillZip("v2"))).toMatchObject({
      kind: "version",
      version: 2,
    });
    const x4 = await call("other", 0, convX, "Skill", { skill: "fruit-sum" }, 2);
    expect(x4.result.isError, x4.result.content).toBe(false);
    expect(x4.result.content).toContain("Fruit sum v2");
    expect(x4.result.content).toContain("version 2");
    const snapX4 = ofType(x4.evs, "skills_catalog");
    expect(snapX4).toHaveLength(1);
    expect(snapX4[0]?.payload.skills).toMatchObject([{ name: "fruit-sum", version: 2 }]);
    // the snapshot is before the first model request of this run
    const firstCall = ofType(x4.evs, "model_call")[0] as ModelCallEvent;
    expect((snapX4[0] as CatalogEvent).seq).toBeLessThan(firstCall.seq);
    expect(await firstRequestText(convX, x4.runId, def)).toContain("Updated skills");

    // ---- 3. Script in the sandbox: Skill copies to /skills/fruit-sum@<digest>/, Bash runs it with sh ----
    // the earlier Skill call (v1) started the device; v2 is copied beside v1 (no new instance)
    expect(x4.result.content).not.toContain(SANDBOX_STARTED_NOTICE);
    const dir = /\/skills\/fruit-sum@[0-9a-f]{12}/.exec(x4.result.content)?.[0] as string;
    expect(dir, x4.result.content).toBeTruthy();
    const box = await db
      .selectFrom("device_instances")
      .innerJoin("conversations", "conversations.device_id", "device_instances.device_id")
      .select("device_instances.handle")
      .where("conversations.id", "=", convX)
      .executeTakeFirstOrThrow();
    const meta = JSON.parse(
      await readFile(
        join(root, "instances", (box.handle as { id: string }).id, "meta.json"),
        "utf8",
      ),
    ) as { fileSystem: string };
    const onDisk = await readFile(
      join(root, "filesystems", meta.fileSystem, dir.slice(1), "run.sh"),
      "utf8",
    );
    expect(onDisk).toContain("fruit-sum v2 ok");
    const run = await call(
      "other",
      1,
      convX,
      "Bash",
      { description: "Test step", command: `sh ${dir}/run.sh` },
      3,
    );
    expect(run.result.isError, run.result.content).toBe(false);
    expect(run.result.content).toContain("fruit-sum v2 ok");

    // no run left active
    const active = await db
      .selectFrom("runs")
      .select("id")
      .where("status", "in", ["queued", "running", "waiting"])
      .execute();
    expect(active).toEqual([]);
  });
});
