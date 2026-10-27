import { createHash, randomUUID } from "node:crypto";
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
import type { ConversationEvent } from "../../src/conversations/events.js";
import { type KernelDb, kernelDb, type SkillManifest } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { AccountsService } from "../../src/identity/accounts.js";
import type { Kernel } from "../../src/kernel.js";
import { type SkillsSnapshot, snapshotChangeText } from "../../src/runtime/context/skills.js";
import { invocationOf, recordSkillsCatalog } from "../../src/skills/catalog.js";
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
import { makeZip } from "./zip.js";

/**
 * Phase D task 2: a skill version stores its invocation metadata (`manifest.invocation`), and
 * manual-only versions (`disable-model-invocation: true`) stay out of the model's catalog, the
 * change reminders and the pinned skills. Real kernel + model-fake + SeaweedFS.
 */

const OBJECT_STORE = fakeExtensionEntry("fake-object-store");

let pgc: TestContainer;
let rd: TestContainer;
let s3: TestS3;
let db: KernelDb;
let destroyDb: () => Promise<void>;
let k: Kernel;

beforeAll(async () => {
  [pgc, rd, s3] = await Promise.all([startTestPostgres(), startTestRedis(), startTestS3()]);
  const raw = createDb(pgc.url, 3);
  db = kernelDb(raw);
  destroyDb = () => raw.destroy();
  k = await startKernel(
    runConfig(
      { pg: pgc.url, redis: rd.url },
      {
        roles: ["api", "worker"],
        extensions: [OBJECT_STORE, MODEL_FAKE],
        extensionConfig: {
          "fake-object-store": {
            endpoint: s3.endpoint,
            region: s3.region,
            bucket: s3.bucket,
            accessKeyId: s3.accessKey,
            secretAccessKey: s3.secretKey,
            forcePathStyle: true,
          },
        },
      },
    ),
  );
}, 180_000);

afterAll(async () => {
  await k?.stop();
  await destroyDb?.();
  await Promise.all([pgc?.stop(), rd?.stop(), s3?.stop()]);
});

let owner: Req;
let ownerId: string;
let orgId: string;

beforeEach(async () => {
  await truncateTables(
    db,
    "capybara.skill_change_requests, capybara.skill_versions, capybara.skills, capybara.attachments, capybara.conversation_events, capybara.runs, capybara.conversations, capybara.agent_versions, capybara.agent_members, capybara.agents, capybara.audit_events, capybara.memberships, capybara.orgs, capybara.sessions, capybara.local_passwords, capybara.identities, capybara.accounts",
  );
  const accounts = new AccountsService(db);
  ownerId = (await accounts.createLocal({ login: "owner", password: PW, displayName: "O" })).id;
  owner = await session(k, "owner");
  orgId = await createOrg(owner);
});

const sha = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");
const md = (name: string, front = "", body = `# ${name}\n\nSteps.\n`) =>
  `---\nname: ${name}\ndescription: Use for ${name} work.\n${front}---\n${body}`;

/** Registers and uploads a skill zip, then creates the skill from it. */
async function upload(text: string, extra: Record<string, string> = {}) {
  const zip = makeZip([
    { name: "SKILL.md", data: text },
    ...Object.entries(extra).map(([name, data]) => ({ name, data })),
  ]);
  const res = await owner({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/skills/uploads`,
    payload: { name: "skill.zip", size: zip.byteLength },
  });
  expect(res.statusCode, res.body).toBe(201);
  const c = res.json() as {
    id: string;
    upload: {
      method: "PUT" | "POST";
      url: string;
      headers: Record<string, string>;
      fields?: Record<string, string>;
    };
  };
  let put: Response;
  if (c.upload.method === "PUT") {
    put = await fetch(c.upload.url, {
      method: "PUT",
      headers: c.upload.headers,
      body: Buffer.from(zip),
    });
  } else {
    const form = new FormData();
    for (const [key, v] of Object.entries(c.upload.fields ?? {})) form.append(key, v);
    form.append("file", new Blob([Buffer.from(zip)], { type: "application/zip" }));
    put = await fetch(c.upload.url, { method: "POST", headers: c.upload.headers, body: form });
  }
  expect(put.status, await put.clone().text()).toBeLessThan(300);
  return owner({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/skills`,
    payload: { uploadId: c.id },
  });
}

async function manifestOf(skillId: string, version = 1): Promise<SkillManifest> {
  const row = await db
    .selectFrom("skill_versions")
    .select("manifest")
    .where("skill_id", "=", skillId)
    .where("version", "=", version)
    .executeTakeFirstOrThrow();
  return row.manifest;
}

