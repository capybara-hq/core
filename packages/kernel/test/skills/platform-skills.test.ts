import { createHash, randomUUID } from "node:crypto";
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
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { agentsUsing, referenceIds } from "../../src/catalog/component-state.js";
import type { ConversationEvent } from "../../src/conversations/events.js";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { skillsChangeText } from "../../src/runtime/context/skills.js";
import { SkillInvoker } from "../../src/skills/invoke.js";
import { skillVersionsById, usableSkills } from "../../src/skills/usable.js";
import { StorageService } from "../../src/storage/storage.service.js";
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

/**
 * Plugin scope phase 2, Task 3: skills resolve from platform components. A platform skill that is
 * on in the org (its plugin on there for `follow`, its own scope for `own`, no switch off, not
 * disabled) is selectable by id and enters the catalog snapshot with `source: platform:<prefix>`;
 * `Skill`, pinned bodies and a person's invocation read its files from `deployment/`. Org copies
 * linked to it (ruling B2) resolve to its current version under their own id, unless pinned.
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
  root = await mkdtemp(join(tmpdir(), "cap-platform-skills-"));
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
    "capybara.catalog_item_org_switches, capybara.component_org_switches, capybara.component_scope_orgs, capybara.platform_skill_versions, capybara.platform_skills, capybara.plugin_installs, capybara.skill_versions, capybara.skills, capybara.catalog_items, capybara.sandboxes, capybara.attachments, capybara.approvals, capybara.tool_outputs, capybara.conversation_events, capybara.runs, capybara.conversations, capybara.agent_versions, capybara.agent_members, capybara.agents, capybara.memberships, capybara.orgs, capybara.sessions, capybara.local_passwords, capybara.identities, capybara.accounts",
  );
  const accounts = accountsFor(db);
  ownerId = (await accounts.createLocal({ login: "owner", password: PW, displayName: "O" })).id;
  owner = await session(k, "owner");
  orgId = await createOrg(owner);
});

const skillMd = (name: string, body: string) =>
  `---\nname: ${name}\ndescription: Use for ${name} work.\n---\n${body}`;

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

/** Writes `files` under `prefix` of `store`; returns their manifest entries. */
async function putFiles(
  store: ReturnType<StorageService["kernel"]>,
  prefix: string,
  files: Record<string, string>,
) {
  const out: { path: string; size: number; sha256: string }[] = [];
  for (const [path, text] of Object.entries(files)) {
    const data = new TextEncoder().encode(text);
    await store.put(`${prefix}${path}`, data, {
      contentType: "application/octet-stream",
      size: data.byteLength,
    });
    out.push({ path, size: data.byteLength, sha256: sha(data) });
  }
  return out;
}

/** The id of catalog item `name` (created when missing). */
async function catalogItem(
  name: string,
  o: { disabled?: boolean; builtin?: boolean } = {},
): Promise<string> {
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
      ...(o.disabled !== undefined && { disabled: o.disabled }),
      ...(o.builtin === true && { builtin: true, scope: "all" as const }),
    })
    .execute();
  return id;
}

/**
 * A live install of plugin `name` in the org (phase 1: the plugin is on there), with the org's
 * switch on so the scope sync (enqueued when the org was created) keeps it.
 */
async function installPlugin(name: string, org = orgId): Promise<void> {
  const itemId = await catalogItem(name);
  await db
    .insertInto("catalog_item_org_switches")
    .values({ item_id: itemId, org_id: org, enabled: true })
    .execute();
  await db
    .insertInto("plugin_installs")
    .values({
      id: randomUUID(),
      org_id: org,
      item_id: itemId,
      version: "1.0.0",
      status: "installed",
    })
    .execute();
}

/**
 * A platform skill of plugin `plugin` (its version files under `deployment/platform/skills/…`); with
 * `id`, a new version of that skill.
 */
