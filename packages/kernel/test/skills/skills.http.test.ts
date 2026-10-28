import { createHash } from "node:crypto";
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
import { MAX_PENDING_SKILL_PACKAGES } from "../../src/conversations/attachments.service.js";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { AccountsService } from "../../src/identity/accounts.js";
import type { Kernel } from "../../src/kernel.js";
import { truncateTables } from "../helpers/db.js";
import { testMembers } from "../helpers/members.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import {
  createAgent,
  createConv,
  createOrg,
  PW,
  type Req,
  runConfig,
  session,
  startKernel,
} from "../helpers/runs.js";
import { makeZip, SKILL_MD } from "./zip.js";

const OBJECT_STORE = fakeExtensionEntry("fake-object-store");

let pgc: TestContainer;
let rd: TestContainer;
let s3: TestS3;
let db: KernelSchemaDb;
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

let admin: Req;
let member: Req;
let adminId: string;
let orgId: string;

beforeEach(async () => {
  await truncateTables(
    db,
    "capybara.skill_versions, capybara.skills, capybara.attachments, capybara.conversation_events, capybara.runs, capybara.conversations, capybara.agent_versions, capybara.agent_members, capybara.agents, capybara.audit_events, capybara.memberships, capybara.orgs, capybara.sessions, capybara.local_passwords, capybara.identities, capybara.accounts",
  );
  const accounts = new AccountsService(db);
  adminId = (await accounts.createLocal({ login: "admin", password: PW, displayName: "A" })).id;
  const memberId = (await accounts.createLocal({ login: "mem", password: PW, displayName: "M" }))
    .id;
  admin = await session(k, "admin");
  orgId = await createOrg(admin);
  await testMembers(db).add(orgId, memberId, "member", adminId);
  member = await session(k, "mem");
});

interface Created {
  id: string;
  upload: {
    method: "PUT" | "POST";
    url: string;
    headers: Record<string, string>;
    fields?: Record<string, string>;
  };
}

const sha = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");

async function putToStore(c: Created, bytes: Uint8Array, contentType: string): Promise<void> {
  let res: Response;
  if (c.upload.method === "PUT") {
    res = await fetch(c.upload.url, {
      method: "PUT",
      headers: c.upload.headers,
      body: Buffer.from(bytes),
    });
  } else {
    const form = new FormData();
    for (const [key, v] of Object.entries(c.upload.fields ?? {})) form.append(key, v);
    form.append("file", new Blob([Buffer.from(bytes)], { type: contentType }));
    res = await fetch(c.upload.url, { method: "POST", headers: c.upload.headers, body: form });
  }
  expect(res.status, await res.clone().text()).toBeLessThan(300);
}

