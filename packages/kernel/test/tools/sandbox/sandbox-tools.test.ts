import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  startTestPostgres,
  startTestRedis,
  startTestS3,
  type TestContainer,
  type TestS3,
} from "@capybara-hq/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ConversationEvent } from "../../../src/conversations/events.js";
import { type KernelDb, kernelDb } from "../../../src/db/kernel-schema.js";
import { createDb } from "../../../src/db/pool.js";
import { AccountsService } from "../../../src/identity/accounts.js";
import type { Kernel } from "../../../src/kernel.js";
import { removeFakeSandbox } from "../../fixtures/plugins/sandbox-fake/index.js";
import { truncateTables } from "../../helpers/db.js";
import { testMembers } from "../../helpers/members.js";
import { MODEL_FAKE } from "../../helpers/model-plugins.js";
import {
  createConv,
  createOrg,
  eventsOf,
  PW,
  postMessage,
  type Req,
  runConfig,
  session,
  startKernel,
  waitForEvent,
  waitForTerminal,
} from "../../helpers/runs.js";

/**
 * M5 T8：沙箱内置工具与产物交付（审查重点 4：命令跑不完或输出巨大时中止 / 存档，沙箱仍可用）。
 * 真实内核 + model-fake（`tool:<key>:<json>` 指令让模型调用工具）+ 假沙箱插件（真的 /bin/sh）+ SeaweedFS。
 */

const S3_PLUGIN = fileURLToPath(
  new URL("../../../../../plugins/object-store-s3/src/index.ts", import.meta.url),
);
const SANDBOX_FAKE = fileURLToPath(
  new URL("../../fixtures/plugins/sandbox-fake/index.ts", import.meta.url),
);

const SANDBOX_TOOLS = [
  "sandbox_bash",
  "sandbox_read",
  "sandbox_write",
  "sandbox_edit",
  "sandbox_glob",
  "sandbox_grep",
  "sandbox_deliver",
];

let pgc: TestContainer;
let rd: TestContainer;
let s3: TestS3;
let db: KernelDb;
let destroyDb: () => Promise<void>;
let k: Kernel;
let root: string;

