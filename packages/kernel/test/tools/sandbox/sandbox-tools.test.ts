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
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ARTIFACT_PREVIEW_MAX_LINES } from "../../../src/conversations/artifacts.js";
import { EventLog } from "../../../src/conversations/event-log.js";
import type { ConversationEvent } from "../../../src/conversations/events.js";
import { type KernelSchemaDb, kernelDb } from "../../../src/db/kernel-schema.js";
import { createDb } from "../../../src/db/pool.js";
import { createLogger } from "../../../src/log.js";
import { SandboxService } from "../../../src/sandbox/sandbox.service.js";
import { StorageService } from "../../../src/storage/storage.service.js";
import {
  SANDBOX_CONNECTION_DROPPED_TEXT,
  SANDBOX_FILES_RESET_NOTICE,
  SANDBOX_RESTARTED_NOTICE,
  SANDBOX_STARTED_NOTICE,
  SANDBOX_UNREACHABLE_TEXT,
} from "../../../src/tools/builtins/sandbox/common.js";
import {
  removeFakeSandbox,
  setFakeFileSystemIdsByName,
  setFakeSandboxFault,
} from "../../fixtures/plugins/sandbox-fake/index.js";
import { truncateTables } from "../../helpers/db.js";
import { onlyBuiltins } from "../../helpers/disabled-tools.js";
import { accountsFor } from "../../helpers/identity.js";
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
  type TestKernel,
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

const SANDBOX_TOOLS = ["Bash", "Read", "Write", "Edit", "Glob", "Grep", "Deliver"];

let pgc: TestContainer;
let rd: TestContainer;
let s3: TestS3;
let db: KernelSchemaDb;
let destroyDb: () => Promise<void>;
let k: TestKernel;
let root: string;
/** The kernel's warn and error records (JSON lines). */
const logLines: string[] = [];

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
    { logger: createLogger("warn", { write: (l) => logLines.push(l) }) },
  );
}, 180_000);

afterAll(async () => {
  await k?.close();
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
    "capybara.environment_instances, capybara.environments, capybara.attachments, capybara.approvals, capybara.tool_outputs, capybara.conversation_events, capybara.runs, capybara.conversations, capybara.agent_versions, capybara.agent_members, capybara.agents, capybara.memberships, capybara.orgs, capybara.sessions, capybara.local_passwords, capybara.identities, capybara.accounts",
  );
  const accounts = accountsFor(db);
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
        disabledTools: onlyBuiltins(SANDBOX_TOOLS.map((name) => ({ kind: "builtin", name }))),
      },
      visibility: "org",
    },
  });
  expect(res.statusCode, res.body).toBe(201);
  const agentId = (res.json() as { agent: { id: string } }).agent.id;
  return createConv(owner, orgId, agentId);
}

/** The environment a conversation is bound to (its owner's default unless one was chosen). */
async function envOf(convId: string): Promise<string> {
  const r = await db
    .selectFrom("conversations")
    .select("environment_id")
    .where("id", "=", convId)
    .executeTakeFirstOrThrow();
  if (r.environment_id === null) throw new Error(`conversation ${convId} is not bound`);
  return r.environment_id;
}

