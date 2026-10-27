// biome-ignore-all lint/suspicious/noTemplateCurlyInString: Claude Code variables such as ${CLAUDE_SKILL_DIR} are plain text here
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SKILL_INVOCATION_LIMITS } from "@capybara-hq/plugin-sdk";
import {
  fakeExtensionEntry,
  startTestPostgres,
  startTestRedis,
  startTestS3,
  type TestContainer,
  type TestS3,
} from "@capybara-hq/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentsService } from "../../src/agents/agents.service.js";
import { ConversationsService } from "../../src/conversations/conversations.service.js";
import type { ConversationEvent } from "../../src/conversations/events.js";
import { type KernelDb, kernelDb, type SkillManifest } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { ApiError } from "../../src/errors.js";
import { AccountsService } from "../../src/identity/accounts.js";
import type { Kernel } from "../../src/kernel.js";
import { parseSlashCommand, SkillInvoker } from "../../src/skills/invoke.js";
import { truncateTables } from "../helpers/db.js";
import { testMembers } from "../helpers/members.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import {
  createConv,
  createOrg,
  eventsOf,
  PW,
  type Req,
  runConfig,
  session,
  startKernel,
  waitForTerminal,
} from "../helpers/runs.js";

/**
 * Phase D task 3: a person invokes a skill of the conversation's agent with `/name args`. The
 * kernel resolves the skill at send time, renders it and logs it as the person's `user_message`
 * (model-visible `content[0]`, non-model-visible `skill`). Also the `/` menu's list route.
 * Real kernel + model-fake + fake sandbox + SeaweedFS; skill rows and files are written directly.
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
  root = await mkdtemp(join(tmpdir(), "cap-skills-invoke-"));
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
  vi.restoreAllMocks();
  await truncateTables(
    db,
    "capybara.skill_change_requests, capybara.skill_versions, capybara.skills, capybara.catalog_items, capybara.sandboxes, capybara.attachments, capybara.approvals, capybara.tool_outputs, capybara.conversation_events, capybara.runs, capybara.conversations, capybara.agent_versions, capybara.agent_members, capybara.agents, capybara.memberships, capybara.orgs, capybara.sessions, capybara.local_passwords, capybara.identities, capybara.accounts",
  );
  const accounts = new AccountsService(db);
  ownerId = (await accounts.createLocal({ login: "owner", password: PW, displayName: "O" })).id;
  owner = await session(k, "owner");
  orgId = await createOrg(owner);
});

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const skillMd = (name: string, body: string, front = "") =>
  `---\nname: ${name}\ndescription: Use for ${name} work.\n${front}---\n${body}`;

/** Writes a skill version's files and row; `skillId` adds a version to that skill. */
async function seedSkill(opts: {
  name: string;
  body: string;
  files?: Record<string, string>;
  invocation?: SkillManifest["invocation"];
  scope?: "org" | "agent";
  agentId?: string;
  skillId?: string;
  plugin?: string;
}): Promise<{ id: string; version: number; prefix: string }> {
  const prefix = `skills/${randomUUID()}/`;
  const store = k.storage.kernel(orgId);
  const files: SkillManifest["files"] = [];
  for (const [path, text] of Object.entries({
    "SKILL.md": skillMd(opts.name, opts.body),
    ...opts.files,
  })) {
    const data = new TextEncoder().encode(text);
    await store.put(`${prefix}${path}`, data, {
      contentType: "application/octet-stream",
      size: data.byteLength,
    });
    files.push({ path, size: data.byteLength, sha256: sha(data) });
  }
  const description = `Use for ${opts.name} work.`;
  const manifest: SkillManifest = {
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
    })
    .execute();
  return { id, version, prefix };
}

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

type Tool = { kind: "builtin"; name: string };

const definition = (orgSkills: string[], tools: Tool[] = []) => ({
  name: "Skilled",
  instructions: "Use skills.",
  model: { provider: "model-fake", model: "fake-1" },
  tools,
  skills: { orgSkills },
});

