import { createHash, randomUUID } from "node:crypto";
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
import type { ConversationEvent, EventPayload } from "../../src/conversations/events.js";
import { type KernelDb, kernelDb, type SkillManifest } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { AccountsService } from "../../src/identity/accounts.js";
import { KERNEL_MIGRATIONS_DIR, type Kernel } from "../../src/kernel.js";
import { type ScriptRule, scriptRules } from "../fixtures/plugins/model-script/index.js";
import { truncateTables } from "../helpers/db.js";
import { seedForkedSkill } from "../helpers/forked-skills.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import {
  createConv,
  createOrg,
  eventsOf,
  PW,
  type Req,
  runConfig,
  runsOf,
  session,
  sleep,
  startKernel,
  waitFor,
  waitForTerminal,
} from "../helpers/runs.js";

/**
 * Phase D Task 9: a skill invocation can be queued (`POST …/queue` with `skill`). It is rendered
 * when queued, like queued `@` resources (UI refresh B decision 15), stored with its `skill`
 * record, and sent later as that text. At dispatch the kernel checks again that the skill is still
 * one of the agent's invocable skills; when it is not, the queue pauses with a reason.
 * One kernel, model-script (a barrier holds the first run), fake sandbox and SeaweedFS.
 */

const MODEL_SCRIPT = fileURLToPath(
  new URL("../fixtures/plugins/model-script/index.ts", import.meta.url),
);
const OBJECT_STORE = fakeExtensionEntry("fake-object-store");
const SANDBOX_FAKE = fileURLToPath(
  new URL("../fixtures/plugins/sandbox-fake/index.ts", import.meta.url),
);

const CHILD = "You are a sub-agent";
const RULES: ScriptRule[] = [
  { when: { systemIncludes: CHILD }, reply: { text: "child report" } },
  {
    when: { lastUserIncludes: "HOLD" },
    reply: { text: "held", barrier: { name: "hold", count: 99, timeoutMs: 60_000 } },
  },
  { when: {}, reply: { text: "answer" } },
];

