import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ToolResult } from "@capybara-hq/plugin-sdk";
import {
  fakeExtensionEntry,
  startTestPostgres,
  startTestRedis,
  startTestS3,
  type TestContainer,
  type TestS3,
} from "@capybara-hq/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentDefinition } from "../../src/agents/definition.js";
import type { ConversationEvent, EventPayload } from "../../src/conversations/events.js";
import { type KernelDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { ApiError } from "../../src/errors.js";
import { AccountsService } from "../../src/identity/accounts.js";
import type { Kernel } from "../../src/kernel.js";
import { buildModelRequest } from "../../src/runtime/context/build.js";
import { CLAUDE_CODE_TOOL_MAP } from "../../src/runtime/context/claude-tools.js";
import { recordSkillsCatalog } from "../../src/skills/catalog.js";
import { skillLoadTool } from "../../src/tools/builtins/skill-load.js";
import { removeFakeSandbox } from "../fixtures/plugins/sandbox-fake/index.js";
import { truncateTables } from "../helpers/db.js";
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
  waitForTerminal,
} from "../helpers/runs.js";
import { MODEL } from "../runtime/context/fixtures.js";

/**
 * M5 T14：技能目录（日志快照 `skills_catalog`，Ruling M17）、`skill_load` 与复制进沙箱。
 * 真实内核 + model-fake（`tool:<key>:<json>`）+ 假沙箱插件 + SeaweedFS。技能行与文件直接写库 / 存储。
 */

const OBJECT_STORE = fakeExtensionEntry("fake-object-store");
const SANDBOX_FAKE = fileURLToPath(
  new URL("../fixtures/plugins/sandbox-fake/index.ts", import.meta.url),
);

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
  root = await mkdtemp(join(tmpdir(), "cap-skills-rt-"));
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
let orgId: string;

beforeEach(async () => {
  await truncateTables(
    db,
    "capybara.skill_versions, capybara.skills, capybara.catalog_items, capybara.sandboxes, capybara.attachments, capybara.approvals, capybara.tool_outputs, capybara.conversation_events, capybara.runs, capybara.conversations, capybara.agent_versions, capybara.agent_members, capybara.agents, capybara.memberships, capybara.orgs, capybara.sessions, capybara.local_passwords, capybara.identities, capybara.accounts",
  );
  const accounts = new AccountsService(db);
  ownerId = (await accounts.createLocal({ login: "owner", password: PW, displayName: "O" })).id;
  owner = await session(k, "owner");
  orgId = await createOrg(owner);
});

const skillMd = (name: string, body: string, description = `Use for ${name} work.`) =>
  `---\nname: ${name}\ndescription: ${description}\n---\n${body}`;

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

/** 写一个技能版本的文件与行；`skillId` 给出时为已有技能的新版本。 */
async function seedSkill(opts: {
  name: string;
  files: Record<string, string>;
  scope?: "org" | "agent";
  agentId?: string;
  skillId?: string;
  /** The catalog item (plugin) the skill came from; created on first use. */
  plugin?: string;
  format?: "capybara" | "claude-code";
}): Promise<{ id: string; version: number; prefix: string }> {
  const prefix = `skills/${randomUUID()}/`;
  const store = k.storage.kernel(orgId);
  const files: { path: string; size: number; sha256: string }[] = [];
  for (const [path, text] of Object.entries(opts.files)) {
    const data = new TextEncoder().encode(text);
    await store.put(`${prefix}${path}`, data, {
      contentType: "application/octet-stream",
      size: data.byteLength,
    });
    files.push({ path, size: data.byteLength, sha256: sha(data) });
  }
  const description = `Use for ${opts.name} work.`;
  const manifest = { name: opts.name, description, files };
  let id = opts.skillId;
  let version = 1;
  const itemId = opts.plugin === undefined ? null : await catalogItem(opts.plugin);
  if (id === undefined) {
    id = randomUUID();
    await db
      .insertInto("skills")
      .values({
        id,
        org_id: orgId,
        scope: opts.scope ?? "org",
        agent_id: opts.agentId ?? null,
        name: opts.name,
        description,
        current_version: 1,
        created_by: ownerId,
        catalog_item_id: itemId,
        catalog_version: itemId === null ? null : "1.0.0",
      })
      .execute();
  } else {
    const row = await db
      .updateTable("skills")
      .set((eb) => ({ current_version: eb("current_version", "+", 1) }))
      .where("id", "=", id)
      .returning("current_version")
      .executeTakeFirstOrThrow();
    version = row.current_version;
  }
  await db
    .insertInto("skill_versions")
    .values({
      skill_id: id,
      version,
      manifest: JSON.stringify(manifest),
      object_prefix: prefix,
      created_by: ownerId,
      ...(opts.format !== undefined && { source_format: opts.format }),
    })
    .execute();
  return { id, version, prefix };
}

