import { randomUUID } from "node:crypto";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { truncateTables } from "../helpers/db.js";
import { accountsFor } from "../helpers/identity.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import {
  createOrg,
  PW,
  type Req,
  runConfig,
  session,
  startKernel,
  type TestKernel,
} from "../helpers/runs.js";

/**
 * Skills default-on (spec 2026-11-12 §4): an agent turns skills off with `disabledSkills`; saving
 * checks and normalizes the list. Selecting (`skills.orgSkills`) and pinning (`skills.pinned`) are
 * gone: a save carrying them is refused.
 */

let pgc: TestContainer;
let rd: TestContainer;
let db: KernelSchemaDb;
let destroyDb: () => Promise<void>;
let k: TestKernel;
let admin: Req;
let adminId: string;
let orgId: string;

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  const raw = createDb(pgc.url, 3);
  db = kernelDb(raw);
  destroyDb = () => raw.destroy();
  k = await startKernel(
    runConfig({ pg: pgc.url, redis: rd.url }, { roles: ["api"], extensions: [MODEL_FAKE] }),
  );
}, 180_000);

afterAll(async () => {
  await k?.close();
  await destroyDb?.();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

beforeEach(async () => {
  await truncateTables(
    db,
    "capybara.skill_change_requests, capybara.skill_versions, capybara.skills, capybara.agent_versions, capybara.agent_members, capybara.agents, capybara.audit_events, capybara.memberships, capybara.orgs, capybara.sessions, capybara.local_passwords, capybara.identities, capybara.accounts",
  );
  adminId = (await accountsFor(db).createLocal({ login: "admin", password: PW, displayName: "A" }))
    .id;
  admin = await session(k, "admin");
  orgId = await createOrg(admin);
});

/** A skill row (scope org, or the agent's own); `plugin` sets its provenance (catalog item). */
async function skill(name: string, o: { agentId?: string; plugin?: string } = {}): Promise<string> {
  const id = randomUUID();
  let itemId: string | null = null;
  if (o.plugin !== undefined) {
    const got = await db
      .selectFrom("catalog_items")
      .select("id")
      .where("name", "=", o.plugin)
      .executeTakeFirst();
    itemId = got?.id ?? randomUUID();
    if (!got) {
      await db
        .insertInto("catalog_items")
        .values({
          id: itemId,
          name: o.plugin,
          package_name: `@acme/plugin-${o.plugin}`,
          publisher: "Acme",
          description: "d",
          latest_version: "1.0.0",
          policy: "allow",
        })
        .execute();
    }
  }
  await db
    .insertInto("skills")
    .values({
      id,
      org_id: orgId,
      scope: o.agentId === undefined ? "org" : "agent",
      agent_id: o.agentId ?? null,
      name,
      description: "d",
      current_version: 1,
      created_by: adminId,
      catalog_item_id: itemId,
    })
    .execute();
  await db
    .insertInto("skill_versions")
    .values({
      skill_id: id,
      version: 1,
      manifest: JSON.stringify({
        name,
        description: "d",
        files: [{ path: "SKILL.md", size: 100, sha256: "0".repeat(64) }],
      }),
      object_prefix: `skills/${id}/`,
      created_by: adminId,
    })
    .execute();
  return id;
}

const definition = (extra: Record<string, unknown> = {}) => ({
  name: "Helper",
  model: { provider: "model-fake", model: "fake-1" },
  disabledTools: [],
  ...extra,
});

const create = (extra: Record<string, unknown> = {}) =>
  admin({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/agents`,
    payload: { definition: definition(extra), visibility: "org" },
  });

async function createOk(extra: Record<string, unknown> = {}): Promise<string> {
  const r = await create(extra);
  expect(r.statusCode, r.body).toBe(201);
  return r.json().agent.id as string;
}

const patch = (agentId: string, extra: Record<string, unknown> = {}) =>
  admin({
    method: "PATCH",
    url: `/api/v1/orgs/${orgId}/agents/${agentId}`,
    payload: { definition: definition(extra) },
  });

const invalidPaths = (r: Awaited<ReturnType<Req>>) => {
  expect(r.statusCode, r.body).toBe(400);
  expect(r.json().error.code).toBe("validation_failed");
  return (r.json().error.details as { path: string }[]).map((d) => d.path);
};

describe("disabledSkills", { timeout: 60_000 }, () => {
  it("nothing pins or selects any more: skills.orgSkills and skills.pinned are refused", async () => {
    const s1 = await skill("one");
    expect((await create({ skills: { orgSkills: [s1] } })).statusCode).toBe(400);
    expect((await create({ skills: { pinned: [s1] } })).statusCode).toBe(400);
    // writePolicy alone saves; an agent created without disabledSkills turns nothing off
    const agentId = await createOk({ skills: { writePolicy: "ask" } });
    const r = await patch(agentId, { skills: { writePolicy: "ask" } });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().agent.currentVersion).toBe(1);
    expect(r.json().agent.definition).toMatchObject({
      skills: { writePolicy: "ask" },
      disabledSkills: [],
    });
  });

  it("is stored in canonical form: one entry per plugin, names sorted, skill entries sorted", async () => {
    await skill("beta", { plugin: "kit" });
    await skill("alpha", { plugin: "kit" });
    const a = await skill("a-org");
    const b = await skill("b-org");
    const [first, second] = [a, b].sort();
    const agentId = await createOk({
      disabledSkills: [
        { kind: "skill", skillId: second },
        { kind: "plugin", plugin: "kit", skills: ["beta"] },
        { kind: "skill", skillId: first },
        { kind: "plugin", plugin: "kit", skills: ["alpha", "beta"] },
        { kind: "skill", skillId: second },
      ],
    });
    const got = await admin({ method: "GET", url: `/api/v1/orgs/${orgId}/agents/${agentId}` });
    expect(got.json().agent.definition.disabledSkills).toEqual([
      { kind: "plugin", plugin: "kit", skills: ["alpha", "beta"] },
      { kind: "skill", skillId: first },
      { kind: "skill", skillId: second },
    ]);
    // "all" absorbs the names
    const r = await patch(agentId, {
      disabledSkills: [
        { kind: "plugin", plugin: "kit", skills: ["alpha"] },
        { kind: "plugin", plugin: "kit", skills: "all" },
      ],
    });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().agent.definition.disabledSkills).toEqual([
      { kind: "plugin", plugin: "kit", skills: "all" },
    ]);
  });

  it("refuses an unknown plugin or name, a plugin skill by id and an unknown skill id, at their index", async () => {
    await skill("alpha", { plugin: "kit" });
    const withPlugin = await skill("beta", { plugin: "kit" });
    const plain = await skill("plain");
    expect(
      invalidPaths(
        await create({
          disabledSkills: [
            { kind: "plugin", plugin: "kit", skills: ["alpha"] },
            { kind: "plugin", plugin: "nope", skills: "all" },
            { kind: "skill", skillId: plain },
            { kind: "skill", skillId: withPlugin },
          ],
        }),
      ),
    ).toEqual([
      "disabledSkills.1",
      // the canonical order is checked: plugins first, then skill ids sorted
      `disabledSkills.${withPlugin < plain ? 2 : 3}`,
    ]);
    expect(
      invalidPaths(
        await create({ disabledSkills: [{ kind: "plugin", plugin: "kit", skills: ["gamma"] }] }),
      ),
    ).toEqual(["disabledSkills.0"]);
    expect(
      invalidPaths(await create({ disabledSkills: [{ kind: "skill", skillId: "nope" }] })),
    ).toEqual(["disabledSkills.0"]);
  });

  it("an entry kept from the current version is not checked again; a new name is", async () => {
    const beta = await skill("beta", { plugin: "kit" });
    await skill("alpha", { plugin: "kit" });
    const plain = await skill("plain");
    const off = [
      { kind: "plugin", plugin: "kit", skills: ["beta"] },
      { kind: "skill", skillId: plain },
    ];
    const agentId = await createOk({ disabledSkills: off });
    // the plugin's skill and the org skill are deleted later: other edits still save
    await db
      .updateTable("skills")
      .set({ deleted_at: new Date() })
      .where("id", "in", [beta, plain])
      .execute();
    const r = await patch(agentId, { disabledSkills: off, instructions: "x" });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().agent.currentVersion).toBe(2);
    // a name added to the kept plugin entry is checked
    expect(
      invalidPaths(
        await patch(agentId, {
          disabledSkills: [
            { kind: "plugin", plugin: "kit", skills: ["beta", "gamma"] },
            { kind: "skill", skillId: plain },
          ],
        }),
      ),
    ).toEqual(["disabledSkills.0"]);
  });

  it("the agent's own skill cannot be turned off", async () => {
    const agentId = await createOk();
    const own = await skill("mine", { agentId });
    expect(
      invalidPaths(await patch(agentId, { disabledSkills: [{ kind: "skill", skillId: own }] })),
    ).toEqual(["disabledSkills.0"]);
  });

  it("an inline sub-agent template names only skills the agent has (skill_not_available)", async () => {
    const one = await skill("one");
    const two = await skill("two");
    const inline = (skills: string[]) => ({
      inline: [{ name: "helper", description: "Helps.", instructions: "Help.", skills }],
    });
    const agentId = await createOk({ subagents: inline([one, two]) });
    const own = await skill("mine", { agentId });
    const r = await patch(agentId, {
      disabledSkills: [{ kind: "skill", skillId: two }],
      subagents: inline([one, own, two]),
    });
    expect(r.statusCode, r.body).toBe(400);
    expect(r.json().error).toMatchObject({
      code: "agent.subagents_invalid",
      details: [{ reason: "skill_not_available", path: "subagents.inline.0.skills.2", value: two }],
    });
    expect(
      (await patch(agentId, { disabledSkills: [], subagents: inline([one, own, two]) })).statusCode,
    ).toBe(200);
  });
});
