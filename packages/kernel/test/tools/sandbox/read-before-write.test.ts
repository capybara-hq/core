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
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ConversationEvent } from "../../../src/conversations/events.js";
import { type KernelSchemaDb, kernelDb } from "../../../src/db/kernel-schema.js";
import { createDb } from "../../../src/db/pool.js";
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
  waitForTerminal,
} from "../../helpers/runs.js";

/**
 * Read before Write and Edit (tool naming spec 4.5), on a real kernel and the fake sandbox.
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
let raw: ReturnType<typeof createDb>;
let destroyDb: () => Promise<void>;
let k: TestKernel;
let root: string;

beforeAll(async () => {
  [pgc, rd, s3] = await Promise.all([startTestPostgres(), startTestRedis(), startTestS3()]);
  raw = createDb(pgc.url, 3);
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
});

afterAll(async () => {
  await k?.close();
  await destroyDb?.();
  await Promise.all([pgc?.stop(), rd?.stop(), s3?.stop()]);
  if (root) await rm(root, { recursive: true, force: true });
});

let owner: Req;
let _other: Req;
let orgId: string;

beforeEach(async () => {
  await truncateTables(
    db,
    "capybara.sandboxes, capybara.attachments, capybara.approvals, capybara.tool_outputs, capybara.conversation_events, capybara.runs, capybara.conversations, capybara.agent_versions, capybara.agent_members, capybara.agents, capybara.memberships, capybara.orgs, capybara.sessions, capybara.local_passwords, capybara.identities, capybara.accounts",
  );
  const accounts = accountsFor(db);
  const ownerId = (await accounts.createLocal({ login: "owner", password: PW, displayName: "O" }))
    .id;
  const otherId = (await accounts.createLocal({ login: "other", password: PW, displayName: "X" }))
    .id;
  owner = await session(k, "owner");
  orgId = await createOrg(owner);
  await testMembers(db).add(orgId, otherId, "member", ownerId);
  _other = await session(k, "other");
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

const NOT_READ = "File has not been read yet. Read it first before writing to it.";
const MODIFIED =
  "File has been modified since it was read, either by the user or by another command. Read it again before writing to it.";

describe("read before write", () => {
  /** A conversation with a stepper over `call` (n counts the finished runs). */
  async function session1() {
    const conv = await sandboxConversation();
    let n = 0;
    const step = (key: string, input: unknown) => call(conv, key, input, ++n);
    return { conv, step };
  }

  it("Edit without a prior Read fails and leaves the file unchanged", async () => {
    const { step } = await session1();
    await step("Bash", {
      description: "seed",
      command: "printf 'hello world\\n' > /workspace/a.txt",
    });
    const r = await step("Edit", {
      file_path: "/workspace/a.txt",
      old_string: "hello",
      new_string: "bye",
    });
    expect(r.isError).toBe(true);
    expect(r.content).toBe(NOT_READ);
    // display only: the web shows the refusal as the guard working, not a failure
    expect(r.view).toEqual({ kind: "guard", reason: "not_read" });
    const cat = await step("Bash", { description: "cat", command: "cat /workspace/a.txt" });
    expect(cat.content).toContain("hello world");
  });

  it("Read then Edit succeeds, and a second Edit right after succeeds too", async () => {
    const { step } = await session1();
    await step("Bash", { description: "seed", command: "printf 'one two\\n' > /workspace/a.txt" });
    await step("Read", { file_path: "/workspace/a.txt" });
    const e1 = await step("Edit", {
      file_path: "/workspace/a.txt",
      old_string: "one",
      new_string: "uno",
    });
    expect(e1.isError).toBe(false);
    const e2 = await step("Edit", {
      file_path: "/workspace/a.txt",
      old_string: "two",
      new_string: "dos",
    });
    expect(e2.isError).toBe(false);
    expect(e2.content).not.toContain("modified");
  });

  it("a change by Bash after the Read is caught; reading again fixes it", async () => {
    const { step } = await session1();
    await step("Bash", { description: "seed", command: "printf 'one\\n' > /workspace/a.txt" });
    await step("Read", { file_path: "/workspace/a.txt" });
    await step("Bash", { description: "append", command: "printf 'more\\n' >> /workspace/a.txt" });
    const bad = await step("Edit", {
      file_path: "/workspace/a.txt",
      old_string: "one",
      new_string: "uno",
    });
    expect(bad.isError).toBe(true);
    expect(bad.content).toBe(MODIFIED);
    expect(bad.view).toEqual({ kind: "guard", reason: "modified" });
    await step("Read", { file_path: "/workspace/a.txt" });
    const ok = await step("Edit", {
      file_path: "/workspace/a.txt",
      old_string: "one",
      new_string: "uno",
    });
    expect(ok.isError).toBe(false);
  });

  it("Write to a new path needs no read; Write to an unread existing file fails; a Write is a read", async () => {
    const { step } = await session1();
    const fresh = await step("Write", { file_path: "/workspace/new.txt", content: "v1\n" });
    expect(fresh.isError).toBe(false);
    // the Write recorded the state: overwriting again needs no Read
    const again = await step("Write", { file_path: "/workspace/new.txt", content: "v2\n" });
    expect(again.isError).toBe(false);
    await step("Bash", { description: "seed", command: "printf 'x\\n' > /workspace/old.txt" });
    const bad = await step("Write", { file_path: "/workspace/old.txt", content: "y\n" });
    expect(bad.isError).toBe(true);
    expect(bad.content).toContain(NOT_READ);
    expect(bad.view).toEqual({ kind: "guard", reason: "not_read" });
    const cat = await step("Bash", { description: "cat", command: "cat /workspace/old.txt" });
    expect(cat.content).toContain("x");
  });

  it("Read with a partial range and an unnormalized path counts for the normalized path", async () => {
    const { step } = await session1();
    await step("Bash", {
      description: "seed",
      command: "printf 'l1\\nl2\\nl3\\nl4\\nl5\\nl6\\nl7\\nl8\\n' > /workspace/a.txt",
    });
    await step("Read", { file_path: "/workspace/./a.txt", offset: 5, limit: 2 });
    const r = await step("Edit", {
      file_path: "/workspace/a.txt",
      old_string: "l1",
      new_string: "L1",
    });
    expect(r.isError).toBe(false);
  });

  it("a file over Read's byte limit: Read then Write succeeds; a same-size change beyond the read bytes is not detected", async () => {
    const { step } = await session1();
    // 11 MB (limit is 10 MB); the seed is a command the review allows
    await step("Bash", {
      description: "seed",
      command: "head -c 11000000 /dev/zero > /workspace/big.txt",
      timeout: 60_000,
    });
    const before = await step("Write", { file_path: "/workspace/big.txt", content: "x" });
    expect(before.isError).toBe(true);
    expect(before.content).toContain(NOT_READ);
    await step("Read", { file_path: "/workspace/big.txt", limit: 1 });
    // same size, changed past the first 10 MB: the digest covers only the bytes read (documented limit)
    await step("Bash", {
      description: "tweak",
      command: "printf 'Z' | dd of=/workspace/big.txt bs=1 seek=10999990 conv=notrunc 2>/dev/null",
    });
    const ok = await step("Write", { file_path: "/workspace/big.txt", content: "small\n" });
    expect(ok.isError).toBe(false);
  });

  it("a tool_result without view.file (a result recorded before the change) counts as not read", async () => {
    const { conv, step } = await session1();
    await step("Bash", { description: "seed", command: "printf 'one\\n' > /workspace/a.txt" });
    await step("Read", { file_path: "/workspace/a.txt" });
    // strip view.file from every recorded result, as if recorded by an older kernel
    await sql`UPDATE capybara.conversation_events SET payload = payload #- '{view,file}'
      WHERE conversation_id = ${conv} AND type = 'tool_result'`.execute(raw);
    const r = await step("Edit", {
      file_path: "/workspace/a.txt",
      old_string: "one",
      new_string: "uno",
    });
    expect(r.isError).toBe(true);
    expect(r.content).toContain(NOT_READ);
  });

  // The pipeline runs one step's calls in order and logs each result before the next call starts,
  // so the rule holds inside one assistant message (the ordering it depends on).
  async function oneMessage(conv: string, n: number, calls: { name: string; input: unknown }[]) {
    await postMessage(owner, orgId, conv, `tools:${JSON.stringify(calls)}`);
    await waitForTerminal(db, conv, n, 30_000);
    return (await eventsOf(db, conv))
      .filter((e): e is ToolResultEvent => e.type === "tool_result")
      .slice(-calls.length)
      .map((e) => e.payload);
  }

  it("Read then Edit of one file in one assistant message both succeed", async () => {
    const { conv, step } = await session1();
    await step("Bash", { description: "seed", command: "printf 'one two\\n' > /workspace/a.txt" });
    const r = await oneMessage(conv, 2, [
      { name: "Read", input: { file_path: "/workspace/a.txt" } },
      {
        name: "Edit",
        input: { file_path: "/workspace/a.txt", old_string: "one", new_string: "uno" },
      },
    ]);
    expect(r.map((x) => [x.toolKey, x.isError])).toEqual([
      ["Read", false],
      ["Edit", false],
    ]);
  });

  it("two Edits of one file in one assistant message both succeed", async () => {
    const { conv, step } = await session1();
    await step("Bash", { description: "seed", command: "printf 'one two\\n' > /workspace/a.txt" });
    await step("Read", { file_path: "/workspace/a.txt" });
    const r = await oneMessage(conv, 3, [
      {
        name: "Edit",
        input: { file_path: "/workspace/a.txt", old_string: "one", new_string: "uno" },
      },
      {
        name: "Edit",
        input: { file_path: "/workspace/a.txt", old_string: "two", new_string: "dos" },
      },
    ]);
    expect(r.map((x) => x.isError)).toEqual([false, false]);
  });
});
