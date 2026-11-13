import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderSkillBody, renderSkillInvocation, type ToolResult } from "@capybara-hq/plugin-sdk";
import {
  fakeExtensionEntry,
  startTestPostgres,
  startTestRedis,
  startTestS3,
  type TestContainer,
  type TestS3,
} from "@capybara-hq/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { AgentDefinition } from "../../src/agents/definition.js";
import type { ConversationEvent, EventPayload } from "../../src/conversations/events.js";
import { type KernelSchemaDb, kernelDb, type SkillManifest } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { KernelConfigService } from "../../src/infra/config/kernel-config.service.js";
import { buildModelRequest } from "../../src/runtime/context/build.js";
import { CLAUDE_CODE_TOOL_MAP } from "../../src/runtime/context/claude-tools.js";
import { StorageService } from "../../src/storage/storage.service.js";
import { skillLoadTool } from "../../src/tools/builtins/skill-load.js";
import { specHash } from "../../src/tools/registry.js";
import { removeFakeSandbox } from "../fixtures/plugins/sandbox-fake/index.js";
import { truncateTables } from "../helpers/db.js";
import { onlyBuiltins } from "../helpers/disabled-tools.js";
import { accountsFor } from "../helpers/identity.js";
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
  type TestKernel,
  waitForTerminal,
} from "../helpers/runs.js";
import { onlySkills } from "../helpers/skills.js";
import { MODEL } from "../runtime/context/fixtures.js";