async function seedPlatformSkill(o: {
  name: string;
  plugin: string;
  body: string;
  id?: string;
  scopeMode?: "follow" | "own";
  scope?: "all" | "optional" | "named";
  disabled?: boolean;
  extra?: Record<string, string>;
}): Promise<{ id: string; version: number; prefix: string }> {
  const id = o.id ?? randomUUID();
  let version = 1;
  if (o.id === undefined) {
    await db
      .insertInto("platform_skills")
      .values({
        id,
        catalog_item_id: await catalogItem(o.plugin),
        plugin_name: o.plugin,
        name: o.name,
        description: `Use for ${o.name} work.`,
        current_version: 1,
        scope_mode: o.scopeMode ?? "follow",
        scope: o.scope ?? "optional",
        disabled: o.disabled ?? false,
      })
      .execute();
  } else {
    version = (
      await db
        .updateTable("platform_skills")
        .set((eb) => ({ current_version: eb("current_version", "+", 1) }))
        .where("id", "=", id)
        .returning("current_version")
        .executeTakeFirstOrThrow()
    ).current_version;
  }
  const prefix = `platform/skills/${id}/${version}/`;
  const files = await putFiles(k.app.get(StorageService).deployment(), prefix, {
    "SKILL.md": skillMd(o.name, o.body),
    ...o.extra,
  });
  await db
    .insertInto("platform_skill_versions")
    .values({
      skill_id: id,
      version,
      manifest: JSON.stringify({ name: o.name, description: `Use for ${o.name} work.`, files }),
      object_prefix: prefix,
      catalog_version: "1.0.0",
    })
    .execute();
  return { id, version, prefix };
}

/** An org skill (files under `kernel/<orgId>/skills/…`); `plugin` sets its provenance. */
async function seedOrgSkill(o: {
  name: string;
  body: string;
  plugin?: string;
  /** An agent's own skill (`scope = 'agent'`). */
  agentId?: string;
}): Promise<{ id: string; prefix: string }> {
  const id = randomUUID();
  const prefix = `skills/${randomUUID()}/`;
  const files = await putFiles(k.app.get(StorageService).kernel(orgId), prefix, {
    "SKILL.md": skillMd(o.name, o.body),
  });
  const itemId = o.plugin === undefined ? null : await catalogItem(o.plugin);
  await db
    .insertInto("skills")
    .values({
      id,
      org_id: orgId,
      scope: o.agentId === undefined ? "org" : "agent",
      agent_id: o.agentId ?? null,
      name: o.name,
      description: `Use for ${o.name} work.`,
      current_version: 1,
      created_by: ownerId,
      catalog_item_id: itemId,
      catalog_version: itemId === null ? null : "1.0.0",
    })
    .execute();
  await db
    .insertInto("skill_versions")
    .values({
      skill_id: id,
      version: 1,
      manifest: JSON.stringify({ name: o.name, description: `Use for ${o.name} work.`, files }),
      object_prefix: prefix,
      created_by: ownerId,
    })
    .execute();
  return { id, prefix };
}

const definition = (orgSkills: string[], pinned?: string[]) => ({
  name: "Skilled",
  instructions: "Use skills.",
  model: { provider: "model-fake", model: "fake-1" },
  disabledTools: onlyBuiltins([{ kind: "builtin", name: "Bash" }]),
  skills: { orgSkills, ...(pinned !== undefined && { pinned }) },
});

