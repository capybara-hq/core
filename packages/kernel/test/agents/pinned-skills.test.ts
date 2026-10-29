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

/** Agent definitions pin up to three skills (`skills.pinned`, spec §9.1). */

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

/** A skill row whose current version's SKILL.md is `bytes` long (scope org, or the agent's own). */
async function skill(name: string, bytes = 1000, agentId?: string): Promise<string> {
  const id = randomUUID();
  await db
    .insertInto("skills")
    .values({
      id,
      org_id: orgId,
      scope: agentId === undefined ? "org" : "agent",
      agent_id: agentId ?? null,
      name,
      description: "d",
      current_version: 1,
      created_by: adminId,
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
        files: [
          { path: "SKILL.md", size: bytes, sha256: "0".repeat(64) },
          { path: "big.txt", size: 999_999, sha256: "0".repeat(64) },
        ],
      }),
      object_prefix: `skills/${id}/`,
      created_by: adminId,
    })
    .execute();
  return id;
}

const definition = (skills: Record<string, unknown> | undefined, extra = {}) => ({
  name: "Helper",
  model: { provider: "model-fake", model: "fake-1" },
  tools: [],
  ...(skills !== undefined && { skills }),
  ...extra,
});

const create = (skills: Record<string, unknown> | undefined) =>
  admin({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/agents`,
    payload: { definition: definition(skills), visibility: "org" },
  });

async function createOk(skills: Record<string, unknown> | undefined): Promise<string> {
  const r = await create(skills);
  expect(r.statusCode, r.body).toBe(201);
  return r.json().agent.id as string;
}

const patch = (agentId: string, skills: Record<string, unknown> | undefined, extra = {}) =>
  admin({
    method: "PATCH",
    url: `/api/v1/orgs/${orgId}/agents/${agentId}`,
    payload: { definition: definition(skills, extra) },
  });

const pinnedError = (r: Awaited<ReturnType<Req>>) => {
  expect(r.statusCode, r.body).toBe(400);
  expect(r.json().error.code).toBe("agent.pinned_invalid");
  return r.json().error.details as { skill: string; reason: string; totalBytes?: number }[];
};

describe("skills.pinned", { timeout: 60_000 }, () => {
  it("a definition without skills.pinned saves without a new version on an unrelated edit", async () => {
    const s1 = await skill("one");
    const agentId = await createOk({ orgSkills: [s1] });
    const r = await patch(agentId, { orgSkills: [s1] });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().agent.currentVersion).toBe(1);
    expect(r.json().agent.definition.skills).toEqual({ orgSkills: [s1] });
  });

  it("pinning an org skill not in orgSkills is not_selected", async () => {
    const s1 = await skill("one");
    const s2 = await skill("two");
    expect(pinnedError(await create({ orgSkills: [s1], pinned: [s2] }))).toEqual([
      { skill: s2, reason: "not_selected" },
    ]);
    expect(pinnedError(await create({ orgSkills: [s1], pinned: ["nope"] }))).toEqual([
      { skill: "nope", reason: "not_found" },
    ]);
    expect(pinnedError(await create({ orgSkills: [s1], pinned: [s1, s1] }))).toEqual([
      { skill: s1, reason: "duplicate" },
    ]);
  });

  it("four pinned is too_many", async () => {
    const ids = await Promise.all(["a", "b", "c", "d"].map((n) => skill(n, 10)));
    const details = pinnedError(await create({ orgSkills: ids, pinned: ids }));
    expect(details).toEqual([{ skill: ids[3], reason: "too_many" }]);
    expect((await create({ orgSkills: ids, pinned: ids.slice(0, 3) })).statusCode).toBe(201);
  });

  it("two skills totalling 33000 bytes is too_large with totalBytes", async () => {
    const a = await skill("a", 16_000);
    const b = await skill("b", 17_000);
    expect(pinnedError(await create({ orgSkills: [a, b], pinned: [a, b] }))).toEqual([
      { skill: b, reason: "too_large", totalBytes: 33_000 },
    ]);
    // only SKILL.md counts: other files of the skill do not
    expect((await create({ orgSkills: [a], pinned: [a] })).statusCode).toBe(201);
  });

  it("pinning the agent's own skill works", async () => {
    const agentId = await createOk(undefined);
    const own = await skill("mine", 100, agentId);
    const r = await patch(agentId, { orgSkills: [], pinned: [own] });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().agent.definition.skills).toEqual({ orgSkills: [], pinned: [own] });
    // another agent cannot pin it
    expect(pinnedError(await create({ orgSkills: [], pinned: [own] }))).toEqual([
      { skill: own, reason: "not_found" },
    ]);
  });

  it("a pinned id whose skill was deleted later is kept on the next save (Review Focus 2)", async () => {
    const s1 = await skill("one");
    const s2 = await skill("two");
    const agentId = await createOk({ orgSkills: [s1, s2], pinned: [s2] });
    const del = await admin({ method: "DELETE", url: `/api/v1/orgs/${orgId}/skills/${s2}` });
    expect(del.statusCode, del.body).toBe(204);
    const r = await patch(agentId, { orgSkills: [s1, s2], pinned: [s2] }, { instructions: "x" });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().agent.currentVersion).toBe(2);
    // a newly pinned deleted skill is still refused
    const s3 = await skill("three");
    await admin({ method: "DELETE", url: `/api/v1/orgs/${orgId}/skills/${s3}` });
    expect(pinnedError(await patch(agentId, { orgSkills: [s1, s2], pinned: [s2, s3] }))).toEqual([
      { skill: s3, reason: "not_found" },
    ]);
  });

  it("editing pinned on a shared agent creates a new agent version and no skill_change_request (§9.1)", async () => {
    const s1 = await skill("one");
    const agentId = await createOk({ orgSkills: [s1] });
    const r = await patch(agentId, { orgSkills: [s1], pinned: [s1] });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().agent.currentVersion).toBe(2);
    expect(r.json().agent.definition.skills).toEqual({ orgSkills: [s1], pinned: [s1] });
    expect(await db.selectFrom("skill_change_requests").select("id").execute()).toEqual([]);
  });
});