/** The instance row of the conversation's environment. */
async function instanceOf(convId: string) {
  return db
    .selectFrom("environment_instances")
    .select(["handle", "generation", "status"])
    .where("environment_id", "=", await envOf(convId))
    .executeTakeFirst();
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
    const r = await call(conv, "Bash", { description: "Test step", command: "pwd && echo hi" }, 1);
    expect(r.isError).toBe(false);
    expect(r.content).toMatch(/^Environment started/);
    expect(r.content).toContain("/workspace\nhi");
    expect(r.content).toContain("[exit code: 0]");
    expect(r.display?.summary.en).toBeTruthy();
    expect(r.display?.summary.zh).toBeTruthy();
    // 第二次不再提示
    const r2 = await call(conv, "Bash", { description: "Test step", command: "echo again" }, 2);
    expect(r2.content).not.toMatch(/Environment started/);
    expect(r2.content).toContain("again");
  });

  it("bash: a timed-out command is stopped and the sandbox stays usable", async () => {
    const conv = await sandboxConversation();
    const t0 = Date.now();
    const r = await call(
      conv,
      "Bash",
      { description: "Test step", command: "sleep 30", timeout: 1500 },
      1,
    );
    expect(Date.now() - t0).toBeLessThan(20_000);
    expect(r.isError).toBe(true);
    expect(r.content).toContain("timedOut");
    const ok = await call(
      conv,
      "Bash",
      { description: "Test step", command: "echo still-alive" },
      2,
    );
    expect(ok.isError).toBe(false);
    expect(ok.content).toContain("still-alive");
  });

  it("bash: timeout is milliseconds; one above the deployment maximum is lowered and says so", async () => {
    const conv = await sandboxConversation();
    const t0 = Date.now();
    const slow = await call(
      conv,
      "Bash",
      { description: "Test step", command: "sleep 30", timeout: 1500 },
      1,
    );
    const took = Date.now() - t0;
    expect(slow.isError).toBe(true);
    expect(slow.content).toContain("timedOut");
    expect(slow.content).toContain("1.5s");
    expect(took).toBeLessThan(20_000);
    const r = await call(
      conv,
      "Bash",
      { description: "Test step", command: "echo done", timeout: 7_201_000 },
      2,
    );
    expect(r.isError).toBe(false);
    expect(r.content).toContain("done");
    expect(r.content).toContain("timeout 7201000 ms is over the deployment maximum");
    expect(r.content).toContain("lowered to 7200000 ms");
    const old = await call(
      conv,
      "Bash",
      { description: "Test step", command: "true", timeoutSeconds: 5 },
      3,
    );
    expect(old.isError).toBe(true);
    expect(old.content).toContain("timeoutSeconds");
  });

  it("bash: output over 30000 characters is archived", async () => {
    const conv = await sandboxConversation();
    const r = await call(
      conv,
      "Bash",
      { description: "Test step", command: "head -c 40000 /dev/zero | tr '\\0' a" },
      1,
    );
    expect(r.outputId).toBeTruthy();
    expect(r.content).toContain("ReadToolOutput");
    expect(r.content.length).toBeLessThan(10_000);
  });

  it("bash: a call without description is a validation error the model can fix", async () => {
    const conv = await sandboxConversation();
    const r = await call(conv, "Bash", { command: "echo hi" }, 1);
    expect(r.isError).toBe(true);
    expect(r.content).toContain("description");
    expect(r.view).toBeUndefined();
    // validation fails before the tool runs: no instance is created
    expect(await instanceOf(conv)).toBeUndefined();
  });

  it("bash: a non-zero exit is not isError, the view carries the exit code and description", async () => {
    const conv = await sandboxConversation();
    const r = await call(conv, "Bash", { command: "exit 1", description: "Check the build" }, 1);
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
      "Bash",
      { command: "sleep 30", description: "Wait", timeout: 1500 },
      2,
    );
    expect(t.isError).toBe(true);
    expect(t.view).toMatchObject({ kind: "command", timedOut: true });
  });

  it("edit / write / read views: diffs, created, line ranges", async () => {
    const conv = await sandboxConversation();
    const w1 = await call(
      conv,
      "Write",
      { file_path: "/workspace/v.txt", content: "one\ntwo\nthree\n" },
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
      "Write",
      { file_path: "/workspace/v.txt", content: "one\nTWO\nthree\n" },
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
      "Edit",
      { file_path: "/workspace/v.txt", old_string: "three", new_string: "3\n4" },
      3,
    );
    expect(e.view).toMatchObject({
      kind: "edit",
      path: "/workspace/v.txt",
      created: false,
      added: 2,
      removed: 1,
    });
    const rd = await call(conv, "Read", { file_path: "/workspace/v.txt", offset: 2 }, 4);
    expect(rd.view).toMatchObject({
      kind: "read",
      path: "/workspace/v.txt",
      fromLine: 2,
      toLine: 4,
      file: { path: "/workspace/v.txt", sha256: expect.stringMatching(/^[0-9a-f]{64}$/) },
    });
    const failed = await call(conv, "Read", { file_path: "/workspace/none.txt" }, 5);
    expect(failed.isError).toBe(true);
    expect(failed.view).toBeUndefined();
  });

  it("a NUL after the first 8 KiB never fails the run: write, edit and read complete", async () => {
    // The Tasks 5-6 review probe: 9000 bytes of "a", a newline, then "x\0y".
    const conv = await sandboxConversation();
    const make =
      "head -c 9000 /dev/zero | tr '\\000' a > /workspace/nul.txt && printf '\\nx\\000y\\nz\\n' >> /workspace/nul.txt";
    const b1 = await call(conv, "Bash", { description: "Make file", command: make }, 1);
    expect(b1.content).toContain("[exit code: 0]");
    await call(conv, "Read", { file_path: "/workspace/nul.txt" }, 2);
    // write over it: the old content has a NUL, so no diff hunks, but the write completes
    const w = await call(conv, "Write", { file_path: "/workspace/nul.txt", content: "new\n" }, 3);
    expect(w.isError).toBe(false);
    expect(w.content).toContain("Overwrote /workspace/nul.txt");
    expect(w.view).toMatchObject({ kind: "edit", truncated: true, hunks: [] });
    // edit with the NUL line in the hunk context: the view shows it as U+FFFD
    await call(conv, "Bash", { description: "Make file", command: make }, 4);
    await call(conv, "Read", { file_path: "/workspace/nul.txt" }, 5);
    const e = await call(
      conv,
      "Edit",
      { file_path: "/workspace/nul.txt", old_string: "z\n", new_string: "Z\n" },
      6,
    );
    expect(e.isError).toBe(false);
    expect(e.view?.kind === "edit" && e.view.hunks[0]?.lines.map((l) => l.text)).toContain(
      "x\uFFFDy",
    );
    // read (a bug from before B): the NUL reaches the model as U+FFFD instead of failing the run
    const r = await call(conv, "Read", { file_path: "/workspace/nul.txt", offset: 2 }, 7);
    expect(r.isError).toBe(false);
    expect(r.content).toContain("x\uFFFDy");
  });

  it("edit: old_string / new_string / replace_all; the old field names are a validation error", async () => {
    const conv = await sandboxConversation();
    await call(conv, "Write", { file_path: "/workspace/e.txt", content: "a-a-a\n" }, 1);
    const one = await call(
      conv,
      "Edit",
      { file_path: "/workspace/e.txt", old_string: "-a-a", new_string: "" },
      2,
    );
    expect(one.isError).toBe(false);
    const rd = await call(conv, "Read", { file_path: "/workspace/e.txt" }, 3);
    expect(rd.content).toContain("1\ta");
    await call(conv, "Write", { file_path: "/workspace/e.txt", content: "a-a-a\n" }, 4);
    const amb = await call(
      conv,
      "Edit",
      { file_path: "/workspace/e.txt", old_string: "a", new_string: "b" },
      5,
    );
    expect(amb.isError).toBe(true);
    expect(amb.content).toContain("replace_all");
    const all = await call(
      conv,
      "Edit",
      { file_path: "/workspace/e.txt", old_string: "a", new_string: "b", replace_all: true },
      6,
    );
    expect(all.isError).toBe(false);
    expect((await call(conv, "Read", { file_path: "/workspace/e.txt" }, 7)).content).toContain(
      "b-b-b",
    );
    const bad = await call(
      conv,
      "Edit",
      { path: "/workspace/e.txt", oldText: "b", newText: "c" },
      8,
    );
    expect(bad.isError).toBe(true);
    expect(bad.content).toContain("file_path");
  });

  it("an invalid path is reported under the parameter's name: file_path for Read / Write / Edit / Deliver, path for Glob", async () => {
    const conv = await sandboxConversation();
    let step = 1;
    for (const [tool, input] of [
      ["Read", { file_path: "relative.txt" }],
      ["Write", { file_path: "relative.txt", content: "x" }],
      ["Edit", { file_path: "relative.txt", old_string: "a", new_string: "b" }],
      ["Deliver", { file_path: "relative.txt" }],
    ] as const) {
      const r = await call(conv, tool, input, step++);
      expect(r.isError, tool).toBe(true);
      expect(r.content, tool).toMatch(/^Invalid file_path "relative\.txt"/);
    }
    const g = await call(conv, "Glob", { pattern: "*", path: "relative" }, step);
    expect(g.content).toMatch(/^Invalid path "relative"/);
  });

  it("grep: count and files_with_matches on a single-file path", async () => {
    const conv = await sandboxConversation();
    await call(
      conv,
      "Write",
      { file_path: "/workspace/one.txt", content: "hit\nno\nhit\nhit\n" },
      1,
    );
    const count = await call(
      conv,
      "Grep",
      { pattern: "hit", path: "/workspace/one.txt", output_mode: "count" },
      2,
    );
    expect(count.content).toBe("/workspace/one.txt:3");
    const files = await call(conv, "Grep", { pattern: "hit", path: "/workspace/one.txt" }, 3);
    expect(files.content).toBe("/workspace/one.txt");
  });

  it("grep: output modes, context, head_limit and offset", async () => {
    const conv = await sandboxConversation();
    await call(
      conv,
      "Write",
      { file_path: "/workspace/g/a.txt", content: "one\nneedle 1\nthree\nneedle 2\n" },
      1,
    );
    await call(conv, "Write", { file_path: "/workspace/g/b.txt", content: "x\nNEEDLE 3\ny\n" }, 2);
    await call(conv, "Write", { file_path: "/workspace/g/c.txt", content: "nothing\n" }, 3);

    const files = await call(conv, "Grep", { pattern: "needle", path: "/workspace/g" }, 4);
    expect(files.content.split("\n").sort()).toEqual(["/workspace/g/a.txt"]);
    const filesI = await call(
      conv,
      "Grep",
      { pattern: "needle", path: "/workspace/g", "-i": true },
      5,
    );
    expect(filesI.content.split("\n").sort()).toEqual(["/workspace/g/a.txt", "/workspace/g/b.txt"]);

    const count = await call(
      conv,
      "Grep",
      { pattern: "needle", path: "/workspace/g", "-i": true, output_mode: "count" },
      6,
    );
    expect(count.content.split("\n").sort()).toEqual([
      "/workspace/g/a.txt:2",
      "/workspace/g/b.txt:1",
    ]);

    const ctx = await call(
      conv,
      "Grep",
      { pattern: "needle 1", path: "/workspace/g", output_mode: "content", "-C": 1 },
      7,
    );
    expect(ctx.content).toBe(
      [
        "/workspace/g/a.txt-1-one",
        "/workspace/g/a.txt:2:needle 1",
        "/workspace/g/a.txt-3-three",
      ].join("\n"),
    );
    const noNum = await call(
      conv,
      "Grep",
      { pattern: "needle 1", path: "/workspace/g", output_mode: "content", "-n": false },
      8,
    );
    expect(noNum.content).toBe("/workspace/g/a.txt:needle 1");

    const content = { pattern: "needle", path: "/workspace/g", "-i": true, output_mode: "content" };
    const first = await call(conv, "Grep", { ...content, head_limit: 1 }, 9);
    expect(first.content.split("\n")[0]).toMatch(/^\/workspace\/g\/[ab]\.txt:\d+:/);
    expect(first.content).toContain("Showing entries 1\u20131 of 3");
    expect(first.content).toContain("offset=1");
    const next = await call(conv, "Grep", { ...content, head_limit: 1, offset: 1 }, 10);
    expect(next.content).toContain("Showing entries 2\u20132 of 3");
    const past = await call(conv, "Grep", { ...content, offset: 5 }, 11);
    expect(past.content).toBe("No more results (3 total).");
    const everything = await call(conv, "Grep", { ...content, head_limit: 0 }, 12);
    expect(everything.content.split("\n")).toHaveLength(3);
    const none = await call(conv, "Grep", { pattern: "zzzz", offset: 4 }, 13);
    expect(none.content).toContain("No matches for zzzz");
    const old = await call(conv, "Grep", { pattern: "needle", ignoreCase: true }, 14);
    expect(old.isError).toBe(true);
  });

  it("write / read / edit / glob / grep round trip", async () => {
    const conv = await sandboxConversation();
    const w = await call(
      conv,
      "Write",
      { file_path: "/workspace/src/a.txt", content: "alpha\nbeta\ngamma\n" },
      1,
    );
    expect(w.isError).toBe(false);
    await call(conv, "Write", { file_path: "/workspace/src/b.md", content: "beta two\n" }, 2);

    const rd1 = await call(conv, "Read", { file_path: "/workspace/src/a.txt" }, 3);
    expect(rd1.content).toContain("1\talpha");
    expect(rd1.content).toContain("3\tgamma");
    const rd2 = await call(
      conv,
      "Read",
      { file_path: "/workspace/src/a.txt", offset: 2, limit: 1 },
      4,
    );
    expect(rd2.content).toContain("2\tbeta");
    expect(rd2.content).not.toContain("alpha");

    const e = await call(
      conv,
      "Edit",
      { file_path: "/workspace/src/a.txt", old_string: "beta", new_string: "BETA" },
      5,
    );
    expect(e.isError).toBe(false);
    const missing = await call(
      conv,
      "Edit",
      { file_path: "/workspace/src/a.txt", old_string: "nope", new_string: "x" },
      6,
    );
    expect(missing.isError).toBe(true);

    const g = await call(conv, "Glob", { pattern: "**/*.txt" }, 7);
    expect(g.content).toContain("/workspace/src/a.txt");
    expect(g.content).not.toContain("b.md");

    const gr = await call(conv, "Grep", { pattern: "beta", "-i": true, output_mode: "content" }, 8);
    expect(gr.content).toContain("/workspace/src/a.txt:2:BETA");
    expect(gr.content).toContain("/workspace/src/b.md:1:beta two");
    const grGlob = await call(
      conv,
      "Grep",
      { pattern: "beta", glob: "*.md", output_mode: "content" },
      9,
    );
    expect(grGlob.content).toContain("b.md");
    expect(grGlob.content).not.toContain("a.txt");

    // 多处匹配：不加 replace_all 报歧义；加了全部替换
    await call(conv, "Write", { file_path: "/workspace/r.txt", content: "x-x-x\n" }, 10);
    const amb = await call(
      conv,
      "Edit",
      { file_path: "/workspace/r.txt", old_string: "x", new_string: "y" },
      11,
    );
    expect(amb.isError).toBe(true);
    expect(amb.content).toContain("occurs 3 times");
    expect(amb.content).toContain("replace_all");
    const all = await call(
      conv,
      "Edit",
      { file_path: "/workspace/r.txt", old_string: "x", new_string: "$&y", replace_all: true },
      12,
    );
    expect(all.isError, all.content).toBe(false);
    expect(all.content).toContain("replaced 3 occurrences");
    const after = await call(conv, "Read", { file_path: "/workspace/r.txt" }, 13);
    expect(after.content).toContain("$&y-$&y-$&y");
  });

  it("a ToolError inside the sandbox call does not recreate the sandbox", async () => {
    const conv = await sandboxConversation();
    await call(
      conv,
      "Bash",
      { description: "Test step", command: "echo keep > /workspace/keep.txt" },
      1,
    );
    const handle = async () => (await instanceOf(conv))?.handle;
    const before = await handle();
    const r = await call(conv, "Read", { file_path: "/workspace/missing.txt" }, 2);
    expect(r.isError).toBe(true);
    expect(r.content).toContain("File not found");
    expect(await handle()).toEqual(before);
    const ok = await call(conv, "Read", { file_path: "/workspace/keep.txt" }, 3);
    expect(ok.content).not.toContain("recreated");
    expect(ok.content).toContain("keep");
  });

  it("paths outside the sandbox roots are rejected", async () => {
    const conv = await sandboxConversation();
    const a = await call(conv, "Read", { file_path: "/etc/passwd" }, 1);
    expect(a.isError).toBe(true);
    expect(a.content).toContain("/workspace");
    const b = await call(conv, "Write", { file_path: "/workspace/../etc/x", content: "x" }, 2);
    expect(b.isError).toBe(true);
    expect(b.content).toContain("..");
    const c = await call(conv, "Deliver", { file_path: "relative.txt" }, 3);
    expect(c.isError).toBe(true);
  });

  it("deliver writes the object and artifact_created; download follows conversation access", async () => {
    const conv = await sandboxConversation();
    await call(conv, "Write", { file_path: "/workspace/out/report.csv", content: "a,b\n1,2\n" }, 1);
    const r = await call(
      conv,
      "Deliver",
      { file_path: "/workspace/out/report.csv", name: "Q3 report.csv" },
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
    const got = await k.app.get(StorageService).kernel(orgId).get(a.objectKey);
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
      "Bash",
      {
        description: "Test step",
        command: `printf '%s' '${png.toString("base64")}' | base64 -d > /workspace/dot.png`,
      },
      1,
    );
    await call(conv, "Write", { file_path: "/workspace/notes.txt", content: "l1\nl2\n" }, 2);
    await call(
      conv,
      "Write",
      { file_path: "/workspace/page.svg", content: "<svg xmlns='http://www.w3.org/2000/svg'/>" },
      3,
    );
    await call(conv, "Deliver", { file_path: "/workspace/dot.png" }, 4);
    await call(conv, "Deliver", { file_path: "/workspace/notes.txt" }, 5);
    await call(conv, "Deliver", { file_path: "/workspace/page.svg" }, 6);
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
      "Bash",
      // 972 字节（低于本测试的 deliverMaxBytes 1024），120 行：超过预览的行数上限
      { description: "Test step", command: "seq 1 120 | sed 's/^/line /' > /workspace/long.log" },
      1,
    );
    await call(conv, "Deliver", { file_path: "/workspace/long.log" }, 2);
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
    const store = k.app.get(StorageService).kernel(orgId);
    const put = async (name: string, bytes: Buffer, contentType = "text/plain") => {
      const artifactId = randomUUID();
      const objectKey = `artifacts/${conv}/${artifactId}`;
      await store.put(objectKey, bytes, {
        contentType,
        size: bytes.byteLength,
        signal: AbortSignal.timeout(10_000),
      });
      await k.app.get(EventLog).append(conv, [
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

  it("environment route returns the bound environment", async () => {
    const conv = await sandboxConversation();
    const url = `/api/v1/orgs/${orgId}/conversations/${conv}/environment`;
    type V = {
      environment: {
        id: string;
        isDefault: boolean;
        instance: { status: string; lastUsedAt: string } | null;
      } | null;
    };
    const before = await owner({ method: "GET", url });
    expect(before.statusCode, before.body).toBe(200);
    const env = (before.json() as V).environment;
    // bound at create to the owner's default environment, no instance before first use
    expect(env?.id).toBe(await envOf(conv));
    expect(env?.isDefault).toBe(true);
    expect(env?.instance).toBeNull();
    await call(conv, "Bash", { description: "Test step", command: "true" }, 1);
    const running = await owner({ method: "GET", url });
    expect(running.statusCode, running.body).toBe(200);
    const s = (running.json() as V).environment?.instance;
    expect(s?.status).toBe("running");
    expect(Number.isNaN(Date.parse(s?.lastUsedAt ?? ""))).toBe(false);
    // someone who cannot see the conversation: as for its stream, 404 conversation.not_found
    const denied = await other({ method: "GET", url });
    expect(denied.statusCode).toBe(404);
    expect((denied.json() as { error: { code: string } }).error.code).toBe(
      "conversation.not_found",
    );
    expect(
      await k.app.get(SandboxService).suspendIdle(new Date(Date.now() + 24 * 3600_000)),
    ).toBeGreaterThan(0);
    const suspended = await owner({ method: "GET", url });
    expect((suspended.json() as V).environment?.instance?.status).toBe("suspended");
    // a deleted environment: null (its sandbox tools fail)
    const del = await owner({
      method: "DELETE",
      url: `/api/v1/orgs/${orgId}/environments/${await envOf(conv)}`,
    });
    expect(del.statusCode, del.body).toBe(202);
    expect(((await owner({ method: "GET", url })).json() as V).environment).toBeNull();
  });

  it("deliver refuses files over sandbox.deliverMaxBytes", async () => {
    const conv = await sandboxConversation();
    await call(
      conv,
      "Bash",
      { description: "Test step", command: "head -c 2048 /dev/zero > /workspace/big.bin" },
      1,
    );
    const r = await call(conv, "Deliver", { file_path: "/workspace/big.bin" }, 2);
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
      `tool:Write:${JSON.stringify({ file_path: "/workspace/x.txt", content: "x" })}`,
    );
    const asked = await waitForEvent(db, conv, (e) => e.type === "approval_requested");
    expect(asked.type === "approval_requested" && asked.payload.toolKey).toBe("Write");

    const conv2 = await sandboxConversation();
    const r = await call(conv2, "Read", { file_path: "/workspace/none.txt" }, 1);
    expect(r.toolKey).toBe("Read");
    expect((await eventsOf(db, conv2)).some((e) => e.type === "approval_requested")).toBe(false);
  });

  /** Uploads a file as the owner and sends it with a message into the conversation's first turn `n`. */
  async function sendWithAttachment(
    conv: string,
    name: string,
    text: string,
    bytes: Buffer,
    n: number,
  ): Promise<void> {
    const created = await owner({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/attachments`,
      payload: { name, contentType: "text/csv", size: bytes.length },
    });
    expect(created.statusCode, created.body).toBe(201);
    const c = created.json() as {
      id: string;
      upload: { method: string; url: string; headers: Record<string, string>; fields?: object };
    };
    const form = new FormData();
    for (const [key, v] of Object.entries(c.upload.fields ?? {})) form.append(key, String(v));
    form.append("file", new Blob([new Uint8Array(bytes)], { type: "text/csv" }));
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
      payload: { text, files: [c.id] },
    });
    expect(sent.statusCode, sent.body).toBe(202);
    await waitForTerminal(db, conv, n, 30_000);
  }

  /** A conversation's attachment directory: the first 12 hex digits of its id. */
  const attDir = (conv: string) =>
    `/workspace/attachments/${conv.replaceAll("-", "").slice(0, 12)}`;

  it("conversation attachments appear under /workspace/attachments/<conversation>", async () => {
    const conv = await sandboxConversation();
    const dir = attDir(conv);
    await sendWithAttachment(
      conv,
      "fruit.csv",
      "echo:got it",
      Buffer.from("name,qty\napple,3\n"),
      1,
    );

    const r = await call(
      conv,
      "Bash",
      { description: "Test step", command: `cat ${dir}/fruit.csv` },
      2,
    );
    expect(r.content).toContain("apple,3");
    expect(r.content).toContain(`${dir}/fruit.csv`);
    // 已同步过的不再提示
    const r2 = await call(conv, "Bash", { description: "Test step", command: `ls ${dir}` }, 3);
    expect(r2.content).toContain("fruit.csv");
    expect(r2.content).not.toContain("Attachments copied");
    // 标记文件不出现在 glob / grep 结果里（它的内容含 fruit.csv）
    const g = await call(conv, "Glob", { pattern: "**" }, 4);
    expect(g.content).toContain(`${dir}/fruit.csv`);
    expect(g.content).not.toContain(".capybara-sync.json");
    const gr = await call(conv, "Grep", { pattern: "fruit|apple", output_mode: "content" }, 5);
    expect(gr.content).toContain(`${dir}/fruit.csv:2:apple,3`);
    expect(gr.content).not.toContain(".capybara-sync.json");

    // the instance is gone at the provider: rebuilt on the kept files, the model is told the
    // instance restarted, and the attachments (still there) are not copied again
    const row = await instanceOf(conv);
    await removeFakeSandbox(root, (row?.handle as { id: string } | undefined)?.id as string);
    const r3 = await call(
      conv,
      "Bash",
      { description: "Test step", command: `cat ${dir}/fruit.csv` },
      6,
    );
    expect(r3.content).not.toContain("Attachments copied");
    expect(r3.content).toContain("apple,3");
    expect(r3.content).toContain(SANDBOX_RESTARTED_NOTICE);
  });

  it("attachments of two conversations do not collide", async () => {
    const a = await sandboxConversation();
    const b = await sandboxConversation();
    expect(await envOf(a)).toBe(await envOf(b));
    await sendWithAttachment(a, "a.txt", "echo:one", Buffer.from("from A\n"), 1);
    await sendWithAttachment(b, "a.txt", "echo:two", Buffer.from("from B\n"), 1);
    const ra = await call(
      a,
      "Bash",
      { description: "Test step", command: `cat ${attDir(a)}/a.txt` },
      2,
    );
    expect(ra.content).toContain("from A");
    expect(ra.content).toContain(`${attDir(a)}/a.txt`);
    const rb = await call(
      b,
      "Bash",
      { description: "Test step", command: `cat ${attDir(b)}/a.txt` },
      2,
    );
    expect(rb.content).toContain("from B");
    expect(attDir(a)).not.toBe(attDir(b));
    // both directories exist in the one file system
    const ls = await call(
      b,
      "Bash",
      { description: "Test step", command: "ls /workspace/attachments" },
      3,
    );
    expect(ls.content).toContain(attDir(a).split("/").at(-1) as string);
    expect(ls.content).toContain(attDir(b).split("/").at(-1) as string);
  });

  it("restart notice says files are kept", async () => {
    const conv = await sandboxConversation();
    await call(
      conv,
      "Bash",
      { description: "Test step", command: "echo kept > /workspace/k.txt" },
      1,
    );
    const row = await instanceOf(conv);
    await removeFakeSandbox(root, (row?.handle as { id: string } | undefined)?.id as string);
    const r = await call(
      conv,
      "Bash",
      { description: "Test step", command: "cat /workspace/k.txt" },
      2,
    );
    expect(r.content).toContain(SANDBOX_RESTARTED_NOTICE);
    expect(SANDBOX_RESTARTED_NOTICE).toContain("files are kept");
    expect(r.content).toContain("kept");
  });

  it("after a files reset each conversation of the environment is told once that its files are gone", async () => {
    // the file system comes back under the same id, as sandbox-docker's volumes do
    await setFakeFileSystemIdsByName(root, true);
    try {
      const a = await sandboxConversation();
      const b = await sandboxConversation();
      const env = await envOf(a);
      expect(await envOf(b)).toBe(env);
      const write = { description: "Test step", command: "echo old > /workspace/r.txt" };
      expect((await call(a, "Bash", write, 1)).content).toContain(SANDBOX_STARTED_NOTICE);
      // b joins the running instance: no notice
      expect((await call(b, "Bash", write, 1)).content).toBe("[exit code: 0]");
      await k.app.get(SandboxService).resetFileSystem(env);
      const ls = { description: "Test step", command: "ls -A /workspace; echo done" };
      for (const conv of [a, b]) {
        const r = await call(conv, "Bash", ls, 2);
        expect(r.content.startsWith(SANDBOX_FILES_RESET_NOTICE), r.content).toBe(true);
        expect(r.content).not.toContain(SANDBOX_RESTARTED_NOTICE);
        expect(r.content).not.toContain("r.txt");
      }
      const again = await call(a, "Bash", ls, 3);
      expect(again.content).not.toContain(SANDBOX_FILES_RESET_NOTICE);
      expect(again.content).not.toContain(SANDBOX_RESTARTED_NOTICE);
    } finally {
      await setFakeFileSystemIdsByName(root, false);
    }
  });

  it("an instance suspended, then destroyed after inactivity: the next command is told files are kept", async () => {
    await setFakeFileSystemIdsByName(root, true);
    try {
      const conv = await sandboxConversation();
      await call(
        conv,
        "Bash",
        { description: "Test step", command: "echo kept > /workspace/s.txt" },
        1,
      );
      const sandbox = k.app.get(SandboxService);
      const later = (days: number) => new Date(Date.now() + days * 86_400_000);
      await sandbox.suspendIdle(later(1));
      expect((await instanceOf(conv))?.status).toBe("suspended");
      await sandbox.destroyInactive(later(30));
      const r = await call(
        conv,
        "Bash",
        { description: "Test step", command: "cat /workspace/s.txt" },
        2,
      );
      expect(r.content).toContain(SANDBOX_RESTARTED_NOTICE);
      expect(r.content).not.toContain(SANDBOX_FILES_RESET_NOTICE);
      expect(r.content).toContain("kept");
    } finally {
      await setFakeFileSystemIdsByName(root, false);
    }
  });
});

describe("sandbox provider unreachable", { timeout: 90_000 }, () => {
  afterEach(() => setFakeSandboxFault(root, null));

  /** The warn records of unreachable-provider tool calls. */
  const unreachableWarns = () =>
    logLines
      .map((l) => JSON.parse(l) as { level?: unknown; msg?: string; err?: { message?: string } })
      .filter((l) => l.msg === "sandbox provider unreachable");
  /** How many tool calls ended in the pipeline's generic failure. */
  const genericFailures = () =>
    logLines.filter((l) => l.includes('"msg":"tool call failed"')).length;

  it("connection refused before the instance exists: Bash gets the actionable error, the cause is logged", async () => {
    const conv = await sandboxConversation();
    await setFakeSandboxFault(root, { code: "ECONNREFUSED" });
    const before = unreachableWarns().length;
    const failedBefore = genericFailures();
    const r = await call(conv, "Bash", { description: "Test step", command: "echo hi" }, 1);
    expect(r.isError).toBe(true);
    expect(r.content).toBe(SANDBOX_UNREACHABLE_TEXT);
    const warns = unreachableWarns().slice(before);
    expect(warns).toHaveLength(1);
    // the provider's own error, unchanged
    expect(warns[0]?.err?.message).toBe("connect ECONNREFUSED 127.0.0.1:2375");
    // the generic pipeline failure is not used
    expect(genericFailures()).toBe(failedBefore);
    await setFakeSandboxFault(root, null);
    const ok = await call(conv, "Bash", { description: "Test step", command: "echo back" }, 2);
    expect(ok.isError).toBe(false);
    expect(ok.content).toContain("back");
  });

  it("every sandbox tool on a running instance maps a refused connection; nothing is written", async () => {
    const conv = await sandboxConversation();
    let n = 0;
    await call(conv, "Write", { file_path: "/workspace/u.txt", content: "one\n" }, ++n);
    await call(conv, "Read", { file_path: "/workspace/u.txt" }, ++n);
    await setFakeSandboxFault(root, { code: "ECONNREFUSED" });
    const calls: [string, unknown][] = [
      ["Bash", { description: "Test step", command: "echo two > /workspace/u.txt" }],
      ["Read", { file_path: "/workspace/u.txt" }],
      ["Write", { file_path: "/workspace/u.txt", content: "three\n" }],
      ["Edit", { file_path: "/workspace/u.txt", old_string: "one", new_string: "four" }],
      ["Glob", { pattern: "*.txt" }],
      ["Grep", { pattern: "one" }],
      ["Deliver", { file_path: "/workspace/u.txt" }],
    ];
    for (const [key, input] of calls) {
      const r = await call(conv, key, input, ++n);
      expect(r.isError, key).toBe(true);
      expect(r.content, key).toBe(SANDBOX_UNREACHABLE_TEXT);
    }
    await setFakeSandboxFault(root, null);
    const after = await call(conv, "Read", { file_path: "/workspace/u.txt" }, ++n);
    expect(after.content).toContain("one");
  });

  it("a fetch-wrapped refused connection maps the same; a reset connection says it may have run", async () => {
    const conv = await sandboxConversation();
    await call(conv, "Bash", { description: "Test step", command: "echo up" }, 1);
    await setFakeSandboxFault(root, { code: "ECONNREFUSED", wrap: "fetch" });
    const refused = await call(conv, "Bash", { description: "Test step", command: "echo x" }, 2);
    expect(refused.content).toBe(SANDBOX_UNREACHABLE_TEXT);
    await setFakeSandboxFault(root, { code: "ECONNRESET" });
    const before = unreachableWarns().length;
    const reset = await call(conv, "Bash", { description: "Test step", command: "echo x" }, 3);
    expect(reset.isError).toBe(true);
    expect(reset.content).toBe(SANDBOX_CONNECTION_DROPPED_TEXT);
    expect(unreachableWarns().slice(before)[0]?.err?.message).toBe("read ECONNRESET");
  });
});
