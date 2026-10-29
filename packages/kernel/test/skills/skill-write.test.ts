import { mkdtemp, readFile, rm } from "node:fs/promises";
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
import type { ConversationEvent } from "../../src/conversations/events.js";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import type { Kernel } from "../../src/kernel.js";
import { sameSkills, skillsChangeText } from "../../src/runtime/context/skills.js";
import { SkillsCatalogService } from "../../src/skills/catalog.js";
import { AGENT_SKILLS_MAX } from "../../src/skills/changes.service.js";
import { skillLoadTool } from "../../src/tools/builtins/skill-load.js";
import { buildSkillWrite, SKILL_WRITE_MAX_BYTES } from "../../src/tools/builtins/skill-write.js";
import { truncateTables } from "../helpers/db.js";
import { accountsFor } from "../helpers/identity.js";
import { testMembers } from "../helpers/members.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
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
  waitFor,
  waitForTerminal,
} from "../helpers/runs.js";

/**
 * M5 T15：agent 自写技能（`skill_write`）与共享 agent 的技能变更审批（R4），以及收件箱汇总。
 * 真实内核 + model-fake（`tool:<key>:<json>`）+ SeaweedFS。
 */

const OBJECT_STORE = fakeExtensionEntry("fake-object-store");
const SANDBOX_FAKE = fileURLToPath(
  new URL("../fixtures/plugins/sandbox-fake/index.ts", import.meta.url),
);

let pgc: TestContainer;
let rd: TestContainer;
let s3: TestS3;
let db: KernelSchemaDb;
let destroyDb: () => Promise<void>;
let k: Kernel;
let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "cap-skill-write-"));
  [pgc, rd, s3] = await Promise.all([startTestPostgres(), startTestRedis(), startTestS3()]);
  const raw = createDb(pgc.url, 3);
  db = kernelDb(raw);
  destroyDb = () => raw.destroy();
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
let ownerId: string;
let member: Req;
let memberId: string;
let other: Req;
let orgId: string;

beforeEach(async () => {
  await truncateTables(
    db,
    "capybara.skill_change_requests, capybara.sandboxes, capybara.skill_versions, capybara.skills, capybara.attachments, capybara.approvals, capybara.conversation_tool_grants, capybara.tool_grants, capybara.tool_outputs, capybara.conversation_events, capybara.runs, capybara.conversations, capybara.agent_versions, capybara.agent_members, capybara.agents, capybara.audit_events, capybara.memberships, capybara.orgs, capybara.sessions, capybara.local_passwords, capybara.identities, capybara.accounts",
  );
  const accounts = accountsFor(db);
  ownerId = (await accounts.createLocal({ login: "owner", password: PW, displayName: "O" })).id;
  memberId = (await accounts.createLocal({ login: "mem", password: PW, displayName: "M" })).id;
  const otherId = (await accounts.createLocal({ login: "oth", password: PW, displayName: "X" })).id;
  owner = await session(k, "owner");
  orgId = await createOrg(owner);
  await testMembers(db).add(orgId, memberId, "member", ownerId);
  await testMembers(db).add(orgId, otherId, "admin", ownerId);
  member = await session(k, "mem");
  other = await session(k, "oth");
});

async function createAgent(
  visibility: "private" | "org",
  extraTools: { kind: "builtin"; name: string }[] = [],
  writePolicy?: "allow" | "ask",
): Promise<string> {
  const res = await owner({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/agents`,
    payload: {
      definition: {
        name: "Writer",
        instructions: "Write skills.",
        model: { provider: "model-fake", model: "fake-1" },
        tools: [{ kind: "builtin", name: "skill_write" }, ...extraTools],
        ...(writePolicy !== undefined && { skills: { writePolicy } }),
      },
      visibility,
    },
  });
  expect(res.statusCode, res.body).toBe(201);
  return (res.json() as { agent: { id: string } }).agent.id;
}

type ToolResultEvent = Extract<ConversationEvent, { type: "tool_result" }>;
type CatalogEvent = Extract<ConversationEvent, { type: "skills_catalog" }>;

const lastResult = async (convId: string) => {
  const r = (await eventsOf(db, convId)).filter(
    (e): e is ToolResultEvent => e.type === "tool_result",
  );
  return (r.at(-1) as ToolResultEvent).payload;
};

/** 发一条脚本消息并等第 n 个终态，返回最后一个工具结果。 */
async function call(req: Req, convId: string, key: string, input: unknown, n: number) {
  await postMessage(req, orgId, convId, `tool:${key}:${JSON.stringify(input)}`);
  await waitForTerminal(db, convId, n, 30_000);
  const r = await lastResult(convId);
  expect(r.toolKey).toBe(key);
  return r;
}

const catalogs = async (convId: string) =>
  (await eventsOf(db, convId)).filter((e): e is CatalogEvent => e.type === "skills_catalog");

const write = (name: string, body: string, extra: { path: string; content: string }[] = []) => ({
  name,
  description: `Use for ${name} work.`,
  files: [{ path: "SKILL.md", content: body }, ...extra],
});

const audits = async (action: string) =>
  db
    .selectFrom("audit_events")
    .select(["action", "actor_account_id", "detail", "target"])
    .where("action", "=", action)
    .execute();

/** 等到会话出现一条待处理的工具审批，由 `req` 批准。 */
async function approvePending(req: Req, convId: string): Promise<string> {
  const a = await waitFor(
    () =>
      db
        .selectFrom("approvals")
        .select(["id", "tool_key", "requested_for"])
        .where("conversation_id", "=", convId)
        .where("status", "=", "pending")
        .executeTakeFirst(),
    15_000,
    "pending approval",
  );
  expect(a.tool_key).toBe("skill_write");
  const res = await req({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/approvals/${a.id}/decision`,
    payload: { decision: "approve" },
  });
  expect(res.statusCode, res.body).toBe(200);
  return a.id;
}

/** 共享 agent 上写技能：发消息 → 发起人确认工具调用 → 等运行结束。 */
async function sharedWrite(req: Req, convId: string, input: unknown, n: number) {
  await postMessage(req, orgId, convId, `tool:skill_write:${JSON.stringify(input)}`);
  await approvePending(req, convId);
  await waitForTerminal(db, convId, n, 30_000);
  return lastResult(convId);
}