/** Writes a skill version's files and row directly; `skillId` adds a version to that skill. */
async function seedSkill(opts: {
  name: string;
  text: string;
  invocation?: SkillManifest["invocation"];
  skillId?: string;
}): Promise<{ id: string; version: number }> {
  const prefix = `skills/${randomUUID()}/`;
  const data = new TextEncoder().encode(opts.text);
  await k.storage.kernel(orgId).put(`${prefix}SKILL.md`, data, {
    contentType: "application/octet-stream",
    size: data.byteLength,
  });
  const description = `Use for ${opts.name} work.`;
  const manifest: SkillManifest = {
    name: opts.name,
    description,
    files: [{ path: "SKILL.md", size: data.byteLength, sha256: sha(data) }],
    ...(opts.invocation !== undefined && { invocation: opts.invocation }),
  };
  let id = opts.skillId;
  let version = 1;
  if (id === undefined) {
    id = randomUUID();
    await db
      .insertInto("skills")
      .values({
        id,
        org_id: orgId,
        scope: "org",
        agent_id: null,
        name: opts.name,
        description,
        current_version: 1,
        created_by: ownerId,
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
  return { id, version };
}

const MANUAL = { model: false, user: true } as const;

async function createAgent(skills: Record<string, unknown>, tools: unknown[] = []) {
  const res = await owner({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/agents`,
    payload: {
      definition: {
        name: "Skilled",
        instructions: "Use skills.",
        model: { provider: "model-fake", model: "fake-1" },
        tools,
        skills,
      },
      visibility: "private",
    },
  });
  return res;
}

async function agentId(skills: Record<string, unknown>, tools: unknown[] = []): Promise<string> {
  const res = await createAgent(skills, tools);
  expect(res.statusCode, res.body).toBe(201);
  return (res.json() as { agent: { id: string } }).agent.id;
}

type Catalog = Extract<ConversationEvent, { type: "skills_catalog" }>;
const catalogs = async (conv: string) =>
  (await eventsOf(db, conv)).filter((e): e is Catalog => e.type === "skills_catalog");

const record = (
  conv: string,
  agent: string,
  def: Pick<AgentDefinition, "skills">,
  runId: string,
  log?: { warn: (...a: unknown[]) => void; error: (...a: unknown[]) => void },
) =>
  recordSkillsCatalog(
    { db, eventLog: k.runs.eventLog, storage: k.storage, ...(log && { log }) },
    { orgId, agentId: agent, conversationId: conv, runId, agent: def as AgentDefinition },
  );

describe("manifest.invocation", { timeout: 60_000 }, () => {
  it("an upload with disable-model-invocation: true stores a manual-only version", async () => {
    const r = await upload(md("manual", "disable-model-invocation: true\nargument-hint: '[n]'\n"));
    expect(r.statusCode, r.body).toBe(201);
    const m = await manifestOf(r.json().skill.id);
    expect(m.invocation).toEqual({ model: false, user: true, argumentHint: "[n]" });
    expect(invocationOf(m)).toEqual({ model: false, user: true, argumentHint: "[n]" });
  });

  it("an ordinary upload's manifest has no invocation key (byte-identical to before)", async () => {
    const r = await upload(md("plain"));
    expect(r.statusCode, r.body).toBe(201);
    const m = await manifestOf(r.json().skill.id);
    expect(m).not.toHaveProperty("invocation");
    expect(invocationOf(m)).toEqual({ model: true, user: true });
  });

  it("a skill neither the model nor a person could use is refused", async () => {
    const r = await upload(md("nobody", "disable-model-invocation: true\nuser-invocable: false\n"));
    expect(r.statusCode, r.body).toBe(400);
    expect(r.json().error.code).toBe("skill.invalid_package");
    expect(JSON.stringify(r.json().error.details)).toContain(
      "a skill with disable-model-invocation: true and user-invocable: false cannot be used",
    );
  });

  it("skill_write of a SKILL.md with disable-model-invocation: true creates a manual-only version", async () => {
    const agent = await agentId({}, [{ kind: "builtin", name: "skill_write" }]);
    const conv = await createConv(owner, orgId, agent);
    const input = {
      name: "notes",
      description: "Take notes.",
      files: [
        {
          path: "SKILL.md",
          content:
            "---\ndisable-model-invocation: true\nargument-hint: '[topic]'\n---\nTake notes.",
        },
      ],
    };
    await postMessage(owner, orgId, conv, `tool:skill_write:${JSON.stringify(input)}`);
    await waitForTerminal(db, conv, 1, 30_000);
    const row = await db
      .selectFrom("skills")
      .select("id")
      .where("name", "=", "notes")
      .executeTakeFirstOrThrow();
    expect((await manifestOf(row.id)).invocation).toEqual({
      model: false,
      user: true,
      argumentHint: "[topic]",
    });
  });
});

describe("the model's catalog", { timeout: 60_000 }, () => {
  it("leaves out manual-only skills", async () => {
    const manual = await seedSkill({ name: "manual", text: md("manual"), invocation: MANUAL });
    const plain = await seedSkill({ name: "plain", text: md("plain") });
    const agent = await agentId({ orgSkills: [manual.id, plain.id] });
    const conv = await createConv(owner, orgId, agent);
    await record(conv, agent, { skills: { orgSkills: [manual.id, plain.id] } }, "run-1");
    const snaps = await catalogs(conv);
    expect(snaps.map((s) => s.payload.skills.map((x) => x.name))).toEqual([["plain"]]);
  });

  it("a new manual-only version of a selected skill reads as removed", async () => {
    const a = await seedSkill({ name: "alpha", text: md("alpha") });
    const b = await seedSkill({ name: "beta", text: md("beta") });
    const def = { skills: { orgSkills: [a.id, b.id] } };
    const agent = await agentId(def.skills);
    const conv = await createConv(owner, orgId, agent);
    await record(conv, agent, def, "run-1");
    await seedSkill({ name: "alpha", text: md("alpha"), invocation: MANUAL, skillId: a.id });
    await record(conv, agent, def, "run-2");
    const snaps = await catalogs(conv);
    expect(snaps.map((s) => s.payload.skills.map((x) => x.name))).toEqual([
      ["alpha", "beta"],
      ["beta"],
    ]);
    const text = snapshotChangeText(
      snaps[0]?.payload as SkillsSnapshot,
      snaps[1]?.payload as SkillsSnapshot,
    );
    expect(text).toContain("Removed skills (no longer available; do not use them): alpha");
  });

  it("a version without invocation stays in the catalog even if its SKILL.md says manual (no backfill)", async () => {
    const old = await seedSkill({
      name: "legacy",
      text: md("legacy", "disable-model-invocation: true\n"),
    });
    const agent = await agentId({ orgSkills: [old.id] });
    const conv = await createConv(owner, orgId, agent);
    await record(conv, agent, { skills: { orgSkills: [old.id] } }, "run-1");
    const snaps = await catalogs(conv);
    expect(snaps.map((s) => s.payload.skills.map((x) => x.name))).toEqual([["legacy"]]);
  });
});

describe("pinned manual-only skills", { timeout: 60_000 }, () => {
  it("pinning a manual-only skill is agent.pinned_invalid manual_only", async () => {
    const manual = await seedSkill({ name: "manual", text: md("manual"), invocation: MANUAL });
    const r = await createAgent({ orgSkills: [manual.id], pinned: [manual.id] });
    expect(r.statusCode, r.body).toBe(400);
    expect(r.json().error.code).toBe("agent.pinned_invalid");
    expect(r.json().error.details).toEqual([{ skill: manual.id, reason: "manual_only" }]);
  });

  it("a pinned skill whose new version is manual-only is dropped at run start", async () => {
    const a = await seedSkill({ name: "alpha", text: md("alpha", "", "Alpha body.") });
    const b = await seedSkill({ name: "beta", text: md("beta", "", "Beta body.") });
    const def = { skills: { orgSkills: [a.id, b.id], pinned: [a.id, b.id] } };
    const agent = await agentId(def.skills);
    const conv = await createConv(owner, orgId, agent);
    await seedSkill({
      name: "alpha",
      text: md("alpha", "", "Alpha v2."),
      invocation: MANUAL,
      skillId: a.id,
    });
    const log = { warn: vi.fn(), error: vi.fn() };
    await record(conv, agent, def, "run-1", log);
    const snaps = await catalogs(conv);
    expect(snaps).toHaveLength(1);
    expect(snaps[0]?.payload.skills.map((s) => s.name)).toEqual(["beta"]);
    expect(snaps[0]?.payload.pinned?.map((p) => p.name)).toEqual(["beta"]);
    expect(log.warn).toHaveBeenCalledWith(
      "pinned skill is manual-only",
      expect.objectContaining({ orgId, agentId: agent, skillId: a.id, name: "alpha" }),
    );
    expect(log.warn).toHaveBeenCalledTimes(1);
  });
});