async function createSkillAgent(orgSkills: string[], pinned?: string[]) {
  return owner({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/agents`,
    payload: { definition: definition(orgSkills, pinned), visibility: "org" },
  });
}

async function agentWith(orgSkills: string[], pinned?: string[]): Promise<string> {
  const res = await createSkillAgent(orgSkills, pinned);
  expect(res.statusCode, res.body).toBe(201);
  return (res.json() as { agent: { id: string } }).agent.id;
}

type ToolResultEvent = Extract<ConversationEvent, { type: "tool_result" }>;

async function call(convId: string, key: string, input: unknown, n: number) {
  await postMessage(owner, orgId, convId, `tool:${key}:${JSON.stringify(input)}`);
  await waitForTerminal(db, convId, n, 30_000);
  const results = (await eventsOf(db, convId)).filter(
    (e): e is ToolResultEvent => e.type === "tool_result",
  );
  return (results.at(-1) as ToolResultEvent).payload;
}

async function say(convId: string, n: number): Promise<void> {
  await postMessage(owner, orgId, convId, "hello");
  await waitForTerminal(db, convId, n, 30_000);
}

const catalogs = async (convId: string) =>
  (await eventsOf(db, convId)).filter(
    (e): e is Extract<ConversationEvent, { type: "skills_catalog" }> => e.type === "skills_catalog",
  );

describe("skills from platform components", { timeout: 90_000 }, () => {
  it("a platform skill on in the org is selectable, enters the snapshot as platform:<prefix> and Skill loads it", async () => {
    const alpha = await seedPlatformSkill({
      name: "alpha",
      plugin: "kit",
      body: "Do alpha from the platform.",
      extra: { "scripts/run.sh": "echo platform-alpha" },
    });
    await installPlugin("kit");
    const agentId = await agentWith([alpha.id], [alpha.id]);
    const conv = await createConv(owner, orgId, agentId);

    const r = await call(conv, "Skill", { skill: "alpha" }, 1);
    expect(r.isError, r.content).toBe(false);
    expect(r.content).toContain("Do alpha from the platform.");
    expect(r.content).toMatch(/\/skills\/alpha@[0-9a-f]{12}\//);

    const snaps = await catalogs(conv);
    expect(snaps).toHaveLength(1);
    expect(snaps[0]?.payload.skills).toEqual([
      {
        id: alpha.id,
        name: "alpha",
        description: "Use for alpha work.",
        version: 1,
        source: `platform:${alpha.prefix}`,
        plugin: "kit",
      },
    ]);
    // the pinned body is read from deployment/ too
    expect(snaps[0]?.payload.pinned).toEqual([
      {
        id: alpha.id,
        version: 1,
        name: "alpha",
        source: `platform:${alpha.prefix}`,
        body: "Do alpha from the platform.",
      },
    ]);

    // the qualified name still resolves
    const q = await call(conv, "Skill", { skill: "kit:alpha" }, 2);
    expect(q.isError, q.content).toBe(false);
    expect(q.content).toContain("Do alpha from the platform.");

    // a person's invocation reads the body from deployment/
    const agent = (
      await db
        .selectFrom("agent_versions")
        .select("definition")
        .where("agent_id", "=", agentId)
        .executeTakeFirstOrThrow()
    ).definition;
    const inv = await k.app.get(SkillInvoker).prepare({
      orgId,
      agentId,
      conversationId: conv,
      agent: agent as never,
      name: "kit:alpha",
      args: "",
    });
    expect(inv.text).toContain("Do alpha from the platform.");
    expect(inv.skill).toMatchObject({ id: alpha.id, source: `platform:${alpha.prefix}` });
  });

  it("a platform skill that is off in the org is refused at save and absent from the snapshot", async () => {
    const alpha = await seedPlatformSkill({ name: "alpha", plugin: "kit", body: "A." });
    // the plugin is not on in the org: not selectable
    const refused = await createSkillAgent([alpha.id]);
    expect(refused.statusCode).toBe(400);

    await installPlugin("kit");
    const agentId = await agentWith([alpha.id]);
    const conv = await createConv(owner, orgId, agentId);
    await say(conv, 1);
    expect((await catalogs(conv)).at(-1)?.payload.skills.map((s) => s.id)).toEqual([alpha.id]);

    // switched off in this org: gone at the next run
    await db
      .insertInto("component_org_switches")
      .values({ kind: "skill", component_id: alpha.id, org_id: orgId, enabled: false })
      .execute();
    await say(conv, 2);
    expect((await catalogs(conv)).at(-1)?.payload.skills).toEqual([]);
  });

  it("usableSkills: follow, own scope, switches, disabled and name clashes", async () => {
    const other = await createOrg(owner, "other");
    const follow = await seedPlatformSkill({ name: "follow", plugin: "kit", body: "F." });
    const ownAll = await seedPlatformSkill({
      name: "own-all",
      plugin: "kit",
      body: "O.",
      scopeMode: "own",
      scope: "all",
    });
    const ownOptional = await seedPlatformSkill({
      name: "own-optional",
      plugin: "kit",
      body: "O.",
      scopeMode: "own",
      scope: "optional",
    });
    const ownNamed = await seedPlatformSkill({
      name: "own-named",
      plugin: "kit",
      body: "O.",
      scopeMode: "own",
      scope: "named",
    });
    await seedPlatformSkill({ name: "gone", plugin: "kit", body: "G.", disabled: true });
    await seedPlatformSkill({ name: "elsewhere", plugin: "other-kit", body: "E." });
    await installPlugin("kit");
    await installPlugin("other-kit", other);
    await db
      .insertInto("component_org_switches")
      .values({ kind: "skill", component_id: ownOptional.id, org_id: orgId, enabled: true })
      .execute();
    await db
      .insertInto("component_scope_orgs")
      .values({ kind: "skill", component_id: ownNamed.id, org_id: orgId })
      .execute();
    const own = await seedOrgSkill({ name: "mine", body: "M." });

    const names = async (org: string) =>
      (await usableSkills(db, org)).map((s) => [s.name, s.origin]);
    expect(await names(orgId)).toEqual([
      ["follow", "platform"],
      ["mine", "org"],
      ["own-all", "platform"],
      ["own-named", "platform"],
      ["own-optional", "platform"],
    ]);
    // the other org: only own-all (scope all) and its own plugin's skill
    expect(await names(other)).toEqual([
      ["elsewhere", "platform"],
      ["own-all", "platform"],
    ]);
    const usable = await usableSkills(db, orgId);
    expect(usable.find((s) => s.name === "follow")).toEqual({
      id: follow.id,
      name: "follow",
      description: "Use for follow work.",
      version: 1,
      source: `platform:${follow.prefix}`,
      plugin: "kit",
      origin: "platform",
      platformSkillId: follow.id,
    });
    expect(usable.find((s) => s.name === "mine")).toMatchObject({
      id: own.id,
      origin: "org",
      plugin: null,
    });
    expect(usable.find((s) => s.id === ownAll.id)).toBeDefined();

    // the plugin disabled: its follow skills are off everywhere
    await db
      .updateTable("catalog_items")
      .set({ disabled: true })
      .where("name", "=", "kit")
      .execute();
    expect((await names(orgId)).map(([n]) => n)).toEqual(["mine"]);
    await db
      .updateTable("catalog_items")
      .set({ disabled: false })
      .where("name", "=", "kit")
      .execute();

    // a clash with the org's own skill: the org's wins, with a warning
    await seedOrgSkill({ name: "follow", body: "Org follow." });
    const log = { warn: vi.fn() };
    const clash = await usableSkills(db, orgId, log);
    expect(clash.filter((s) => s.name === "follow")).toEqual([
      expect.objectContaining({ origin: "org" }),
    ]);
    expect(log.warn).toHaveBeenCalledWith(
      "platform skill shadowed by an org skill of the same name",
      expect.objectContaining({ orgId, name: "follow", platformSkillId: follow.id }),
    );
  });

  it("a linked copy resolves to the platform version under its own id; a pinned copy keeps its own", async () => {
    await installPlugin("kit");
    const copy = await seedOrgSkill({ name: "alpha", body: "Org copy of alpha.", plugin: "kit" });
    const agentId = await agentWith([copy.id]);
    const conv = await createConv(owner, orgId, agentId);
    await say(conv, 1);
    const first = (await catalogs(conv)).at(-1)?.payload.skills ?? [];
    expect(first).toEqual([
      expect.objectContaining({ id: copy.id, version: 1, source: copy.prefix }),
    ]);

    // the platform skill (version 2) and the link: same id in the snapshot, platform content
    const p = await seedPlatformSkill({ name: "alpha", plugin: "kit", body: "Platform alpha v1." });
    const p2 = await seedPlatformSkill({
      id: p.id,
      name: "alpha",
      plugin: "kit",
      body: "Platform alpha v2.",
    });
    await db
      .updateTable("skills")
      .set({ platform_skill_id: p.id })
      .where("id", "=", copy.id)
      .execute();
    await say(conv, 2);
    const snaps = await catalogs(conv);
    const linked = snaps.at(-1)?.payload.skills ?? [];
    expect(linked).toEqual([
      {
        id: copy.id,
        name: "alpha",
        description: "Use for alpha work.",
        version: 2,
        source: `platform:${p2.prefix}`,
        plugin: "kit",
      },
    ]);
    const notice = skillsChangeText(first, linked);
    expect(notice).toContain("Updated skills");
    expect(notice).not.toContain("New skills");
    expect(notice).not.toContain("Removed skills");

    const r = await call(conv, "Skill", { skill: "alpha" }, 3);
    expect(r.isError, r.content).toBe(false);
    expect(r.content).toContain("Platform alpha v2.");

    // the library lists the platform skill with the linked copy's id (the editor keeps it selected)
    const library = async () => {
      const res = await owner({ method: "GET", url: `/api/v1/orgs/${orgId}/skills` });
      expect(res.statusCode, res.body).toBe(200);
      return (res.json().skills as { id: string; origin: string; linkedIds?: string[] }[]).map(
        (x) => [x.id, x.origin, ...(x.linkedIds ? [x.linkedIds] : [])],
      );
    };
    expect(await library()).toEqual([[p.id, "platform", [copy.id]]]);

    // a pin keeps the copy's own stored version
    await db.updateTable("skills").set({ pinned_version: 1 }).where("id", "=", copy.id).execute();
    await say(conv, 4);
    expect((await catalogs(conv)).at(-1)?.payload.skills).toEqual([
      expect.objectContaining({ id: copy.id, version: 1, source: copy.prefix }),
    ]);
    const pinned = await call(conv, "Skill", { skill: "alpha" }, 5);
    expect(pinned.content).toContain("Org copy of alpha.");
    // pinned: the copy is the org's own again and wins the name
    expect(await library()).toEqual([[copy.id, "org"]]);
  });
  it("a pinned linked copy follows its platform skill's availability and counts as a reference (ruling P2-18)", async () => {
    await installPlugin("kit");
    const p = await seedPlatformSkill({ name: "alpha", plugin: "kit", body: "Platform alpha." });
    const copy = await seedOrgSkill({ name: "alpha", body: "Org copy of alpha.", plugin: "kit" });
    await db
      .updateTable("skills")
      .set({ platform_skill_id: p.id, pinned_version: 1 })
      .where("id", "=", copy.id)
      .execute();
    const usable = async () => (await usableSkills(db, orgId)).map((x) => x.id);
    const byId = async () => [...(await skillVersionsById(db, orgId, [copy.id])).keys()];
    expect(await usable()).toEqual([copy.id]);
    expect(await byId()).toEqual([copy.id]);
    const agentId = await agentWith([copy.id]);
    // the previews (disable, scope, uninstall) see the agent through the pinned copy
    expect(await referenceIds(db, orgId, "skill", [p.id])).toEqual(
      new Map([
        [p.id, p.id],
        [copy.id, p.id],
      ]),
    );
    expect(await agentsUsing(db, orgId, "skill", [p.id])).toEqual([
      expect.objectContaining({ id: agentId, refs: [copy.id] }),
    ]);

    // disabled on the deployment
    await db
      .updateTable("platform_skills")
      .set({ disabled: true })
      .where("id", "=", p.id)
      .execute();
    expect(await usable()).toEqual([]);
    expect(await byId()).toEqual([]);
    await db
      .updateTable("platform_skills")
      .set({ disabled: false })
      .where("id", "=", p.id)
      .execute();
    expect(await usable()).toEqual([copy.id]);

    // switched off in the org
    await db
      .insertInto("component_org_switches")
      .values({ kind: "skill", component_id: p.id, org_id: orgId, enabled: false })
      .execute();
    expect(await usable()).toEqual([]);
    expect(await byId()).toEqual([]);
    await db.deleteFrom("component_org_switches").execute();
    expect(await byId()).toEqual([copy.id]);

    // its plugin uninstalled in the org
    await db.deleteFrom("plugin_installs").where("org_id", "=", orgId).execute();
    expect(await usable()).toEqual([]);
    expect(await byId()).toEqual([]);
  });
});

/**
 * Skill authoring spec, decision 8 and §5.7: the skills of a builtin plugin (`skills-core`'s
 * `skill-guide`) are in every agent's catalog without being selected, listed (not pinned); ranking
 * and the on-in-the-org rules stay as for any platform skill.
 */
describe("skills of builtin plugins", { timeout: 90_000 }, () => {
  /** A platform skill of the builtin plugin `core` (scope `all`, follows its plugin). */
  async function seedBuiltinSkill(name = "skill-guide", body = "How to write a skill.") {
    await catalogItem("core", { builtin: true });
    return seedPlatformSkill({ name, plugin: "core", body });
  }

  it("an agent that selects nothing has the builtin skill in its catalog; Skill loads it and the / menu lists it", async () => {
    const guide = await seedBuiltinSkill();
    const agentId = await agentWith([]);
    const conv = await createConv(owner, orgId, agentId);

    const r = await call(conv, "Skill", { skill: "skill-guide" }, 1);
    expect(r.isError, r.content).toBe(false);
    expect(r.content).toContain("How to write a skill.");

    const snaps = await catalogs(conv);
    expect(snaps).toHaveLength(1);
    expect(snaps[0]?.payload.skills).toEqual([
      {
        id: guide.id,
        name: "skill-guide",
        description: "Use for skill-guide work.",
        version: 1,
        source: `platform:${guide.prefix}`,
        plugin: "core",
      },
    ]);
    // listed only, never pinned
    expect(snaps[0]?.payload.pinned).toBeUndefined();

    const menu = await owner({
      method: "GET",
      url: `/api/v1/orgs/${orgId}/agents/${agentId}/invocable-skills`,
    });
    expect(menu.statusCode, menu.body).toBe(200);
    expect((menu.json() as { skills: { id: string }[] }).skills.map((s) => s.id)).toEqual([
      guide.id,
    ]);

    // the library marks it as builtin (the agent page shows it as always included)
    const lib = await owner({ method: "GET", url: `/api/v1/orgs/${orgId}/skills` });
    expect(lib.statusCode, lib.body).toBe(200);
    expect(
      (lib.json() as { skills: { id: string; builtin?: boolean }[] }).skills.map((s) => [
        s.id,
        s.builtin,
      ]),
    ).toEqual([[guide.id, true]]);
  });

  it("an agent's own skill of the same name shadows the builtin one", async () => {
    await seedBuiltinSkill();
    const agentId = await agentWith([]);
    const own = await seedOrgSkill({ name: "skill-guide", body: "My own guide.", agentId });
    const conv = await createConv(owner, orgId, agentId);
    const r = await call(conv, "Skill", { skill: "skill-guide" }, 1);
    expect(r.content).toContain("My own guide.");
    expect((await catalogs(conv)).at(-1)?.payload.skills).toEqual([
      expect.objectContaining({ id: own.id, name: "skill-guide", source: own.prefix }),
    ]);
  });

  it("a platform skill of a plugin that is not builtin still needs selecting", async () => {
    const guide = await seedBuiltinSkill();
    await catalogItem("kit");
    const alpha = await seedPlatformSkill({
      name: "alpha",
      plugin: "kit",
      body: "A.",
      scopeMode: "own",
      scope: "all",
    });
    const agentId = await agentWith([]);
    const conv = await createConv(owner, orgId, agentId);
    await say(conv, 1);
    expect((await catalogs(conv)).at(-1)?.payload.skills.map((s) => s.id)).toEqual([guide.id]);

    const selecting = await agentWith([alpha.id]);
    const conv2 = await createConv(owner, orgId, selecting);
    await say(conv2, 1);
    expect((await catalogs(conv2)).at(-1)?.payload.skills.map((s) => s.name)).toEqual([
      "alpha",
      "skill-guide",
    ]);
  });

  it("selecting the builtin skill explicitly lists it once", async () => {
    const guide = await seedBuiltinSkill();
    const agentId = await agentWith([guide.id]);
    const conv = await createConv(owner, orgId, agentId);
    await say(conv, 1);
    expect((await catalogs(conv)).at(-1)?.payload.skills.map((s) => s.id)).toEqual([guide.id]);
  });

  it("the org's pinned copy of the builtin skill takes its place, unselected", async () => {
    const guide = await seedBuiltinSkill();
    const copy = await seedOrgSkill({ name: "skill-guide", body: "Pinned guide.", plugin: "core" });
    await db
      .updateTable("skills")
      .set({ platform_skill_id: guide.id, pinned_version: 1 })
      .where("id", "=", copy.id)
      .execute();
    const agentId = await agentWith([]);
    const conv = await createConv(owner, orgId, agentId);
    const r = await call(conv, "Skill", { skill: "skill-guide" }, 1);
    expect(r.content).toContain("Pinned guide.");
    expect((await catalogs(conv)).at(-1)?.payload.skills.map((s) => s.id)).toEqual([copy.id]);
    // the library marks the copy as builtin too (the agent page shows it as always included)
    const lib = await owner({ method: "GET", url: `/api/v1/orgs/${orgId}/skills` });
    expect(
      (lib.json() as { skills: { id: string; builtin?: boolean }[] }).skills.map((s) => [
        s.id,
        s.builtin,
      ]),
    ).toEqual([[copy.id, true]]);
  });

  it("a builtin item or skill owned by another org never reaches this org's agents unselected", async () => {
    const other = await createOrg(owner, "other");
    // an org-owned item marked builtin (never so in practice): its skill is not auto-included
    const otherItem = randomUUID();
    await db
      .insertInto("catalog_items")
      .values({
        id: otherItem,
        name: "theirs",
        package_name: "@acme/plugin-theirs",
        publisher: "Acme",
        description: "d",
        latest_version: "1.0.0",
        policy: "allow",
        builtin: true,
        scope: "all",
        owner_org_id: other,
        shareable: true,
      })
      .execute();
    await seedPlatformSkill({ name: "theirs", plugin: "theirs", body: "T." });
    // a skill owned by another org inside a platform builtin item: not auto-included either
    const guide = await seedBuiltinSkill();
    const owned = await seedPlatformSkill({ name: "owned", plugin: "core", body: "O." });
    await db
      .updateTable("platform_skills")
      .set({ owner_org_id: other })
      .where("id", "=", owned.id)
      .execute();
    // another org's pinned copy of the builtin skill
    const copyId = randomUUID();
    await db
      .insertInto("skills")
      .values({
        id: copyId,
        org_id: other,
        scope: "org",
        agent_id: null,
        name: "skill-guide",
        description: "d",
        current_version: 1,
        created_by: ownerId,
        platform_skill_id: guide.id,
        pinned_version: 1,
      })
      .execute();
    const agentId = await agentWith([]);
    const conv = await createConv(owner, orgId, agentId);
    await say(conv, 1);
    expect((await catalogs(conv)).at(-1)?.payload.skills.map((s) => s.id)).toEqual([guide.id]);
  });

  it("follows the org's component switch and stays out when manual-only", async () => {
    const guide = await seedBuiltinSkill();
    const agentId = await agentWith([]);
    const conv = await createConv(owner, orgId, agentId);
    await say(conv, 1);
    expect((await catalogs(conv)).at(-1)?.payload.skills.map((s) => s.id)).toEqual([guide.id]);

    // a component switch off in the org (if one is ever written) takes it out at the next run
    await db
      .insertInto("component_org_switches")
      .values({ kind: "skill", component_id: guide.id, org_id: orgId, enabled: false })
      .execute();
    await say(conv, 2);
    expect((await catalogs(conv)).at(-1)?.payload.skills).toEqual([]);
    await db.deleteFrom("component_org_switches").execute();

    // a manual-only version never enters the model's catalog
    await db
      .updateTable("platform_skill_versions")
      .set((eb) => ({
        manifest: sql`jsonb_set(${eb.ref("manifest")}, '{invocation}', '{"model":false,"user":true}')`,
      }))
      .where("skill_id", "=", guide.id)
      .execute();
    const conv2 = await createConv(owner, orgId, agentId);
    await say(conv2, 1);
    expect(await catalogs(conv2)).toEqual([]);
  });
});