async function createAgent(
  orgSkills: string[],
  tools: Tool[] = [],
  visibility: "private" | "org" = "private",
): Promise<string> {
  const res = await owner({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/agents`,
    payload: { definition: definition(orgSkills, tools), visibility },
  });
  expect(res.statusCode, res.body).toBe(201);
  return (res.json() as { agent: { id: string } }).agent.id;
}

async function setSkills(agentId: string, orgSkills: string[], tools: Tool[] = []) {
  const res = await owner({
    method: "PATCH",
    url: `/api/v1/orgs/${orgId}/agents/${agentId}`,
    payload: { definition: definition(orgSkills, tools) },
  });
  expect(res.statusCode, res.body).toBe(200);
}

const send = (conv: string, body: Record<string, unknown>, req: Req = owner): ReturnType<Req> =>
  req({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/conversations/${conv}/messages`,
    payload: body,
  });

type UserMessage = Extract<ConversationEvent, { type: "user_message" }>;
const userMessages = async (conv: string) =>
  (await eventsOf(db, conv)).filter((e): e is UserMessage => e.type === "user_message");

const firstText = (e: UserMessage | undefined): string => {
  const b = e?.payload.content[0];
  return b?.type === "text" ? b.text : "";
};

interface Listed {
  id: string;
  name: string;
  plugin?: string;
  description: string;
  version: number;
  argumentHint?: string;
  arguments?: string[];
  manual: boolean;
  fork: boolean;
}

const list = (agentId: string, conversationId?: string, req: Req = owner) =>
  req({
    method: "GET",
    url: `/api/v1/orgs/${orgId}/agents/${agentId}/invocable-skills${
      conversationId === undefined ? "" : `?conversationId=${conversationId}`
    }`,
  });

/** Only `get` is used here (reads the agent row and version). */
const agentsService = () => new AgentsService(db, {} as never, {} as never, {} as never);

const FIX_ISSUE = "Fix GitHub issue $ARGUMENTS following our coding standards.";

describe("parseSlashCommand", () => {
  it("reads a leading /name and its arguments", () => {
    expect(parseSlashCommand("/fix-issue 12")).toEqual({ name: "fix-issue", args: "12" });
    expect(parseSlashCommand("/a:b")).toEqual({ name: "a:b", args: "" });
    expect(parseSlashCommand("/x\nmore lines")).toEqual({ name: "x", args: "more lines" });
  });

  it("is null for anything else", () => {
    expect(parseSlashCommand("/etc/hosts x")).toBeNull();
    expect(parseSlashCommand(" /x")).toBeNull();
    expect(parseSlashCommand("hello /x")).toBeNull();
    expect(parseSlashCommand("/Upper")).toBeNull();
    expect(parseSlashCommand("/")).toBeNull();
  });
});

describe("GET …/agents/:agentId/invocable-skills", { timeout: 60_000 }, () => {
  it("lists the agent's selected org skills and own skills by name, with manual and fork flags", async () => {
    const plain = await seedSkill({ name: "plain", body: "P." });
    const manual = await seedSkill({
      name: "manual",
      body: "M.",
      invocation: { model: false, user: true, argumentHint: "[topic]" },
    });
    const forked = await seedSkill({
      name: "forked",
      body: "F.",
      invocation: { model: true, user: true, fork: { agent: "reviewer" }, arguments: ["pr"] },
    });
    const hidden = await seedSkill({
      name: "hidden",
      body: "H.",
      invocation: { model: true, user: false },
    });
    await seedSkill({ name: "unselected", body: "U." });
    const brain = await seedSkill({ name: "brainstorming", body: "B.", plugin: "superpowers" });
    const agentId = await createAgent([plain.id, manual.id, forked.id, hidden.id, brain.id]);
    const own = await seedSkill({ name: "own", body: "O.", scope: "agent", agentId });
    const res = await list(agentId);
    expect(res.statusCode, res.body).toBe(200);
    const skills = (res.json() as { skills: Listed[] }).skills;
    expect(skills).toEqual([
      {
        id: brain.id,
        name: "brainstorming",
        plugin: "superpowers",
        description: "Use for brainstorming work.",
        version: 1,
        manual: false,
        fork: false,
      },
      {
        id: forked.id,
        name: "forked",
        description: "Use for forked work.",
        version: 1,
        arguments: ["pr"],
        manual: false,
        fork: true,
      },
      {
        id: manual.id,
        name: "manual",
        description: "Use for manual work.",
        version: 1,
        argumentHint: "[topic]",
        manual: true,
        fork: false,
      },
      {
        id: own.id,
        name: "own",
        description: "Use for own work.",
        version: 1,
        manual: false,
        fork: false,
      },
      {
        id: plain.id,
        name: "plain",
        description: "Use for plain work.",
        version: 1,
        manual: false,
        fork: false,
      },
    ]);
  });

  it("includes a trial draft only for the conversation that started it", async () => {
    const agentId = await createAgent([]);
    const conv1 = await createConv(owner, orgId, agentId);
    const conv2 = await createConv(owner, orgId, agentId);
    const prefix = `skill-changes/${randomUUID()}/`;
    const data = new TextEncoder().encode(skillMd("draft", "D."));
    await k.storage.kernel(orgId).put(`${prefix}SKILL.md`, data, {
      contentType: "application/octet-stream",
      size: data.byteLength,
    });
    await db
      .insertInto("skill_change_requests")
      .values({
        id: randomUUID(),
        org_id: orgId,
        agent_id: agentId,
        skill_id: null,
        proposed_version: JSON.stringify({
          skillId: randomUUID(),
          version: 1,
          manifest: {
            name: "draft",
            description: "Use for draft work.",
            files: [{ path: "SKILL.md", size: data.byteLength, sha256: sha(data) }],
          },
        }),
        object_prefix: prefix,
        requested_by_account: ownerId,
        requested_in_conversation: conv1,
      })
      .execute();
    const names = async (conv?: string) => {
      const r = await list(agentId, conv);
      expect(r.statusCode, r.body).toBe(200);
      return (r.json() as { skills: Listed[] }).skills.map((s) => s.name);
    };
    expect(await names(conv1)).toEqual(["draft"]);
    expect(await names(conv2)).toEqual([]);
    expect(await names()).toEqual([]);
    // and it can be invoked there
    const sent = await send(conv1, { text: "", skill: { name: "draft" } });
    expect(sent.statusCode, sent.body).toBe(202);
    expect(firstText((await userMessages(conv1))[0])).toContain("D.");
  });

  it("is 404 for a non-member and for another person's conversation", async () => {
    const agentId = await createAgent([], [], "org");
    const accounts = new AccountsService(db);
    const memberId = (await accounts.createLocal({ login: "mem", password: PW, displayName: "M" }))
      .id;
    await accounts.createLocal({ login: "out", password: PW, displayName: "X" });
    const outsider = await session(k, "out");
    expect((await list(agentId, undefined, outsider)).statusCode).toBe(404);
    await testMembers(db).add(orgId, memberId, "member", ownerId);
    const member = await session(k, "mem");
    expect((await list(agentId, undefined, member)).statusCode).toBe(200);
    const ownerConv = await createConv(owner, orgId, agentId);
    const r = await list(agentId, ownerConv, member);
    expect(r.statusCode, r.body).toBe(404);
    expect(r.json().error.code).toBe("conversation.not_found");
    // a conversation with another agent
    const other = await createAgent([]);
    const otherConv = await createConv(owner, orgId, other);
    expect((await list(agentId, otherConv)).statusCode).toBe(404);
  });
});

describe("POST …/messages with skill", { timeout: 60_000 }, () => {
  it("appends one user_message holding the rendered skill, and the model gets it", async () => {
    // manual-only: the model's catalog stays empty, so the run offers no tools and model-fake
    // answers "You said: <the last user text>"
    const s = await seedSkill({
      name: "fix-issue",
      body: FIX_ISSUE,
      invocation: { model: false, user: true },
    });
    const agentId = await createAgent([s.id]);
    const conv = await createConv(owner, orgId, agentId);
    const res = await send(conv, { text: "123", skill: { name: "fix-issue" } });
    expect(res.statusCode, res.body).toBe(202);
    await waitForTerminal(db, conv, 1, 30_000);
    const msgs = await userMessages(conv);
    expect(msgs).toHaveLength(1);
    const text = firstText(msgs[0]);
    expect(text).toBe(
      'The user invoked the skill "fix-issue" with /fix-issue 123. Follow its instructions for this request.\n\n' +
        '<skill_invocation name="fix-issue" version="1">\nFix GitHub issue 123 following our coding standards.\n</skill_invocation>',
    );
    expect(msgs[0]?.payload.skill).toEqual({
      id: s.id,
      version: 1,
      source: s.prefix,
      name: "fix-issue",
      arguments: "123",
      mode: "inline",
    });
    const reply = (await eventsOf(db, conv)).find((e) => e.type === "assistant_message");
    expect(JSON.stringify(reply?.payload)).toContain("Fix GitHub issue 123");
  });

  it("resolves <plugin>:<name> to the plugin's skill and renders its bare directory", async () => {
    const s = await seedSkill({
      name: "brainstorming",
      body: "Read ${CLAUDE_SKILL_DIR}/notes.md first.",
      files: { "notes.md": "notes" },
      plugin: "superpowers",
    });
    const agentId = await createAgent([s.id]);
    const conv = await createConv(owner, orgId, agentId);
    const bad = await send(conv, { text: "", skill: { name: "other:brainstorming" } });
    expect(bad.statusCode, bad.body).toBe(400);
    expect(bad.json().error.code).toBe("skill.not_invocable");
    expect(bad.json().error.details).toEqual([{ reason: "not_found" }]);
    const res = await send(conv, { text: "", skill: { name: "superpowers:brainstorming" } });
    expect(res.statusCode, res.body).toBe(202);
    const [m] = await userMessages(conv);
    const text = firstText(m);
    expect(text).toContain("Read /skills/brainstorming/notes.md first.");
    expect(text).toContain('<skill_invocation name="superpowers:brainstorming" version="1">');
    expect(text).toContain(
      'Its files are not in the sandbox yet: call skill_load with "superpowers:brainstorming" to copy them to /skills/brainstorming/ before running its scripts.',
    );
    expect(m?.payload.skill).toMatchObject({
      name: "brainstorming",
      plugin: "superpowers",
      arguments: "",
    });
  });

  it("refuses a skill the person cannot invoke, writing nothing", async () => {
    const hidden = await seedSkill({
      name: "hidden",
      body: "H.",
      invocation: { model: true, user: false },
    });
    const unselected = await seedSkill({ name: "unselected", body: "U." });
    const agentId = await createAgent([hidden.id]);
    const conv = await createConv(owner, orgId, agentId);
    const r1 = await send(conv, { text: "", skill: { name: "hidden" } });
    expect(r1.statusCode, r1.body).toBe(400);
    expect(r1.json().error).toMatchObject({
      code: "skill.not_invocable",
      details: [{ reason: "not_user_invocable" }],
    });
    const r2 = await send(conv, { text: "", skill: { name: unselected.id && "unselected" } });
    expect(r2.statusCode, r2.body).toBe(400);
    expect(r2.json().error.details).toEqual([{ reason: "not_found" }]);
    expect(await eventsOf(db, conv)).toEqual([]);
  });

  it("a rendered skill over the limit is 400 validation_failed and writes nothing", async () => {
    const s = await seedSkill({ name: "big", body: "$ARGUMENTS\n".repeat(30) });
    const agentId = await createAgent([s.id]);
    const conv = await createConv(owner, orgId, agentId);
    const res = await send(conv, { text: "x".repeat(9000), skill: { name: "big" } });
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json().error.code).toBe("validation_failed");
    expect(res.json().error.details).toEqual([
      {
        path: "text",
        message: `the rendered skill must be at most ${SKILL_INVOCATION_LIMITS.renderedMaxChars} characters; shorten the arguments`,
      },
    ]);
    const tooLong = await send(conv, { text: "y".repeat(10_001), skill: { name: "big" } });
    expect(tooLong.statusCode, tooLong.body).toBe(400);
    expect(tooLong.json().error.code).toBe("validation_failed");
    expect(await eventsOf(db, conv)).toEqual([]);
  });

  it("a SKILL.md body over the limit by itself says the skill is too large, not the arguments", async () => {
    const s = await seedSkill({
      name: "huge",
      body: "a".repeat(SKILL_INVOCATION_LIMITS.renderedMaxChars + 1),
    });
    const agentId = await createAgent([s.id]);
    const conv = await createConv(owner, orgId, agentId);
    const res = await send(conv, { text: "", skill: { name: "huge" } });
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json().error.details).toEqual([
      {
        path: "skill",
        message: `the skill "huge" is too large to invoke (its rendered text must be at most ${SKILL_INVOCATION_LIMITS.renderedMaxChars} characters)`,
      },
    ]);
    expect(await eventsOf(db, conv)).toEqual([]);
  });

  it("adds the files line by whether skill_load will be offered, and the shell line only with sandbox_bash", async () => {
    // an ordinary skill is in the model's catalog, so the run offers skill_load
    const tool = await seedSkill({
      name: "tool",
      body: "Run it:\n!`git status`\n",
      files: { "run.sh": "echo hi" },
    });
    const withBash = await createAgent([tool.id], [{ kind: "builtin", name: "sandbox_bash" }]);
    const c1 = await createConv(owner, orgId, withBash);
    expect((await send(c1, { text: "", skill: { name: "tool" } })).statusCode).toBe(202);
    const t1 = firstText((await userMessages(c1))[0]);
    expect(t1).toContain('call skill_load with "tool" to copy them to /skills/tool/');
    expect(
      t1.endsWith(
        "Lines written as !`command` were meant to run before you read this; run those commands with sandbox_bash if you need their output.",
      ),
    ).toBe(true);
    await waitForTerminal(db, c1, 1, 30_000);

    // a manual-only skill alone leaves the catalog empty: no skill_load, no shell tool
    const manual = await seedSkill({
      name: "manual",
      body: "Run it:\n!`git status`\n",
      files: { "run.sh": "echo hi" },
      invocation: { model: false, user: true },
    });
    const bare = await createAgent([manual.id]);
    const c2 = await createConv(owner, orgId, bare);
    expect((await send(c2, { text: "", skill: { name: "manual" } })).statusCode).toBe(202);
    const t2 = firstText((await userMessages(c2))[0]);
    expect(t2.endsWith("\n\nIts other files are not available in this conversation.")).toBe(true);
    expect(t2).not.toContain("sandbox_bash");
    await waitForTerminal(db, c2, 1, 30_000);

    // no other files: no files line
    const lone = await seedSkill({ name: "lone", body: "Just text." });
    const a3 = await createAgent([lone.id]);
    const c3 = await createConv(owner, orgId, a3);
    expect((await send(c3, { text: "", skill: { name: "lone" } })).statusCode).toBe(202);
    expect(firstText((await userMessages(c3))[0]).endsWith("</skill_invocation>")).toBe(true);
    await waitForTerminal(db, c3, 1, 30_000);
  });

  it("puts the invocation first, then the @ resources, then the files", async () => {
    const s = await seedSkill({ name: "fix-issue", body: FIX_ISSUE });
    const agentId = await createAgent([s.id]);
    const conv = await createConv(owner, orgId, agentId);
    const svc = new ConversationsService(
      db,
      k.runs.eventLog,
      agentsService(),
      undefined,
      undefined,
      async (_o, _a, refs) => ({
        blocks: refs.map((r) => ({ type: "text" as const, text: `resource ${r.uri}` })),
        attachments: refs.map((r) => ({
          appId: r.connectorId,
          appName: "c",
          uri: r.uri,
          name: "n",
        })),
      }),
      async (_t, _o, _c, _a, ids) =>
        ids.map((id) => ({ type: "text" as const, text: `file ${id}` })),
      undefined,
      new SkillInvoker({ db, storage: k.storage, eventLog: k.runs.eventLog }),
    );
    const connectorId = randomUUID();
    const fileId = randomUUID();
    const e = await svc.postUserMessage(orgId, conv, ownerId, {
      text: "7",
      skill: { name: "fix-issue" },
      attachments: [{ connectorId, uri: "res://a" }],
      files: [fileId],
    });
    expect(e.type).toBe("user_message");
    const content = (e as UserMessage).payload.content;
    expect(content.map((b) => (b.type === "text" ? b.text : b.type))).toEqual([
      expect.stringMatching(/^The user invoked the skill "fix-issue" with \/fix-issue 7\./),
      "resource res://a",
      `file ${fileId}`,
    ]);
  });

  it("files are bound after the invocation text (HTTP)", async () => {
    const s = await seedSkill({ name: "fix-issue", body: FIX_ISSUE });
    const agentId = await createAgent([s.id]);
    const conv = await createConv(owner, orgId, agentId);
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
      "base64",
    );
    const created = await owner({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/attachments`,
      payload: { name: "a.png", contentType: "image/png", size: png.length },
    });
    expect(created.statusCode, created.body).toBe(201);
    const c = created.json() as {
      id: string;
      upload: {
        method: string;
        url: string;
        headers: Record<string, string>;
        fields?: Record<string, string>;
      };
    };
    let up: Response;
    if (c.upload.method === "PUT") {
      up = await fetch(c.upload.url, { method: "PUT", headers: c.upload.headers, body: png });
    } else {
      const form = new FormData();
      for (const [key, v] of Object.entries(c.upload.fields ?? {})) form.append(key, v);
      form.append("file", new Blob([png], { type: "image/png" }));
      up = await fetch(c.upload.url, { method: "POST", headers: c.upload.headers, body: form });
    }
    expect(up.status).toBeLessThan(300);
    const fin = await owner({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/attachments/${c.id}/finalize`,
    });
    expect(fin.statusCode, fin.body).toBe(200);
    const res = await send(conv, { text: "9", skill: { name: "fix-issue" }, files: [c.id] });
    expect(res.statusCode, res.body).toBe(202);
    const [m] = await userMessages(conv);
    expect(m?.payload.content.map((b) => b.type)).toEqual(["text", "image"]);
    expect(firstText(m)).toContain("Fix GitHub issue 9");
    await waitForTerminal(db, conv, 1, 30_000);
  });

  it("a forked skill is logged with mode fork, its resolved type and the fork lead", async () => {
    const s = await seedSkill({
      name: "review",
      body: "Review $ARGUMENTS.",
      invocation: { model: true, user: true, fork: { agent: "Explore" } },
    });
    const missing = await seedSkill({
      name: "deep",
      body: "Deep.",
      invocation: { model: false, user: true, fork: { agent: "nobody" } },
    });
    const agentId = await createAgent([s.id, missing.id]);
    const invoker = new SkillInvoker({ db, storage: k.storage, eventLog: k.runs.eventLog });
    const agent = (await agentsService().get(orgId, agentId, ownerId)).definition;
    const r = await invoker.prepare({ orgId, agentId, agent, name: "review", args: "PR 4" });
    expect(r.skill).toMatchObject({
      mode: "fork",
      agentType: "general-purpose",
      arguments: "PR 4",
    });
    expect(r.text).toBe(
      'The user ran the skill "review" in a sub-agent (general-purpose) with /review PR 4. The sub-agent gets the skill\'s instructions as its task; its report follows. Do not do the task yourself.',
    );
    expect(r.task).toBe(
      '<skill_invocation name="review" version="1">\nReview PR 4.\n</skill_invocation>',
    );
    expect(r.warning).toBeUndefined();
    const d = await invoker.prepare({ orgId, agentId, agent, name: "deep", args: "" });
    expect(d.skill.agentType).toBe("general-purpose");
    expect(d.warning).toBe(
      'Skill "deep" asked for sub-agent type "nobody", which this agent does not have; it ran as general-purpose.',
    );
  });
});

