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
import { AttachmentsService } from "../../src/conversations/attachments.service.js";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { truncateTables } from "../helpers/db.js";
import { accountsFor } from "../helpers/identity.js";
import { testMembers } from "../helpers/members.js";
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

const OBJECT_STORE = fakeExtensionEntry("fake-object-store");

let pgc: TestContainer;
let rd: TestContainer;
let s3: TestS3;
let db: KernelSchemaDb;
let destroyDb: () => Promise<void>;
let k: TestKernel;
let kNoStore: TestKernel;

beforeAll(async () => {
  [pgc, rd, s3] = await Promise.all([startTestPostgres(), startTestRedis(), startTestS3()]);
  const raw = createDb(pgc.url, 3);
  db = kernelDb(raw);
  destroyDb = () => raw.destroy();
  const urls = { pg: pgc.url, redis: rd.url };
  k = await startKernel(
    runConfig(urls, {
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
    }),
  );
  // a second kernel on the same database with no object store provider
  kNoStore = await startKernel(runConfig(urls, { roles: ["api"], extensions: [MODEL_FAKE] }));
});
afterAll(async () => {
  await kNoStore?.close();
  await k?.close();
  await destroyDb?.();
  await Promise.all([pgc?.stop(), rd?.stop(), s3?.stop()]);
});

let admin: Req;
let member: Req;
let orgId: string;