/** 登记并直传一个技能包，返回上传 id（不 finalize：由 POST /skills 代为完成）。 */
async function uploadZip(req: Req, zip: Uint8Array, name = "skill.zip"): Promise<string> {
  const res = await req({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/skills/uploads`,
    payload: { name, size: zip.byteLength },
  });
  expect(res.statusCode, res.body).toBe(201);
  const c = res.json() as Created;
  await putToStore(c, zip, "application/zip");
  return c.id;
}

const createSkill = (req: Req, uploadId: string) =>
  req({ method: "POST", url: `/api/v1/orgs/${orgId}/skills`, payload: { uploadId } });

const zipOf = (name: string, extra: Record<string, string> = {}, description?: string) =>
  makeZip([
    { name: "SKILL.md", data: SKILL_MD(name, description) },
    ...Object.entries(extra).map(([n, data]) => ({ name: n, data })),
  ]);

interface Uploaded {
  skill: { id: string; name: string; description: string; currentVersion: number };
  version: number;
  created: boolean;
}

describe("上传技能包", { timeout: 60_000 }, () => {
  it("新技能 → 版本 1；对象写在 kernel/<orgId>/skills/<uploadId>/；同名再传 → 版本 2", async () => {
    const zip1 = zipOf("pdf-tools", { "scripts/run.py": "print(1)\n" });
    const up1 = await uploadZip(admin, zip1);
    const r1 = await createSkill(admin, up1);
    expect(r1.statusCode, r1.body).toBe(201);
    const b1 = r1.json() as Uploaded;
    expect(b1).toMatchObject({
      created: true,
      version: 1,
      skill: { name: "pdf-tools", description: "Work with PDFs.", currentVersion: 1 },
    });

    const v1 = await db
      .selectFrom("skill_versions")
      .selectAll()
      .where("skill_id", "=", b1.skill.id)
      .executeTakeFirstOrThrow();
    expect(v1.object_prefix).toBe(`skills/${up1}/`);
    const md = SKILL_MD("pdf-tools");
    expect(v1.manifest).toEqual({
      name: "pdf-tools",
      description: "Work with PDFs.",
      files: [
        { path: "SKILL.md", size: md.length, sha256: sha(md) },
        { path: "scripts/run.py", size: 9, sha256: sha("print(1)\n") },
      ],
    });
    const store = k.storage.kernel(orgId);
    const obj = await store.get(`skills/${up1}/scripts/run.py`);
    expect(obj && Buffer.from(await new Response(obj.body).arrayBuffer()).toString()).toBe(
      "print(1)\n",
    );

    const up2 = await uploadZip(admin, zipOf("pdf-tools", {}, "Better PDFs."));
    const r2 = await createSkill(admin, up2);
    expect(r2.statusCode, r2.body).toBe(201);
    expect(r2.json()).toMatchObject({
      created: false,
      version: 2,
      skill: { id: b1.skill.id, description: "Better PDFs.", currentVersion: 2 },
    });

    const list = await member({ method: "GET", url: `/api/v1/orgs/${orgId}/skills` });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toMatchObject({
      skills: [{ id: b1.skill.id, name: "pdf-tools", currentVersion: 2, scope: "org" }],
    });
    const detail = await member({
      method: "GET",
      url: `/api/v1/orgs/${orgId}/skills/${b1.skill.id}`,
    });
    expect(detail.statusCode).toBe(200);
    const d = detail.json() as { versions: { version: number; files: { path: string }[] }[] };
    expect(d.versions.map((v) => v.version)).toEqual([2, 1]);
    expect(d.versions[1]?.files.map((f) => f.path)).toEqual(["SKILL.md", "scripts/run.py"]);
    // 当前版本 SKILL.md 的正文（去掉 frontmatter，网页按纯文本显示）
    expect((detail.json() as { body: string | null }).body).toBe("# pdf-tools\n\nSteps.\n");

    const audits = await db
      .selectFrom("audit_events")
      .select("action")
      .where("org_id", "=", orgId)
      .where("action", "like", "skill.%")
      .orderBy("id")
      .execute();
    expect(audits.map((a) => a.action)).toEqual(["skill.created", "skill.version_created"]);
  });

  it("同一上传重试（响应丢失）返回同一个版本、不新增；技能包上传不能当附件发出或下载", async () => {
    const up = await uploadZip(admin, zipOf("once"));
    const first = await createSkill(admin, up);
    expect(first.statusCode).toBe(201);
    const again = await createSkill(admin, up);
    expect(again.statusCode).toBe(201);
    expect(again.json()).toEqual(first.json());
    expect(await db.selectFrom("skill_versions").select("version").execute()).toHaveLength(1);
    // 别的管理员拿同一 id 不行（上传只认上传者）
    const adm2 = (
      await new AccountsService(db).createLocal({ login: "adm2", password: PW, displayName: "B" })
    ).id;
    await testMembers(db).add(orgId, adm2, "admin", adminId);
    const other = await createSkill(await session(k, "adm2"), up);
    expect(other.statusCode).toBe(404);
    expect(other.json().error.code).toBe("attachment.not_found");

    const pending = await uploadZip(admin, zipOf("other"));
    await admin({ method: "POST", url: `/api/v1/orgs/${orgId}/attachments/${pending}/finalize` });
    const agentId = await createAgent(admin, orgId);
    const convId = await createConv(admin, orgId, agentId);
    const msg = await admin({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/conversations/${convId}/messages`,
      payload: { text: "hi", files: [pending] },
    });
    expect(msg.statusCode).toBe(404);
    expect(msg.json().error.code).toBe("attachment.not_found");
    const dl = await admin({
      method: "GET",
      url: `/api/v1/orgs/${orgId}/attachments/${pending}/download`,
    });
    expect(dl.statusCode).toBe(404);
  });

  it("并发上传同名的两个包：版本号 1 与 2，不重复", async () => {
    const a = await uploadZip(admin, zipOf("race", { "a.txt": "a" }));
    const b = await uploadZip(admin, zipOf("race", { "b.txt": "b" }));
    const [ra, rb] = await Promise.all([createSkill(admin, a), createSkill(admin, b)]);
    expect([ra.statusCode, rb.statusCode]).toEqual([201, 201]);
    const versions = [ra, rb].map((r) => (r.json() as Uploaded).version).sort();
    expect(versions).toEqual([1, 2]);
    expect(new Set([ra, rb].map((r) => (r.json() as Uploaded).skill.id)).size).toBe(1);
  });

  it("包不合法 → 400 skill.invalid_package，不产生技能", async () => {
    const up = await uploadZip(admin, makeZip([{ name: "../evil", data: "x" }]));
    const r = await createSkill(admin, up);
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe("skill.invalid_package");
    const missing = await uploadZip(admin, makeZip([{ name: "README.md", data: "x" }]));
    const r2 = await createSkill(admin, missing);
    expect(r2.statusCode).toBe(400);
    expect(JSON.stringify(r2.json())).toContain("SKILL.md is required");
    expect(await db.selectFrom("skills").selectAll().execute()).toEqual([]);
  });

  it("内容不是 zip → finalize 时 415 attachment.type_not_allowed", async () => {
    const up = await uploadZip(admin, Buffer.from("definitely not a zip"));
    const r = await createSkill(admin, up);
    expect(r.statusCode).toBe(415);
    expect(r.json().error.code).toBe("attachment.type_not_allowed");
  });

  it("技能包上传有自己的待完成上限，不占对话附件的额度；大小上限 50MB", async () => {
    for (let i = 0; i < MAX_PENDING_SKILL_PACKAGES; i++) {
      const r = await admin({
        method: "POST",
        url: `/api/v1/orgs/${orgId}/skills/uploads`,
        payload: { name: `s${i}.zip`, size: 10 },
      });
      expect(r.statusCode).toBe(201);
    }
    const over = await admin({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/skills/uploads`,
      payload: { name: "x.zip", size: 10 },
    });
    expect(over.statusCode).toBe(429);
    expect(over.json().error.code).toBe("attachment.too_many_pending");
    const chat = await admin({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/attachments`,
      payload: { name: "a.txt", contentType: "text/plain", size: 3 },
    });
    expect(chat.statusCode).toBe(201);
    const big = await admin({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/skills/uploads`,
      payload: { name: "big.zip", size: 50 * 1024 * 1024 + 1 },
    });
    expect(big.statusCode).toBe(400);
    // 对话附件接口不接受 zip
    const zipChat = await admin({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/attachments`,
      payload: { name: "a.zip", contentType: "application/zip", size: 3 },
    });
    expect(zipChat.statusCode).toBe(415);
  });
});