const pending = () =>
  db
    .selectFrom("skill_change_requests")
    .selectAll()
    .where("status", "=", "pending")
    .orderBy("created_at")
    .execute();

const decide = (req: Req, id: string, decision: "approve" | "reject") =>
  req({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/skill-changes/${id}/decide`,
    payload: { decision },
  });

describe("catalog source (pure)", () => {
  const e = (version: number, source: string) => ({
    id: "s1",
    name: "x",
    description: "d",
    version,
    source,
  });
  it("same id + version but a different source is a change, rendered as updated", () => {
    expect(sameSkills([e(2, "skills/a/")], [e(2, "skills/b/")])).toBe(false);
    expect(skillsChangeText([e(2, "skills/a/")], [e(2, "skills/b/")])).toContain("Updated skills");
    expect(sameSkills([e(2, "skills/a/")], [e(2, "skills/a/")])).toBe(true);
  });
  it("NUL in the SKILL.md body or the description is rejected", () => {
    const body = buildSkillWrite({
      name: "x",
      description: "Use for x.",
      files: [{ path: "SKILL.md", content: "a\u0000b" }],
    });
    expect("errors" in body && body.errors.join(" ")).toMatch(/SKILL\.md: only text/);
    const desc = buildSkillWrite({ name: "x", description: "Use\u0000x.", files: [] });
    expect("errors" in desc && desc.errors.join(" ")).toMatch(/description: only text/);
  });
});

describe("buildSkillWrite (pure)", () => {
  it("synthesizes SKILL.md from name + description + body, dropping frontmatter in the body", () => {
    const r = buildSkillWrite({
      name: "pdf-report",
      description: "Make PDF reports: use when asked for a report.",
      files: [
        { path: "SKILL.md", content: "---\nname: other\ndescription: x\n---\n# Steps\n1. go" },
        { path: "scripts/run.py", content: "print(1)" },
      ],
    });
    if ("errors" in r) throw new Error(r.errors.join("; "));
    const md = new TextDecoder().decode(r.files.find((f) => f.path === "SKILL.md")?.data);
    expect(md).toBe(
      '---\nname: pdf-report\ndescription: "Make PDF reports: use when asked for a report."\n---\n\n# Steps\n1. go\n',
    );
    expect(r.manifest.files.map((f) => f.path)).toEqual(["SKILL.md", "scripts/run.py"]);
    expect(r.manifest.description).toBe("Make PDF reports: use when asked for a report.");
  });

  it("without a SKILL.md entry the body is empty", () => {
    const r = buildSkillWrite({ name: "x", description: "Use for x.", files: [] });
    if ("errors" in r) throw new Error(r.errors.join("; "));
    expect(r.manifest.files.map((f) => f.path)).toEqual(["SKILL.md"]);
  });

  it(`rejects skills over ${SKILL_WRITE_MAX_BYTES} bytes, binary content, bad paths and XML in the description`, () => {
    const big = buildSkillWrite({
      name: "big",
      description: "Use for big.",
      files: [{ path: "big.txt", content: "a".repeat(SKILL_WRITE_MAX_BYTES) }],
    });
    expect("errors" in big && big.errors.join(" ")).toMatch(/1 MB/);
    const bin = buildSkillWrite({
      name: "bin",
      description: "Use for bin.",
      files: [{ path: "b.bin", content: "a\u0000b" }],
    });
    expect("errors" in bin && bin.errors.join(" ")).toMatch(/text/i);
    const paths = buildSkillWrite({
      name: "p",
      description: "Use for p.",
      files: [
        { path: "/abs.txt", content: "x" },
        { path: "a\\b.txt", content: "x" },
        { path: "dup.txt", content: "x" },
        { path: "DUP.txt", content: "x" },
      ],
    });
    expect("errors" in paths && paths.errors.length).toBeGreaterThanOrEqual(3);
    const xml = buildSkillWrite({ name: "x", description: "Use <b>me</b>.", files: [] });
    expect("errors" in xml).toBe(true);
  });
});

describe("skill_write on a private agent", { timeout: 120_000 }, () => {
  it("writes a new version immediately (no approval), visible within the same run and loadable", async () => {
    const agentId = await createAgent("private");
    const conv = await createConv(owner, orgId, agentId);

    const r = await call(
      owner,
      conv,
      "skill_write",
      write("notes", "# Notes\nTake notes v1.", [{ path: "scripts/a.sh", content: "echo a" }]),
      1,
    );
    expect(r.isError, r.content).toBe(false);
    expect(r.content).toContain("version 1");
    expect(r.display?.summary.zh).toContain("notes");
    expect(r.display?.summary.en).toContain("notes");
    expect(await db.selectFrom("approvals").select("id").execute()).toHaveLength(0);
    expect(await db.selectFrom("skill_change_requests").select("id").execute()).toHaveLength(0);

    const skill = await db
      .selectFrom("skills")
      .selectAll()
      .where("agent_id", "=", agentId)
      .executeTakeFirstOrThrow();
    expect(skill).toMatchObject({ scope: "agent", name: "notes", current_version: 1 });
    const v = await db
      .selectFrom("skill_versions")
      .selectAll()
      .where("skill_id", "=", skill.id)
      .executeTakeFirstOrThrow();
    expect(v.manifest.files.map((f) => f.path).sort()).toEqual(["SKILL.md", "scripts/a.sh"]);
    // 合成的 SKILL.md：frontmatter 来自 name / description
    const md = await k.storage.kernel(orgId).get(`${v.object_prefix}SKILL.md`);
    const text = await new Response(md?.body).text();
    expect(text).toMatch(/^---\nname: notes\ndescription: Use for notes work\.\n---\n/);
    expect(text).toContain("Take notes v1.");

    // 同一运行内：工具成功后立即追加目录快照，下一次模型请求就带上 skill_load
    const events = await eventsOf(db, conv);
    const snapIdx = events.findIndex((e) => e.type === "skills_catalog");
    const resultIdx = events.findIndex((e) => e.type === "tool_result");
    expect(snapIdx).toBeGreaterThan(-1);
    const calls = events.filter(
      (e): e is Extract<ConversationEvent, { type: "model_call" }> => e.type === "model_call",
    );
    const snapSeq = events[snapIdx]?.seq ?? 0;
    const resultSeq = events[resultIdx]?.seq ?? 0;
    // 快照与工具结果同一运行：之后的第一次模型请求带上 skill_load
    expect(events[snapIdx]?.runId).toBe(events[resultIdx]?.runId);
    const after = calls.filter((c) => c.seq > Math.max(snapSeq, resultSeq));
    expect(after.length).toBeGreaterThan(0);
    expect(after[0]?.runId).toBe(events[resultIdx]?.runId);
    expect(after[0]?.payload.request.tools?.map((t) => t.key)).toContain("skill_load");
    expect((await catalogs(conv)).at(-1)?.payload.skills).toEqual([
      {
        id: skill.id,
        name: "notes",
        description: "Use for notes work.",
        version: 1,
        source: v.object_prefix,
      },
    ]);

    const loaded = await call(owner, conv, "skill_load", { name: "notes" }, 2);
    expect(loaded.isError, loaded.content).toBe(false);
    expect(loaded.content).toContain("Take notes v1.");

    // 再写：新版本
    const r2 = await call(owner, conv, "skill_write", write("notes", "Take notes v2."), 3);
    expect(r2.isError, r2.content).toBe(false);
    expect(r2.content).toContain("version 2");
    const l2 = await call(owner, conv, "skill_load", { name: "notes" }, 4);
    expect(l2.content).toContain("Take notes v2.");
    expect(l2.content).toContain("version 2");

    const created = await audits("skill.created");
    const versioned = await audits("skill.version_created");
    expect(created).toHaveLength(1);
    expect(versioned).toHaveLength(1);
    expect(created[0]).toMatchObject({ actor_account_id: ownerId, target: skill.id });
    expect(created[0]?.detail).toMatchObject({ agentId, via: "skill_write", version: 1 });
  });

  it("rejects invalid input with actionable errors", async () => {
    const agentId = await createAgent("private");
    const conv = await createConv(owner, orgId, agentId);
    const bad = await call(owner, conv, "skill_write", write("Bad Name", "x"), 1);
    expect(bad.isError).toBe(true);
    expect(bad.content).toMatch(/name/i);

    const escaped = await call(
      owner,
      conv,
      "skill_write",
      write("ok-name", "x", [{ path: "../etc/passwd", content: "x" }]),
      2,
    );
    expect(escaped.isError).toBe(true);
    expect(escaped.content).toContain("../etc/passwd");

    // NUL（二进制）内容进不了日志（PG jsonb 不收 \u0000），由 buildSkillWrite 的单元测试覆盖
    expect(await db.selectFrom("skills").select("id").execute()).toHaveLength(0);
  });

  it(`caps agent skills at ${AGENT_SKILLS_MAX}`, async () => {
    const agentId = await createAgent("private");
    const rows = Array.from({ length: AGENT_SKILLS_MAX }, (_, i) => ({
      id: `s${i}`,
      org_id: orgId,
      scope: "agent" as const,
      agent_id: agentId,
      name: `skill-${i}`,
      description: "d",
      current_version: 1,
      created_by: ownerId,
    }));
    await db.insertInto("skills").values(rows).execute();
    const conv = await createConv(owner, orgId, agentId);
    const r = await call(owner, conv, "skill_write", write("one-more", "x"), 1);
    expect(r.isError).toBe(true);
    expect(r.content).toContain(String(AGENT_SKILLS_MAX));
    expect(r.content).toMatch(/update an existing skill|ask/i);
  });

  it("a write to the conversation that re-checks the agent foreign key while skill_write waits for it: no deadlock (40P01)", async () => {
    const agentId = await createAgent("private");
    const conv = await createConv(owner, orgId, agentId);
    // An event-log transaction on the conversation (e.g. the title job: set the title, then append
    // its usage event): its first update locks the row; a second update of the row version it wrote
    // itself re-checks the agent foreign key (KEY SHARE on the agent row). skill_write holds the
    // agent row lock and waits for the conversation row.
    let release!: () => void;
    const released = new Promise<void>((r) => {
      release = r;
    });
    let locked!: () => void;
    const rowLocked = new Promise<void>((r) => {
      locked = r;
    });
    const bump = sql`UPDATE capybara.conversations SET last_seq = last_seq + 1 WHERE id = ${conv}`;
    const writer = db.transaction().execute(async (t) => {
      await bump.execute(t);
      locked();
      await released;
      await bump.execute(t);
    });
    await rowLocked;
    const built = buildSkillWrite(write("notes", "Take notes."));
    if ("errors" in built) throw new Error(built.errors.join("; "));
    const written = k.skillChanges.write(
      { orgId, agentId, accountId: ownerId, conversationId: conv },
      built,
    );
    await waitFor(
      async () => {
        const r = await sql<{ n: number }>`SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE wait_event_type = 'Lock'
            AND query LIKE '%from "capybara"."conversations" where "id" = $1 for update%'`.execute(
          db,
        );
        return (r.rows[0]?.n ?? 0) > 0;
      },
      10_000,
      "skill_write waits for the conversation row",
    );
    release();
    await expect(writer).resolves.toBeUndefined();
    await expect(written).resolves.toMatchObject({ kind: "version", version: 1, created: true });
    expect(await catalogs(conv)).toHaveLength(1);
  });

  it("a shared-agent write while another writer holds a row referencing the conversation: no deadlock (40P01)", async () => {
    const agentId = await createAgent("org");
    const conv = await createConv(member, orgId, agentId);
    // Another writer (e.g. an approval request) inserted a row referencing the conversation (the
    // foreign key check takes FOR KEY SHARE on its row) and is about to append (FOR UPDATE).
    // skill_write's change request insert takes the same FOR KEY SHARE before its own append.
    let release!: () => void;
    const released = new Promise<void>((r) => {
      release = r;
    });
    let shared!: () => void;
    const rowShared = new Promise<void>((r) => {
      shared = r;
    });
    const other = db.transaction().execute(async (t) => {
      await sql`SELECT 1 FROM capybara.conversations WHERE id = ${conv} FOR KEY SHARE`.execute(t);
      shared();
      await released;
      await sql`SELECT id FROM capybara.conversations WHERE id = ${conv} FOR UPDATE`.execute(t);
    });
    await rowShared;
    const built = buildSkillWrite(write("notes", "Take notes."));
    if ("errors" in built) throw new Error(built.errors.join("; "));
    const written = k.skillChanges.write(
      { orgId, agentId, accountId: memberId, conversationId: conv },
      built,
    );
    await waitFor(
      async () => {
        const r = await sql<{ n: number }>`SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE wait_event_type = 'Lock' AND query ILIKE '%capybara%conversations%'`.execute(db);
        return (r.rows[0]?.n ?? 0) > 0;
      },
      10_000,
      "skill_write waits for the conversation row",
    );
    release();
    await expect(other).resolves.toBeUndefined();
    await expect(written).resolves.toMatchObject({ kind: "requested", version: 1 });
    expect(await pending()).toHaveLength(1);
  });
});

describe("skill_write and pinned skills (phase B)", { timeout: 120_000 }, () => {
  it("skill_write of a pinned agent skill refreshes its pinned body in the mid-run snapshot", async () => {
    const agentId = await createAgent("private");
    const conv = await createConv(owner, orgId, agentId);
    const first = await call(owner, conv, "skill_write", write("memo", "Memo v1."), 1);
    expect(first.isError, first.content).toBe(false);
    const memo = await db
      .selectFrom("skills")
      .select("id")
      .where("name", "=", "memo")
      .executeTakeFirstOrThrow();
    const pin = await owner({
      method: "PATCH",
      url: `/api/v1/orgs/${orgId}/agents/${agentId}`,
      payload: {
        definition: {
          name: "Writer",
          instructions: "Write skills.",
          model: { provider: "model-fake", model: "fake-1" },
          tools: [{ kind: "builtin", name: "skill_write" }],
          skills: { pinned: [memo.id] },
        },
      },
    });
    expect(pin.statusCode, pin.body).toBe(200);
    // the next run start pins version 1
    const second = await call(owner, conv, "skill_write", write("memo", "Memo v2."), 2);
    expect(second.isError, second.content).toBe(false);
    const snaps = await catalogs(conv);
    const pinned = snaps.map((s) =>
      (s.payload.pinned ?? []).map((p) => [p.version, p.body.trim()]),
    );
    // write v1 (not pinned yet), run start (v1 pinned), write v2 (pinned body refreshed)
    expect(pinned).toEqual([[], [[1, "Memo v1."]], [[2, "Memo v2."]]]);
    const last = snaps.at(-1)?.payload;
    expect(last?.pinned?.[0]?.source).toBe(last?.skills.find((x) => x.name === "memo")?.source);
  });
});

describe("skill_write confirmation switch on a private agent (D10)", { timeout: 120_000 }, () => {
  it("writePolicy ask: asks the owner, takes effect directly after approval, no change request", async () => {
    const agentId = await createAgent("private", [], "ask");
    const conv = await createConv(owner, orgId, agentId);
    const r = await sharedWrite(owner, conv, write("asked", "Asked v1."), 1);
    expect(r.isError, r.content).toBe(false);
    const skill = await db
      .selectFrom("skills")
      .selectAll()
      .where("agent_id", "=", agentId)
      .executeTakeFirstOrThrow();
    expect(skill).toMatchObject({ name: "asked", current_version: 1 });
    expect(await db.selectFrom("skill_change_requests").select("id").execute()).toHaveLength(0);
  });

  it("switching to ask mid-conversation applies from the next call (current version read live)", async () => {
    const agentId = await createAgent("private");
    const conv = await createConv(owner, orgId, agentId);
    const r1 = await call(owner, conv, "skill_write", write("first", "First v1."), 1);
    expect(r1.isError, r1.content).toBe(false);
    expect(await db.selectFrom("approvals").select("id").execute()).toHaveLength(0);

    const def = await db
      .selectFrom("agent_versions")
      .select("definition")
      .where("agent_id", "=", agentId)
      .orderBy("version", "desc")
      .executeTakeFirstOrThrow();
    const patch = await owner({
      method: "PATCH",
      url: `/api/v1/orgs/${orgId}/agents/${agentId}`,
      payload: { definition: { ...def.definition, skills: { orgSkills: [], writePolicy: "ask" } } },
    });
    expect(patch.statusCode, patch.body).toBe(200);

    const r2 = await sharedWrite(owner, conv, write("second", "Second v1."), 2);
    expect(r2.isError, r2.content).toBe(false);
    expect(await db.selectFrom("approvals").select("id").execute()).toHaveLength(1);
  });

  it("a shared agent with writePolicy allow still asks (R3) and files a change request (R4)", async () => {
    const agentId = await createAgent("org", [], "allow");
    const conv = await createConv(owner, orgId, agentId);
    await sharedWrite(owner, conv, write("shared", "Shared v1."), 1);
    expect(await pending()).toHaveLength(1);
  });
});

describe("skill_write on a shared agent (R4)", { timeout: 180_000 }, () => {
  it("asks the initiator, files a change request, trial in the originating conversation only, owner approves", async () => {
    const agentId = await createAgent("org");
    const convM = await createConv(member, orgId, agentId);
    const convX = await createConv(other, orgId, agentId);

    // 发起人确认之前：收件箱里是一条工具审批
    await postMessage(
      member,
      orgId,
      convM,
      `tool:skill_write:${JSON.stringify(write("alpha", "Alpha v1."))}`,
    );
    await waitFor(
      () =>
        db
          .selectFrom("approvals")
          .select("id")
          .where("conversation_id", "=", convM)
          .where("status", "=", "pending")
          .executeTakeFirst(),
      15_000,
      "approval",
    );
    const inboxM = await member({ method: "GET", url: `/api/v1/orgs/${orgId}/inbox` });
    expect(inboxM.statusCode, inboxM.body).toBe(200);
    const itemsM = (inboxM.json() as { items: { type: string; approval?: { toolKey: string } }[] })
      .items;
    expect(itemsM.map((i) => i.type)).toEqual(["tool_approval"]);
    expect(itemsM[0]?.approval?.toolKey).toBe("skill_write");
    // 发起人确认工具调用
    await approvePending(member, convM);
    await waitForTerminal(db, convM, 1, 30_000);
    const r = await lastResult(convM);
    expect(r.isError, r.content).toBe(false);
    expect(r.content).toMatch(/owner/i);
    expect(r.content).toMatch(/this conversation/i);

    // 变更申请（技能本身尚不存在）
    const [req] = await pending();
    expect(req).toMatchObject({
      org_id: orgId,
      agent_id: agentId,
      skill_id: null,
      requested_by_account: memberId,
      requested_in_conversation: convM,
      status: "pending",
    });
    expect(await db.selectFrom("skills").select("id").execute()).toHaveLength(0);
    const requested = await audits("skill.change_requested");
    expect(requested).toHaveLength(1);
    expect(requested[0]?.actor_account_id).toBe(memberId);

    // 发起对话可试用；别的对话看不到
    const mine = await call(member, convM, "skill_load", { name: "alpha" }, 2);
    expect(mine.isError, mine.content).toBe(false);
    expect(mine.content).toContain("Alpha v1.");
    const theirs = await call(other, convX, "skill_load", { name: "alpha" }, 1);
    expect(theirs.isError).toBe(true);
    expect(theirs.content).not.toContain("Alpha v1.");

    // 收件箱：负责人看到这条变更；别人看不到
    const inboxO = await owner({ method: "GET", url: `/api/v1/orgs/${orgId}/inbox` });
    expect(inboxO.statusCode).toBe(200);
    const itemsO = (
      inboxO.json() as {
        items: {
          type: string;
          id: string;
          skillChange?: { name: string; agent: { id: string } };
        }[];
      }
    ).items;
    expect(itemsO).toHaveLength(1);
    expect(itemsO[0]).toMatchObject({
      type: "skill_change",
      id: req?.id,
      skillChange: { name: "alpha", agent: { id: agentId } },
    });
    const inboxX = await other({ method: "GET", url: `/api/v1/orgs/${orgId}/inbox` });
    expect((inboxX.json() as { items: unknown[] }).items).toHaveLength(0);

    // 详情：负责人能看文件内容
    const detail = await owner({
      method: "GET",
      url: `/api/v1/orgs/${orgId}/skill-changes/${req?.id}`,
    });
    expect(detail.statusCode, detail.body).toBe(200);
    const files = (detail.json() as { skillChange: { files: { path: string; content: string }[] } })
      .skillChange.files;
    expect(files.find((f) => f.path === "SKILL.md")?.content).toContain("Alpha v1.");
    // 新技能：没有当前版本
    expect((detail.json() as { skillChange: { current: unknown } }).skillChange.current).toBeNull();

    // 非负责人（含组织管理员、发起人自己）决定 → 403
    for (const who of [other, member]) {
      const res = await decide(who, req?.id as string, "approve");
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe("skill_change.not_owner");
    }
    // 服务令牌（agent / 自动化）不能决定（R2）
    const t = await owner({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/service-tokens`,
      payload: { name: "ci", role: "admin" },
    });
    expect(t.statusCode, t.body).toBe(201);
    const svc = await k.http.inject({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/skill-changes/${req?.id}/decide`,
      headers: { authorization: `Bearer ${(t.json() as { token: string }).token}` },
      payload: { decision: "approve" },
    });
    expect(svc.statusCode).toBe(403);

    // 负责人批准：之后所有对话都能看到
    const ok = await decide(owner, req?.id as string, "approve");
    expect(ok.statusCode, ok.body).toBe(200);
    expect((ok.json() as { skillChange: { status: string } }).skillChange.status).toBe("approved");
    const again = await decide(owner, req?.id as string, "approve");
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe("skill_change.already_decided");

    const theirs2 = await call(other, convX, "skill_load", { name: "alpha" }, 2);
    expect(theirs2.isError, theirs2.content).toBe(false);
    expect(theirs2.content).toContain("Alpha v1.");
    const skill = await db
      .selectFrom("skills")
      .selectAll()
      .where("agent_id", "=", agentId)
      .executeTakeFirstOrThrow();
    expect(skill.current_version).toBe(1);
    // 发起对话里的 id 与批准后一致（目录不变，不多写快照）
    const mineSnaps = await catalogs(convM);
    expect(mineSnaps.at(-1)?.payload.skills[0]?.id).toBe(skill.id);
    const decided = await audits("skill.change_decided");
    expect(decided).toHaveLength(1);
    expect(decided[0]).toMatchObject({ actor_account_id: ownerId, target: req?.id });
    expect(decided[0]?.detail).toMatchObject({ decision: "approved", agentId, name: "alpha" });
  });

  it("an update stays invisible to other conversations until approved; rejection reverts and deletes the draft", async () => {
    const agentId = await createAgent("org");
    const convM = await createConv(member, orgId, agentId);
    const convX = await createConv(other, orgId, agentId);
    await sharedWrite(member, convM, write("beta", "Beta v1."), 1);
    const [first] = await pending();
    expect((await decide(owner, first?.id as string, "approve")).statusCode).toBe(200);

    // 第二版：只在发起对话里生效
    const r = await sharedWrite(member, convM, write("beta", "Beta v2."), 2);
    expect(r.isError, r.content).toBe(false);
    const [second] = await pending();
    expect(second?.skill_id).not.toBeNull();
    const mine = await call(member, convM, "skill_load", { name: "beta" }, 3);
    expect(mine.content).toContain("Beta v2.");
    expect(mine.content).toContain("version 2");
    const theirs = await call(other, convX, "skill_load", { name: "beta" }, 1);
    expect(theirs.content).toContain("Beta v1.");
    expect(theirs.content).not.toContain("Beta v2.");

    // 详情：草稿文件 + 当前版本的文件（网页据此显示差异），以及发起人的名字
    const det = await owner({
      method: "GET",
      url: `/api/v1/orgs/${orgId}/skill-changes/${second?.id}`,
    });
    expect(det.statusCode, det.body).toBe(200);
    const sc = (
      det.json() as {
        skillChange: {
          requestedByName: string;
          files: { path: string; content: string | null }[];
          current: { version: number; files: { path: string; content: string | null }[] } | null;
        };
      }
    ).skillChange;
    expect(sc.requestedByName).toBe("M");
    expect(sc.files.find((f) => f.path === "SKILL.md")?.content).toContain("Beta v2.");
    expect(sc.current?.version).toBe(1);
    expect(sc.current?.files.find((f) => f.path === "SKILL.md")?.content).toContain("Beta v1.");

    // 拒绝：草稿对象删除，发起对话的下一份快照回到 v1
    const prefix = second?.object_prefix as string;
    expect(await k.storage.kernel(orgId).head(`${prefix}SKILL.md`)).not.toBeNull();
    const no = await decide(owner, second?.id as string, "reject");
    expect(no.statusCode, no.body).toBe(200);
    expect((no.json() as { skillChange: { status: string } }).skillChange.status).toBe("rejected");
    await waitFor(
      async () => (await k.storage.kernel(orgId).head(`${prefix}SKILL.md`)) === null,
      10_000,
      "draft deleted",
    );
    const back = await call(member, convM, "skill_load", { name: "beta" }, 4);
    expect(back.isError, back.content).toBe(false);
    expect(back.content).toContain("Beta v1.");
    expect((await catalogs(convM)).at(-1)?.payload.skills[0]?.version).toBe(1);
    const skill = await db
      .selectFrom("skills")
      .select("current_version")
      .where("agent_id", "=", agentId)
      .executeTakeFirstOrThrow();
    expect(skill.current_version).toBe(1);
    const decided = await audits("skill.change_decided");
    expect(decided.map((d) => (d.detail as { decision: string }).decision).sort()).toEqual([
      "approved",
      "rejected",
    ]);
  });

  it("one pending change per skill: the same conversation supersedes, another conversation is refused", async () => {
    const agentId = await createAgent("org");
    const convM = await createConv(member, orgId, agentId);
    const convX = await createConv(other, orgId, agentId);
    await sharedWrite(member, convM, write("gamma", "Gamma draft 1."), 1);
    const [d1] = await pending();

    // 另一个对话写同一技能：拒绝（等负责人处理）
    const refused = await sharedWrite(other, convX, write("gamma", "Gamma from X."), 1);
    expect(refused.isError).toBe(true);
    expect(refused.content).toMatch(/awaiting the owner's approval/i);
    expect((await pending()).map((p) => p.id)).toEqual([d1?.id]);

    // 同一对话再写：取代旧申请（旧的 cancelled、草稿删除），技能 id 保持
    const again = await sharedWrite(member, convM, write("gamma", "Gamma draft 2."), 2);
    expect(again.isError, again.content).toBe(false);
    const [d2] = await pending();
    expect(d2?.id).not.toBe(d1?.id);
    const old = await db
      .selectFrom("skill_change_requests")
      .select("status")
      .where("id", "=", d1?.id as string)
      .executeTakeFirstOrThrow();
    expect(old.status).toBe("cancelled");
    expect(d2?.proposed_version.skillId).toBe(d1?.proposed_version.skillId);
    await waitFor(
      async () => (await k.storage.kernel(orgId).head(`${d1?.object_prefix}SKILL.md`)) === null,
      10_000,
      "superseded draft deleted",
    );
    const mine = await call(member, convM, "skill_load", { name: "gamma" }, 3);
    expect(mine.content).toContain("Gamma draft 2.");

    // 旧申请已不能决定
    expect((await decide(owner, d1?.id as string, "approve")).statusCode).toBe(409);
    expect((await decide(owner, d2?.id as string, "approve")).statusCode).toBe(200);
  });

  it("a rejected draft and a later draft with the same version number: the sandbox copy is refreshed", async () => {
    const agentId = await createAgent("org", [{ kind: "builtin", name: "sandbox_bash" }]);
    const convM = await createConv(member, orgId, agentId);
    const run = { path: "run.sh", content: "echo v1" };
    await sharedWrite(member, convM, write("delta", "Run run.sh.", [run]), 1);
    const [v1] = await pending();
    expect((await decide(owner, v1?.id as string, "approve")).statusCode).toBe(200);

    await sharedWrite(
      member,
      convM,
      write("delta", "Run run.sh.", [{ ...run, content: "echo d1" }]),
      2,
    );
    const [d1] = await pending();
    const l1 = await call(member, convM, "skill_load", { name: "delta" }, 3);
    expect(l1.content, l1.content).toContain("version 2");
    const box = await db
      .selectFrom("sandboxes")
      .select("handle")
      .where("conversation_id", "=", convM)
      .executeTakeFirstOrThrow();
    const file = () =>
      readFile(
        join(root, "instances", (box.handle as { id: string }).id, "fs", "skills/delta/run.sh"),
        "utf8",
      );
    expect(await file()).toBe("echo d1");
    expect((await decide(owner, d1?.id as string, "reject")).statusCode).toBe(200);

    // 新草稿与被拒绝的草稿同为版本 2：标记按来源前缀判断，重新复制
    await sharedWrite(
      member,
      convM,
      write("delta", "Run run.sh.", [{ ...run, content: "echo d2" }]),
      4,
    );
    const l2 = await call(member, convM, "skill_load", { name: "delta" }, 5);
    expect(l2.content).toContain("version 2");
    expect(await file()).toBe("echo d2");
  });

  it("A's rejected draft vs B's approved same-numbered version: A reverts at once, then sees B's version as updated; a stale draft entry never resolves to B's content", async () => {
    const agentId = await createAgent("org");
    const convA = await createConv(member, orgId, agentId);
    const convB = await createConv(other, orgId, agentId);
    await sharedWrite(member, convA, write("xray", "X v1."), 1);
    const [v1] = await pending();
    expect((await decide(owner, v1?.id as string, "approve")).statusCode).toBe(200);
    const v1Prefix = v1?.object_prefix as string;

    // A 试用 v2，然后被拒绝：拒绝的事务里给 A 追加回退快照（不用等下一次运行）
    await sharedWrite(member, convA, write("xray", "X v2 from A."), 2);
    const [a2] = await pending();
    const aDraft = a2?.object_prefix as string;
    expect((await catalogs(convA)).at(-1)?.payload.skills[0]).toMatchObject({
      version: 2,
      source: aDraft,
    });
    const before = (await catalogs(convA)).length;
    expect((await decide(owner, a2?.id as string, "reject")).statusCode).toBe(200);
    const afterReject = await catalogs(convA);
    expect(afterReject).toHaveLength(before + 1);
    expect(afterReject.at(-1)?.payload.skills[0]).toMatchObject({ version: 1, source: v1Prefix });

    // B 写同名 v2，负责人批准
    await sharedWrite(other, convB, write("xray", "X v2 from B."), 1);
    const [b2] = await pending();
    expect((await decide(owner, b2?.id as string, "approve")).statusCode).toBe(200);

    // A 的下一次运行：目录更新为 B 的 v2（来源不同），加载得到 B 的内容
    const l = await call(member, convA, "skill_load", { name: "xray" }, 3);
    expect(l.content).toContain("X v2 from B.");
    expect((await catalogs(convA)).at(-1)?.payload.skills[0]).toMatchObject({
      version: 2,
      source: b2?.object_prefix,
    });

    // 即使日志里还留着 A 草稿的条目（{xray, v2, A 的前缀}），也只按来源解析：已移除，不会拿到 B 的内容
    const skillId = a2?.proposed_version.skillId as string;
    const t = skillLoadTool({
      db,
      storage: k.storage,
      eventLog: {
        append: async () => [],
        latestOfType: async () =>
          ({
            conversationId: convA,
            seq: 1,
            runId: "r",
            createdAt: new Date(),
            type: "skills_catalog",
            payload: {
              skills: [{ id: skillId, name: "xray", description: "d", version: 2, source: aDraft }],
            },
          }) as never,
      },
      sandbox: {
        available: false,
        withSandbox: async () => {
          throw new Error("unused");
        },
      },
      attachments: {
        listForConversation: async () => [],
        openForConversation: async () => null,
      },
      config: { get: () => k.config },
    });
    await expect(
      t.run(
        { name: "xray" },
        {
          orgId,
          accountId: memberId,
          agentId,
          conversationId: convA,
          callId: "c",
          signal: new AbortController().signal,
        },
      ),
    ).rejects.toThrow(/removed/);
  });

  it("deleting the agent cancels its pending changes and deletes the drafts; the owner can delete an agent skill", async () => {
    const agentId = await createAgent("org");
    const convM = await createConv(member, orgId, agentId);
    await sharedWrite(member, convM, write("keep", "Keep v1."), 1);
    const [k1] = await pending();
    expect((await decide(owner, k1?.id as string, "approve")).statusCode).toBe(200);
    const skill = await db
      .selectFrom("skills")
      .select("id")
      .where("agent_id", "=", agentId)
      .executeTakeFirstOrThrow();

    // 只有负责人能删 agent 自己的技能；同名待处理改动一并取消
    await sharedWrite(member, convM, write("keep", "Keep v2."), 2);
    const [k2] = await pending();
    const url = `/api/v1/orgs/${orgId}/agents/${agentId}/skills/${skill.id}`;
    const denied = await other({ method: "DELETE", url });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error.code).toBe("forbidden");
    // 服务令牌：403（HUMAN_ONLY）
    const tok = await owner({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/service-tokens`,
      payload: { name: "ci", role: "admin" },
    });
    expect(tok.statusCode, tok.body).toBe(201);
    const svc = await k.http.inject({
      method: "DELETE",
      url,
      headers: { authorization: `Bearer ${(tok.json() as { token: string }).token}` },
    });
    expect(svc.statusCode).toBe(403);
    // 看不到的 agent（别人的私有 agent）：404 agent.not_found
    const priv = await createAgent("private");
    const hidden = await member({
      method: "DELETE",
      url: `/api/v1/orgs/${orgId}/agents/${priv}/skills/${skill.id}`,
    });
    expect(hidden.statusCode).toBe(404);
    expect(hidden.json().error.code).toBe("agent.not_found");
    // 跨组织：别的组织的 agent 在本组织路径下 → 404 agent.not_found
    const org2 = await createOrg(other, "Other");
    const res2 = await other({
      method: "POST",
      url: `/api/v1/orgs/${org2}/agents`,
      payload: {
        definition: {
          name: "X",
          instructions: "x",
          model: { provider: "model-fake", model: "fake-1" },
          tools: [],
        },
        visibility: "org",
      },
    });
    expect(res2.statusCode, res2.body).toBe(201);
    const foreign = (res2.json() as { agent: { id: string } }).agent.id;
    const cross = await other({
      method: "DELETE",
      url: `/api/v1/orgs/${orgId}/agents/${foreign}/skills/${skill.id}`,
    });
    expect(cross.statusCode).toBe(404);
    expect(cross.json().error.code).toBe("agent.not_found");
    const ok = await owner({ method: "DELETE", url });
    expect(ok.statusCode, ok.body).toBe(204);
    expect((await owner({ method: "DELETE", url })).statusCode).toBe(404);
    expect(await pending()).toHaveLength(0);
    expect((await catalogs(convM)).at(-1)?.payload.skills).toEqual([]);
    await waitFor(
      async () => (await k.storage.kernel(orgId).head(`${k2?.object_prefix}SKILL.md`)) === null,
      10_000,
      "draft deleted on skill delete",
    );
    expect(await audits("skill.deleted")).toHaveLength(1);

    // 删除 agent：待处理改动取消、草稿删除
    await sharedWrite(member, convM, write("other", "Other v1."), 3);
    const [o1] = await pending();
    const del = await owner({ method: "DELETE", url: `/api/v1/orgs/${orgId}/agents/${agentId}` });
    expect(del.statusCode, del.body).toBe(204);
    const row = await db
      .selectFrom("skill_change_requests")
      .select("status")
      .where("id", "=", o1?.id as string)
      .executeTakeFirstOrThrow();
    expect(row.status).toBe("cancelled");
    await waitFor(
      async () => (await k.storage.kernel(orgId).head(`${o1?.object_prefix}SKILL.md`)) === null,
      10_000,
      "draft deleted on agent delete",
    );
  });

  it("run start serializes with a reject + revert on the conversation row (no stale draft re-written)", async () => {
    const agentId = await createAgent("org");
    const convA = await createConv(member, orgId, agentId);
    await sharedWrite(member, convA, write("rho", "Rho v1."), 1);
    const [v1] = await pending();
    expect((await decide(owner, v1?.id as string, "approve")).statusCode).toBe(200);
    await sharedWrite(member, convA, write("rho", "Rho v2."), 2);
    const [d2] = await pending();
    const real = await db
      .selectFrom("skills")
      .select(["id", "description"])
      .where("agent_id", "=", agentId)
      .executeTakeFirstOrThrow();
    const before = (await catalogs(convA)).length;

    // 模拟拒绝事务：持有会话行锁期间改状态并写回退快照；运行开始的记录必须等它提交
    let release!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });
    let locked!: () => void;
    const isLocked = new Promise<void>((r) => {
      locked = r;
    });
    const rejecting = db.transaction().execute(async (t) => {
      await t
        .selectFrom("conversations")
        .select("id")
        .where("id", "=", convA)
        .forUpdate()
        .executeTakeFirst();
      await t
        .updateTable("skill_change_requests")
        .set({ status: "rejected" })
        .where("id", "=", d2?.id as string)
        .execute();
      await k.runs.eventLog.append(
        convA,
        [
          {
            type: "skills_catalog",
            idemKey: "test-revert",
            payload: {
              skills: [
                {
                  id: real.id,
                  name: "rho",
                  description: real.description,
                  version: 1,
                  source: v1?.object_prefix as string,
                },
              ],
            },
          },
        ],
        t,
      );
      locked();
      await held;
    });
    await isLocked;
    let settled = false;
    const recording = k.app
      .get(SkillsCatalogService)
      .record({ orgId, agentId, conversationId: convA, runId: "run-race", agent: {} })
      .then(() => {
        settled = true;
      });
    await new Promise((r) => setTimeout(r, 300));
    expect(settled).toBe(false);
    release();
    await rejecting;
    await recording;
    const snaps = await catalogs(convA);
    expect(snaps).toHaveLength(before + 1);
    expect(snaps.at(-1)?.payload.skills[0]).toMatchObject({
      version: 1,
      source: v1?.object_prefix,
    });
  });
});