/** The id of catalog item `name` (created when missing). */
async function catalogItem(name: string): Promise<string> {
  const got = await db
    .selectFrom("catalog_items")
    .select("id")
    .where("name", "=", name)
    .executeTakeFirst();
  if (got) return got.id;
  const id = randomUUID();
  await db
    .insertInto("catalog_items")
    .values({
      id,
      name,
      package_name: `@acme/plugin-${name}`,
      publisher: "Acme",
      description: "d",
      latest_version: "1.0.0",
      policy: "allow",
    })
    .execute();
  return id;
}

async function createSkillAgent(orgSkills: string[], pinned?: string[]): Promise<string> {
  const res = await owner({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/agents`,
    payload: {
      definition: {
        name: "Skilled",
        instructions: "Use skills.",
        model: { provider: "model-fake", model: "fake-1" },
        tools: [{ kind: "builtin", name: "sandbox_bash" }],
        skills: { orgSkills, ...(pinned !== undefined && { pinned }) },
      },
      visibility: "org",
    },
  });
  expect(res.statusCode, res.body).toBe(201);
  return (res.json() as { agent: { id: string } }).agent.id;
}

/** Saves the agent's skills (a new agent version; the next run uses it). */
async function setSkills(agentId: string, orgSkills: string[], pinned?: string[]): Promise<void> {
  const res = await owner({
    method: "PATCH",
    url: `/api/v1/orgs/${orgId}/agents/${agentId}`,
    payload: {
      definition: {
        name: "Skilled",
        instructions: "Use skills.",
        model: { provider: "model-fake", model: "fake-1" },
        tools: [{ kind: "builtin", name: "sandbox_bash" }],
        skills: { orgSkills, ...(pinned !== undefined && { pinned }) },
      },
    },
  });
  expect(res.statusCode, res.body).toBe(200);
}

/** One plain run (the n-th terminal event of the conversation). */
async function say(convId: string, n: number): Promise<void> {
  await postMessage(owner, orgId, convId, "hello");
  await waitForTerminal(db, convId, n, 30_000);
}

type ToolResultEvent = Extract<ConversationEvent, { type: "tool_result" }>;

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

const catalogs = async (convId: string) =>
  (await eventsOf(db, convId)).filter(
    (e): e is Extract<ConversationEvent, { type: "skills_catalog" }> => e.type === "skills_catalog",
  );

async function sandboxId(convId: string): Promise<string> {
  const row = await db
    .selectFrom("sandboxes")
    .select("handle")
    .where("conversation_id", "=", convId)
    .executeTakeFirstOrThrow();
  return (row.handle as { id: string }).id;
}

const sandboxFile = async (convId: string, path: string) =>
  readFile(join(root, "instances", await sandboxId(convId), "fs", path), "utf8").catch(() => null);

describe("skills at runtime", { timeout: 90_000 }, () => {
  it("catalog snapshot lists selected org skills + agent skills; skill_load returns the body; unselected skills are invisible", async () => {
    const alpha = await seedSkill({
      name: "alpha",
      files: { "SKILL.md": skillMd("alpha", "# Alpha\nDo alpha step by step.") },
    });
    await seedSkill({
      name: "beta",
      files: { "SKILL.md": skillMd("beta", "# Beta\nSecret beta.") },
    });
    const agentId = await createSkillAgent([alpha.id]);
    await seedSkill({
      name: "charlie",
      scope: "agent",
      agentId,
      files: { "SKILL.md": skillMd("charlie", "# Charlie") },
    });
    const conv = await createConv(owner, orgId, agentId);

    const r = await call(conv, "skill_load", { name: "alpha" }, 1);
    expect(r.isError, r.content).toBe(false);
    expect(r.content).toContain("Do alpha step by step.");
    expect(r.content).toContain("version 1");
    expect(r.content).not.toContain("name: alpha");
    expect(r.display?.summary.en).toContain("alpha");
    expect(r.display?.summary.zh).toContain("alpha");
    // 只有 SKILL.md：不创建沙箱
    const boxes = await db.selectFrom("sandboxes").select("conversation_id").execute();
    expect(boxes).toHaveLength(0);

    const snaps = await catalogs(conv);
    expect(snaps).toHaveLength(1);
    expect(snaps[0]?.payload.skills.map((s) => [s.name, s.version])).toEqual([
      ["alpha", 1],
      ["charlie", 1],
    ]);

    // 未选中的组织技能：不在目录里，加载报错
    const b = await call(conv, "skill_load", { name: "beta" }, 2);
    expect(b.isError).toBe(true);
    expect(b.content).toContain("not in the skills catalog");
    expect(b.content).not.toContain("Secret beta");
    // 目录没变：不写新快照
    expect(await catalogs(conv)).toHaveLength(1);

    // 由日志还原：每次模型请求的 system 与记录的指纹一致，且含目录
    const def = (
      await db
        .selectFrom("agent_versions")
        .select("definition")
        .where("agent_id", "=", agentId)
        .executeTakeFirstOrThrow()
    ).definition as unknown as AgentDefinition;
    const events = await eventsOf(db, conv);
    const calls = events.filter(
      (e): e is Extract<ConversationEvent, { type: "model_call" }> => e.type === "model_call",
    );
    expect(calls.length).toBeGreaterThanOrEqual(2);
    for (const c of calls) {
      const rebuilt = buildModelRequest({
        events: events.filter((e) => e.seq <= c.payload.request.toSeq),
        agent: def,
        agentVersion: 1,
        model: MODEL,
        step: c.payload.step,
        ...(c.payload.request.absorbedUpToSeq !== undefined && {
          absorbedUpToSeq: c.payload.request.absorbedUpToSeq,
        }),
      });
      expect(rebuilt.meta.systemHash).toBe(c.payload.request.systemHash);
      const sys = rebuilt.request.system[0]?.text ?? "";
      expect(sys).toContain("- alpha: Use for alpha work.");
      expect(sys).toContain("- charlie:");
      expect(sys).not.toContain("beta");
    }
  });

  it("an agent without skills gets no catalog event and no skill_load tool", async () => {
    const agentId = await createSkillAgent([]);
    const conv = await createConv(owner, orgId, agentId);
    const r = await call(conv, "skill_load", { name: "alpha" }, 1);
    expect(r.isError).toBe(true);
    expect(await catalogs(conv)).toHaveLength(0);
  });

  it("skills with scripts are copied to /skills/<name>/ and run with an interpreter; re-copied on version change and recreation", async () => {
    const delta = await seedSkill({
      name: "delta",
      files: {
        "SKILL.md": skillMd("delta", "Run scripts/run.sh."),
        "scripts/run.sh": "echo delta-v1",
        "data/notes.txt": "notes",
      },
    });
    const agentId = await createSkillAgent([delta.id]);
    const conv = await createConv(owner, orgId, agentId);

    const r = await call(conv, "skill_load", { name: "delta" }, 1);
    expect(r.isError, r.content).toBe(false);
    expect(r.content).toContain("/skills/delta/");
    expect(r.content).toContain("scripts/run.sh");
    expect(r.content).toMatch(/\bsh \/skills\/delta\//);
    expect(await sandboxFile(conv, "skills/delta/scripts/run.sh")).toBe("echo delta-v1");
    expect(await sandboxFile(conv, "skills/delta/data/notes.txt")).toBe("notes");

    const run = await call(conv, "sandbox_bash", { command: "sh /skills/delta/scripts/run.sh" }, 2);
    expect(run.content).toContain("delta-v1");

    // 同一版本再加载：标记命中，不重新复制（被改过的文件保持原样）
    const p = join(root, "instances", await sandboxId(conv), "fs", "skills/delta/data/notes.txt");
    await writeFile(p, "touched");
    const again = await call(conv, "skill_load", { name: "delta" }, 3);
    expect(again.isError).toBe(false);
    expect(await sandboxFile(conv, "skills/delta/data/notes.txt")).toBe("touched");

    // 新版本：下一轮写新快照（提醒「已更新」），加载时复制新版本
    await seedSkill({
      name: "delta",
      skillId: delta.id,
      files: {
        "SKILL.md": skillMd("delta", "Run scripts/run.sh (v2)."),
        "scripts/run.sh": "echo delta-v2",
      },
    });
    const v2 = await call(conv, "skill_load", { name: "delta" }, 4);
    expect(v2.content).toContain("version 2");
    expect(v2.content).toContain("(v2)");
    // v1 独有的 data/notes.txt 留在原处，列为旧版本遗留（M18）
    expect(v2.content).toMatch(/left over from an earlier version[^\n]*data\/notes\.txt/);
    expect(await sandboxFile(conv, "skills/delta/scripts/run.sh")).toBe("echo delta-v2");
    const snaps = await catalogs(conv);
    expect(snaps.map((s) => s.payload.skills[0]?.version)).toEqual([1, 2]);

    // 沙箱被销毁：重建后重新复制
    await removeFakeSandbox(root, await sandboxId(conv));
    const re = await call(conv, "skill_load", { name: "delta" }, 5);
    expect(re.isError, re.content).toBe(false);
    expect(re.content).toContain("recreated");
    expect(await sandboxFile(conv, "skills/delta/scripts/run.sh")).toBe("echo delta-v2");
  });

  it("a deleted skill drops out of the next snapshot", async () => {
    const alpha = await seedSkill({
      name: "alpha",
      files: { "SKILL.md": skillMd("alpha", "Alpha body.") },
    });
    const agentId = await createSkillAgent([alpha.id]);
    const conv = await createConv(owner, orgId, agentId);
    expect((await call(conv, "skill_load", { name: "alpha" }, 1)).isError).toBe(false);
    await db
      .updateTable("skills")
      .set({ deleted_at: new Date() })
      .where("id", "=", alpha.id)
      .execute();
    const r = await call(conv, "skill_load", { name: "alpha" }, 2);
    expect(r.isError).toBe(true);
    const snaps = await catalogs(conv);
    expect(snaps.map((s) => s.payload.skills.length)).toEqual([1, 0]);
    // 最新快照为空也照样带 skill_load（不改工具集合：缓存前缀不变，也不会出现没有工具却有 tool_use 历史的请求）
    const calls = (await eventsOf(db, conv)).filter(
      (e): e is Extract<ConversationEvent, { type: "model_call" }> => e.type === "model_call",
    );
    const keys = (i: number) => (calls.at(i)?.payload.request.tools ?? []).map((t) => t.key);
    expect(keys(0)).toContain("skill_load");
    expect(keys(-1)).toContain("skill_load");
  });
});

describe("skill_load handler", { timeout: 60_000 }, () => {
  type Snapshot = EventPayload<"skills_catalog">;

  function tool(snapshot: Snapshot | null, sandboxAvailable: boolean) {
    return skillLoadTool({
      db,
      storage: k.storage,
      eventLog: {
        append: async () => [],
        latestOfType: async () =>
          snapshot === null
            ? undefined
            : ({
                conversationId: "c",
                seq: 3,
                runId: "r",
                createdAt: new Date(),
                type: "skills_catalog",
                payload: snapshot,
              } as ConversationEvent as never),
      },
      sandbox: {
        available: sandboxAvailable,
        withSandbox: async () => {
          throw new Error("sandbox must not be used");
        },
      },
      attachments: {
        listForConversation: async () => [],
        openForConversation: async () => null,
      },
      config: () => k.config,
    });
  }

  const ctx = () => ({
    orgId,
    accountId: ownerId,
    agentId: "a",
    conversationId: randomUUID(),
    callId: "call-1",
    signal: new AbortController().signal,
  });

  it("no sandbox provider: returns the body and says scripts are unavailable", async () => {
    const s = await seedSkill({
      name: "echo",
      files: { "SKILL.md": skillMd("echo", "Echo body."), "run.py": "print(1)" },
    });
    const t = tool(
      { skills: [{ id: s.id, name: "echo", description: "d", version: 1, source: s.prefix }] },
      false,
    );
    const r = (await t.run({ name: "echo" }, ctx())) as ToolResult;
    const text = (r.content[0] as { text: string }).text;
    expect(text).toContain("Echo body.");
    expect(text).toContain("run.py");
    expect(text).toMatch(/no sandbox/i);
    expect(text).toMatch(/scripts?.*(not available|unavailable|cannot)/i);
  });

  it("agent without sandbox tools: no sandbox is created, body only", async () => {
    const s = await seedSkill({
      name: "nobox",
      files: { "SKILL.md": skillMd("nobox", "Nobox body."), "run.sh": "echo hi" },
    });
    // 有沙箱提供方，但本步没有沙箱工具：withSandbox 一旦被调用，存根就抛错
    const t = tool(
      { skills: [{ id: s.id, name: "nobox", description: "d", version: 1, source: s.prefix }] },
      true,
    );
    const r = (await t.run({ name: "nobox" }, { ...ctx(), tools: [] })) as ToolResult;
    const text = (r.content[0] as { text: string }).text;
    expect(text).toContain("Nobox body.");
    expect(text).toContain("run.sh");
    expect(text).toMatch(/no sandbox tools/i);
  });

  it("a skill removed after the snapshot: actionable error", async () => {
    const s = await seedSkill({ name: "gone", files: { "SKILL.md": skillMd("gone", "x") } });
    await db.updateTable("skills").set({ deleted_at: new Date() }).where("id", "=", s.id).execute();
    const t = tool(
      { skills: [{ id: s.id, name: "gone", description: "d", version: 1, source: s.prefix }] },
      true,
    );
    await expect(t.run({ name: "gone" }, ctx())).rejects.toThrow(/removed.*(ask|do the task)/i);
  });

  it("file content that does not match the manifest sha256 is rejected", async () => {
    const s = await seedSkill({ name: "bad", files: { "SKILL.md": skillMd("bad", "ok") } });
    const v = await db
      .selectFrom("skill_versions")
      .select("object_prefix")
      .where("skill_id", "=", s.id)
      .executeTakeFirstOrThrow();
    const evil = new TextEncoder().encode(skillMd("bad", "tampered"));
    await k.storage.kernel(orgId).put(`${v.object_prefix}SKILL.md`, evil, {
      contentType: "application/octet-stream",
      size: evil.byteLength,
    });
    const t = tool(
      { skills: [{ id: s.id, name: "bad", description: "d", version: 1, source: s.prefix }] },
      true,
    );
    await expect(t.run({ name: "bad" }, ctx())).rejects.toThrow(/integrity/i);
  });

  it("no catalog: actionable error", async () => {
    const t = tool(null, true);
    await expect(t.run({ name: "x" }, ctx())).rejects.toThrow(/no skills/i);
  });
});

describe("phase B snapshot: plugins, pinned skills and the Claude tool map", {
  timeout: 90_000,
}, () => {
  const pinnedOf = (e: Extract<ConversationEvent, { type: "skills_catalog" }> | undefined) =>
    (e?.payload.pinned ?? []).map((p) => [p.name, p.version, p.body]);

  it("a catalog skill from a plugin carries plugin; an uploaded one does not", async () => {
    const brain = await seedSkill({
      name: "brainstorming",
      plugin: "superpowers",
      files: { "SKILL.md": skillMd("brainstorming", "Brainstorm first.") },
    });
    const own = await seedSkill({
      name: "notes",
      files: { "SKILL.md": skillMd("notes", "Take notes.") },
    });
    const agentId = await createSkillAgent([brain.id, own.id]);
    const conv = await createConv(owner, orgId, agentId);
    await say(conv, 1);
    const [snap] = await catalogs(conv);
    expect(snap?.payload.skills.map((s) => [s.name, s.plugin])).toEqual([
      ["brainstorming", "superpowers"],
      ["notes", undefined],
    ]);
    expect(snap?.payload.pinned).toBeUndefined();
    expect(snap?.payload.toolMap).toBeUndefined();
  });

  it("pinned bodies go into the snapshot in the agent's order with version and source", async () => {
    const a = await seedSkill({
      name: "alpha",
      files: { "SKILL.md": skillMd("alpha", "A body.") },
    });
    const b = await seedSkill({ name: "beta", files: { "SKILL.md": skillMd("beta", "B body.") } });
    const agentId = await createSkillAgent([a.id, b.id], [b.id, a.id]);
    const conv = await createConv(owner, orgId, agentId);
    await say(conv, 1);
    const [snap] = await catalogs(conv);
    expect(snap?.payload.pinned).toEqual([
      { id: b.id, version: 1, name: "beta", source: b.prefix, body: "B body." },
      { id: a.id, version: 1, name: "alpha", source: a.prefix, body: "A body." },
    ]);
  });

  it("an old snapshot without plugin / pinned / toolMap and unchanged skills: no new event (Review Focus 1)", async () => {
    const brain = await seedSkill({
      name: "brainstorming",
      plugin: "superpowers",
      files: { "SKILL.md": skillMd("brainstorming", "Brainstorm first.") },
    });
    const agentId = await createSkillAgent([brain.id]);
    const conv = await createConv(owner, orgId, agentId);
    await say(conv, 1);
    // rewrite the snapshot as a kernel before phase B wrote it (no plugin field)
    const [snap] = await catalogs(conv);
    const old = { skills: snap?.payload.skills.map(({ plugin: _p, ...rest }) => rest) };
    await db
      .updateTable("conversation_events")
      .set({ payload: JSON.stringify(old) })
      .where("conversation_id", "=", conv)
      .where("seq", "=", String(snap?.seq))
      .execute();
    await say(conv, 2);
    const snaps = await catalogs(conv);
    expect(snaps).toHaveLength(1);
    expect(snaps[0]?.payload).toEqual(old);
  });

  it("unpinning, a new version of a pinned skill and deleting a pinned skill each write a new snapshot (Review Focus 2)", async () => {
    const a = await seedSkill({ name: "alpha", files: { "SKILL.md": skillMd("alpha", "A1.") } });
    const b = await seedSkill({ name: "beta", files: { "SKILL.md": skillMd("beta", "B1.") } });
    const agentId = await createSkillAgent([a.id, b.id], [a.id, b.id]);
    const conv = await createConv(owner, orgId, agentId);
    await say(conv, 1);
    // unpin beta
    await setSkills(agentId, [a.id, b.id], [a.id]);
    await say(conv, 2);
    // a new version of alpha
    await seedSkill({
      name: "alpha",
      skillId: a.id,
      files: { "SKILL.md": skillMd("alpha", "A2.") },
    });
    await say(conv, 3);
    // alpha deleted: the run goes on without it
    await db.updateTable("skills").set({ deleted_at: new Date() }).where("id", "=", a.id).execute();
    await say(conv, 4);
    const snaps = await catalogs(conv);
    expect(snaps.map(pinnedOf)).toEqual([
      [
        ["alpha", 1, "A1."],
        ["beta", 1, "B1."],
      ],
      [["alpha", 1, "A1."]],
      [["alpha", 2, "A2."]],
      [],
    ]);
    expect(snaps[3]?.payload.pinned).toBeUndefined();
    const terminal = (await eventsOf(db, conv)).filter((e) => e.type.startsWith("run_f"));
    expect(terminal.map((e) => e.type)).toEqual([
      "run_finished",
      "run_finished",
      "run_finished",
      "run_finished",
    ]);
  });

  it("a pinned set over 32 KB at run time keeps what fits and warns (Review Focus 4)", async () => {
    const a = await seedSkill({ name: "alpha", files: { "SKILL.md": skillMd("alpha", "A1.") } });
    const b = await seedSkill({ name: "beta", files: { "SKILL.md": skillMd("beta", "B1.") } });
    const c = await seedSkill({ name: "gamma", files: { "SKILL.md": skillMd("gamma", "C1.") } });
    const agentId = await createSkillAgent([a.id, b.id, c.id], [a.id, b.id, c.id]);
    // beta's new version alone is 30000 bytes: alpha fits, beta does not, gamma is dropped too
    await seedSkill({
      name: "beta",
      skillId: b.id,
      files: { "SKILL.md": skillMd("beta", "b".repeat(30_000)) },
    });
    await seedSkill({
      name: "alpha",
      skillId: a.id,
      files: { "SKILL.md": skillMd("alpha", "a".repeat(3_000)) },
    });
    const conv = await createConv(owner, orgId, agentId);
    await say(conv, 1);
    const [snap] = await catalogs(conv);
    expect(snap?.payload.pinned?.map((p) => [p.name, p.version])).toEqual([["alpha", 2]]);
  });

  it("toolMap appears with the first claude-code skill and goes with the last", async () => {
    const own = await seedSkill({ name: "notes", files: { "SKILL.md": skillMd("notes", "N.") } });
    const brain = await seedSkill({
      name: "brainstorming",
      plugin: "superpowers",
      format: "claude-code",
      files: { "SKILL.md": skillMd("brainstorming", "Brainstorm first.") },
    });
    const agentId = await createSkillAgent([own.id]);
    const conv = await createConv(owner, orgId, agentId);
    await say(conv, 1);
    await setSkills(agentId, [own.id, brain.id]);
    await say(conv, 2);
    await setSkills(agentId, [own.id]);
    await say(conv, 3);
    const snaps = await catalogs(conv);
    expect(snaps.map((s) => s.payload.toolMap)).toEqual([
      undefined,
      CLAUDE_CODE_TOOL_MAP,
      undefined,
    ]);
  });

  it("a storage failure while reading a pinned body ends the run with run_failed storage.unavailable and writes no snapshot", async () => {
    const a = await seedSkill({ name: "alpha", files: { "SKILL.md": skillMd("alpha", "A1.") } });
    const agentId = await createSkillAgent([a.id], [a.id]);
    // the stored SKILL.md no longer matches its manifest
    const evil = new TextEncoder().encode(skillMd("alpha", "tampered"));
    await k.storage.kernel(orgId).put(`${a.prefix}SKILL.md`, evil, {
      contentType: "application/octet-stream",
      size: evil.byteLength,
    });
    const conv = await createConv(owner, orgId, agentId);
    await postMessage(owner, orgId, conv, "hello");
    const [end] = await waitForTerminal(db, conv, 1, 30_000);
    expect(end?.type).toBe("run_failed");
    expect((end?.payload as { error?: { code: string } } | undefined)?.error).toEqual({
      code: "storage.unavailable",
      // permanent: sending again cannot help, so the message points at the agent's owner (M4)
      message: `Pinned skill "alpha" cannot be read; ask the agent's owner to unpin it or upload it again.`,
    });
    const events = await eventsOf(db, conv);
    expect(events.some((e) => e.type === "skills_catalog")).toBe(false);
    expect(events.some((e) => e.type === "model_call")).toBe(false);
  });

  /**
   * Wraps the kernel's object store so that each read of a pinned SKILL.md first runs `onRead`
   * (the run worker and the test share this StorageService instance).
   */
  function onPinnedRead(onRead: () => Promise<void>) {
    const original = k.storage.kernel.bind(k.storage);
    return vi.spyOn(k.storage, "kernel").mockImplementation((id: string) => {
      const store = original(id);
      return new Proxy(store, {
        get(target, prop, receiver) {
          if (prop !== "get") return Reflect.get(target, prop, receiver);
          return async (key: string, opts?: { signal?: AbortSignal }) => {
            if (key.endsWith("SKILL.md")) await onRead();
            return target.get(key, opts);
          };
        },
      });
    });
  }

  it("recordSkillsCatalog: a pinned version that changes while its body is read is resolved again (M9)", async () => {
    const a = await seedSkill({ name: "alpha", files: { "SKILL.md": skillMd("alpha", "A1.") } });
    const agentId = await createSkillAgent([a.id], [a.id]);
    const conv = await createConv(owner, orgId, agentId);
    let reads = 0;
    const spy = onPinnedRead(async () => {
      // the first read sees version 1 while version 2 lands: the transaction sees another set
      if (++reads === 1) {
        await seedSkill({
          name: "alpha",
          skillId: a.id,
          files: { "SKILL.md": skillMd("alpha", "A2.") },
        });
      }
    });
    try {
      await recordSkillsCatalog(
        { db, eventLog: k.runs.eventLog, storage: k.storage },
        {
          orgId,
          agentId,
          conversationId: conv,
          runId: "run-retry",
          agent: { skills: { orgSkills: [a.id], pinned: [a.id] } } as AgentDefinition,
        },
      );
    } finally {
      spy.mockRestore();
    }
    expect(reads).toBe(2);
    const snaps = await catalogs(conv);
    expect(snaps.map(pinnedOf)).toEqual([[["alpha", 2, "A2."]]]);
  });

  it("recordSkillsCatalog: pins that keep changing give conflict after three attempts; a run fails with run_failed conflict (M9)", async () => {
    const a = await seedSkill({ name: "alpha", files: { "SKILL.md": skillMd("alpha", "A1.") } });
    const agentId = await createSkillAgent([a.id], [a.id]);
    const conv = await createConv(owner, orgId, agentId);
    let reads = 0;
    const spy = onPinnedRead(async () => {
      reads++;
      await seedSkill({
        name: "alpha",
        skillId: a.id,
        files: { "SKILL.md": skillMd("alpha", `A${reads + 1}.`) },
      });
    });
    try {
      const err = await recordSkillsCatalog(
        { db, eventLog: k.runs.eventLog, storage: k.storage },
        {
          orgId,
          agentId,
          conversationId: conv,
          runId: "run-conflict",
          agent: { skills: { orgSkills: [a.id], pinned: [a.id] } } as AgentDefinition,
        },
      ).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).code).toBe("conflict");
      expect(reads).toBe(3);
      expect(await catalogs(conv)).toEqual([]);

      // the run worker turns it into run_failed conflict before any model request
      await postMessage(owner, orgId, conv, "hello");
      const [end] = await waitForTerminal(db, conv, 1, 30_000);
      expect(end?.type).toBe("run_failed");
      expect((end?.payload as { error?: unknown } | undefined)?.error).toEqual({
        code: "conflict",
        message: "The pinned skills kept changing while the run started; send the message again.",
      });
      const events = await eventsOf(db, conv);
      expect(events.some((e) => e.type === "skills_catalog")).toBe(false);
      expect(events.some((e) => e.type === "model_call")).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  it('skill_load "superpowers:brainstorming" loads brainstorming; "other:brainstorming" is not in the catalog; a plain name still works', async () => {
    const brain = await seedSkill({
      name: "brainstorming",
      plugin: "superpowers",
      files: { "SKILL.md": skillMd("brainstorming", "Brainstorm first.") },
    });
    const agentId = await createSkillAgent([brain.id]);
    const conv = await createConv(owner, orgId, agentId);
    const q = await call(conv, "skill_load", { name: "superpowers:brainstorming" }, 1);
    expect(q.isError, q.content).toBe(false);
    expect(q.content).toContain('Loaded skill "brainstorming" (version 1)');
    expect(q.content).toContain("Brainstorm first.");
    const other = await call(conv, "skill_load", { name: "other:brainstorming" }, 2);
    expect(other.isError).toBe(true);
    expect(other.content).toContain("not in the skills catalog");
    expect(other.content).toContain(": brainstorming.");
    const plain = await call(conv, "skill_load", { name: "brainstorming" }, 3);
    expect(plain.isError, plain.content).toBe(false);
    expect(plain.content).toContain("Brainstorm first.");
  });
});