/**
 * M5 T14：技能目录（日志快照 `skills_catalog`，Ruling M17）、`Skill` 与复制进沙箱。
 * 真实内核 + model-fake（`tool:<key>:<json>`）+ 假沙箱插件 + SeaweedFS。技能行与文件直接写库 / 存储。
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
let k: TestKernel;
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
});

afterAll(async () => {
  await k?.close();
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
    "capybara.agent_template_versions, capybara.agent_templates, capybara.skill_versions, capybara.skills, capybara.catalog_items, capybara.device_instances, capybara.devices, capybara.attachments, capybara.approvals, capybara.tool_outputs, capybara.conversation_events, capybara.runs, capybara.conversations, capybara.agent_versions, capybara.agent_members, capybara.agents, capybara.memberships, capybara.orgs, capybara.sessions, capybara.local_passwords, capybara.identities, capybara.accounts",
  );
  const accounts = accountsFor(db);
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
  /** Phase D invocation metadata (absent: an ordinary skill). */
  invocation?: SkillManifest["invocation"];
}): Promise<{ id: string; version: number; prefix: string }> {
  const prefix = `skills/${randomUUID()}/`;
  const store = k.app.get(StorageService).kernel(orgId);
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
  const manifest = {
    name: opts.name,
    description,
    files,
    ...(opts.invocation !== undefined && { invocation: opts.invocation }),
  };
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

/**
 * An agent that has only `keep` of the org's skills (and its own): every other org skill is turned
 * off (skills default-on spec §4), so the catalogs stay what selecting `keep` gave.
 */
async function createSkillAgent(keep: string[]): Promise<string> {
  const res = await owner({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/agents`,
    payload: {
      definition: {
        name: "Skilled",
        instructions: "Use skills.",
        model: { provider: "model-fake", model: "fake-1" },
        disabledTools: onlyBuiltins([{ kind: "builtin", name: "Bash" }]),
        disabledSkills: await onlySkills(db, orgId, keep),
      },
      visibility: "org",
    },
  });
  expect(res.statusCode, res.body).toBe(201);
  return (res.json() as { agent: { id: string } }).agent.id;
}

/** Leaves the agent only `keep` of the org's skills (a new agent version; the next run uses it). */
async function setSkills(agentId: string, keep: string[]): Promise<void> {
  const res = await owner({
    method: "PATCH",
    url: `/api/v1/orgs/${orgId}/agents/${agentId}`,
    payload: {
      definition: {
        name: "Skilled",
        instructions: "Use skills.",
        model: { provider: "model-fake", model: "fake-1" },
        disabledTools: onlyBuiltins([{ kind: "builtin", name: "Bash" }]),
        disabledSkills: await onlySkills(db, orgId, keep),
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
    .selectFrom("device_instances")
    .innerJoin("conversations", "conversations.device_id", "device_instances.device_id")
    .select("device_instances.handle")
    .where("conversations.id", "=", convId)
    .executeTakeFirstOrThrow();
  return (row.handle as { id: string }).id;
}

/** Where the fake provider keeps a file of the conversation's device (`skills/…`, `workspace/…`). */
async function sandboxFilePath(convId: string, path: string): Promise<string> {
  const meta = JSON.parse(
    await readFile(join(root, "instances", await sandboxId(convId), "meta.json"), "utf8"),
  ) as { fileSystem: string };
  return join(root, "filesystems", meta.fileSystem, path);
}

const sandboxFile = async (convId: string, path: string) =>
  readFile(await sandboxFilePath(convId, path), "utf8").catch(() => null);

describe("skills at runtime", () => {
  it("catalog snapshot lists the org skills left on + agent skills; Skill returns the body; turned-off skills are invisible", async () => {
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

    const r = await call(conv, "Skill", { skill: "alpha" }, 1);
    expect(r.isError, r.content).toBe(false);
    expect(r.content).toContain("Do alpha step by step.");
    expect(r.content).toContain("version 1");
    expect(r.content).not.toContain("name: alpha");
    expect(r.display?.summary.en).toContain("alpha");
    expect(r.display?.summary.zh).toContain("alpha");
    // 只有 SKILL.md：不创建沙箱
    const boxes = await db.selectFrom("device_instances").select("device_id").execute();
    expect(boxes).toHaveLength(0);

    const snaps = await catalogs(conv);
    expect(snaps).toHaveLength(1);
    expect(snaps[0]?.payload.skills.map((s) => [s.name, s.version])).toEqual([
      ["alpha", 1],
      ["charlie", 1],
    ]);

    // an org skill the agent turned off: not in the catalog, loading it fails
    const b = await call(conv, "Skill", { skill: "beta" }, 2);
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

  it("an agent without skills gets no catalog event and no Skill tool", async () => {
    const agentId = await createSkillAgent([]);
    const conv = await createConv(owner, orgId, agentId);
    const r = await call(conv, "Skill", { skill: "alpha" }, 1);
    expect(r.isError).toBe(true);
    expect(await catalogs(conv)).toHaveLength(0);
  });

  it("skills with scripts are copied to /skills/<name>@<digest>/ and run with an interpreter; two versions coexist; a restart keeps the copies", async () => {
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
    const digestIn = (content: string): string =>
      (/\/skills\/delta@([0-9a-f]{12})\//.exec(content) as RegExpExecArray)[1] as string;

    const r = await call(conv, "Skill", { skill: "delta" }, 1);
    expect(r.isError, r.content).toBe(false);
    const d1 = digestIn(r.content);
    const dir1 = `skills/delta@${d1}`;
    expect(r.content).toContain(`/skills/delta@${d1}/`);
    expect(r.content).toContain("scripts/run.sh");
    expect(r.content).toMatch(/\bsh \/skills\/delta@[0-9a-f]{12}\//);
    expect(await sandboxFile(conv, `${dir1}/scripts/run.sh`)).toBe("echo delta-v1");
    expect(await sandboxFile(conv, `${dir1}/data/notes.txt`)).toBe("notes");
    expect(await sandboxFile(conv, `skills/.capybara/delta@${d1}.json`)).toContain(
      `"digest":"${d1}"`,
    );

    const run = await call(
      conv,
      "Bash",
      { description: "Test step", command: `sh /${dir1}/scripts/run.sh` },
      2,
    );
    expect(run.content).toContain("delta-v1");

    // the same version again: the marker hits, nothing is copied again (a touched file stays)
    const p = await sandboxFilePath(conv, `${dir1}/data/notes.txt`);
    await writeFile(p, "touched");
    const again = await call(conv, "Skill", { skill: "delta" }, 3);
    expect(again.isError).toBe(false);
    expect(await sandboxFile(conv, `${dir1}/data/notes.txt`)).toBe("touched");

    // a new version: the next turn writes a new snapshot; it is copied beside the old one
    await seedSkill({
      name: "delta",
      skillId: delta.id,
      files: {
        "SKILL.md": skillMd("delta", "Run scripts/run.sh (v2)."),
        "scripts/run.sh": "echo delta-v2",
      },
    });
    const v2 = await call(conv, "Skill", { skill: "delta" }, 4);
    expect(v2.content).toContain("version 2");
    expect(v2.content).toContain("(v2)");
    const d2 = digestIn(v2.content);
    expect(d2).not.toBe(d1);
    const dir2 = `skills/delta@${d2}`;
    expect(await sandboxFile(conv, `${dir2}/scripts/run.sh`)).toBe("echo delta-v2");
    // both versions and both markers coexist
    expect(await sandboxFile(conv, `${dir1}/scripts/run.sh`)).toBe("echo delta-v1");
    expect(await sandboxFile(conv, `skills/.capybara/delta@${d1}.json`)).toContain(d1);
    expect(await sandboxFile(conv, `skills/.capybara/delta@${d2}.json`)).toContain(d2);
    const snaps = await catalogs(conv);
    expect(snaps.map((s) => s.payload.skills[0]?.version)).toEqual([1, 2]);

    // the instance is destroyed: the device's files are kept, so the copies and markers are
    // still there and nothing is copied again
    await removeFakeSandbox(root, await sandboxId(conv));
    const re = await call(conv, "Skill", { skill: "delta" }, 5);
    expect(re.isError, re.content).toBe(false);
    expect(re.content).toContain("restarted");
    expect(await sandboxFile(conv, `${dir2}/scripts/run.sh`)).toBe("echo delta-v2");
  });

  it("a deleted skill drops out of the next snapshot", async () => {
    const alpha = await seedSkill({
      name: "alpha",
      files: { "SKILL.md": skillMd("alpha", "Alpha body.") },
    });
    const agentId = await createSkillAgent([alpha.id]);
    const conv = await createConv(owner, orgId, agentId);
    expect((await call(conv, "Skill", { skill: "alpha" }, 1)).isError).toBe(false);
    await db
      .updateTable("skills")
      .set({ deleted_at: new Date() })
      .where("id", "=", alpha.id)
      .execute();
    const r = await call(conv, "Skill", { skill: "alpha" }, 2);
    expect(r.isError).toBe(true);
    const snaps = await catalogs(conv);
    expect(snaps.map((s) => s.payload.skills.length)).toEqual([1, 0]);
    // 最新快照为空也照样带 Skill（不改工具集合：缓存前缀不变，也不会出现没有工具却有 tool_use 历史的请求）
    const calls = (await eventsOf(db, conv)).filter(
      (e): e is Extract<ConversationEvent, { type: "model_call" }> => e.type === "model_call",
    );
    const keys = (i: number) => (calls.at(i)?.payload.request.tools ?? []).map((t) => t.key);
    expect(keys(0)).toContain("Skill");
    expect(keys(-1)).toContain("Skill");
  });
});

describe("Skill handler", () => {
  type Snapshot = EventPayload<"skills_catalog">;

  function tool(snapshot: Snapshot | null, sandboxAvailable: boolean) {
    return skillLoadTool({
      db,
      storage: k.app.get(StorageService),
      eventLog: {
        append: async () => [],
        latestFileState: async () => null,
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
        cloudAvailable: sandboxAvailable,
        availableFor: async () => sandboxAvailable,
        withSandbox: async () => {
          throw new Error("sandbox must not be used");
        },
      },
      devices: { forTool: async () => randomUUID() },
      attachments: {
        listForConversation: async () => [],
        openForConversation: async () => null,
      },
      config: { get: () => k.app.get(KernelConfigService).get() },
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
    const r = (await t.run({ skill: "echo" }, ctx())) as ToolResult;
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
    const r = (await t.run({ skill: "nobox" }, { ...ctx(), tools: [] })) as ToolResult;
    const text = (r.content[0] as { text: string }).text;
    expect(text).toContain("Nobox body.");
    expect(text).toContain("run.sh");
    expect(text).toMatch(/no sandbox tools/i);
  });

  it("custom roots: files, markers and CLAUDE_SKILL_DIR under the instance's skills root", async () => {
    const roots = {
      workspace: "/Users/u/capybara-device/e1/workspace",
      skills: "/Users/u/capybara-device/e1/skills",
      tmp: "/Users/u/capybara-device/e1/tmp",
    };
    const s = await seedSkill({
      name: "dev",
      files: {
        // biome-ignore lint/suspicious/noTemplateCurlyInString: the Claude Code variable
        "SKILL.md": skillMd("dev", "Run sh ${CLAUDE_SKILL_DIR}/run.sh."),
        "run.sh": "echo hi",
      },
    });
    const writes: string[] = [];
    const p = {
      readFile: async () => null,
      writeFile: async (_h: unknown, path: string) => {
        writes.push(path);
      },
    };
    const t = skillLoadTool({
      db,
      storage: k.app.get(StorageService),
      eventLog: {
        append: async () => [],
        latestFileState: async () => null,
        latestOfType: async (_c: string, type: string) =>
          (type !== "skills_catalog"
            ? undefined
            : {
                conversationId: "c",
                seq: 3,
                runId: "r",
                createdAt: new Date(),
                type: "skills_catalog",
                payload: {
                  skills: [
                    { id: s.id, name: "dev", description: "d", version: 1, source: s.prefix },
                  ],
                },
              }) as never,
      },
      sandbox: {
        cloudAvailable: true,
        availableFor: async () => true,
        withSandbox: async (_c, fn, sig) =>
          fn({ id: "e1", roots }, p as never, { fresh: false, restarted: false, roots }, sig),
      },
      devices: { forTool: async () => randomUUID() },
      attachments: {
        listForConversation: async () => [],
        openForConversation: async () => null,
      },
      config: { get: () => k.app.get(KernelConfigService).get() },
    });
    const bash = { key: "Bash", source: { kind: "builtin", name: "Bash" } };
    const r = (await t.run({ skill: "dev" }, { ...ctx(), tools: [bash as never] })) as ToolResult;
    const text = (r.content[0] as { text: string }).text;
    const dir = writes[0]?.slice(0, writes[0].lastIndexOf("/"));
    expect(dir).toMatch(/^\/Users\/u\/capybara-device\/e1\/skills\/dev@[0-9a-f]{12}$/);
    expect(writes.sort()).toEqual(
      [
        `${dir}/SKILL.md`,
        `${dir}/run.sh`,
        `${roots.skills}/.capybara/${dir?.slice(roots.skills.length + 1)}.json`,
      ].sort(),
    );
    expect(text).toContain(`Run sh ${dir}/run.sh.`);
    expect(text).toContain(`copied to ${dir}/ in the sandbox`);
    expect(text).toContain(`Write outputs under ${roots.workspace}, not ${roots.skills}.`);
    expect(text).not.toMatch(/(^|[\s(`])\/skills\/dev@/);
  });

  describe("args", () => {
    const run = async (body: string, args: string | undefined, name = "argskill") => {
      const s = await seedSkill({ name, files: { "SKILL.md": skillMd(name, body) } });
      const t = tool(
        { skills: [{ id: s.id, name, description: "d", version: 1, source: s.prefix }] },
        false,
      );
      const r = (await t.run(
        args === undefined ? { skill: name } : { skill: name, args },
        ctx(),
      )) as ToolResult;
      return (r.content[0] as { text: string }).text;
    };

    it("substitutes positional placeholders", async () => {
      const text = await run("Fix issue $ARGUMENTS[0] in $1", "123 api");
      expect(text).toContain("Fix issue 123 in api");
    });

    it("appends ARGUMENTS when the body has no placeholder", async () => {
      const text = await run("Plain instructions.", "x y");
      expect(text).toContain("ARGUMENTS: x y");
    });

    it("renders $ARGUMENTS empty without args", async () => {
      const text = await run("Do it: [$ARGUMENTS]", undefined);
      expect(text).toContain("Do it: []");
      expect(text).not.toContain("$ARGUMENTS");
    });

    it("the schema limits args to 10 000 characters; the handler refuses more", async () => {
      const props = skillLoadTool({} as never).spec.inputSchema.properties as Record<
        string,
        { maxLength?: number }
      >;
      expect(props.args?.maxLength).toBe(10_000);
      await expect(run("b", "a".repeat(10_001), "toolong")).rejects.toThrow(/10000|10 000/);
    });

    it("renders the same body text as a person's /name invocation", async () => {
      const body = "Fix issue $ARGUMENTS[0] in $1";
      const text = await run(body, "123 api", "same");
      const person = renderSkillInvocation({
        name: "same",
        skillName: "same",
        version: 1,
        body,
        digest: "000000000000",
        invocation: { model: true, user: true },
        args: "123 api",
        lines: {},
      });
      expect(person).toContain("Fix issue 123 in api");
      expect(text).toContain(
        renderSkillBody(body, { model: true, user: true }, "123 api", "same", "000000000000"),
      );
    });
  });

  it("a skill removed after the snapshot: actionable error", async () => {
    const s = await seedSkill({ name: "gone", files: { "SKILL.md": skillMd("gone", "x") } });
    await db.updateTable("skills").set({ deleted_at: new Date() }).where("id", "=", s.id).execute();
    const t = tool(
      { skills: [{ id: s.id, name: "gone", description: "d", version: 1, source: s.prefix }] },
      true,
    );
    await expect(t.run({ skill: "gone" }, ctx())).rejects.toThrow(/removed.*(ask|do the task)/i);
  });

  it("file content that does not match the manifest sha256 is rejected", async () => {
    const s = await seedSkill({ name: "bad", files: { "SKILL.md": skillMd("bad", "ok") } });
    const v = await db
      .selectFrom("skill_versions")
      .select("object_prefix")
      .where("skill_id", "=", s.id)
      .executeTakeFirstOrThrow();
    const evil = new TextEncoder().encode(skillMd("bad", "tampered"));
    await k.app.get(StorageService).kernel(orgId).put(`${v.object_prefix}SKILL.md`, evil, {
      contentType: "application/octet-stream",
      size: evil.byteLength,
    });
    const t = tool(
      { skills: [{ id: s.id, name: "bad", description: "d", version: 1, source: s.prefix }] },
      true,
    );
    await expect(t.run({ skill: "bad" }, ctx())).rejects.toThrow(/integrity/i);
  });

  it("no catalog: actionable error", async () => {
    const t = tool(null, true);
    await expect(t.run({ skill: "x" }, ctx())).rejects.toThrow(/no skills/i);
  });
});