describe("Review Focus 2: the skill changes between listing and sending", {
  timeout: 60_000,
}, () => {
  it("a deselected skill is 400 skill.not_invocable and writes nothing", async () => {
    const s = await seedSkill({ name: "fix-issue", body: FIX_ISSUE });
    const agentId = await createAgent([s.id]);
    const conv = await createConv(owner, orgId, agentId);
    expect((await list(agentId, conv)).json().skills).toHaveLength(1);
    await setSkills(agentId, []);
    const res = await send(conv, { text: "1", skill: { name: "fix-issue" } });
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json().error.code).toBe("skill.not_invocable");
    expect(await eventsOf(db, conv)).toEqual([]);
  });

  it("a deleted skill is 400 skill.not_invocable", async () => {
    const s = await seedSkill({ name: "fix-issue", body: FIX_ISSUE });
    const agentId = await createAgent([s.id]);
    const conv = await createConv(owner, orgId, agentId);
    await db.updateTable("skills").set({ deleted_at: new Date() }).where("id", "=", s.id).execute();
    const res = await send(conv, { text: "1", skill: { name: "fix-issue" } });
    expect(res.statusCode, res.body).toBe(400);
    expect(await eventsOf(db, conv)).toEqual([]);
  });

  it("a new version uploaded meanwhile renders that version", async () => {
    const s = await seedSkill({ name: "fix-issue", body: FIX_ISSUE });
    const agentId = await createAgent([s.id]);
    const conv = await createConv(owner, orgId, agentId);
    await seedSkill({ name: "fix-issue", body: "Fix $ARGUMENTS, v2.", skillId: s.id });
    expect((await send(conv, { text: "5", skill: { name: "fix-issue" } })).statusCode).toBe(202);
    const [m] = await userMessages(conv);
    expect(firstText(m)).toContain('<skill_invocation name="fix-issue" version="2">\nFix 5, v2.');
    expect(m?.payload.skill?.version).toBe(2);
    await waitForTerminal(db, conv, 1, 30_000);
  });

  it("object storage down is 503 storage.unavailable and writes nothing", async () => {
    const s = await seedSkill({ name: "fix-issue", body: FIX_ISSUE });
    const agentId = await createAgent([s.id]);
    const conv = await createConv(owner, orgId, agentId);
    const original = k.storage.kernel.bind(k.storage);
    vi.spyOn(k.storage, "kernel").mockImplementation((id: string) => {
      const store = original(id);
      return new Proxy(store, {
        get(target, prop, receiver) {
          if (prop !== "get") return Reflect.get(target, prop, receiver);
          return async () => {
            throw new ApiError("storage.unavailable", "Object storage is unavailable");
          };
        },
      });
    });
    const res = await send(conv, { text: "1", skill: { name: "fix-issue" } });
    expect(res.statusCode, res.body).toBe(503);
    expect(res.json().error.code).toBe("storage.unavailable");
    expect(await eventsOf(db, conv)).toEqual([]);
  });

  it("a SKILL.md that fails its integrity check is 503 and writes nothing", async () => {
    const s = await seedSkill({ name: "fix-issue", body: FIX_ISSUE });
    const agentId = await createAgent([s.id]);
    const conv = await createConv(owner, orgId, agentId);
    const evil = new TextEncoder().encode(skillMd("fix-issue", "tampered"));
    await k.storage.kernel(orgId).put(`${s.prefix}SKILL.md`, evil, {
      contentType: "application/octet-stream",
      size: evil.byteLength,
    });
    const res = await send(conv, { text: "1", skill: { name: "fix-issue" } });
    expect(res.statusCode, res.body).toBe(503);
    expect(res.json().error).toMatchObject({
      code: "storage.unavailable",
      details: [{ reason: "skill_unreadable", name: "fix-issue" }],
    });
    expect(await eventsOf(db, conv)).toEqual([]);
  });
});

