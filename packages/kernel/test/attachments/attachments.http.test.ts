import { fileURLToPath } from "node:url";
import type { ModelRequest } from "@capybara-hq/plugin-sdk";
import {
  startTestPostgres,
  startTestRedis,
  startTestS3,
  type TestContainer,
  type TestS3,
} from "@capybara-hq/testing";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type KernelDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { AccountsService } from "../../src/identity/accounts.js";
import type { Kernel } from "../../src/kernel.js";
import type { MediaProvider } from "../fixtures/plugins/model-media/index.js";
import { truncateTables } from "../helpers/db.js";
import { testMembers } from "../helpers/members.js";
import {
  createAgent,
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

const S3_PLUGIN = fileURLToPath(
  new URL("../../../../plugins/object-store-s3/src/index.ts", import.meta.url),
);
const MODEL_MEDIA = fileURLToPath(
  new URL("../fixtures/plugins/model-media/index.ts", import.meta.url),
);

/** 1×1 透明 PNG。 */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);
/** 两页的最小 PDF（未压缩，`/Type /Page` 可数）。 */
const PDF = Buffer.from(
  [
    "%PDF-1.4",
    "1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj",
    "2 0 obj << /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >> endobj",
    "3 0 obj << /Type /Page /Parent 2 0 R >> endobj",
    "4 0 obj << /Type /Page /Parent 2 0 R >> endobj",
    "trailer << /Root 1 0 R >>",
    "%%EOF",
  ].join("\n"),
);
const TEXT = Buffer.from("name,qty\napple,3\n");

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
        plugins: [S3_PLUGIN, MODEL_MEDIA],
        pluginConfig: {
          "object-store-s3": {
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

const provider = (): MediaProvider => {
  const e = k.host.list("model-provider").find((p) => p.plugin === "model-media");
  if (!e) throw new Error("model-media not loaded");
  return e.impl as MediaProvider;
};

let owner: Req;
let other: Req;
let ownerId: string;
let orgId: string;

beforeEach(async () => {
  await truncateTables(
    db,
    "capybara.attachments, capybara.conversation_events, capybara.runs, capybara.conversations, capybara.agent_versions, capybara.agent_members, capybara.agents, capybara.memberships, capybara.orgs, capybara.sessions, capybara.local_passwords, capybara.identities, capybara.accounts",
  );
  provider().requests.length = 0;
  const accounts = new AccountsService(db);
  ownerId = (await accounts.createLocal({ login: "owner", password: PW, displayName: "Owner" })).id;
  const otherId = (
    await accounts.createLocal({ login: "other", password: PW, displayName: "Other" })
  ).id;
  owner = await session(k, "owner");
  orgId = await createOrg(owner);
  await testMembers(db).add(orgId, otherId, "member", ownerId);
  other = await session(k, "other");
});

interface Created {
  id: string;
  upload: {
    method: "PUT" | "POST";
    url: string;
    headers: Record<string, string>;
    fields?: Record<string, string>;
  };
  expiresAt: string;
}

async function create(
  req: Req,
  body: { name: string; contentType: string; size: number },
): Promise<Created> {
  const res = await req({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/attachments`,
    payload: body,
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as Created;
}

/** 按返回的预签名表单直传存储（POST：先放 fields，最后放 file）。 */
async function upload(c: Created, bytes: Uint8Array, contentType: string): Promise<Response> {
  if (c.upload.method === "PUT") {
    return fetch(c.upload.url, {
      method: "PUT",
      headers: c.upload.headers,
      body: Buffer.from(bytes),
    });
  }
  const form = new FormData();
  for (const [key, v] of Object.entries(c.upload.fields ?? {})) form.append(key, v);
  form.append("file", new Blob([Buffer.from(bytes)], { type: contentType }));
  return fetch(c.upload.url, { method: "POST", headers: c.upload.headers, body: form });
}

const finalize = (req: Req, id: string) =>
  req({ method: "POST", url: `/api/v1/orgs/${orgId}/attachments/${id}/finalize` });

/** 建、传、finalize 一个附件，返回 id。 */
async function ready(req: Req, name: string, contentType: string, bytes: Buffer): Promise<string> {
  const c = await create(req, { name, contentType, size: bytes.length });
  const up = await upload(c, bytes, contentType);
  expect(up.status, await up.clone().text()).toBeLessThan(300);
  const f = await finalize(req, c.id);
  expect(f.statusCode, f.body).toBe(200);
  expect(f.json()).toEqual({ id: c.id, name, contentType, size: bytes.length });
  return c.id;
}

const post = (req: Req, convId: string, payload: Record<string, unknown>) =>
  req({ method: "POST", url: `/api/v1/orgs/${orgId}/conversations/${convId}/messages`, payload });

async function conversationWith(model: string): Promise<string> {
  const agentId = await createAgent(owner, orgId, { provider: "model-media", model });
  return createConv(owner, orgId, agentId);
}

/** 请求里全部 user 内容块。 */
const userBlocks = (r: ModelRequest) =>
  r.messages.flatMap((m) => (m.role === "user" ? m.content : []));

describe("上传 → finalize → 发消息 → 模型请求", { timeout: 30_000 }, () => {
  it("支持视觉的模型收到 base64 图片与 PDF；日志里只有引用", async () => {
    const convId = await conversationWith("see-1");
    const img = await ready(owner, "cat.png", "image/png", PNG);
    const pdf = await ready(owner, "spec.pdf", "application/pdf", PDF);
    const res = await post(owner, convId, { text: "look", files: [img, pdf] });
    expect(res.statusCode, res.body).toBe(202);
    await waitForTerminal(db, convId);

    const reqs = provider().requests;
    expect(reqs).toHaveLength(1);
    const blocks = userBlocks(reqs[0] as ModelRequest);
    expect(blocks).toEqual([
      { type: "text", text: "look" },
      {
        type: "image",
        mediaType: "image/png",
        name: "cat.png",
        source: { kind: "base64", data: PNG.toString("base64") },
      },
      {
        type: "document",
        mediaType: "application/pdf",
        name: "spec.pdf",
        source: { kind: "base64", data: PDF.toString("base64") },
      },
    ]);
    // 插件绝不收到 ref
    expect(JSON.stringify(reqs)).not.toContain('"ref"');

    const events = await eventsOf(db, convId);
    const user = events.find((e) => e.type === "user_message");
    expect(user?.payload).toMatchObject({
      content: [
        { type: "text", text: "look" },
        { type: "image", source: { kind: "ref", attachmentId: img }, name: "cat.png" },
        { type: "document", source: { kind: "ref", attachmentId: pdf }, name: "spec.pdf" },
      ],
    });
    const log = JSON.stringify(events);
    expect(log).not.toContain(PNG.toString("base64"));
    expect(log).not.toContain(PDF.toString("base64"));
    // model_call 记下的估算含图片 1600 + PDF 两页 × 1000
    const call = events.find((e) => e.type === "model_call");
    expect(
      call?.type === "model_call" && call.payload.request.estimatedInputTokens,
    ).toBeGreaterThanOrEqual(3600);
  });

  it("不支持图片 / 文档的模型只收到文字占位，请求里没有字节；文本文件内联", async () => {
    const convId = await conversationWith("blind-1");
    const img = await ready(owner, "cat.png", "image/png", PNG);
    const pdf = await ready(owner, "spec.pdf", "application/pdf", PDF);
    const csv = await ready(owner, "fruit.csv", "text/csv", TEXT);
    const res = await post(owner, convId, { text: "look", files: [img, pdf, csv] });
    expect(res.statusCode, res.body).toBe(202);
    await waitForTerminal(db, convId);

    const reqs = provider().requests;
    expect(reqs).toHaveLength(1);
    const blocks = userBlocks(reqs[0] as ModelRequest);
    expect(blocks.every((b) => b.type === "text")).toBe(true);
    const texts = blocks.map((b) => (b.type === "text" ? b.text : ""));
    expect(texts).toContain('[Attached image "cat.png" — this model cannot view images.]');
    expect(texts.some((t) => t.startsWith('[Attached document "spec.pdf"'))).toBe(true);
    expect(texts.some((t) => t.includes("apple,3"))).toBe(true);
    const sent = JSON.stringify(reqs);
    expect(sent).not.toContain(PNG.toString("base64"));
    expect(sent).not.toContain(PDF.toString("base64"));
    expect(sent).not.toContain('"image"');
    expect(sent).not.toContain('"document"');
  });

  it("对象被删掉后，模型收到「不再可用」占位", async () => {
    const convId = await conversationWith("see-1");
    const img = await ready(owner, "gone.png", "image/png", PNG);
    await k.storage.kernel(orgId).delete(`attachments/${img}`);
    expect((await post(owner, convId, { text: "x", files: [img] })).statusCode).toBe(202);
    await waitForTerminal(db, convId);
    const texts = userBlocks(provider().requests[0] as ModelRequest).map((b) =>
      b.type === "text" ? b.text : b.type,
    );
    expect(texts).toEqual(["x", '[Attachment "gone.png" is no longer available.]']);
  });

  it("finalize 之后对象被换成别的大小：不发字节，按不再可用处理", async () => {
    const convId = await conversationWith("see-1");
    const img = await ready(owner, "swap.png", "image/png", PNG);
    const swapped = Buffer.concat([PNG, Buffer.from("extra")]);
    await k.storage.kernel(orgId).put(`attachments/${img}`, swapped, { contentType: "image/png" });
    expect((await post(owner, convId, { text: "x", files: [img] })).statusCode).toBe(202);
    await waitForTerminal(db, convId);
    const req = provider().requests[0] as ModelRequest;
    expect(JSON.stringify(req)).not.toContain(swapped.toString("base64"));
    expect(userBlocks(req).map((b) => (b.type === "text" ? b.text : b.type))).toEqual([
      "x",
      '[Attachment "swap.png" is no longer available.]',
    ]);
  });
});

describe("校验", { timeout: 30_000 }, () => {
  it("类型不在允许列表 → 415；超出大小 → 413；名字非法 → 400", async () => {
    const url = `/api/v1/orgs/${orgId}/attachments`;
    const bad = await owner({
      method: "POST",
      url,
      payload: { name: "a.zip", contentType: "application/zip", size: 10 },
    });
    expect(bad.statusCode).toBe(415);
    expect(bad.json().error.code).toBe("attachment.type_not_allowed");
    const big = await owner({
      method: "POST",
      url,
      payload: { name: "a.pdf", contentType: "application/pdf", size: 20 * 1024 * 1024 + 1 },
    });
    expect(big.statusCode).toBe(413);
    expect(big.json().error.code).toBe("attachment.too_large");
    // 图片还受 MEDIA_LIMITS.imageBytes（5 MiB）限制
    const bigImg = await owner({
      method: "POST",
      url,
      payload: { name: "a.png", contentType: "image/png", size: 5 * 1024 * 1024 + 1 },
    });
    expect(bigImg.statusCode).toBe(413);
    const ctl = await owner({
      method: "POST",
      url,
      payload: { name: "a\u0007.png", contentType: "image/png", size: 10 },
    });
    expect(ctl.statusCode).toBe(400);
  });

  it("finalize：没上传 → 409 not_ready；大小与声明不符 → 拒绝；内容不是声明的类型 → 415", async () => {
    const c = await create(owner, { name: "a.png", contentType: "image/png", size: PNG.length });
    const early = await finalize(owner, c.id);
    expect(early.statusCode).toBe(409);
    expect(early.json().error.code).toBe("attachment.not_ready");

    // 上传比声明小的文件：存储接受（只限上限），finalize 发现不符
    const small = await upload(c, PNG.subarray(0, PNG.length - 4), "image/png");
    expect(small.status).toBeLessThan(300);
    const mismatch = await finalize(owner, c.id);
    expect(mismatch.statusCode).toBe(409);
    expect(mismatch.json().error.code).toBe("attachment.not_ready");

    // 比声明大：存储直接拒绝
    const c2 = await create(owner, { name: "b.png", contentType: "image/png", size: 10 });
    const big = await upload(c2, PNG, "image/png");
    expect(big.status).toBeGreaterThanOrEqual(400);

    // 字节不是 PNG
    const fake = Buffer.from("definitely not a png");
    const c3 = await create(owner, { name: "c.png", contentType: "image/png", size: fake.length });
    expect((await upload(c3, fake, "image/png")).status).toBeLessThan(300);
    const sniff = await finalize(owner, c3.id);
    expect(sniff.statusCode).toBe(415);
    expect(sniff.json().error.code).toBe("attachment.type_not_allowed");
  });

  it("finalize 只有上传者能做；别人 → 404", async () => {
    const c = await create(owner, { name: "a.png", contentType: "image/png", size: PNG.length });
    await upload(c, PNG, "image/png");
    const r = await finalize(other, c.id);
    expect(r.statusCode).toBe(404);
    expect(r.json().error.code).toBe("attachment.not_found");
  });

  it("消息引用：pending → 409；别人的 → 404；已用于别的对话 → 404；超过 10 个 → 400", async () => {
    const convId = await conversationWith("see-1");
    const pending = await create(owner, {
      name: "p.png",
      contentType: "image/png",
      size: PNG.length,
    });
    const r1 = await post(owner, convId, { text: "x", files: [pending.id] });
    expect(r1.statusCode).toBe(409);
    expect(r1.json().error.code).toBe("attachment.not_ready");

    const theirs = await ready(other, "o.png", "image/png", PNG);
    const r2 = await post(owner, convId, { text: "x", files: [theirs] });
    expect(r2.statusCode).toBe(404);
    expect(r2.json().error.code).toBe("attachment.not_found");

    const mine = await ready(owner, "m.png", "image/png", PNG);
    expect((await post(owner, convId, { text: "x", files: [mine] })).statusCode).toBe(202);
    const conv2 = await conversationWith("see-1");
    const r3 = await post(owner, conv2, { text: "x", files: [mine] });
    expect(r3.statusCode).toBe(404);
    expect(r3.json().error.code).toBe("attachment.not_found");

    const many = Array.from({ length: 11 }, () => mine);
    const r4 = await post(owner, conv2, { text: "x", files: many });
    expect(r4.statusCode).toBe(400);
    // 失败的消息没有写进日志
    expect((await eventsOf(db, conv2)).filter((e) => e.type === "user_message")).toHaveLength(0);
  });
});

describe("下载", { timeout: 30_000 }, () => {
  it("对话所有者 302 到预签名地址；别的成员 → 404；绑定前只有上传者可下载", async () => {
    const id = await ready(owner, "cat.png", "image/png", PNG);
    const url = `/api/v1/orgs/${orgId}/attachments/${id}/download`;
    expect((await other({ method: "GET", url })).statusCode).toBe(404);
    const pre = await owner({ method: "GET", url });
    expect(pre.statusCode).toBe(302);

    const convId = await conversationWith("see-1");
    expect((await post(owner, convId, { text: "x", files: [id] })).statusCode).toBe(202);
    await waitForTerminal(db, convId);
    const res = await owner({ method: "GET", url });
    expect(res.statusCode).toBe(302);
    const got = await fetch(res.headers.location as string);
    expect(got.status).toBe(200);
    expect(Buffer.from(await got.arrayBuffer()).equals(PNG)).toBe(true);
    const denied = await other({ method: "GET", url });
    expect(denied.statusCode).toBe(404);
    expect(denied.json().error.code).toBe("attachment.not_found");
  });
});

describe("清理", { timeout: 30_000 }, () => {
  it("超过 24 小时未绑定的附件（pending / ready）连同对象被删除；已绑定的保留", async () => {
    const stale = await ready(owner, "old.png", "image/png", PNG);
    const pending = await create(owner, {
      name: "p.png",
      contentType: "image/png",
      size: PNG.length,
    });
    await upload(pending, PNG, "image/png");
    const bound = await ready(owner, "kept.png", "image/png", PNG);
    const convId = await conversationWith("see-1");
    expect((await post(owner, convId, { text: "x", files: [bound] })).statusCode).toBe(202);
    const fresh = await ready(owner, "new.png", "image/png", PNG);
    await db
      .updateTable("attachments")
      .set({
        created_at: sql<Date>`now() - interval '25 hours'`,
        expires_at: sql<Date>`now() - interval '1 hour'`,
      })
      .where("id", "in", [stale, pending.id, bound])
      .execute();

    expect(await k.attachments.deleteExpired()).toBe(2);
    const left = await db.selectFrom("attachments").select("id").execute();
    expect(left.map((r) => r.id).sort()).toEqual([bound, fresh].sort());
    const store = k.storage.kernel(orgId);
    expect(await store.head(`attachments/${stale}`)).toBeNull();
    expect(await store.head(`attachments/${pending.id}`)).toBeNull();
    expect(await store.head(`attachments/${bound}`)).not.toBeNull();
  });
});