/** Releases the run waiting at the `hold` barrier (the kernel runs in this process). */
function release(): void {
  const s = (
    globalThis as { __modelScript?: { barriers: Map<string, { waiters: (() => void)[] }> } }
  ).__modelScript;
  for (const w of s?.barriers.get("hold")?.waiters.splice(0) ?? []) w();
}

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
  root = await mkdtemp(join(tmpdir(), "cap-queue-skill-"));
  k = await startKernel(
    runConfig(
      { pg: pgc.url, redis: rd.url },
      {
        roles: ["api", "worker"],
        extensions: [MODEL_FAKE, MODEL_SCRIPT, OBJECT_STORE, SANDBOX_FAKE],
        extensionConfig: {
          "model-script": { rules: RULES },
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
  release();
  await k?.stop();
  await destroyDb?.();
  await Promise.all([pgc?.stop(), rd?.stop(), s3?.stop()]);
  if (root) await rm(root, { recursive: true, force: true });
});

let owner: Req;
let ownerId: string;
let orgId: string;

beforeEach(async () => {
  release();
  scriptRules([]);
  await truncateTables(
    db,
    "capybara.agent_template_versions, capybara.agent_templates, capybara.skill_versions, capybara.skills, capybara.catalog_items, capybara.sandboxes, capybara.approvals, capybara.conversation_queue, capybara.conversation_events, capybara.runs, capybara.conversations, capybara.agent_versions, capybara.agent_members, capybara.agents, capybara.memberships, capybara.orgs, capybara.sessions, capybara.local_passwords, capybara.identities, capybara.accounts",
  );
  ownerId = (
    await new AccountsService(db).createLocal({ login: "owner", password: PW, displayName: "O" })
  ).id;
  owner = await session(k, "owner");
  orgId = await createOrg(owner);
});

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

/** Writes an org skill version (a new version of `skillId` when given). */
async function seedSkill(
  name: string,
  body: string,
  opts: { skillId?: string; invocation?: SkillManifest["invocation"] } = {},
): Promise<{ id: string; version: number }> {
  const prefix = `skills/${randomUUID()}/`;
  const data = new TextEncoder().encode(
    `---\nname: ${name}\ndescription: Use for ${name} work.\n---\n${body}`,
  );
  await k.storage.kernel(orgId).put(`${prefix}SKILL.md`, data, {
    contentType: "application/octet-stream",
    size: data.byteLength,
  });
  const manifest: SkillManifest = {
    name,
    description: `Use for ${name} work.`,
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
        name,
        description: manifest.description,
        current_version: 1,
        created_by: ownerId,
      })
      .execute();
  } else {
    version = (
      await db
        .updateTable("skills")
        .set((eb) => ({ current_version: eb("current_version", "+", 1) }))
        .where("id", "=", id)
        .returning("current_version")
        .executeTakeFirstOrThrow()
    ).current_version;
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

const definition = (skills: string[]) => ({
  name: "Lead",
  instructions: "Lead the work.",
  model: { provider: "model-script", model: "script-1" },
  tools: [],
  skills: { orgSkills: skills },
});

async function createAgent(skills: string[]): Promise<string> {
  const res = await owner({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/agents`,
    payload: { definition: definition(skills), visibility: "private" },
  });
  expect(res.statusCode, res.body).toBe(201);
  return (res.json() as { agent: { id: string } }).agent.id;
}

async function setSkills(agentId: string, skills: string[]): Promise<void> {
  const res = await owner({
    method: "PATCH",
    url: `/api/v1/orgs/${orgId}/agents/${agentId}`,
    payload: { definition: definition(skills) },
  });
  expect(res.statusCode, res.body).toBe(200);
}

interface Item {
  id: string;
  text: string;
  clientMessageId: string;
  skill?: { name: string; arguments: string; mode: "inline" | "fork" };
}
const base = (conv: string) => `/api/v1/orgs/${orgId}/conversations/${conv}/queue`;
const enqueue = (conv: string, body: Record<string, unknown>) =>
  owner({
    method: "POST",
    url: base(conv),
    payload: { clientMessageId: randomUUID(), ...body },
  });
const queueOf = async (conv: string) => {
  const r = await owner({ method: "GET", url: base(conv) });
  expect(r.statusCode, r.body).toBe(200);
  return r.json() as { items: Item[]; paused: boolean; pauseReason?: string };
};

type Ev<T extends ConversationEvent["type"]> = ConversationEvent & {
  type: T;
  payload: EventPayload<T>;
};
const ofType = <T extends ConversationEvent["type"]>(events: ConversationEvent[], type: T) =>
  events.filter((e): e is Ev<T> => e.type === type);
const firstText = (e: Ev<"user_message"> | undefined): string => {
  const b = e?.payload.content[0];
  return b?.type === "text" ? b.text : "";
};

/** Starts a run that waits at the `hold` barrier until {@link release}. */
async function holdRun(conv: string): Promise<void> {
  const res = await owner({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/conversations/${conv}/messages`,
    payload: { text: "HOLD" },
  });
  expect(res.statusCode, res.body).toBe(202);
  await waitFor(
    async () => (await runsOf(db, conv)).some((r) => r.status === "running") || null,
    15_000,
    "the held run running",
  );
}

const FIX = "Fix GitHub issue $ARGUMENTS.";
const rendered = (version: number, body: string) =>
  `The user invoked the skill "fix-issue" with /fix-issue 9. Follow its instructions for this request.\n\n<skill_invocation name="fix-issue" version="${version}">\n${body}\n</skill_invocation>`;

describe("queued skill invocations (phase D Task 9)", { timeout: 90_000 }, () => {
  it("is rendered when queued and sent as that text, even after the skill got a new version", async () => {
    const fix = await seedSkill("fix-issue", FIX);
    const agentId = await createAgent([fix.id]);
    const conv = await createConv(owner, orgId, agentId);
    await holdRun(conv);
    const q = await enqueue(conv, { text: "9", skill: { name: "fix-issue" } });
    expect(q.statusCode, q.body).toBe(201);
    const item = (q.json() as { item: Item }).item;
    expect(item).toMatchObject({
      text: "9",
      skill: { name: "fix-issue", arguments: "9", mode: "inline" },
    });
    expect((await queueOf(conv)).items).toEqual([expect.objectContaining({ id: item.id })]);
    // a new version meanwhile: the queued text stays as rendered when queued
    await seedSkill("fix-issue", "Changed $ARGUMENTS.", { skillId: fix.id });
    release();
    await waitForTerminal(db, conv, 2, 30_000);
    const msgs = ofType(await eventsOf(db, conv), "user_message");
    expect(msgs).toHaveLength(2);
    const sent = msgs[1];
    expect(firstText(sent)).toBe(rendered(1, "Fix GitHub issue 9."));
    expect(sent?.payload.content).toHaveLength(1);
    expect(sent?.payload.skill).toEqual({
      id: fix.id,
      version: 1,
      source: expect.any(String),
      name: "fix-issue",
      arguments: "9",
      mode: "inline",
    });
    expect(sent?.payload.clientMessageId).toBe(item.clientMessageId);
    expect(await queueOf(conv)).toEqual({ items: [], paused: false });
  });

  it("a skill the person cannot invoke is 400 skill.not_invocable and queues nothing", async () => {
    const hidden = await seedSkill("hidden", "H.", { invocation: { model: true, user: false } });
    const agentId = await createAgent([hidden.id]);
    const conv = await createConv(owner, orgId, agentId);
    await holdRun(conv);
    for (const name of ["hidden", "nope"]) {
      const res = await enqueue(conv, { text: "", skill: { name } });
      expect(res.statusCode, res.body).toBe(400);
      expect(res.json()).toMatchObject({ error: { code: "skill.not_invocable" } });
    }
    expect((await queueOf(conv)).items).toEqual([]);
    release();
  });

  it("a retry with the same clientMessageId returns the queued item without rendering again", async () => {
    const fix = await seedSkill("fix-issue", FIX);
    const agentId = await createAgent([fix.id]);
    const conv = await createConv(owner, orgId, agentId);
    await holdRun(conv);
    const clientMessageId = randomUUID();
    const a = await enqueue(conv, { text: "9", skill: { name: "fix-issue" }, clientMessageId });
    expect(a.statusCode, a.body).toBe(201);
    await setSkills(agentId, []);
    const b = await enqueue(conv, { text: "9", skill: { name: "fix-issue" }, clientMessageId });
    expect(b.statusCode, b.body).toBe(200);
    expect((b.json() as { item: Item }).item.id).toBe((a.json() as { item: Item }).item.id);
    release();
  });

  it("a skill deselected before dispatch pauses the queue with a reason; resume sends it once it is back", async () => {
    const fix = await seedSkill("fix-issue", FIX);
    const agentId = await createAgent([fix.id]);
    const conv = await createConv(owner, orgId, agentId);
    await holdRun(conv);
    expect((await enqueue(conv, { text: "9", skill: { name: "fix-issue" } })).statusCode).toBe(201);
    await setSkills(agentId, []);
    release();
    await waitForTerminal(db, conv, 1, 30_000);
    await waitFor(async () => (await queueOf(conv)).paused || null, 10_000, "queue paused");
    await sleep(300);
    expect(await queueOf(conv)).toMatchObject({
      paused: true,
      pauseReason: "skill_not_invocable",
      items: [expect.objectContaining({ text: "9" })],
    });
    expect(ofType(await eventsOf(db, conv), "user_message")).toHaveLength(1);

    // send now refuses it too, and the item stays
    const item = (await queueOf(conv)).items[0] as Item;
    const now = await owner({ method: "POST", url: `${base(conv)}/${item.id}/send` });
    expect(now.statusCode, now.body).toBe(400);
    expect(now.json()).toMatchObject({ error: { code: "skill.not_invocable" } });
    expect((await queueOf(conv)).items).toHaveLength(1);

    await setSkills(agentId, [fix.id]);
    const resumed = await owner({ method: "POST", url: `${base(conv)}/resume` });
    expect(resumed.statusCode, resumed.body).toBe(202);
    await waitForTerminal(db, conv, 2, 30_000);
    const msgs = ofType(await eventsOf(db, conv), "user_message");
    expect(firstText(msgs[1])).toBe(rendered(1, "Fix GitHub issue 9."));
    expect(await queueOf(conv)).toEqual({ items: [], paused: false });
  });

  it("editing a queued invocation renders the new arguments", async () => {
    const fix = await seedSkill("fix-issue", FIX);
    const agentId = await createAgent([fix.id]);
    const conv = await createConv(owner, orgId, agentId);
    await holdRun(conv);
    const item = (
      (await enqueue(conv, { text: "8", skill: { name: "fix-issue" } })).json() as {
        item: Item;
      }
    ).item;
    const edited = await owner({
      method: "PATCH",
      url: `${base(conv)}/${item.id}`,
      payload: { text: "9" },
    });
    expect(edited.statusCode, edited.body).toBe(200);
    expect((edited.json() as { item: Item }).item).toMatchObject({
      text: "9",
      skill: { name: "fix-issue", arguments: "9", mode: "inline" },
    });
    release();
    await waitForTerminal(db, conv, 2, 30_000);
    const msgs = ofType(await eventsOf(db, conv), "user_message");
    expect(firstText(msgs[1])).toBe(rendered(1, "Fix GitHub issue 9."));
    expect(msgs[1]?.payload.skill?.arguments).toBe("9");
  });

  it("a queued fork invocation runs as a sub-agent: dispatched before any model call of its run", async () => {
    const review = await seedForkedSkill(
      { db, storage: k.storage, orgId, ownerId },
      "review",
      "Review $ARGUMENTS.",
    );
    const agentId = await createAgent([review.id]);
    const conv = await createConv(owner, orgId, agentId);
    await holdRun(conv);
    const q = await enqueue(conv, { text: "src", skill: { name: "review" } });
    expect(q.statusCode, q.body).toBe(201);
    expect((q.json() as { item: Item }).item.skill).toEqual({
      name: "review",
      arguments: "src",
      mode: "fork",
    });
    release();
    await waitForTerminal(db, conv, 2, 40_000);
    const events = await eventsOf(db, conv);
    const msg = ofType(events, "user_message")[1];
    expect(firstText(msg)).toBe(
      'The user ran the skill "review" in a sub-agent (general-purpose) with /review src. The sub-agent gets the skill\'s instructions as its task; its report follows. Do not do the task yourself.',
    );
    expect(msg?.payload.skill).toMatchObject({ mode: "fork", agentType: "general-purpose" });
    const runs = await runsOf(db, conv);
    const second = (runs as unknown as { id: string }[])[1]?.id;
    const ofSecond = events.filter((e) => e.runId === second);
    const dispatchAt = ofSecond.findIndex((e) => e.type === "subagent_dispatched");
    expect(dispatchAt).toBeGreaterThanOrEqual(0);
    expect(ofSecond.findIndex((e) => e.type === "model_call")).toBeGreaterThan(dispatchAt);
    expect(ofType(events, "subagent_dispatched")[0]?.payload.callId).toBe(`skill-${msg?.seq}`);
    expect(ofType(events, "skill_fork_result")).toHaveLength(1);
  });
});

describe("0062_queued_skill.sql", () => {
  it("applies twice without error", async () => {
    const content = await readFile(join(KERNEL_MIGRATIONS_DIR, "0062_queued_skill.sql"), "utf8");
    for (let i = 0; i < 2; i++) {
      await db.transaction().execute(async (t) => {
        await sql`set local search_path to capybara, public`.execute(t);
        await sql.raw(content).execute(t);
      });
    }
  });
});