describe("SkillInvoker logging", { timeout: 60_000 }, () => {
  it("logs an unreadable SKILL.md with its skill id, version and source", async () => {
    const s = await seedSkill({ name: "fix-issue", body: FIX_ISSUE });
    const agentId = await createAgent([s.id]);
    const evil = new TextEncoder().encode(skillMd("fix-issue", "tampered"));
    await k.storage.kernel(orgId).put(`${s.prefix}SKILL.md`, evil, {
      contentType: "application/octet-stream",
      size: evil.byteLength,
    });
    const error = vi.fn();
    const invoker = new SkillInvoker({
      db,
      storage: k.storage,
      eventLog: k.runs.eventLog,
      log: { error },
    });
    const agent = (await agentsService().get(orgId, agentId, ownerId)).definition;
    await expect(
      invoker.prepare({ orgId, agentId, agent, name: "fix-issue", args: "1" }),
    ).rejects.toMatchObject({ code: "storage.unavailable" });
    expect(error).toHaveBeenCalledWith("invoked skill unreadable", {
      orgId,
      skillId: s.id,
      version: s.version,
      source: s.prefix,
      problem: "failed its integrity check",
    });
  });
});

describe("Review Focus 4: a retry with the same clientMessageId", { timeout: 60_000 }, () => {
  it("returns the same event without resolving again, even after the skill changed", async () => {
    const s = await seedSkill({ name: "fix-issue", body: FIX_ISSUE });
    const agentId = await createAgent([s.id]);
    const conv = await createConv(owner, orgId, agentId);
    const body = { text: "1", skill: { name: "fix-issue" }, clientMessageId: "cm-1" };
    const r1 = await send(conv, body);
    expect(r1.statusCode, r1.body).toBe(202);
    await seedSkill({ name: "fix-issue", body: "v2 $ARGUMENTS", skillId: s.id });
    const r2 = await send(conv, body);
    expect(r2.statusCode, r2.body).toBe(202);
    expect(r2.json().event.seq).toBe(r1.json().event.seq);
    // deselected: still the first event
    await setSkills(agentId, []);
    const r3 = await send(conv, body);
    expect(r3.statusCode, r3.body).toBe(202);
    expect(r3.json().event.seq).toBe(r1.json().event.seq);
    const msgs = await userMessages(conv);
    expect(msgs).toHaveLength(1);
    expect(firstText(msgs[0])).toContain('version="1"');
    await waitForTerminal(db, conv, 1, 30_000);
  });
});

