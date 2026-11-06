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
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ComponentPromotion } from "../../src/catalog/component-promotion.js";
import { PluginInstaller } from "../../src/catalog/plugin-install.js";
import type { ConversationEvent } from "../../src/conversations/events.js";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { SkillsService } from "../../src/skills/skills.service.js";
import { usableSkills } from "../../src/skills/usable.js";
import { StorageService } from "../../src/storage/storage.service.js";
import { truncateTables } from "../helpers/db.js";
import { accountsFor } from "../helpers/identity.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import { captureProviderRequests } from "../helpers/provider-capture.js";
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
  waitFor,
  waitForTerminal,
} from "../helpers/runs.js";
import { makeZip } from "./zip.js";

/**
 * Plugin scope phase 3, Task 8 (spec §14, rulings P3-3 to P3-6, P3-23; pre-flight F16, F19): an
 * org's own skill or agent template stays an org row until the super admin first shows it to other
 * orgs or associates it with one. That action promotes it: a platform row owned by the org at the
 * same version, the files copied under `deployment/platform/…`, the org row linked to it without a
 * pin. The owner's agents keep the org row's id and see the same version, source and body (no
 * "Updated skills" line); other orgs reference the platform id; the owner's later versions go to
 * the platform row and reach both. Only the owner's own rows can be made shareable.
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
let sandboxRoot: string;
/** The super admin, owner of orgs A and B. */
let root: Req;
let rootId: string;
let orgA: string;
let orgB: string;
const capture = captureProviderRequests();

beforeAll(async () => {
  capture.install();
  [pgc, rd, s3] = await Promise.all([startTestPostgres(), startTestRedis(), startTestS3()]);
  const raw = createDb(pgc.url, 3);
  db = kernelDb(raw);
  destroyDb = () => raw.destroy();
  sandboxRoot = await mkdtemp(join(tmpdir(), "cap-promote-on-share-"));
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
          "sandbox-fake": { root: sandboxRoot },
        },
      },
    ),
  );
  rootId = (
    await accountsFor(db).createLocal({
      login: "root",
      password: PW,
      displayName: "R",
      superAdmin: true,
    })
  ).id;
  root = await session(k, "root");
  orgA = await createOrg(root, "A");
  orgB = await createOrg(root, "B");
}, 180_000);

