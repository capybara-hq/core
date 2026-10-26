import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  fakeExtensionEntry,
  startTestPostgres,
  startTestRedis,
  startTestS3,
  type TestContainer,
  type TestS3,
} from "@capybara-hq/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ARTIFACT_PREVIEW_MAX_LINES } from "../../../src/conversations/artifacts.js";
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

const OBJECT_STORE = fakeExtensionEntry("fake-object-store");
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
        extensions: [MODEL_FAKE, OBJECT_STORE, SANDBOX_FAKE],
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
    const r = await call(
      conv,
      "sandbox_bash",
      { description: "Test step", command: "pwd && echo hi" },
      1,
    );
    expect(r.isError).toBe(false);
    expect(r.content).toMatch(/^Sandbox started/);
    expect(r.content).toContain("/workspace\nhi");
    expect(r.content).toContain("[exit code: 0]");
    expect(r.display?.summary.en).toBeTruthy();
    expect(r.display?.summary.zh).toBeTruthy();
    // 第二次不再提示
    const r2 = await call(
      conv,
      "sandbox_bash",
      { description: "Test step", command: "echo again" },
      2,
    );
    expect(r2.content).not.toMatch(/Sandbox started/);
    expect(r2.content).toContain("again");
  });

  it("bash: a timed-out command is stopped and the sandbox stays usable", async () => {
    const conv = await sandboxConversation();
    const t0 = Date.now();
    const r = await call(
      conv,
      "sandbox_bash",
      { description: "Test step", command: "sleep 30", timeoutSeconds: 1 },
      1,
    );
    expect(Date.now() - t0).toBeLessThan(20_000);
    expect(r.isError).toBe(true);
    expect(r.content).toContain("timedOut");
    const ok = await call(
      conv,
      "sandbox_bash",
      { description: "Test step", command: "echo still-alive" },
      2,
    );
    expect(ok.isError).toBe(false);
    expect(ok.content).toContain("still-alive");
  });

  it("bash: timeoutSeconds above sandbox.limits.maxCommandSeconds is rejected", async () => {
    const conv = await sandboxConversation();
    const r = await call(
      conv,
      "sandbox_bash",
      { description: "Test step", command: "true", timeoutSeconds: 7201 },
      1,
    );
    expect(r.isError).toBe(true);
    expect(r.content).toContain("7200");
  });

  it("bash: output over 30000 characters is archived", async () => {
    const conv = await sandboxConversation();
    const r = await call(
      conv,
      "sandbox_bash",
      { description: "Test step", command: "head -c 40000 /dev/zero | tr '\\0' a" },
      1,
    );
    expect(r.outputId).toBeTruthy();
    expect(r.content).toContain("read_tool_output");
    expect(r.content.length).toBeLessThan(10_000);
  });

  it("bash: a call without description is a validation error the model can fix", async () => {
    const conv = await sandboxConversation();
    const r = await call(conv, "sandbox_bash", { command: "echo hi" }, 1);
    expect(r.isError).toBe(true);
    expect(r.content).toContain("description");
    expect(r.view).toBeUndefined();
    // validation fails before the tool runs: no sandbox is created
    const rows = db.selectFrom("sandboxes").select("handle").where("conversation_id", "=", conv);
    expect(await rows.execute()).toEqual([]);
  });

  it("bash: a non-zero exit is not isError, the view carries the exit code and description", async () => {
    const conv = await sandboxConversation();
    const r = await call(
      conv,
      "sandbox_bash",
      { command: "exit 1", description: "Check the build" },
      1,
    );
    expect(r.isError).toBe(false);
    expect(r.content).toContain("[exit code: 1]");
    expect(r.view).toEqual({
      kind: "command",
      description: "Check the build",
      exitCode: 1,
      timedOut: false,
    });
    const t = await call(
      conv,
      "sandbox_bash",
      { command: "sleep 30", description: "Wait", timeoutSeconds: 1 },
      2,
    );
    expect(t.isError).toBe(true);
    expect(t.view).toMatchObject({ kind: "command", timedOut: true });
  });

  it("edit / write / read views: diffs, created, line ranges", async () => {
    const conv = await sandboxConversation();
    const w1 = await call(
      conv,
      "sandbox_write",
      { path: "/workspace/v.txt", content: "one\ntwo\nthree\n" },
      1,
    );
    expect(w1.view).toMatchObject({
      kind: "edit",
      path: "/workspace/v.txt",
      created: true,
      added: 3,
      removed: 0,
      truncated: false,
    });
    const w2 = await call(
      conv,
      "sandbox_write",
      { path: "/workspace/v.txt", content: "one\nTWO\nthree\n" },
      2,
    );
    expect(w2.view).toMatchObject({ kind: "edit", created: false, added: 1, removed: 1 });
    expect(w2.view?.kind === "edit" && w2.view.hunks[0]?.lines).toEqual([
      { kind: "ctx", text: "one" },
      { kind: "del", text: "two" },
      { kind: "add", text: "TWO" },
      { kind: "ctx", text: "three" },
    ]);
    const e = await call(
      conv,
      "sandbox_edit",
      { path: "/workspace/v.txt", oldText: "three", newText: "3\n4" },
      3,
    );
    expect(e.view).toMatchObject({
      kind: "edit",
      path: "/workspace/v.txt",
      created: false,
      added: 2,
      removed: 1,
    });
    const rd = await call(conv, "sandbox_read", { path: "/workspace/v.txt", offset: 2 }, 4);
    expect(rd.view).toEqual({ kind: "read", path: "/workspace/v.txt", fromLine: 2, toLine: 4 });
    const failed = await call(conv, "sandbox_read", { path: "/workspace/none.txt" }, 5);
    expect(failed.isError).toBe(true);
    expect(failed.view).toBeUndefined();
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

    // 多处匹配：不加 replaceAll 报歧义；加了全部替换
    await call(conv, "sandbox_write", { path: "/workspace/r.txt", content: "x-x-x\n" }, 10);
    const amb = await call(
      conv,
      "sandbox_edit",
      { path: "/workspace/r.txt", oldText: "x", newText: "y" },
      11,
    );
    expect(amb.isError).toBe(true);
    expect(amb.content).toContain("occurs 3 times");
    expect(amb.content).toContain("replaceAll");
    const all = await call(
      conv,
      "sandbox_edit",
      { path: "/workspace/r.txt", oldText: "x", newText: "$&y", replaceAll: true },
      12,
    );
    expect(all.isError, all.content).toBe(false);
    expect(all.content).toContain("replaced 3 occurrences");
    const after = await call(conv, "sandbox_read", { path: "/workspace/r.txt" }, 13);
    expect(after.content).toContain("$&y-$&y-$&y");
  });

  it("a ToolError inside the sandbox call does not recreate the sandbox", async () => {
    const conv = await sandboxConversation();
    await call(
      conv,
      "sandbox_bash",
      { description: "Test step", command: "echo keep > /workspace/keep.txt" },
      1,
    );
    const handle = async () =>
      (
        await db
          .selectFrom("sandboxes")
          .select(["handle", "generation"])
          .where("conversation_id", "=", conv)
          .executeTakeFirstOrThrow()
      ).handle;
    const before = await handle();
    const r = await call(conv, "sandbox_read", { path: "/workspace/missing.txt" }, 2);
    expect(r.isError).toBe(true);
    expect(r.content).toContain("File not found");
    expect(await handle()).toEqual(before);
    const ok = await call(conv, "sandbox_read", { path: "/workspace/keep.txt" }, 3);
    expect(ok.content).not.toContain("recreated");
    expect(ok.content).toContain("keep");
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
    // 真实的产物 id、但挂在查看者自己的另一个会话下：404
    const conv2 = await sandboxConversation();
    const elsewhere = await owner({
      method: "GET",
      url: `/api/v1/orgs/${orgId}/conversations/${conv2}/artifacts/${a.artifactId}/download`,
    });
    expect(elsewhere.statusCode).toBe(404);
    expect((elsewhere.json() as { error: { code: string } }).error.code).toBe(
      "conversation.artifact_not_found",
    );
    const unknown = await owner({
      method: "GET",
      url: `/api/v1/orgs/${orgId}/conversations/${conv}/artifacts/00000000-0000-4000-8000-000000000000/download`,
    });
    expect(unknown.statusCode).toBe(404);
    expect((unknown.json() as { error: { code: string } }).error.code).toBe(
      "conversation.artifact_not_found",
    );
  });

  it("download ?inline=1 opens only raster images inline; preview returns text first lines", async () => {
    const conv = await sandboxConversation();
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64",
    );
    await call(
      conv,
      "sandbox_bash",
      {
        description: "Test step",
        command: `printf '%s' '${png.toString("base64")}' | base64 -d > /workspace/dot.png`,
      },
      1,
    );
    await call(conv, "sandbox_write", { path: "/workspace/notes.txt", content: "l1\nl2\n" }, 2);
    await call(
      conv,
      "sandbox_write",
      { path: "/workspace/page.svg", content: "<svg xmlns='http://www.w3.org/2000/svg'/>" },
      3,
    );
    await call(conv, "sandbox_deliver", { path: "/workspace/dot.png" }, 4);
    await call(conv, "sandbox_deliver", { path: "/workspace/notes.txt" }, 5);
    await call(conv, "sandbox_deliver", { path: "/workspace/page.svg" }, 6);
    const arts = (await eventsOf(db, conv))
      .filter(
        (e): e is Extract<ConversationEvent, { type: "artifact_created" }> =>
          e.type === "artifact_created",
      )
      .map((e) => e.payload);
    const idOf = (n: string) => arts.find((a) => a.name === n)?.artifactId as string;
    const base = `/api/v1/orgs/${orgId}/conversations/${conv}/artifacts`;

    const img = await owner({ method: "GET", url: `${base}/${idOf("dot.png")}/download?inline=1` });
    expect(img.statusCode).toBe(302);
    expect(decodeURIComponent(String(img.headers.location))).toContain("inline");
    // 图片的预签名地址浏览器能直接加载（<img src>，不需要 CORS）
    const fetched = await fetch(String(img.headers.location));
    expect(fetched.status).toBe(200);
    expect(fetched.headers.get("content-type")).toBe("image/png");
    // 非位图（SVG 能执行脚本）、文本：?inline=1 不生效，仍是 attachment
    for (const n of ["page.svg", "notes.txt"]) {
      const r = await owner({ method: "GET", url: `${base}/${idOf(n)}/download?inline=1` });
      expect(r.statusCode).toBe(302);
      const loc = decodeURIComponent(String(r.headers.location));
      expect(loc).toContain("attachment");
      expect(loc).not.toContain("inline");
    }

    const text = await owner({ method: "GET", url: `${base}/${idOf("notes.txt")}/preview` });
    expect(text.statusCode, text.body).toBe(200);
    expect(text.headers["cache-control"]).toContain("no-store");
    expect(text.json()).toEqual({ preview: { text: "l1\nl2\n", truncated: false } });
    // 不是文本类（图片、SVG）：不给预览
    for (const n of ["dot.png", "page.svg"]) {
      const r = await owner({ method: "GET", url: `${base}/${idOf(n)}/preview` });
      expect(r.statusCode).toBe(400);
      expect((r.json() as { error: { code: string } }).error.code).toBe(
        "conversation.artifact_not_previewable",
      );
    }
    // 看不到会话的人：404
    const denied = await other({ method: "GET", url: `${base}/${idOf("notes.txt")}/preview` });
    expect(denied.statusCode).toBe(404);
  });

  it("preview of a long text file is cut at a line boundary and marked truncated", async () => {
    const conv = await sandboxConversation();
    await call(
      conv,
      "sandbox_bash",
      // 972 字节（低于本测试的 deliverMaxBytes 1024），120 行：超过预览的行数上限
      { description: "Test step", command: "seq 1 120 | sed 's/^/line /' > /workspace/long.log" },
      1,
    );
    await call(conv, "sandbox_deliver", { path: "/workspace/long.log" }, 2);
    const a = (await eventsOf(db, conv)).find((e) => e.type === "artifact_created") as Extract<
      ConversationEvent,
      { type: "artifact_created" }
    >;
    const r = await owner({
      method: "GET",
      url: `/api/v1/orgs/${orgId}/conversations/${conv}/artifacts/${a.payload.artifactId}/preview`,
    });
    expect(r.statusCode, r.body).toBe(200);
    const p = (r.json() as { preview: { text: string; truncated: boolean } }).preview;
    expect(p.truncated).toBe(true);
    const lines = p.text.split("\n");
    expect(lines[0]).toBe("line 1");
    expect(lines.length).toBeLessThanOrEqual(ARTIFACT_PREVIEW_MAX_LINES);
    for (const l of lines) expect(l).toMatch(/^line \d+$/);
  });

  it("preview: a text file over 8 KB is cut at a UTF-8 boundary / a line; NUL bytes → not previewable", async () => {
    const conv = await sandboxConversation();
    const store = k.storage.kernel(orgId);
    const put = async (name: string, bytes: Buffer, contentType = "text/plain") => {
      const artifactId = randomUUID();
      const objectKey = `artifacts/${conv}/${artifactId}`;
      await store.put(objectKey, bytes, {
        contentType,
        size: bytes.byteLength,
        signal: AbortSignal.timeout(10_000),
      });
      await k.runs.eventLog.append(conv, [
        {
          type: "artifact_created",
          payload: {
            artifactId,
            name,
            contentType,
            size: bytes.byteLength,
            objectKey,
            sourcePath: `/workspace/${name}`,
            callId: "preview-test",
          },
        },
      ]);
      return owner({
        method: "GET",
        url: `/api/v1/orgs/${orgId}/conversations/${conv}/artifacts/${artifactId}/preview`,
      });
    };
    type P = { preview: { text: string; truncated: boolean } };
    // 一行 3000 个「中」（9000 字节）：开头 8192 字节截在第 2731 个字符中间，残缺的字符被丢掉
    const oneLine = await put("one-line.txt", Buffer.from("中".repeat(3000)));
    expect(oneLine.statusCode, oneLine.body).toBe(200);
    expect((oneLine.json() as P).preview).toEqual({ text: "中".repeat(2730), truncated: true });
    expect((oneLine.json() as P).preview.text).not.toContain("\uFFFD");
    // 有换行：去掉被截断的最后一行
    const lines = await put("lines.txt", Buffer.from(`head\n${"中".repeat(3000)}\n`));
    expect((lines.json() as P).preview).toEqual({ text: "head", truncated: true });
    // 声称是文本、开头却有 NUL：不预览（界面显示「不能预览」）
    const bin = await put("bin.txt", Buffer.from([0x61, 0x62, 0x00, 0x63, 0x0a]));
    expect(bin.statusCode).toBe(400);
    expect((bin.json() as { error: { code: string } }).error.code).toBe(
      "conversation.artifact_not_previewable",
    );
  });

  it("GET .../sandbox: 404 before first use, running after, suspended after the idle sweep", async () => {
    const conv = await sandboxConversation();
    const url = `/api/v1/orgs/${orgId}/conversations/${conv}/sandbox`;
    const none = await owner({ method: "GET", url });
    expect(none.statusCode).toBe(404);
    expect((none.json() as { error: { code: string } }).error.code).toBe("sandbox.not_found");
    await call(conv, "sandbox_bash", { description: "Test step", command: "true" }, 1);
    const running = await owner({ method: "GET", url });
    expect(running.statusCode, running.body).toBe(200);
    const s = running.json() as { status: string; lastUsedAt: string };
    expect(s.status).toBe("running");
    expect(Number.isNaN(Date.parse(s.lastUsedAt))).toBe(false);
    // 看不到会话的人：与会话流相同，404 conversation.not_found
    const denied = await other({ method: "GET", url });
    expect(denied.statusCode).toBe(404);
    expect((denied.json() as { error: { code: string } }).error.code).toBe(
      "conversation.not_found",
    );
    expect(await k.sandbox.suspendIdle(new Date(Date.now() + 24 * 3600_000))).toBeGreaterThan(0);
    const suspended = await owner({ method: "GET", url });
    expect((suspended.json() as { status: string }).status).toBe("suspended");
    // 已销毁的：与未创建一样（文件已不在），404
    await k.sandbox.destroyFor(conv);
    expect((await owner({ method: "GET", url })).statusCode).toBe(404);
  });

  it("deliver refuses files over sandbox.deliverMaxBytes", async () => {
    const conv = await sandboxConversation();
    await call(
      conv,
      "sandbox_bash",
      { description: "Test step", command: "head -c 2048 /dev/zero > /workspace/big.bin" },
      1,
    );
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
      { description: "Test step", command: "cat /workspace/attachments/fruit.csv" },
      2,
    );
    expect(r.content).toContain("apple,3");
    expect(r.content).toContain("/workspace/attachments/fruit.csv");
    // 已同步过的不再提示
    const r2 = await call(
      conv,
      "sandbox_bash",
      { description: "Test step", command: "ls /workspace/attachments" },
      3,
    );
    expect(r2.content).toContain("fruit.csv");
    expect(r2.content).not.toContain("Attachments copied");
    // 标记文件不出现在 glob / grep 结果里（它的内容含 fruit.csv）
    const g = await call(conv, "sandbox_glob", { pattern: "**" }, 4);
    expect(g.content).toContain("/workspace/attachments/fruit.csv");
    expect(g.content).not.toContain(".capybara-sync.json");
    const gr = await call(conv, "sandbox_grep", { pattern: "fruit|apple" }, 5);
    expect(gr.content).toContain("/workspace/attachments/fruit.csv:2:apple,3");
    expect(gr.content).not.toContain(".capybara-sync.json");

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
      { description: "Test step", command: "cat /workspace/attachments/fruit.csv" },
      6,
    );
    expect(r3.content).toMatch(/^Sandbox was recreated; previous files are gone\./);
    expect(r3.content).toContain("Attachments copied");
    expect(r3.content).toContain("apple,3");
  });
});