beforeEach(async () => {
  await truncateTables(
    db,
    "capybara.attachments, capybara.agent_versions, capybara.agent_members, capybara.agents, capybara.audit_events, capybara.memberships, capybara.orgs, capybara.sessions, capybara.local_passwords, capybara.identities, capybara.accounts",
  );
  const accounts = accountsFor(db);
  const adminId = (await accounts.createLocal({ login: "admin", password: PW, displayName: "A" }))
    .id;
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
interface AgentJson {
  id: string;
  profile: { updatedAt: string; avatar: { kind: string; uploadId?: string } | null };
}

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const code = (res: { json(): unknown }) =>
  (res.json() as { error?: { code?: string } }).error?.code;

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

async function newAgent(req: Req, visibility = "org"): Promise<AgentJson> {
  const res = await req({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/agents`,
    payload: {
      definition: {
        name: "Helper",
        instructions: "Be helpful.",
        model: { provider: "model-fake", model: "fake-1" },
        disabledTools: [],
      },
      visibility,
    },
  });
  expect(res.statusCode, res.body).toBe(201);
  return (res.json() as { agent: AgentJson }).agent;
}

const avatarUrl = (agentId: string) => `/api/v1/orgs/${orgId}/agents/${agentId}/avatar`;

function requestUpload(req: Req, agentId: string, payload: Record<string, unknown>) {
  return req({ method: "POST", url: `${avatarUrl(agentId)}/uploads`, payload });
}

/** Registers and uploads a PNG; returns the upload id. */
async function uploadPng(req: Req, agentId: string): Promise<string> {
  const res = await requestUpload(req, agentId, {
    name: "me.png",
    contentType: "image/png",
    size: PNG.byteLength,
  });
  expect(res.statusCode, res.body).toBe(201);
  const c = res.json() as Created;
  await putToStore(c, PNG, "image/png");
  return c.id;
}

const saveAvatar = (req: Req, a: AgentJson, uploadId: string) =>
  req({
    method: "PATCH",
    url: `/api/v1/orgs/${orgId}/agents/${a.id}/profile`,
    payload: { avatar: { kind: "upload", uploadId }, expectedUpdatedAt: a.profile.updatedAt },
  });

describe("agent avatar uploads", () => {
  it("upload registers an image attachment", async () => {
    const a = await newAgent(admin);
    const res = await requestUpload(admin, a.id, {
      name: "me.png",
      contentType: "image/png",
      size: PNG.byteLength,
    });
    expect(res.statusCode, res.body).toBe(201);
    const c = res.json() as Created & { expiresAt: string };
    expect(c.upload.url).toContain(new URL(s3.endpoint).host);
    expect(c.expiresAt).toBeTruthy();
    const row = await db
      .selectFrom("attachments")
      .selectAll()
      .where("id", "=", c.id)
      .executeTakeFirstOrThrow();
    expect(row).toMatchObject({
      purpose: "agent-avatar",
      status: "pending",
      content_type: "image/png",
      org_id: orgId,
    });
    expect(row.object_key).toMatch(/^agent-avatars\//);
  });

  it("a non-image or 2 MB + 1 upload is 400", async () => {
    const a = await newAgent(admin);
    for (const payload of [
      { name: "a.gif", contentType: "image/gif", size: 10 },
      { name: "a.pdf", contentType: "application/pdf", size: 10 },
      { name: "big.png", contentType: "image/png", size: 2_097_153 },
      { name: "none.png", contentType: "image/png", size: 0 },
    ]) {
      const res = await requestUpload(admin, a.id, payload);
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
    }
    const ok = await requestUpload(admin, a.id, {
      name: "max.webp",
      contentType: "image/webp",
      size: 2_097_152,
    });
    expect(ok.statusCode, ok.body).toBe(201);
  });

  it("saving an upload avatar consumes the upload; a second agent can't reuse it", async () => {
    const a = await newAgent(admin);
    const b = await newAgent(admin);
    const uploadId = await uploadPng(admin, a.id);

    // another account can't use the uploader's upload
    const mine = await newAgent(member);
    const stolen = await saveAvatar(member, mine, uploadId);
    expect(stolen.statusCode).toBe(404);
    expect(code(stolen)).toBe("attachment.not_found");

    const res = await saveAvatar(admin, a, uploadId);
    expect(res.statusCode, res.body).toBe(200);
    expect((res.json() as { profile: AgentJson["profile"] }).profile.avatar).toEqual({
      kind: "upload",
      uploadId,
    });
    const row = await db
      .selectFrom("attachments")
      .selectAll()
      .where("id", "=", uploadId)
      .executeTakeFirstOrThrow();
    expect(row).toMatchObject({ status: "ready", agent_id: a.id, expires_at: null });

    const reuse = await saveAvatar(admin, b, uploadId);
    expect(reuse.statusCode).toBe(404);
    expect(code(reuse)).toBe("attachment.not_found");
    const bAfter = await admin({ method: "GET", url: `/api/v1/orgs/${orgId}/agents/${b.id}` });
    expect((bAfter.json() as { agent: AgentJson }).agent.profile.avatar?.kind).not.toBe("upload");

    // the expired-attachment cleanup keeps a used avatar
    const attachments = k.app.get(
      (await import("../../src/conversations/attachments.service.js")).AttachmentsService,
    );
    await attachments.deleteExpired();
    const kept = await db
      .selectFrom("attachments")
      .select("id")
      .where("id", "=", uploadId)
      .execute();
    expect(kept).toHaveLength(1);
  });

  it("an upload whose bytes are not the declared image is refused", async () => {
    const a = await newAgent(admin);
    const res = await requestUpload(admin, a.id, {
      name: "fake.png",
      contentType: "image/png",
      size: 12,
    });
    const c = res.json() as Created;
    await putToStore(c, new Uint8Array(12).fill(65), "image/png");
    const saved = await saveAvatar(admin, a, c.id);
    expect(saved.statusCode).toBe(415);
    expect(code(saved)).toBe("attachment.type_not_allowed");
  });

  it("GET avatar redirects for a reader who can see the agent and is 404 otherwise", async () => {
    const shared = await newAgent(admin);
    const uploadId = await uploadPng(admin, shared.id);
    expect((await saveAvatar(admin, shared, uploadId)).statusCode).toBe(200);

    const ok = await member({ method: "GET", url: avatarUrl(shared.id) });
    expect(ok.statusCode, ok.body).toBe(302);
    expect(ok.headers.location).toContain(new URL(s3.endpoint).host);
    const img = await fetch(String(ok.headers.location));
    expect(img.status).toBe(200);
    expect(img.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await img.arrayBuffer())).toEqual(PNG);

    // a private agent is invisible to another member
    const priv = await newAgent(admin, "private");
    const pid = await uploadPng(admin, priv.id);
    expect((await saveAvatar(admin, priv, pid)).statusCode).toBe(200);
    expect((await admin({ method: "GET", url: avatarUrl(priv.id) })).statusCode).toBe(302);
    expect((await member({ method: "GET", url: avatarUrl(priv.id) })).statusCode).toBe(404);
    expect((await member({ method: "GET", url: avatarUrl("nope") })).statusCode).toBe(404);

    // external: https redirects, http is 404; preset and null are 404
    const set = (avatar: unknown) =>
      sql`update capybara.agents set profile_avatar = ${JSON.stringify(avatar)}::jsonb where id = ${shared.id}`.execute(
        db,
      );
    await set({ kind: "external", url: "https://cdn.example.com/a.png" });
    const ext = await member({ method: "GET", url: avatarUrl(shared.id) });
    expect(ext.statusCode).toBe(302);
    expect(ext.headers.location).toBe("https://cdn.example.com/a.png");
    await set({ kind: "external", url: "http://cdn.example.com/a.png" });
    expect((await member({ method: "GET", url: avatarUrl(shared.id) })).statusCode).toBe(404);
    await set({ kind: "external", url: "https://" });
    expect((await member({ method: "GET", url: avatarUrl(shared.id) })).statusCode).toBe(404);
    await set({ kind: "preset", id: "fox" });
    expect((await member({ method: "GET", url: avatarUrl(shared.id) })).statusCode).toBe(404);
    await sql`update capybara.agents set profile_avatar = null where id = ${shared.id}`.execute(db);
    expect((await member({ method: "GET", url: avatarUrl(shared.id) })).statusCode).toBe(404);
  });

  it("without an object store the upload is 503 storage.unavailable and a preset still saves", async () => {
    const a = await newAgent(admin);
    const req = await session(kNoStore, "admin");
    const up = await requestUpload(req, a.id, {
      name: "me.png",
      contentType: "image/png",
      size: 10,
    });
    expect(up.statusCode).toBe(503);
    expect(code(up)).toBe("storage.unavailable");

    const saveUpload = await saveAvatar(req, a, "some-upload");
    expect(saveUpload.statusCode).toBe(503);
    expect(code(saveUpload)).toBe("storage.unavailable");

    const get = await req({ method: "GET", url: avatarUrl(a.id) });
    expect([404, 503]).toContain(get.statusCode);

    const preset = await req({
      method: "PATCH",
      url: `/api/v1/orgs/${orgId}/agents/${a.id}/profile`,
      payload: {
        avatar: { kind: "preset", id: "owl" },
        expectedUpdatedAt: a.profile.updatedAt,
      },
    });
    expect(preset.statusCode, preset.body).toBe(200);
  });

  it("create with an upload avatar is 400", async () => {
    const res = await admin({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/agents`,
      payload: {
        definition: {
          name: "H",
          instructions: "x",
          model: { provider: "model-fake", model: "fake-1" },
          disabledTools: [],
        },
        visibility: "org",
        profile: { avatar: { kind: "upload", uploadId: "u" } },
      },
    });
    expect(res.statusCode).toBe(400);
  });

  describe("a replaced avatar's upload expires", () => {
    const expired = async (id: string) => {
      const r = await db
        .selectFrom("attachments")
        .select(sql<boolean>`expires_at is not null and expires_at <= now()`.as("e"))
        .where("id", "=", id)
        .executeTakeFirstOrThrow();
      return r.e;
    };
    const patchProfile = (a: AgentJson, avatar: unknown) =>
      admin({
        method: "PATCH",
        url: `/api/v1/orgs/${orgId}/agents/${a.id}/profile`,
        payload: { avatar, expectedUpdatedAt: a.profile.updatedAt },
      });
    const withUpload = async () => {
      const a = await newAgent(admin);
      const id = await uploadPng(admin, a.id);
      const saved = await saveAvatar(admin, a, id);
      const profile = (saved.json() as { profile: AgentJson["profile"] }).profile;
      return { a: { ...a, profile }, id };
    };

    it("replacing it with a preset, another upload or null expires the old row", async () => {
      for (const next of [{ kind: "preset", id: "fox" }, null, "upload"] as const) {
        const { a, id } = await withUpload();
        expect(await expired(id)).toBe(false);
        let avatar: unknown = next;
        let newId: string | undefined;
        if (next === "upload") {
          newId = await uploadPng(admin, a.id);
          avatar = { kind: "upload", uploadId: newId };
        }
        const res = await patchProfile(a, avatar);
        expect(res.statusCode, res.body).toBe(200);
        expect(await expired(id)).toBe(true);
        if (newId) expect(await expired(newId)).toBe(false);
      }
    });

    it("re-saving the same upload keeps it", async () => {
      const { a, id } = await withUpload();
      const res = await saveAvatar(admin, a, id);
      expect(res.statusCode, res.body).toBe(200);
      expect(await expired(id)).toBe(false);
    });

    it("deleting the agent expires it and the cleanup job deletes the object", async () => {
      const { a, id } = await withUpload();
      const del = await admin({ method: "DELETE", url: `/api/v1/orgs/${orgId}/agents/${a.id}` });
      expect(del.statusCode).toBe(204);
      expect(await expired(id)).toBe(true);
      const attachments = k.app.get(AttachmentsService);
      expect(await attachments.deleteExpired()).toBeGreaterThanOrEqual(1);
      const left = await db.selectFrom("attachments").select("id").where("id", "=", id).execute();
      expect(left).toHaveLength(0);
    });
  });
});