describe("skill_write and manual-only skills (phase D)", { timeout: 180_000 }, () => {
  const manual = (body: string) => `---\ndisable-model-invocation: true\n---\n${body}`;
  const names = async (conv: string) =>
    ((await catalogs(conv)).at(-1)?.payload.skills ?? []).map((s) => s.name);
  const pinnedNames = async (conv: string) =>
    ((await catalogs(conv)).at(-1)?.payload.pinned ?? []).map((p) => p.name);

  it("a manual-only write never enters the conversation's catalog snapshot, and skill_load refuses it", async () => {
    const agentId = await createAgent("private", [{ kind: "builtin", name: "skill_load" }]);
    const conv = await createConv(owner, orgId, agentId);
    expect((await call(owner, conv, "skill_write", write("other", "Other."), 1)).isError).toBe(
      false,
    );
    const v1 = await call(owner, conv, "skill_write", write("notes", "Notes v1."), 2);
    expect(v1.isError, v1.content).toBe(false);
    expect(await names(conv)).toEqual(["notes", "other"]);
    expect((await call(owner, conv, "skill_load", { name: "notes" }, 3)).content).toContain(
      "Notes v1.",
    );

    // A new manual-only version of a skill in the snapshot removes it.
    const v2 = await call(owner, conv, "skill_write", write("notes", manual("Notes v2.")), 4);
    expect(v2.isError, v2.content).toBe(false);
    expect(v2.content).toContain(
      "It is manual-only (disable-model-invocation: true): it is not in your skills catalog and skill_load cannot load it; a person invokes it with /notes.",
    );
    expect(v2.content).not.toContain("call skill_load to use it");
    expect(await names(conv)).toEqual(["other"]);
    const gone = await call(owner, conv, "skill_load", { name: "notes" }, 5);
    expect(gone.isError).toBe(true);
    expect(gone.content).toContain('Skill "notes" is not in the skills catalog');

    // A new manual-only skill is never added (no snapshot is written for it at all).
    const before = (await catalogs(conv)).length;
    const memo = await call(owner, conv, "skill_write", write("memo", manual("Memo.")), 6);
    expect(memo.isError, memo.content).toBe(false);
    expect((await catalogs(conv)).length).toBe(before);
    expect(await names(conv)).toEqual(["other"]);
    const refused = await call(owner, conv, "skill_load", { name: "memo" }, 7);
    expect(refused.isError).toBe(true);
    expect(refused.content).toContain('Skill "memo" is not in the skills catalog');
    // The next run start agrees with the mid-run snapshots.
    expect(await names(conv)).toEqual(["other"]);
  });

  it("a manual-only write of a pinned skill drops its pinned entry", async () => {
    const agentId = await createAgent("private");
    const conv = await createConv(owner, orgId, agentId);
    await call(owner, conv, "skill_write", write("other", "Other."), 1);
    await call(owner, conv, "skill_write", write("memo", "Memo v1."), 2);
    const ids = await db.selectFrom("skills").select(["id", "name"]).orderBy("name").execute();
    const pin = await owner({
      method: "PATCH",
      url: `/api/v1/orgs/${orgId}/agents/${agentId}`,
      payload: {
        definition: {
          name: "Writer",
          instructions: "Write skills.",
          model: { provider: "model-fake", model: "fake-1" },
          tools: [{ kind: "builtin", name: "skill_write" }],
          skills: { pinned: ids.map((s) => s.id) },
        },
      },
    });
    expect(pin.statusCode, pin.body).toBe(200);
    const r = await call(owner, conv, "skill_write", write("memo", manual("Memo v2.")), 3);
    expect(r.isError, r.content).toBe(false);
    const snaps = await catalogs(conv);
    // run start pinned both; the manual-only write removed memo and its pinned entry
    expect(snaps.at(-2)?.payload.pinned?.map((p) => p.name)).toEqual(["memo", "other"]);
    expect(await names(conv)).toEqual(["other"]);
    expect(await pinnedNames(conv)).toEqual(["other"]);
  });

  it("rejecting a draft does not put back a manual-only current version", async () => {
    const agentId = await createAgent("org", [{ kind: "builtin", name: "skill_load" }]);
    const conv = await createConv(member, orgId, agentId);
    await sharedWrite(member, conv, write("other", "Other."), 1);
    const [o] = await pending();
    expect((await decide(owner, o?.id as string, "approve")).statusCode).toBe(200);
    await sharedWrite(member, conv, write("beta", manual("Beta v1.")), 2);
    const [b1] = await pending();
    expect((await decide(owner, b1?.id as string, "approve")).statusCode).toBe(200);
    expect((await lastResult(conv)).content).toContain("It is manual-only");
    // An ordinary draft over a manual-only version: on trial in this conversation
    const r = await sharedWrite(member, conv, write("beta", "Beta v2."), 3);
    expect(r.isError, r.content).toBe(false);
    expect(await names(conv)).toEqual(["beta", "other"]);
    const [b2] = await pending();
    expect((await decide(owner, b2?.id as string, "reject")).statusCode).toBe(200);
    // The revert removes the draft and does not re-add the manual-only version 1
    expect(await names(conv)).toEqual(["other"]);
    const load = await call(member, conv, "skill_load", { name: "beta" }, 4);
    expect(load.isError).toBe(true);
    expect(load.content).toContain('Skill "beta" is not in the skills catalog');
  });
});