describe("phase B snapshot: plugins and the Claude tool map; nothing is pinned any more", () => {
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

  it("a conversation whose latest snapshot has pins gets one without them at its next run, and the request says they were removed (skills default-on spec §8)", async () => {
    const a = await seedSkill({
      name: "alpha",
      files: { "SKILL.md": skillMd("alpha", "A body.") },
    });
    const agentId = await createSkillAgent([a.id]);
    const conv = await createConv(owner, orgId, agentId);
    await say(conv, 1);
    // rewrite the snapshot as a kernel that pinned alpha wrote it
    const [snap] = await catalogs(conv);
    expect(snap?.payload.pinned).toBeUndefined();
    const old = {
      ...snap?.payload,
      pinned: [{ id: a.id, version: 1, name: "alpha", source: a.prefix, body: "A body." }],
    };
    await db
      .updateTable("conversation_events")
      .set({ payload: JSON.stringify(old) })
      .where("conversation_id", "=", conv)
      .where("seq", "=", String(snap?.seq))
      .execute();
    await say(conv, 2);
    const snaps = await catalogs(conv);
    expect(snaps).toHaveLength(2);
    expect(snaps[1]?.payload).toEqual({ skills: snap?.payload.skills });

    // the request, rebuilt from the log, carries the existing removal notice; alpha is still in
    // the catalog, so the model can load it with Skill
    const def = (
      await db
        .selectFrom("agent_versions")
        .select("definition")
        .where("agent_id", "=", agentId)
        .executeTakeFirstOrThrow()
    ).definition as unknown as AgentDefinition;
    const events = await eventsOf(db, conv);
    const last = events
      .filter(
        (e): e is Extract<ConversationEvent, { type: "model_call" }> => e.type === "model_call",
      )
      .at(-1);
    if (!last) throw new Error("no model_call");
    const rebuilt = buildModelRequest({
      events: events.filter((e) => e.seq <= last.payload.request.toSeq),
      agent: def,
      agentVersion: 1,
      model: MODEL,
      step: last.payload.step,
    });
    expect(rebuilt.meta.systemHash).toBe(last.payload.request.systemHash);
    const notices = rebuilt.request.messages.flatMap((m) =>
      m.role === "system" ? [m.content as string] : [],
    );
    expect(
      notices.some((t) =>
        t.includes("Pinned skills removed (their pinned instructions no longer apply): alpha"),
      ),
    ).toBe(true);
    expect(rebuilt.request.system[0]?.text).toContain("- alpha: Use for alpha work.");
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

  it("run start reads no object storage for skills: a SKILL.md that no longer matches its manifest does not fail the run", async () => {
    const a = await seedSkill({ name: "alpha", files: { "SKILL.md": skillMd("alpha", "A1.") } });
    const agentId = await createSkillAgent([a.id]);
    const evil = new TextEncoder().encode(skillMd("alpha", "tampered"));
    await k.app.get(StorageService).kernel(orgId).put(`${a.prefix}SKILL.md`, evil, {
      contentType: "application/octet-stream",
      size: evil.byteLength,
    });
    const conv = await createConv(owner, orgId, agentId);
    await postMessage(owner, orgId, conv, "hello");
    const [end] = await waitForTerminal(db, conv, 1, 30_000);
    expect(end?.type).toBe("run_finished");
    const snaps = await catalogs(conv);
    expect(snaps.map((e) => e.payload)).toEqual([
      { skills: [expect.objectContaining({ id: a.id, name: "alpha" })] },
    ]);
  });

  it('Skill "superpowers:brainstorming" loads brainstorming; "other:brainstorming" is not in the catalog; a plain name still works', async () => {
    const brain = await seedSkill({
      name: "brainstorming",
      plugin: "superpowers",
      files: { "SKILL.md": skillMd("brainstorming", "Brainstorm first.") },
    });
    const agentId = await createSkillAgent([brain.id]);
    const conv = await createConv(owner, orgId, agentId);
    const q = await call(conv, "Skill", { skill: "superpowers:brainstorming" }, 1);
    expect(q.isError, q.content).toBe(false);
    expect(q.content).toContain('Loaded skill "brainstorming" (version 1)');
    expect(q.content).toContain("Brainstorm first.");
    const other = await call(conv, "Skill", { skill: "other:brainstorming" }, 2);
    expect(other.isError).toBe(true);
    expect(other.content).toContain("not in the skills catalog");
    expect(other.content).toContain(": brainstorming.");
    const plain = await call(conv, "Skill", { skill: "brainstorming" }, 3);
    expect(plain.isError, plain.content).toBe(false);
    expect(plain.content).toContain("Brainstorm first.");
  });
});

describe("phase D: Skill for invoked and forked skills", () => {
  const MANUAL = { model: false, user: true } as const;

  /** A person's invocation of `name` (the n-th run's trigger). */
  async function invoke(convId: string, name: string, n: number): Promise<void> {
    const res = await owner({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/conversations/${convId}/messages`,
      payload: { text: "", skill: { name } },
    });
    expect(res.statusCode, res.body).toBe(202);
    await waitForTerminal(db, convId, n, 30_000);
  }

  /** An ordinary skill keeps the catalog non-empty, so Skill is offered. */
  async function agentWith(extra: string[]): Promise<{ agentId: string; plain: string }> {
    const plain = await seedSkill({
      name: "plain",
      files: { "SKILL.md": skillMd("plain", "Plain body.") },
    });
    return { agentId: await createSkillAgent([plain.id, ...extra]), plain: plain.id };
  }

  it("a manual-only skill loads only after a person invoked it in the conversation", async () => {
    const manual = await seedSkill({
      name: "manual",
      files: { "SKILL.md": skillMd("manual", "Manual body."), "run.sh": "echo manual" },
      invocation: MANUAL,
    });
    const { agentId } = await agentWith([manual.id]);
    const conv = await createConv(owner, orgId, agentId);
    const before = await call(conv, "Skill", { skill: "manual" }, 1);
    expect(before.isError).toBe(true);
    expect(before.content).toContain('Skill "manual" is not in the skills catalog');

    await invoke(conv, "manual", 2);
    const after = await call(conv, "Skill", { skill: "manual" }, 3);
    expect(after.isError, after.content).toBe(false);
    expect(after.content).toContain('Loaded skill "manual" (version 1).');
    expect(after.content).toContain("Manual body.");
    const manualDir = /\/skills\/manual@[0-9a-f]{12}\//.exec(after.content)?.[0] as string;
    expect(manualDir).toBeTruthy();
    expect(await sandboxFile(conv, `${manualDir.slice(1)}run.sh`)).toBe("echo manual");

    // another conversation of the same agent: nobody invoked it there
    const other = await createConv(owner, orgId, agentId);
    const there = await call(other, "Skill", { skill: "manual" }, 1);
    expect(there.isError).toBe(true);
    expect(there.content).toContain("is not in the skills catalog");
  });

  it("Review Focus 5: deleted after the invocation -> removed; a new skill of the same name is never loaded", async () => {
    const manual = await seedSkill({
      name: "manual",
      files: { "SKILL.md": skillMd("manual", "Old body."), "run.sh": "echo old" },
      invocation: MANUAL,
    });
    const { agentId, plain } = await agentWith([manual.id]);
    const conv = await createConv(owner, orgId, agentId);
    await invoke(conv, "manual", 1);
    await db
      .updateTable("skills")
      .set({ deleted_at: new Date() })
      .where("id", "=", manual.id)
      .execute();
    const gone = await call(conv, "Skill", { skill: "manual" }, 2);
    expect(gone.isError).toBe(true);
    expect(gone.content).toContain('Skill "manual" was removed after the skills list was shown');

    // a new org skill with the same name (another id), on for the agent
    const fresh = await seedSkill({
      name: "manual",
      files: { "SKILL.md": skillMd("manual", "New body."), "run.sh": "echo new" },
      invocation: MANUAL,
    });
    await setSkills(agentId, [plain, fresh.id]);
    const again = await call(conv, "Skill", { skill: "manual" }, 3);
    expect(again.isError).toBe(true);
    expect(again.content).toContain("was removed");
    expect(again.content).not.toContain("New body.");
  });

  it("Review Focus 5: turned off after the invocation -> removed", async () => {
    const manual = await seedSkill({
      name: "manual",
      files: { "SKILL.md": skillMd("manual", "Body.") },
      invocation: MANUAL,
    });
    const { agentId, plain } = await agentWith([manual.id]);
    const conv = await createConv(owner, orgId, agentId);
    await invoke(conv, "manual", 1);
    await setSkills(agentId, [plain]);
    const r = await call(conv, "Skill", { skill: "manual" }, 2);
    expect(r.isError).toBe(true);
    expect(r.content).toContain("was removed");
  });

  /** A plugin agent template `acme:code-reviewer` of this org. */
  async function reviewerTemplate(): Promise<string> {
    const id = randomUUID();
    await catalogItem("acme");
    await db
      .insertInto("agent_templates")
      .values({ id, org_id: orgId, name: "code-reviewer", plugin_name: "acme", current_version: 1 })
      .execute();
    await db
      .insertInto("agent_template_versions")
      .values({
        template_id: id,
        version: 1,
        definition: JSON.stringify({
          name: "code-reviewer",
          description: "Reviews code.",
          instructions: "Review the code.",
        }),
      })
      .execute();
    return id;
  }

  it("a forked skill's Skill says to run it through the agent tool, or that it cannot", async () => {
    const review = await seedSkill({
      name: "review",
      plugin: "acme",
      files: { "SKILL.md": skillMd("review", "Review steps.") },
      invocation: { model: true, user: true, fork: { agent: "code-reviewer" } },
    });
    const template = await reviewerTemplate();
    const res = await owner({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/agents`,
      payload: {
        definition: {
          name: "Forker",
          instructions: "Use skills.",
          model: { provider: "model-fake", model: "fake-1" },
          disabledTools: onlyBuiltins([
            { kind: "builtin", name: "Bash" },
            { kind: "builtin", name: "Agent" },
          ]),
          disabledSkills: await onlySkills(db, orgId, [review.id]),
          subagents: { templates: [template] },
        },
        visibility: "org",
      },
    });
    expect(res.statusCode, res.body).toBe(201);
    const withAgent = (res.json() as { agent: { id: string } }).agent.id;
    const c1 = await createConv(owner, orgId, withAgent);
    const r1 = await call(c1, "Skill", { skill: "review" }, 1);
    expect(r1.isError, r1.content).toBe(false);
    expect(
      r1.content.startsWith(
        'This skill is written to run in a sub-agent: call Agent with subagent_type "acme:code-reviewer" and a prompt containing these instructions and the details of the task, then use its report; do not follow the instructions yourself.\n\nLoaded skill "review" (version 1).',
      ),
      r1.content,
    ).toBe(true);
    expect(r1.content).toContain("Review steps.");

    const without = await createSkillAgent([review.id]);
    const c2 = await createConv(owner, orgId, without);
    const r2 = await call(c2, "Skill", { skill: "review" }, 1);
    expect(r2.isError, r2.content).toBe(false);
    expect(
      r2.content.startsWith(
        "This skill is written to run in a sub-agent, which is not available here; follow the instructions yourself.\n\n",
      ),
      r2.content,
    ).toBe(true);
  });

  it("the Skill spec hash is pinned (it changes only with a reviewed rename of the tool or its parameters)", () => {
    // devices rename (spec §15): "the skills directory of this device"
    expect(specHash(skillLoadTool({} as never).spec)).toBe("9d47336c9cbf0272");
  });
});