afterAll(async () => {
  capture.restore();
  await k?.close();
  await destroyDb?.();
  await Promise.all([pgc?.stop(), rd?.stop(), s3?.stop()]);
  if (sandboxRoot) await rm(sandboxRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  await truncateTables(
    db,
    "capybara.component_org_switches, capybara.component_scope_orgs, capybara.platform_skill_versions, capybara.platform_skills, capybara.platform_agent_template_versions, capybara.platform_agent_templates, capybara.agent_template_versions, capybara.agent_templates, capybara.skill_versions, capybara.skills, capybara.catalog_items, capybara.sandboxes, capybara.approvals, capybara.tool_outputs, capybara.conversation_events, capybara.runs, capybara.conversations, capybara.agent_versions, capybara.agent_members, capybara.agents, capybara.org_notices, capybara.platform_notices, capybara.audit_events",
  );
  await k.app.get(StorageService).deployment().deletePrefix("platform/");
  capture.reset();
});

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const skillMd = (name: string, body: string) =>
  `---\nname: ${name}\ndescription: Use for ${name} work.\n---\n${body}`;

const errorOf = (r: { statusCode: number; body: string }) =>
  [r.statusCode, (JSON.parse(r.body) as { error?: { code: string } }).error?.code] as const;

/** An org-scope skill of `org` with one version per body (files under `kernel/<org>/skills/…`). */
async function seedOrgSkill(
  org: string,
  name: string,
  bodies: string[],
  o: { scope?: "org" | "agent"; agentId?: string } = {},
): Promise<{ id: string; prefix: string }> {
  const id = randomUUID();
  const store = k.app.get(StorageService).kernel(org);
  await db
    .insertInto("skills")
    .values({
      id,
      org_id: org,
      scope: o.scope ?? "org",
      agent_id: o.agentId ?? null,
      name,
      description: `Use for ${name} work.`,
      current_version: bodies.length,
      created_by: rootId,
    })
    .execute();
  let prefix = "";
  for (const [i, body] of bodies.entries()) {
    prefix = `skills/${randomUUID()}/`;
    const data = new TextEncoder().encode(skillMd(name, body));
    await store.put(`${prefix}SKILL.md`, data, {
      contentType: "application/octet-stream",
      size: data.byteLength,
    });
    await db
      .insertInto("skill_versions")
      .values({
        skill_id: id,
        version: i + 1,
        manifest: JSON.stringify({
          name,
          description: `Use for ${name} work.`,
          files: [{ path: "SKILL.md", size: data.byteLength, sha256: sha(data) }],
        }),
        object_prefix: prefix,
        created_by: rootId,
      })
      .execute();
  }
  return { id, prefix };
}

async function agentWith(org: string, orgSkills: string[], pinned?: string[]): Promise<string> {
  const r = await root({
    method: "POST",
    url: `/api/v1/orgs/${org}/agents`,
    payload: {
      definition: {
        name: "Skilled",
        instructions: "Use skills.",
        model: { provider: "model-fake", model: "fake-1" },
        tools: [{ kind: "builtin", name: "Bash" }],
        skills: { orgSkills, ...(pinned !== undefined && { pinned }) },
      },
      visibility: "org",
    },
  });
  expect(r.statusCode, r.body).toBe(201);
  return (r.json() as { agent: { id: string } }).agent.id;
}

type ToolResultEvent = Extract<ConversationEvent, { type: "tool_result" }>;

async function call(org: string, convId: string, key: string, input: unknown, n: number) {
  await postMessage(root, org, convId, `tool:${key}:${JSON.stringify(input)}`);
  await waitForTerminal(db, convId, n, 30_000);
  const results = (await eventsOf(db, convId)).filter(
    (e): e is ToolResultEvent => e.type === "tool_result",
  );
  return (results.at(-1) as ToolResultEvent).payload;
}

async function say(org: string, convId: string, n: number): Promise<void> {
  await postMessage(root, org, convId, "hello");
  await waitForTerminal(db, convId, n, 30_000);
}

const catalogs = async (convId: string) =>
  (await eventsOf(db, convId)).filter(
    (e): e is Extract<ConversationEvent, { type: "skills_catalog" }> => e.type === "skills_catalog",
  );

const setShareable = (org: string, kind: "skills" | "agent-templates", id: string, on = true) =>
  root({
    method: "PUT",
    url: `/api/v1/orgs/${org}/${kind}/${id}/shareable`,
    payload: { shareable: on },
  });

/** Preview + PUT of a component scope change by the super admin. */
async function putScope(
  kind: "skill" | "agent_template",
  id: string,
  body: Record<string, unknown>,
) {
  const p = await root({
    method: "POST",
    url: `/api/v1/admin/components/${kind}/${id}/scope/preview`,
    payload: body,
  });
  expect(p.statusCode, p.body).toBe(200);
  return root({
    method: "PUT",
    url: `/api/v1/admin/components/${kind}/${id}/scope`,
    payload: { ...body, scopeHash: p.json().scopeHash },
  });
}

const showToOthers = (kind: "skill" | "agent_template", id: string) =>
  root({
    method: "PUT",
    url: `/api/v1/admin/components/${kind}/${id}/shown`,
    payload: { shownToOthers: true },
  });

/** `report` at version 3 in org A, used and pinned by agent X with one run done. */
async function reportInA() {
  const skill = await seedOrgSkill(orgA, "report", ["Report v1.", "Report v2.", "Report v3."]);
  const agentX = await agentWith(orgA, [skill.id], [skill.id]);
  const convX = await createConv(root, orgA, agentX);
  await say(orgA, convX, 1);
  return { ...skill, agentX, convX };
}

/** {@link reportInA}, made shareable and associated with org B by the super admin. */
async function promotedReport() {
  const r = await reportInA();
  expect((await setShareable(orgA, "skills", r.id)).statusCode).toBe(200);
  const res = await putScope("skill", r.id, { scope: "named", orgs: [orgA, orgB] });
  expect(res.statusCode, res.body).toBe(200);
  return { ...r, platformId: res.json().id as string };
}

describe("promote on share", { timeout: 120_000 }, () => {
  it("toggle only on owned rows", async () => {
    const own = await seedOrgSkill(orgA, "mine", ["Mine."]);
    const ok = await setShareable(orgA, "skills", own.id);
    expect(ok.statusCode, ok.body).toBe(200);
    expect(
      (
        await db
          .selectFrom("skills")
          .select("shareable")
          .where("id", "=", own.id)
          .executeTakeFirstOrThrow()
      ).shareable,
    ).toBe(true);

    // a copy linked to a platform skill the org does not own
    const pid = randomUUID();
    await db
      .insertInto("platform_skills")
      .values({ id: pid, name: "theirs", description: "d", current_version: 1 })
      .execute();
    const copy = await seedOrgSkill(orgA, "theirs", ["Theirs."]);
    await db
      .updateTable("skills")
      .set({ platform_skill_id: pid })
      .where("id", "=", copy.id)
      .execute();
    expect(errorOf(await setShareable(orgA, "skills", copy.id))).toEqual([
      409,
      "catalog.not_owned",
    ]);

    // an agent's own skill
    const agentId = await agentWith(orgA, []);
    const agentSkill = await seedOrgSkill(orgA, "agent-own", ["Agent own."], {
      scope: "agent",
      agentId,
    });
    expect(errorOf(await setShareable(orgA, "skills", agentSkill.id))).toEqual([
      409,
      "catalog.not_owned",
    ]);
    // another org's skill is not found here
    const elsewhere = await seedOrgSkill(orgB, "other", ["Other."]);
    expect((await setShareable(orgA, "skills", elsewhere.id)).statusCode).toBe(404);
  });

  it("unshared skills stay org rows", async () => {
    const own = await seedOrgSkill(orgA, "report", ["Report v1."]);
    const list = await root({ method: "GET", url: "/api/v1/admin/components?kind=skill" });
    expect(list.statusCode, list.body).toBe(200);
    expect(list.json().components).toEqual([
      expect.objectContaining({
        id: own.id,
        owner: { kind: "org", orgId: orgA, name: "A" },
        promoted: false,
        shareable: false,
      }),
    ]);
    expect(errorOf(await showToOthers("skill", own.id))).toEqual([409, "catalog.not_shareable"]);
    const widen = await root({
      method: "POST",
      url: `/api/v1/admin/components/skill/${own.id}/scope/preview`,
      payload: { scope: "named", orgs: [orgA, orgB] },
    });
    expect(widen.statusCode, widen.body).toBe(200);
    const put = await root({
      method: "PUT",
      url: `/api/v1/admin/components/skill/${own.id}/scope`,
      payload: { scope: "named", orgs: [orgA, orgB], scopeHash: widen.json().scopeHash },
    });
    expect(errorOf(put)).toEqual([409, "catalog.not_shareable"]);
    expect(await db.selectFrom("platform_skills").select("id").execute()).toEqual([]);
    expect(
      (
        await db
          .selectFrom("skills")
          .select("platform_skill_id")
          .where("id", "=", own.id)
          .executeTakeFirstOrThrow()
      ).platform_skill_id,
    ).toBeNull();
  });

  it("promotion keeps ids and versions", async () => {
    const r = await promotedReport();
    expect(r.platformId).not.toBe(r.id);
    const p = await db
      .selectFrom("platform_skills")
      .selectAll()
      .where("id", "=", r.platformId)
      .executeTakeFirstOrThrow();
    expect(p).toMatchObject({
      name: "report",
      current_version: 3,
      owner_org_id: orgA,
      origin_org_id: orgA,
      shareable: true,
      shown_to_others: false,
      scope_mode: "own",
      scope: "named",
      catalog_item_id: null,
    });
    const listed = await db
      .selectFrom("component_scope_orgs")
      .select("org_id")
      .where("component_id", "=", r.platformId)
      .orderBy("org_id")
      .execute();
    expect(listed.map((x) => x.org_id)).toEqual([orgA, orgB].sort());
    const versions = await db
      .selectFrom("platform_skill_versions")
      .select(["version", "object_prefix"])
      .where("skill_id", "=", r.platformId)
      .execute();
    // a fresh prefix per prepared version (ruling P3-45)
    expect(versions).toEqual([
      {
        version: 3,
        object_prefix: expect.stringMatching(
          new RegExp(`^platform/skills/${r.platformId}/3-[0-9a-f-]{36}/$`),
        ),
      },
    ]);
    const copied = await k.app
      .get(StorageService)
      .deployment()
      .get(`${versions[0]?.object_prefix}SKILL.md`);
    expect(copied).not.toBeNull();
    expect(await new Response(copied?.body).text()).toContain("Report v3.");
    const row = await db
      .selectFrom("skills")
      .select(["platform_skill_id", "pinned_version", "current_version"])
      .where("id", "=", r.id)
      .executeTakeFirstOrThrow();
    expect(row).toEqual({
      platform_skill_id: r.platformId,
      pinned_version: null,
      current_version: 3,
    });

    // agent X: same id, version, source and pinned body; no new snapshot, so no notice
    const before = await catalogs(r.convX);
    expect(before).toHaveLength(1);
    await say(orgA, r.convX, 2);
    const after = await catalogs(r.convX);
    expect(after).toHaveLength(1);
    expect(after[0]?.payload.skills).toEqual([
      expect.objectContaining({ id: r.id, version: 3, source: r.prefix }),
    ]);
    expect(after[0]?.payload.pinned).toEqual([
      expect.objectContaining({ id: r.id, version: 3, source: r.prefix, body: "Report v3." }),
    ]);
    expect(JSON.stringify(await eventsOf(db, r.convX))).not.toContain("Updated skills");

    // org B's agent selects the platform id and loads the same body
    const agentB = await agentWith(orgB, [r.platformId]);
    const convB = await createConv(root, orgB, agentB);
    const loaded = await call(orgB, convB, "Skill", { skill: "report" }, 1);
    expect(loaded.isError, loaded.content).toBe(false);
    expect(loaded.content).toContain("Report v3.");

    // org A's usable set has the skill once, under the org row's id
    const inA = (await usableSkills(db, orgA)).filter((s) => s.name === "report");
    expect(inA.map((s) => [s.id, s.origin, s.version])).toEqual([[r.id, "org", 3]]);
    const lib = await root({ method: "GET", url: `/api/v1/orgs/${orgA}/skills` });
    expect(
      (lib.json().skills as { id: string; origin: string; shareable: boolean }[]).map((s) => [
        s.id,
        s.origin,
        s.shareable,
      ]),
    ).toEqual([[r.id, "org", true]]);

    // the admin list shows the platform row once (promoted), not the org row
    const admin = await root({ method: "GET", url: "/api/v1/admin/components?kind=skill" });
    expect(
      (admin.json().components as { id: string; promoted: boolean }[]).map((c) => [
        c.id,
        c.promoted,
      ]),
    ).toEqual([[r.platformId, true]]);

    // promoting again is a no-op returning the same platform id
    const again = await showToOthers("skill", r.id);
    expect(again.statusCode, again.body).toBe(200);
    expect(again.json().id).toBe(r.platformId);
    expect(await db.selectFrom("platform_skills").select("id").execute()).toHaveLength(1);

    // turning 可共享 off writes both rows
    expect((await setShareable(orgA, "skills", r.id, false)).statusCode).toBe(200);
    const both = await db
      .selectFrom("platform_skills")
      .select("shareable")
      .where("id", "=", r.platformId)
      .executeTakeFirstOrThrow();
    expect(both.shareable).toBe(false);
  });

  it("owner updates reach both", async () => {
    const r = await promotedReport();
    const agentB = await agentWith(orgB, [r.platformId]);
    const convB = await createConv(root, orgB, agentB);
    await say(orgB, convB, 1);

    // org A uploads `report` again (zip)
    const zip = makeZip([{ name: "SKILL.md", data: skillMd("report", "Report v4.") }]);
    const reg = await root({
      method: "POST",
      url: `/api/v1/orgs/${orgA}/skills/uploads`,
      payload: { name: "report.zip", size: zip.byteLength },
    });
    expect(reg.statusCode, reg.body).toBe(201);
    const c = reg.json() as {
      id: string;
      upload: {
        method: string;
        url: string;
        headers: Record<string, string>;
        fields?: Record<string, string>;
      };
    };
    if (c.upload.method === "PUT") {
      await fetch(c.upload.url, {
        method: "PUT",
        headers: c.upload.headers,
        body: new Uint8Array(zip),
      });
    } else {
      const form = new FormData();
      for (const [key, v] of Object.entries(c.upload.fields ?? {})) form.append(key, v);
      form.append("file", new Blob([new Uint8Array(zip)], { type: "application/zip" }));
      await fetch(c.upload.url, { method: "POST", headers: c.upload.headers, body: form });
    }
    const up = await root({
      method: "POST",
      url: `/api/v1/orgs/${orgA}/skills`,
      payload: { uploadId: c.id },
    });
    expect(up.statusCode, up.body).toBe(201);
    expect(up.json()).toMatchObject({ version: 4, created: false, skill: { id: r.id } });

    const p = await db
      .selectFrom("platform_skills")
      .select("current_version")
      .where("id", "=", r.platformId)
      .executeTakeFirstOrThrow();
    expect(p.current_version).toBe(4);
    const row = await db
      .selectFrom("skills")
      .select(["pinned_version", "platform_skill_id"])
      .where("id", "=", r.id)
      .executeTakeFirstOrThrow();
    expect(row).toEqual({ pinned_version: null, platform_skill_id: r.platformId });

    // agent X sees version 4 under the org row's id; org B's agent too, under the platform id
    await say(orgA, r.convX, 2);
    expect((await catalogs(r.convX)).at(-1)?.payload.skills).toEqual([
      expect.objectContaining({
        id: r.id,
        version: 4,
        source: expect.stringMatching(
          new RegExp(`^platform:platform/skills/${r.platformId}/4-[0-9a-f-]{36}/$`),
        ),
      }),
    ]);
    await say(orgB, convB, 2);
    expect((await catalogs(convB)).at(-1)?.payload.skills).toEqual([
      expect.objectContaining({ id: r.platformId, version: 4 }),
    ]);
    const loaded = await call(orgB, convB, "Skill", { skill: "report" }, 3);
    expect(loaded.content).toContain("Report v4.");

    // org B is told; the owner is not
    const notices = await db
      .selectFrom("org_notices")
      .select(["org_id", "kind", "detail"])
      .where("kind", "=", "shared_item_updated")
      .execute();
    expect(notices).toEqual([
      expect.objectContaining({
        org_id: orgB,
        detail: expect.objectContaining({
          ref: { kind: "skill", id: r.platformId },
          from: "3",
          to: "4",
        }),
      }),
    ]);
    // the owner's library shows the new version under the org row's id
    const detail = await root({ method: "GET", url: `/api/v1/orgs/${orgA}/skills/${r.id}` });
    expect(detail.statusCode, detail.body).toBe(200);
    expect(detail.json()).toMatchObject({ id: r.id, currentVersion: 4, body: "Report v4." });
  });

  it("two orgs share one name", async () => {
    const a = await seedOrgSkill(orgA, "report", ["Report A."]);
    const b = await seedOrgSkill(orgB, "report", ["Report B."]);
    await setShareable(orgA, "skills", a.id);
    await setShareable(orgB, "skills", b.id);
    const pa = await showToOthers("skill", a.id);
    expect(pa.statusCode, pa.body).toBe(200);
    const pb = await showToOthers("skill", b.id);
    expect(pb.statusCode, pb.body).toBe(200);
    expect(pa.json().id).not.toBe(pb.json().id);
    expect(await db.selectFrom("platform_skills").select("id").execute()).toHaveLength(2);

    // associating org B's with org A would put two `report`s in A (rule 10)
    const preview = await root({
      method: "POST",
      url: `/api/v1/admin/components/skill/${pb.json().id}/scope/preview`,
      payload: { scope: "named", orgs: [orgA, orgB] },
    });
    expect(preview.statusCode, preview.body).toBe(200);
    expect(preview.json().conflicts).toEqual([expect.objectContaining({ orgId: orgA })]);
    const put = await root({
      method: "PUT",
      url: `/api/v1/admin/components/skill/${pb.json().id}/scope`,
      payload: { scope: "named", orgs: [orgA, orgB], scopeHash: preview.json().scopeHash },
    });
    expect(errorOf(put)).toEqual([409, "plugin.skill_conflict"]);
  });

  it("owner deletes a shared skill", async () => {
    const r = await promotedReport();
    const agentB = await agentWith(orgB, [r.platformId]);

    const preview = await root({
      method: "GET",
      url: `/api/v1/orgs/${orgA}/skills/${r.id}/delete-preview`,
    });
    expect(preview.statusCode, preview.body).toBe(200);
    expect(preview.json()).toEqual({
      outcome: "transferred",
      orgs: [{ id: orgB, name: "B" }],
      agents: [{ id: r.agentX, name: "Skilled" }],
    });

    const del = await root({ method: "DELETE", url: `/api/v1/orgs/${orgA}/skills/${r.id}` });
    expect(del.statusCode, del.body).toBe(204);
    const p = await db
      .selectFrom("platform_skills")
      .select(["owner_org_id", "deleted_at"])
      .where("id", "=", r.platformId)
      .executeTakeFirstOrThrow();
    expect(p).toEqual({ owner_org_id: null, deleted_at: null });
    const listed = await db
      .selectFrom("component_scope_orgs")
      .select("org_id")
      .where("component_id", "=", r.platformId)
      .execute();
    expect(listed.map((x) => x.org_id)).toEqual([orgB]);
    const notices = await db.selectFrom("platform_notices").select(["kind", "detail"]).execute();
    expect(notices).toEqual([
      {
        kind: "ownership_transferred",
        detail: expect.objectContaining({
          ref: { kind: "skill", id: r.platformId },
          reason: "owner_deleted",
        }),
      },
    ]);
    const own = await db
      .selectFrom("skills")
      .select("deleted_at")
      .where("id", "=", r.id)
      .executeTakeFirstOrThrow();
    expect(own.deleted_at).not.toBeNull();
    expect((await usableSkills(db, orgB)).map((s) => s.id)).toEqual([r.platformId]);
    const convB = await createConv(root, orgB, agentB);
    const loaded = await call(orgB, convB, "Skill", { skill: "report" }, 1);
    expect(loaded.content).toContain("Report v3.");

    // an unshared one is removed
    const lone = await seedOrgSkill(orgA, "lone", ["Lone."]);
    await setShareable(orgA, "skills", lone.id);
    const shown = await showToOthers("skill", lone.id);
    expect(shown.statusCode, shown.body).toBe(200);
    const lp = await root({
      method: "GET",
      url: `/api/v1/orgs/${orgA}/skills/${lone.id}/delete-preview`,
    });
    expect(lp.json()).toEqual({ outcome: "removed", orgs: [], agents: [] });
    expect(
      (await root({ method: "DELETE", url: `/api/v1/orgs/${orgA}/skills/${lone.id}` })).statusCode,
    ).toBe(204);
    const gone = await db
      .selectFrom("platform_skills")
      .select("deleted_at")
      .where("id", "=", shown.json().id)
      .executeTakeFirstOrThrow();
    expect(gone.deleted_at).not.toBeNull();
  });

  it("agent templates", async () => {
    const tplId = randomUUID();
    await db
      .insertInto("agent_templates")
      .values({ id: tplId, org_id: orgA, name: "reviewer", plugin_name: "crm", current_version: 1 })
      .execute();
    await db
      .insertInto("agent_template_versions")
      .values({
        template_id: tplId,
        version: 1,
        definition: JSON.stringify({
          name: "reviewer",
          description: "Reviews work.",
          instructions: "Review O1.",
        }),
        source_format: "capybara",
      })
      .execute();
    const lead = await root({
      method: "POST",
      url: `/api/v1/orgs/${orgA}/agents`,
      payload: {
        definition: {
          name: "Lead",
          instructions: "Lead the work.",
          model: { provider: "model-fake", model: "fake-1" },
          tools: [{ kind: "builtin", name: "Agent" }],
          subagents: { templates: [tplId] },
        },
        visibility: "org",
      },
    });
    expect(lead.statusCode, lead.body).toBe(201);
    const leadId = lead.json().agent.id as string;
    const conv = await createConv(root, orgA, leadId);
    await postMessage(
      root,
      orgA,
      conv,
      `tool:Agent:${JSON.stringify({ description: "Review", prompt: "echo:first", subagent_type: "crm:reviewer" })}`,
    );
    await waitForTerminal(db, conv, 1, 30_000);
    const dispatched = (await eventsOf(db, conv)).find(
      (e) => e.type === "subagent_dispatched",
    ) as Extract<ConversationEvent, { type: "subagent_dispatched" }>;
    const childId = dispatched.payload.subagentId as string;
    const started = (await eventsOf(db, childId)).find((e) => e.type === "subagent_started") as
      | Extract<ConversationEvent, { type: "subagent_started" }>
      | undefined;
    const recorded = { source: "plugin", id: tplId, version: 1, plugin: "crm" };
    expect(started?.payload.template).toEqual(recorded);

    // every agent template is a plugin's in phase 3: not shareable, not promotable (ruling P3-46)
    expect(errorOf(await setShareable(orgA, "agent-templates", tplId))).toEqual([
      409,
      "catalog.not_owned",
    ]);
    expect(errorOf(await showToOthers("agent_template", tplId))).toEqual([
      409,
      "catalog.not_owned",
    ]);
    // the promotion branch kept for phase 4, at service level
    await db
      .updateTable("agent_templates")
      .set({ shareable: true })
      .where("id", "=", tplId)
      .execute();
    const promotion = k.app.get(ComponentPromotion);
    const prepared = await promotion.prepare("agent_template", tplId);
    const pid = await promotion.txHost.run(() => promotion.promote(prepared, rootId));
    expect(pid).not.toBe(tplId);
    expect(
      await db
        .selectFrom("platform_agent_templates")
        .select(["current_version", "owner_org_id", "plugin_name", "shown_to_others"])
        .where("id", "=", pid)
        .executeTakeFirstOrThrow(),
    ).toEqual({
      current_version: 1,
      owner_org_id: orgA,
      plugin_name: "crm",
      shown_to_others: false,
    });
    expect(
      (
        await db
          .selectFrom("agent_templates")
          .select("platform_template_id")
          .where("id", "=", tplId)
          .executeTakeFirstOrThrow()
      ).platform_template_id,
    ).toBe(pid);

    // the running child resumes by the recorded id
    capture.reset();
    await postMessage(
      root,
      orgA,
      conv,
      // a follow-up is a SendMessage to the sub-agent (agent map spec §4.2)
      `tool:SendMessage:${JSON.stringify({ to: childId, message: "echo:again" })}`,
    );
    await waitForTerminal(db, conv, 2, 30_000);
    const req = await waitFor(
      async () =>
        capture.sent.find((x) => {
          const last = x.messages.at(-1);
          return (
            last?.role === "user" &&
            JSON.stringify(last.content).includes("echo:again") &&
            !JSON.stringify(last.content).includes("tool:Agent") &&
            !JSON.stringify(last.content).includes("tool:SendMessage")
          );
        }),
      10_000,
      "the resumed child's request",
    );
    expect(req.system.map((s) => s.text).join("\n")).toContain("Review O1.");
    // a new dispatch records the same template reference as before the promotion
    await postMessage(
      root,
      orgA,
      conv,
      `tool:Agent:${JSON.stringify({ description: "New", prompt: "echo:new", subagent_type: "crm:reviewer" })}`,
    );
    await waitForTerminal(db, conv, 3, 30_000);
    const all = (await eventsOf(db, conv)).filter(
      (e) => e.type === "subagent_dispatched",
    ) as Extract<ConversationEvent, { type: "subagent_dispatched" }>[];
    const second = all.at(-1)?.payload.subagentId as string;
    expect(second).not.toBe(childId);
    const started2 = (await eventsOf(db, second)).find((e) => e.type === "subagent_started") as
      | Extract<ConversationEvent, { type: "subagent_started" }>
      | undefined;
    expect(started2?.payload.template).toEqual(recorded);

    // the org's template list shows it once, under the org row's id
    const list = await root({ method: "GET", url: `/api/v1/orgs/${orgA}/agent-templates` });
    expect(
      (list.json().templates as { id: string; origin: string }[]).map((t) => [t.id, t.origin]),
    ).toEqual([[tplId, "org"]]);
  });
  it("plugin content is not the org's own (ruling P3-46)", async () => {
    const item = randomUUID();
    await db
      .insertInto("catalog_items")
      .values({
        id: item,
        name: "kit",
        package_name: "@acme/plugin-kit",
        publisher: "Acme",
        description: "d",
        latest_version: "1.0.0",
        policy: "allow",
      })
      .execute();
    const copy = await seedOrgSkill(orgA, "from-kit", ["From kit."]);
    await db
      .updateTable("skills")
      .set({ catalog_item_id: item, catalog_version: "1.0.0", shareable: true })
      .where("id", "=", copy.id)
      .execute();
    expect(errorOf(await setShareable(orgA, "skills", copy.id))).toEqual([
      409,
      "catalog.not_owned",
    ]);
    expect(errorOf(await showToOthers("skill", copy.id))).toEqual([409, "catalog.not_owned"]);
    const preview = await root({
      method: "POST",
      url: `/api/v1/admin/components/skill/${copy.id}/scope/preview`,
      payload: { scope: "named", orgs: [orgA, orgB] },
    });
    const put = await root({
      method: "PUT",
      url: `/api/v1/admin/components/skill/${copy.id}/scope`,
      payload: { scope: "named", orgs: [orgA, orgB], scopeHash: preview.json().scopeHash },
    });
    expect(errorOf(put)).toEqual([409, "catalog.not_owned"]);
    expect(await db.selectFrom("platform_skills").select("id").execute()).toEqual([]);
  });

  it("a legacy uninstall never touches a promoted row (ruling P3-47)", async () => {
    const r = await promotedReport();
    const installer = k.app.get(PluginInstaller);
    const removed = await installer.txHost.run(() =>
      installer.removeComponent(
        orgA,
        rootId,
        { kind: "skill", ref: r.id, created: true, skillVersion: null },
        "plugin_install_cleanup",
      ),
    );
    expect(removed).toBe(false);
    const row = await db
      .selectFrom("skills")
      .select(["deleted_at", "current_version", "platform_skill_id"])
      .where("id", "=", r.id)
      .executeTakeFirstOrThrow();
    expect(row).toEqual({ deleted_at: null, current_version: 3, platform_skill_id: r.platformId });
  });

  it("an org's own plugin's copies are still removed by its uninstall (ruling P3-47)", async () => {
    // an org-uploaded plugin's skill: a platform row owned by the org but from a plugin, with the
    // org's install copy linked to it (as the platform migration links copies)
    const item = randomUUID();
    await db
      .insertInto("catalog_items")
      .values({
        id: item,
        name: "own-kit",
        package_name: "@acme/plugin-own-kit",
        publisher: "Acme",
        description: "d",
        latest_version: "1.0.0",
        policy: "allow",
        owner_org_id: orgA,
      })
      .execute();
    const pid = randomUUID();
    await db
      .insertInto("platform_skills")
      .values({
        id: pid,
        catalog_item_id: item,
        plugin_name: "own-kit",
        name: "kit-notes",
        description: "d",
        current_version: 1,
        owner_org_id: orgA,
        origin_org_id: orgA,
      })
      .execute();
    const copy = await seedOrgSkill(orgA, "kit-notes", ["Kit notes."]);
    await db
      .updateTable("skills")
      .set({ platform_skill_id: pid, catalog_item_id: item, catalog_version: "1.0.0" })
      .where("id", "=", copy.id)
      .execute();
    const installer = k.app.get(PluginInstaller);
    const removed = await installer.txHost.run(() =>
      installer.removeComponent(
        orgA,
        rootId,
        { kind: "skill", ref: copy.id, created: true, skillVersion: null },
        "plugin_install_cleanup",
      ),
    );
    expect(removed).toBe(true);
    const row = await db
      .selectFrom("skills")
      .select("deleted_at")
      .where("id", "=", copy.id)
      .executeTakeFirstOrThrow();
    expect(row.deleted_at).not.toBeNull();
  });

  it("the super admin cannot upload a version of an org's promoted skill (ruling P3-48)", async () => {
    const r = await promotedReport();
    const zip = makeZip([{ name: "SKILL.md", data: skillMd("report", "Admin v4.") }]);
    const res = await root({
      method: "POST",
      url: `/api/v1/admin/components/skill/${r.platformId}/versions`,
      headers: { "content-type": "application/octet-stream" },
      payload: zip,
    });
    expect(errorOf(res)).toEqual([409, "catalog.not_owned"]);
    const p = await db
      .selectFrom("platform_skills")
      .select("current_version")
      .where("id", "=", r.platformId)
      .executeTakeFirstOrThrow();
    expect(p.current_version).toBe(3);
  });

  it("two racing owner versions never overwrite committed files (ruling P3-45)", async () => {
    const r = await promotedReport();
    const skills = k.app.get(SkillsService);
    const pkg = (body: string) => {
      const data = new TextEncoder().encode(skillMd("report", body));
      return {
        name: "report",
        description: "Use for report work.",
        files: [{ path: "SKILL.md", size: data.byteLength, sha256: sha(data), data }],
      };
    };
    const results = await Promise.allSettled([
      skills.createVersionFromFiles(orgA, rootId, pkg("Racer one.")),
      skills.createVersionFromFiles(orgA, rootId, pkg("Racer two, longer.")),
    ]);
    expect(results.some((x) => x.status === "fulfilled")).toBe(true);
    const p = await db
      .selectFrom("platform_skills as p")
      .innerJoin("platform_skill_versions as v", (j) =>
        j.onRef("v.skill_id", "=", "p.id").onRef("v.version", "=", "p.current_version"),
      )
      .select(["v.manifest", "v.object_prefix", "p.current_version"])
      .where("p.id", "=", r.platformId)
      .executeTakeFirstOrThrow();
    expect(p.current_version).toBeGreaterThanOrEqual(4);
    const store = k.app.get(StorageService).deployment();
    for (const f of p.manifest.files) {
      const got = await store.get(`${p.object_prefix}${f.path}`);
      expect(got).not.toBeNull();
      const data = new Uint8Array(await new Response(got?.body).arrayBuffer());
      expect(sha(data)).toBe(f.sha256);
    }
    // a loser's objects are deleted (best effort)
    const listed = await store.list(`platform/skills/${r.platformId}/4`);
    const prefixes = new Set(listed.items.map((o) => o.key.split("/").slice(0, 4).join("/")));
    expect(prefixes.size).toBe(1);
  });
});