beforeAll(async () => {
  [pgc, rd, s3] = await Promise.all([startTestPostgres(), startTestRedis(), startTestS3()]);
  const raw = createDb(pgc.url, 3);
  db = kernelDb(raw);
  destroyDb = () => raw.destroy();
  root = await mkdtemp(join(tmpdir(), "cap-sbx-tools-"));
  k = await startKernel(
    runConfig(
      { pg: pgc.url, redis: rd.url },
      {
        roles: ["api", "worker"],
        plugins: [MODEL_FAKE, S3_PLUGIN, SANDBOX_FAKE],
        pluginConfig: {
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
        sandbox: { deliverMaxBytes: 1024 },
      },
    ),
  );
}, 180_000);

afterAll(async () => {
  await k?.stop();
  await destroyDb?.();
  await Promise.all([pgc?.stop(), rd?.stop(), s3?.stop()]);
  if (root) await rm(root, { recursive: true, force: true });
});

let owner: Req;
let other: Req;
let orgId: string;

beforeEach(async () => {
  await truncateTables(
    db,
    "capybara.sandboxes, capybara.attachments, capybara.approvals, capybara.tool_outputs, capybara.conversation_events, capybara.runs, capybara.conversations, capybara.agent_versions, capybara.agent_members, capybara.agents, capybara.memberships, capybara.orgs, capybara.sessions, capybara.local_passwords, capybara.identities, capybara.accounts",
  );
  const accounts = new AccountsService(db);
  const ownerId = (await accounts.createLocal({ login: "owner", password: PW, displayName: "O" }))
    .id;
  const otherId = (await accounts.createLocal({ login: "other", password: PW, displayName: "X" }))
    .id;
  owner = await session(k, "owner");
  orgId = await createOrg(owner);
  await testMembers(db).add(orgId, otherId, "member", ownerId);
  other = await session(k, "other");
});

async function sandboxConversation(): Promise<string> {
  const res = await owner({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/agents`,
    payload: {
      definition: {
        name: "Coder",
        instructions: "Use the sandbox.",
        model: { provider: "model-fake", model: "fake-1" },
        tools: SANDBOX_TOOLS.map((name) => ({ kind: "builtin", name })),
      },
      visibility: "org",
    },
  });
  expect(res.statusCode, res.body).toBe(201);
  const agentId = (res.json() as { agent: { id: string } }).agent.id;
  return createConv(owner, orgId, agentId);
}

type ToolResultEvent = Extract<ConversationEvent, { type: "tool_result" }>;

/** 让模型调用一次工具，等运行结束，返回这次调用的 tool_result。 */
async function call(convId: string, key: string, input: unknown, n: number) {
  await postMessage(owner, orgId, convId, `tool:${key}:${JSON.stringify(input)}`);
  await waitForTerminal(db, convId, n, 30_000);
  const results = (await eventsOf(db, convId)).filter(
    (e): e is ToolResultEvent => e.type === "tool_result",
  );
  const r = results.at(-1) as ToolResultEvent;
  expect(r.payload.toolKey).toBe(key);
  return r.payload;
}

describe("sandbox tools", { timeout: 60_000 }, () => {
  it("bash: first use notice, runs in /workspace, display summary", async () => {
    const conv = await sandboxConversation();
    const r = await call(conv, "sandbox_bash", { command: "pwd && echo hi" }, 1);
    expect(r.isError).toBe(false);
    expect(r.content).toMatch(/^Sandbox started/);
    expect(r.content).toContain("/workspace\nhi");
    expect(r.content).toContain("[exit code: 0]");
    expect(r.display?.summary.en).toBeTruthy();
    expect(r.display?.summary.zh).toBeTruthy();
    // 第二次不再提示
    const r2 = await call(conv, "sandbox_bash", { command: "echo again" }, 2);
    expect(r2.content).not.toMatch(/Sandbox started/);
    expect(r2.content).toContain("again");
  });

  it("bash: a timed-out command is stopped and the sandbox stays usable", async () => {
    const conv = await sandboxConversation();
    const t0 = Date.now();
    const r = await call(conv, "sandbox_bash", { command: "sleep 30", timeoutSeconds: 1 }, 1);
    expect(Date.now() - t0).toBeLessThan(20_000);
    expect(r.isError).toBe(true);
    expect(r.content).toContain("timedOut");
    const ok = await call(conv, "sandbox_bash", { command: "echo still-alive" }, 2);
    expect(ok.isError).toBe(false);
    expect(ok.content).toContain("still-alive");
  });

  it("bash: timeoutSeconds above sandbox.limits.maxCommandSeconds is rejected", async () => {
    const conv = await sandboxConversation();
    const r = await call(conv, "sandbox_bash", { command: "true", timeoutSeconds: 7201 }, 1);
    expect(r.isError).toBe(true);
    expect(r.content).toContain("7200");
  });

  it("bash: output over 30000 characters is archived", async () => {
    const conv = await sandboxConversation();
    const r = await call(
      conv,
      "sandbox_bash",
      { command: "head -c 40000 /dev/zero | tr '\\0' a" },
      1,
    );
    expect(r.outputId).toBeTruthy();
    expect(r.content).toContain("read_tool_output");
    expect(r.content.length).toBeLessThan(10_000);
  });

  it("write / read / edit / glob / grep round trip", async () => {
    const conv = await sandboxConversation();
    const w = await call(
      conv,
      "sandbox_write",
      { path: "/workspace/src/a.txt", content: "alpha\nbeta\ngamma\n" },
      1,
    );
    expect(w.isError).toBe(false);
    await call(conv, "sandbox_write", { path: "/workspace/src/b.md", content: "beta two\n" }, 2);

    const rd1 = await call(conv, "sandbox_read", { path: "/workspace/src/a.txt" }, 3);
    expect(rd1.content).toContain("1\talpha");
    expect(rd1.content).toContain("3\tgamma");
    const rd2 = await call(
      conv,
      "sandbox_read",
      { path: "/workspace/src/a.txt", offset: 2, limit: 1 },
      4,
    );
    expect(rd2.content).toContain("2\tbeta");
    expect(rd2.content).not.toContain("alpha");

    const e = await call(
      conv,
      "sandbox_edit",
      { path: "/workspace/src/a.txt", oldText: "beta", newText: "BETA" },
      5,
    );
    expect(e.isError).toBe(false);
    const missing = await call(
      conv,
      "sandbox_edit",
      { path: "/workspace/src/a.txt", oldText: "nope", newText: "x" },
      6,
    );
    expect(missing.isError).toBe(true);

    const g = await call(conv, "sandbox_glob", { pattern: "**/*.txt" }, 7);
    expect(g.content).toContain("/workspace/src/a.txt");
    expect(g.content).not.toContain("b.md");

    const gr = await call(conv, "sandbox_grep", { pattern: "beta", ignoreCase: true }, 8);
    expect(gr.content).toContain("/workspace/src/a.txt:2:BETA");
    expect(gr.content).toContain("/workspace/src/b.md:1:beta two");
    const grGlob = await call(conv, "sandbox_grep", { pattern: "beta", glob: "*.md" }, 9);
    expect(grGlob.content).toContain("b.md");
    expect(grGlob.content).not.toContain("a.txt");
  });

  it("paths outside the sandbox roots are rejected", async () => {
    const conv = await sandboxConversation();
    const a = await call(conv, "sandbox_read", { path: "/etc/passwd" }, 1);
    expect(a.isError).toBe(true);
    expect(a.content).toContain("/workspace");
    const b = await call(conv, "sandbox_write", { path: "/workspace/../etc/x", content: "x" }, 2);
    expect(b.isError).toBe(true);
    expect(b.content).toContain("..");
    const c = await call(conv, "sandbox_deliver", { path: "relative.txt" }, 3);
    expect(c.isError).toBe(true);
  });

  it("deliver writes the object and artifact_created; download follows conversation access", async () => {
    const conv = await sandboxConversation();
    await call(
      conv,
      "sandbox_write",
      { path: "/workspace/out/report.csv", content: "a,b\n1,2\n" },
      1,
    );
    const r = await call(
      conv,
      "sandbox_deliver",
      { path: "/workspace/out/report.csv", name: "Q3 report.csv" },
      2,
    );
    expect(r.isError).toBe(false);
    const ev = (await eventsOf(db, conv)).find((e) => e.type === "artifact_created");
    expect(ev?.type).toBe("artifact_created");
    const a = (ev as Extract<ConversationEvent, { type: "artifact_created" }>).payload;
    expect(a).toMatchObject({
      name: "Q3 report.csv",
      contentType: "text/csv",
      size: 8,
      sourcePath: "/workspace/out/report.csv",
    });
    expect(a.objectKey).toBe(`artifacts/${conv}/${a.artifactId}`);
    expect(r.content).toContain(a.artifactId);
    const got = await k.storage.kernel(orgId).get(a.objectKey);
    expect(got).not.toBeNull();
    expect(Buffer.from(await new Response(got?.body).arrayBuffer()).toString()).toBe("a,b\n1,2\n");

    const url = `/api/v1/orgs/${orgId}/conversations/${conv}/artifacts/${a.artifactId}/download`;
    const ok = await owner({ method: "GET", url });
    expect(ok.statusCode).toBe(302);
    const loc = String(ok.headers.location);
    expect(loc).toContain("attachment");
    expect(decodeURIComponent(loc)).toContain("Q3 report.csv");
    // 看不到这个会话的人：与会话流相同，404
    const denied = await other({ method: "GET", url });
    expect(denied.statusCode).toBe(404);
    const unknown = await owner({
      method: "GET",
      url: `/api/v1/orgs/${orgId}/conversations/${conv}/artifacts/00000000-0000-4000-8000-000000000000/download`,
    });
    expect(unknown.statusCode).toBe(404);
    expect((unknown.json() as { error: { code: string } }).error.code).toBe(
      "conversation.artifact_not_found",
    );
  });

  it("deliver refuses files over sandbox.deliverMaxBytes", async () => {
    const conv = await sandboxConversation();
    await call(conv, "sandbox_bash", { command: "head -c 2048 /dev/zero > /workspace/big.bin" }, 1);
    const r = await call(conv, "sandbox_deliver", { path: "/workspace/big.bin" }, 2);
    expect(r.isError).toBe(true);
    expect(r.content).toContain("1024");
    expect((await eventsOf(db, conv)).some((e) => e.type === "artifact_created")).toBe(false);
  });

  it("org policy ask: write needs approval, read does not", async () => {
    const patch = await owner({
      method: "PATCH",
      url: `/api/v1/orgs/${orgId}/settings`,
      payload: { sandboxToolPolicy: "ask" },
    });
    expect(patch.statusCode, patch.body).toBe(200);
    const conv = await sandboxConversation();
    await postMessage(
      owner,
      orgId,
      conv,
      `tool:sandbox_write:${JSON.stringify({ path: "/workspace/x.txt", content: "x" })}`,
    );
    const asked = await waitForEvent(db, conv, (e) => e.type === "approval_requested");
    expect(asked.type === "approval_requested" && asked.payload.toolKey).toBe("sandbox_write");

    const conv2 = await sandboxConversation();
    const r = await call(conv2, "sandbox_read", { path: "/workspace/none.txt" }, 1);
    expect(r.toolKey).toBe("sandbox_read");
    expect((await eventsOf(db, conv2)).some((e) => e.type === "approval_requested")).toBe(false);
  });

  it("conversation attachments appear under /workspace/attachments", async () => {
    const conv = await sandboxConversation();
    const bytes = Buffer.from("name,qty\napple,3\n");
    const created = await owner({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/attachments`,
      payload: { name: "fruit.csv", contentType: "text/csv", size: bytes.length },
    });
    expect(created.statusCode, created.body).toBe(201);
    const c = created.json() as {
      id: string;
      upload: { method: string; url: string; headers: Record<string, string>; fields?: object };
    };
    const form = new FormData();
    for (const [key, v] of Object.entries(c.upload.fields ?? {})) form.append(key, String(v));
    form.append("file", new Blob([bytes], { type: "text/csv" }));
    const up =
      c.upload.method === "PUT"
        ? await fetch(c.upload.url, { method: "PUT", headers: c.upload.headers, body: bytes })
        : await fetch(c.upload.url, { method: "POST", headers: c.upload.headers, body: form });
    expect(up.status).toBeLessThan(300);
    const fin = await owner({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/attachments/${c.id}/finalize`,
    });
    expect(fin.statusCode, fin.body).toBe(200);
    const sent = await owner({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/conversations/${conv}/messages`,
      payload: { text: "echo:got it", files: [c.id] },
    });
    expect(sent.statusCode, sent.body).toBe(202);
    await waitForTerminal(db, conv, 1, 30_000);

    const r = await call(
      conv,
      "sandbox_bash",
      { command: "cat /workspace/attachments/fruit.csv" },
      2,
    );
    expect(r.content).toContain("apple,3");
    expect(r.content).toContain("/workspace/attachments/fruit.csv");
    // 已同步过的不再提示
    const r2 = await call(conv, "sandbox_bash", { command: "ls /workspace/attachments" }, 3);
    expect(r2.content).toContain("fruit.csv");
    expect(r2.content).not.toContain("Attachments copied");

    // 实例在提供方那边没了：透明重建，告诉模型文件已不在，并重新复制附件
    const row = await db
      .selectFrom("sandboxes")
      .select("handle")
      .where("conversation_id", "=", conv)
      .executeTakeFirstOrThrow();
    await removeFakeSandbox(root, (row.handle as { id: string }).id);
    const r3 = await call(
      conv,
      "sandbox_bash",
      { command: "cat /workspace/attachments/fruit.csv" },
      4,
    );
    expect(r3.content).toMatch(/^Sandbox was recreated; previous files are gone\./);
    expect(r3.content).toContain("Attachments copied");
    expect(r3.content).toContain("apple,3");
  });
});