describe("POST /conversations with a skill as the first message", { timeout: 60_000 }, () => {
  it("creates the conversation with the invocation; a retry returns it", async () => {
    const s = await seedSkill({ name: "fix-issue", body: FIX_ISSUE });
    const agentId = await createAgent([s.id]);
    const payload = {
      agentId,
      message: { text: "42", skill: { name: "fix-issue" }, clientMessageId: "first-1" },
    };
    const r1 = await owner({ method: "POST", url: `/api/v1/orgs/${orgId}/conversations`, payload });
    expect(r1.statusCode, r1.body).toBe(201);
    const conv = (r1.json() as { conversation: { id: string } }).conversation.id;
    const [m] = await userMessages(conv);
    expect(firstText(m)).toContain("Fix GitHub issue 42");
    expect(m?.payload.skill?.name).toBe("fix-issue");
    const r2 = await owner({ method: "POST", url: `/api/v1/orgs/${orgId}/conversations`, payload });
    expect(r2.statusCode, r2.body).toBe(200);
    expect(r2.json().event.seq).toBe(r1.json().event.seq);
    const missing = await owner({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/conversations`,
      payload: {
        agentId,
        message: { text: "", skill: { name: "nope" }, clientMessageId: "first-2" },
      },
    });
    expect(missing.statusCode, missing.body).toBe(400);
    expect(missing.json().error.code).toBe("skill.not_invocable");
    const convs = await db.selectFrom("conversations").select("id").execute();
    expect(convs).toHaveLength(1);
    await waitForTerminal(db, conv, 1, 30_000);
  });
});