describe("权限", { timeout: 30_000 }, () => {
  it("非 admin 上传 / 创建 / 删除组织技能 → 403；成员可读；未登录 401", async () => {
    const r = await member({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/skills/uploads`,
      payload: { name: "s.zip", size: 10 },
    });
    expect(r.statusCode).toBe(403);
    expect(r.json().error.code).toBe("forbidden");

    const up = await uploadZip(admin, zipOf("guarded"));
    const c = await createSkill(member, up);
    expect(c.statusCode).toBe(403);
    expect(c.json().error.code).toBe("forbidden");
    const ok = await createSkill(admin, up);
    const id = (ok.json() as Uploaded).skill.id;
    const del = await member({ method: "DELETE", url: `/api/v1/orgs/${orgId}/skills/${id}` });
    expect(del.statusCode).toBe(403);
    expect((await member({ method: "GET", url: `/api/v1/orgs/${orgId}/skills` })).statusCode).toBe(
      200,
    );
    const anon = await k.http.inject({ method: "GET", url: `/api/v1/orgs/${orgId}/skills` });
    expect(anon.statusCode).toBe(401);
  });

  it("服务令牌（即使 admin 角色）访问技能接口一律 403", async () => {
    const t = await admin({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/service-tokens`,
      payload: { name: "ci", role: "admin" },
    });
    expect(t.statusCode, t.body).toBe(201);
    const headers = { authorization: `Bearer ${(t.json() as { token: string }).token}` };
    const base = `/api/v1/orgs/${orgId}/skills`;
    for (const [method, url, payload] of [
      ["GET", base, undefined],
      ["GET", `${base}/x`, undefined],
      ["POST", `${base}/uploads`, { name: "s.zip", size: 10 }],
      ["POST", base, { uploadId: "x" }],
      ["DELETE", `${base}/x`, undefined],
    ] as const) {
      const r = await k.http.inject({
        method,
        url,
        headers,
        ...(payload !== undefined && { payload }),
      });
      expect(r.statusCode, `${method} ${url}`).toBe(403);
      expect(r.json().error.code).toBe("forbidden");
    }
  });
});

describe("删除与 agent 引用", { timeout: 60_000 }, () => {
  async function skill(name: string): Promise<string> {
    const r = await createSkill(admin, await uploadZip(admin, zipOf(name)));
    expect(r.statusCode, r.body).toBe(201);
    return (r.json() as Uploaded).skill.id;
  }

  const agentBody = (orgSkills: string[]) => ({
    definition: {
      name: "Helper",
      model: { provider: "model-fake", model: "fake-1" },
      tools: [],
      skills: { orgSkills },
    },
    visibility: "org",
  });

  it("agent 定义引用组织技能：保存时校验存在且未删除，作为新版本保存", async () => {
    const s1 = await skill("one");
    const s2 = await skill("two");
    const created = await admin({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/agents`,
      payload: agentBody([s1]),
    });
    expect(created.statusCode, created.body).toBe(201);
    const agent = created.json().agent as { id: string; currentVersion: number };
    expect(created.json().agent.definition.skills).toEqual({ orgSkills: [s1] });

    const upd = await admin({
      method: "PATCH",
      url: `/api/v1/orgs/${orgId}/agents/${agent.id}`,
      payload: { definition: agentBody([s1, s2]).definition },
    });
    expect(upd.statusCode, upd.body).toBe(200);
    expect(upd.json().agent.currentVersion).toBe(2);

    const unknown = await admin({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/agents`,
      payload: agentBody(["nope"]),
    });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json().error).toMatchObject({
      code: "validation_failed",
      details: [{ path: "skills.orgSkills.0" }],
    });
    const dup = await admin({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/agents`,
      payload: agentBody([s1, s1]),
    });
    expect(dup.statusCode).toBe(400);

    // 其他组织的技能不能引用
    const otherOrg = await createOrg(admin, "Other");
    const foreign = await admin({
      method: "POST",
      url: `/api/v1/orgs/${otherOrg}/agents`,
      payload: agentBody([s1]),
    });
    expect(foreign.statusCode).toBe(400);

    const del = await admin({ method: "DELETE", url: `/api/v1/orgs/${orgId}/skills/${s2}` });
    expect(del.statusCode).toBe(204);
    // 当前版本已引用的技能被删：只改提示词照常保存（运行时由 T14 忽略已删除的技能）
    const promptOnly = await admin({
      method: "PATCH",
      url: `/api/v1/orgs/${orgId}/agents/${agent.id}`,
      payload: { definition: { ...agentBody([s1, s2]).definition, instructions: "x" } },
    });
    expect(promptOnly.statusCode, promptOnly.body).toBe(200);
    expect(promptOnly.json().agent.currentVersion).toBe(3);
    // 新加一个已删除的技能仍被拒
    const s3 = await skill("three");
    await admin({ method: "DELETE", url: `/api/v1/orgs/${orgId}/skills/${s3}` });
    const addDeleted = await admin({
      method: "PATCH",
      url: `/api/v1/orgs/${orgId}/agents/${agent.id}`,
      payload: { definition: agentBody([s1, s2, s3]).definition },
    });
    expect(addDeleted.statusCode).toBe(400);
    expect(addDeleted.json().error.details).toEqual([
      expect.objectContaining({ path: "skills.orgSkills.2" }),
    ]);
    // 新加别的组织的技能也被拒
    const foreignSkill = await (async () => {
      const r = await admin({
        method: "POST",
        url: `/api/v1/orgs/${otherOrg}/skills/uploads`,
        payload: { name: "f.zip", size: zipOf("foreign").byteLength },
      });
      const c = r.json() as Created;
      await putToStore(c, zipOf("foreign"), "application/zip");
      const made = await admin({
        method: "POST",
        url: `/api/v1/orgs/${otherOrg}/skills`,
        payload: { uploadId: c.id },
      });
      expect(made.statusCode, made.body).toBe(201);
      return (made.json() as Uploaded).skill.id;
    })();
    const addForeign = await admin({
      method: "PATCH",
      url: `/api/v1/orgs/${orgId}/agents/${agent.id}`,
      payload: { definition: agentBody([s1, foreignSkill]).definition },
    });
    expect(addForeign.statusCode).toBe(400);
    // 新建 agent 时严格核对：引用已删除的技能被拒
    const createDeleted = await admin({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/agents`,
      payload: agentBody([s2]),
    });
    expect(createDeleted.statusCode).toBe(400);
  });

  it("软删除：详情 404、列表不再有；同名可重新上传为新技能", async () => {
    const id = await skill("gone");
    expect(
      (await admin({ method: "DELETE", url: `/api/v1/orgs/${orgId}/skills/${id}` })).statusCode,
    ).toBe(204);
    const again = await admin({ method: "DELETE", url: `/api/v1/orgs/${orgId}/skills/${id}` });
    expect(again.statusCode).toBe(404);
    expect(again.json().error.code).toBe("skill.not_found");
    const get = await admin({ method: "GET", url: `/api/v1/orgs/${orgId}/skills/${id}` });
    expect(get.statusCode).toBe(404);
    expect((await admin({ method: "GET", url: `/api/v1/orgs/${orgId}/skills` })).json()).toEqual({
      skills: [],
    });
    const row = await db.selectFrom("skills").select("deleted_at").where("id", "=", id).execute();
    expect(row[0]?.deleted_at).not.toBeNull();
    const r = await createSkill(admin, await uploadZip(admin, zipOf("gone")));
    expect(r.json()).toMatchObject({ created: true, version: 1 });
    expect((r.json() as Uploaded).skill.id).not.toBe(id);
  });

  it("scope=agent 的技能只按 agent 查到，不进组织技能库", async () => {
    const agentId = await createAgent(admin, orgId);
    await db
      .insertInto("skills")
      .values({
        id: "agent-skill-1",
        org_id: orgId,
        scope: "agent",
        agent_id: agentId,
        name: "mine",
        description: "d",
        current_version: 1,
        created_by: adminId,
      })
      .execute();
    expect(await k.skills.list(orgId)).toEqual([]);
    expect((await k.skills.listForAgent(orgId, agentId)).map((s) => s.name)).toEqual(["mine"]);

    // GET /agents/:agentId/skills：能看到该 agent 的人都能读；看不到的 agent → 404 agent.not_found
    const url = `/api/v1/orgs/${orgId}/agents/${agentId}/skills`;
    const own = await admin({ method: "GET", url });
    expect(own.statusCode, own.body).toBe(200);
    expect((own.json() as { skills: { name: string; scope: string }[] }).skills).toMatchObject([
      { name: "mine", scope: "agent" },
    ]);
    // 组织可见的 agent：成员能读
    const shared = await member({ method: "GET", url });
    expect(shared.statusCode, shared.body).toBe(200);
    expect((shared.json() as { skills: unknown[] }).skills).toHaveLength(1);
    // 改成私有：成员看不到
    const patched = await admin({
      method: "PATCH",
      url: `/api/v1/orgs/${orgId}/agents/${agentId}`,
      payload: { visibility: "private" },
    });
    expect(patched.statusCode, patched.body).toBe(200);
    const hidden = await member({ method: "GET", url });
    expect(hidden.statusCode).toBe(404);
    expect(hidden.json().error.code).toBe("agent.not_found");
    const missing = await admin({
      method: "GET",
      url: `/api/v1/orgs/${orgId}/agents/nope/skills`,
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe("agent.not_found");
  });
});

describe("skill list fields (phase B)", { timeout: 60_000 }, () => {
  it("GET skills returns plugin, sourceFormat, suggestPinned, entryBytes, tokenEstimate, manual, fork; an uploaded skill has plugin null and capybara", async () => {
    const up = await uploadZip(admin, zipOf("pdf-tools"));
    expect((await createSkill(admin, up)).statusCode).toBe(201);
    const bytes = new TextEncoder().encode(SKILL_MD("pdf-tools")).byteLength;
    const list = await member({ method: "GET", url: `/api/v1/orgs/${orgId}/skills` });
    expect(list.statusCode, list.body).toBe(200);
    expect(list.json().skills).toMatchObject([
      {
        name: "pdf-tools",
        plugin: null,
        sourceFormat: "capybara",
        suggestPinned: false,
        entryBytes: bytes,
        tokenEstimate: Math.ceil(bytes / 4),
        manual: false,
        fork: false,
      },
    ]);
    // the agent's own skills list carries the same fields
    const agentId = await createAgent(admin, orgId);
    await db
      .insertInto("skills")
      .values({
        id: "agent-skill-2",
        org_id: orgId,
        scope: "agent",
        agent_id: agentId,
        name: "mine",
        description: "d",
        current_version: 1,
        created_by: adminId,
      })
      .execute();
    await db
      .insertInto("skill_versions")
      .values({
        skill_id: "agent-skill-2",
        version: 1,
        manifest: JSON.stringify({
          name: "mine",
          description: "d",
          files: [{ path: "SKILL.md", size: 40, sha256: "0".repeat(64) }],
          // phase D: a manual-only forked version (the agent page tags it)
          invocation: { model: false, user: true, fork: {} },
        }),
        object_prefix: "skills/x/",
        created_by: adminId,
      })
      .execute();
    const own = await admin({
      method: "GET",
      url: `/api/v1/orgs/${orgId}/agents/${agentId}/skills`,
    });
    expect(own.json().skills).toMatchObject([
      {
        name: "mine",
        plugin: null,
        sourceFormat: "capybara",
        suggestPinned: false,
        entryBytes: 40,
        tokenEstimate: 10,
        manual: true,
        fork: true,
      },
    ]);
  });
});

describe("清理", { timeout: 60_000 }, () => {
  it("过期未用掉的技能包：删 zip 与已写的文件；用掉的：删 zip、保留版本引用的文件", async () => {
    const store = k.storage.kernel(orgId);
    // 用掉的
    const used = await uploadZip(admin, zipOf("kept"));
    expect((await createSkill(admin, used)).statusCode).toBe(201);
    // 处理到一半就失败的：文件已写、没有版本
    const orphan = await uploadZip(admin, zipOf("orphan"));
    await admin({ method: "POST", url: `/api/v1/orgs/${orgId}/attachments/${orphan}/finalize` });
    await store.put(`skills/${orphan}/SKILL.md`, new Uint8Array([1]), {
      contentType: "application/octet-stream",
    });
    await db
      .updateTable("attachments")
      .set({ expires_at: sql<Date>`now() - interval '1 minute'` })
      .where("id", "in", [used, orphan])
      .execute();

    expect(await k.attachments.deleteExpired()).toBe(2);
    expect(await store.head(`skill-packages/${used}`)).toBeNull();
    expect(await store.head(`skill-packages/${orphan}`)).toBeNull();
    expect(await store.head(`skills/${used}/SKILL.md`)).not.toBeNull();
    expect(await store.head(`skills/${orphan}/SKILL.md`)).toBeNull();
    expect(await db.selectFrom("attachments").select("id").execute()).toEqual([]);
  });

  it("技能包上传 1 小时过期，不跟对话附件的 24 小时", async () => {
    const up = await uploadZip(admin, zipOf("ttl"));
    const row = await db
      .selectFrom("attachments")
      .select([sql<number>`extract(epoch from expires_at - created_at)`.as("ttl"), "purpose"])
      .where("id", "=", up)
      .executeTakeFirstOrThrow();
    expect(row.purpose).toBe("skill-package");
    expect(Math.round(Number(row.ttl))).toBe(3600);
  });
});
