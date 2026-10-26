import { fileURLToPath } from "node:url";
import type { ModelRequest, ObjectStore } from "@capybara-hq/plugin-sdk";
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
import { TITLE_PROMPT } from "../../src/conversations/titles.js";
import { type KernelDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { AccountsService } from "../../src/identity/accounts.js";
import type { Kernel } from "../../src/kernel.js";
import { StorageService } from "../../src/storage/storage.service.js";
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

const OBJECT_STORE = fakeExtensionEntry("fake-object-store");
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
        extensions: [OBJECT_STORE, MODEL_MEDIA],
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

const provider = (): MediaProvider => {
  const e = k.host.list("model-provider").find((p) => p.plugin === "model-media");
  if (!e) throw new Error("model-media not loaded");
  return e.impl as MediaProvider;
};

/** The agent's requests: conversation title calls (UI refresh B) left out. */
const agentRequests = () =>
  provider().requests.filter((r) => !r.system.some((x) => x.text === TITLE_PROMPT));

let owner: Req;
let other: Req;
let ownerId: string;
let otherId: string;
let orgId: string;

beforeEach(async () => {
  await truncateTables(
    db,
    "capybara.attachments, capybara.conversation_events, capybara.runs, capybara.conversations, capybara.agent_versions, capybara.agent_members, capybara.agents, capybara.memberships, capybara.orgs, capybara.sessions, capybara.local_passwords, capybara.identities, capybara.accounts",
  );
  provider().requests.length = 0;
  const accounts = new AccountsService(db);
  ownerId = (await accounts.createLocal({ login: "owner", password: PW, displayName: "Owner" })).id;
  otherId = (await accounts.createLocal({ login: "other", password: PW, displayName: "Other" })).id;
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

    const reqs = agentRequests();
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

    const reqs = agentRequests();
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
    const texts = userBlocks(agentRequests()[0] as ModelRequest).map((b) =>
      b.type === "text" ? b.text : b.type,
    );
    expect(texts).toEqual(["x", '[Attachment "gone.png" is no longer available.]']);
  });

  it("finalize 之后经同一预签名表单重传（大小相同、内容不同）：etag 不符，模型与下载都按不再可用处理", async () => {
    const convId = await conversationWith("see-1");
    const c = await create(owner, { name: "re.png", contentType: "image/png", size: PNG.length });
    expect(Date.parse(c.expiresAt) - Date.now()).toBeLessThanOrEqual(300_000);
    expect(Date.parse(c.expiresAt) - Date.now()).toBeGreaterThan(240_000);
    expect((await upload(c, PNG, "image/png")).status).toBeLessThan(300);
    expect((await finalize(owner, c.id)).statusCode).toBe(200);
    const evil = Buffer.from(PNG);
    evil[evil.length - 1] = (evil[evil.length - 1] as number) ^ 0xff;
    expect((await upload(c, evil, "image/png")).status).toBeLessThan(300);

    expect((await post(owner, convId, { text: "x", files: [c.id] })).statusCode).toBe(202);
    await waitForTerminal(db, convId);
    const req = agentRequests()[0] as ModelRequest;
    expect(JSON.stringify(req)).not.toContain(evil.toString("base64"));
    expect(userBlocks(req).map((b) => (b.type === "text" ? b.text : b.type))).toEqual([
      "x",
      '[Attachment "re.png" is no longer available.]',
    ]);
    const dl = await owner({
      method: "GET",
      url: `/api/v1/orgs/${orgId}/attachments/${c.id}/download`,
    });
    expect(dl.statusCode).toBe(404);
    expect(dl.json().error.code).toBe("attachment.not_found");
  });

  it("finalize 之后对象被换成别的大小：不发字节，按不再可用处理", async () => {
    const convId = await conversationWith("see-1");
    const img = await ready(owner, "swap.png", "image/png", PNG);
    const swapped = Buffer.concat([PNG, Buffer.from("extra")]);
    await k.storage.kernel(orgId).put(`attachments/${img}`, swapped, { contentType: "image/png" });
    expect((await post(owner, convId, { text: "x", files: [img] })).statusCode).toBe(202);
    await waitForTerminal(db, convId);
    const req = agentRequests()[0] as ModelRequest;
    expect(JSON.stringify(req)).not.toContain(swapped.toString("base64"));
    expect(userBlocks(req).map((b) => (b.type === "text" ? b.text : b.type))).toEqual([
      "x",
      '[Attachment "swap.png" is no longer available.]',
    ]);
  });
});

describe("校验", { timeout: 30_000 }, () => {
  it("GET /attachments/limits：组织成员可读上限；非成员 → 404", async () => {
    const res = await owner({ method: "GET", url: `/api/v1/orgs/${orgId}/attachments/limits` });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({
      types: [
        "image/png",
        "image/jpeg",
        "image/gif",
        "image/webp",
        "application/pdf",
        "text/plain",
        "text/markdown",
        "text/csv",
      ],
      maxBytes: 20_971_520,
      imageMaxBytes: 5_242_880,
      maxPerMessage: 10,
      requestMediaBytes: 20_971_520,
      available: true,
    });
    const other2 = await other({ method: "GET", url: `/api/v1/orgs/${orgId}/attachments/limits` });
    expect(other2.statusCode).toBe(200);
    const stranger = await createOrg(other, "Elsewhere");
    const denied = await owner({
      method: "GET",
      url: `/api/v1/orgs/${stranger}/attachments/limits`,
    });
    expect(denied.statusCode).toBe(404);
  });

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
    // 细节里带出问题附件的 id：网页据此把对应条目标为出错
    expect(r1.json().error.details).toEqual([
      expect.objectContaining({ path: "files", attachmentId: pending.id }),
    ]);

    const theirs = await ready(other, "o.png", "image/png", PNG);
    const r2 = await post(owner, convId, { text: "x", files: [theirs] });
    expect(r2.statusCode).toBe(404);
    expect(r2.json().error.code).toBe("attachment.not_found");
    expect(r2.json().error.details).toEqual([
      expect.objectContaining({ path: "files", attachmentId: theirs }),
    ]);

    const mine = await ready(owner, "m.png", "image/png", PNG);
    expect((await post(owner, convId, { text: "x", files: [mine] })).statusCode).toBe(202);
    const conv2 = await conversationWith("see-1");
    const r3 = await post(owner, conv2, { text: "x", files: [mine] });
    expect(r3.statusCode).toBe(404);
    expect(r3.json().error.code).toBe("attachment.not_found");

    const fresh = await ready(owner, "f.png", "image/png", PNG);
    const many = Array.from({ length: 11 }, () => fresh);
    const r4 = await post(owner, conv2, { text: "x", files: many });
    expect(r4.statusCode).toBe(400);
    // 同一条消息里重复的 id → 400
    const dup = await post(owner, conv2, { text: "x", files: [fresh, fresh] });
    expect(dup.statusCode).toBe(400);
    expect(dup.json().error.code).toBe("validation_failed");
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

  it("图片与 PDF inline、其余一律 attachment；类型按核对过的值返回；302 可缓存 60 秒", async () => {
    const img = await ready(owner, "猫 1.png", "image/png", PNG);
    const pdf = await ready(owner, "spec.pdf", "application/pdf", PDF);
    const txt = await ready(owner, "notes.txt", "text/plain", TEXT);
    const open = async (id: string) => {
      const res = await owner({
        method: "GET",
        url: `/api/v1/orgs/${orgId}/attachments/${id}/download`,
      });
      expect(res.statusCode).toBe(302);
      expect(res.headers["cache-control"]).toBe("private, max-age=60");
      const got = await fetch(res.headers.location as string);
      expect(got.status).toBe(200);
      return {
        cd: got.headers.get("content-disposition") ?? "",
        ct: got.headers.get("content-type") ?? "",
      };
    };
    const a = await open(img);
    expect(a.cd).toMatch(/^inline;/);
    expect(a.cd).toContain(`filename*=UTF-8''${encodeURIComponent("猫 1.png")}`);
    expect(a.ct).toBe("image/png");
    expect((await open(pdf)).cd).toMatch(/^inline;/);
    const t = await open(txt);
    expect(t.cd).toMatch(/^attachment;/);
    expect(t.ct).toBe("text/plain");
  });

  it("已绑定的附件：不是上传者、但能访问其会话的人可以下载", async () => {
    const id = await ready(owner, "cat.png", "image/png", PNG);
    const convId = await conversationWith("see-1");
    expect((await post(owner, convId, { text: "x", files: [id] })).statusCode).toBe(202);
    // 会话只对所有者可见：把上传者改成另一个成员，模拟「上传者 ≠ 能访问会话的人」
    await db.updateTable("attachments").set({ account_id: otherId }).where("id", "=", id).execute();
    const url = `/api/v1/orgs/${orgId}/attachments/${id}/download`;
    expect((await owner({ method: "GET", url })).statusCode).toBe(302);
    expect((await other({ method: "GET", url })).statusCode).toBe(404);
  });
});

describe("只有附件的消息", { timeout: 30_000 }, () => {
  it("text 为空 + files：202，日志与请求里都没有空文本块", async () => {
    const convId = await conversationWith("see-1");
    const img = await ready(owner, "cat.png", "image/png", PNG);
    const res = await post(owner, convId, { text: "", files: [img] });
    expect(res.statusCode, res.body).toBe(202);
    await waitForTerminal(db, convId);
    const [msg] = (await eventsOf(db, convId)).filter((e) => e.type === "user_message");
    expect(msg?.payload.content).toEqual([
      {
        type: "image",
        mediaType: "image/png",
        source: { kind: "ref", attachmentId: img },
        name: "cat.png",
      },
    ]);
    const blocks = userBlocks(agentRequests()[0] as ModelRequest);
    expect(blocks.map((b) => b.type)).toEqual(["image"]);
  });

  it("text 为空且没有 files → 400；text 为空但带 @ 资源 → 400", async () => {
    const convId = await conversationWith("see-1");
    expect((await post(owner, convId, { text: "" })).statusCode).toBe(400);
    expect((await post(owner, convId, { text: "", files: [] })).statusCode).toBe(400);
    const img = await ready(owner, "cat.png", "image/png", PNG);
    const res = await post(owner, convId, {
      text: "",
      files: [img],
      attachments: [{ connectorId: "00000000-0000-4000-8000-000000000001", uri: "x://y" }],
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("大文本附件（Ruling M8）", { timeout: 30_000 }, () => {
  it("fetchMedia 按 caps 只取开头；模型收到截断并注明的文档；mediaInfo 带 etag", async () => {
    const big = Buffer.from("a,b\n".repeat(50_000)); // 200 000 字节
    const id = await ready(owner, "big.csv", "text/csv", big);
    const convId = await conversationWith("see-1");
    expect((await post(owner, convId, { text: "read", files: [id] })).statusCode).toBe(202);
    await waitForTerminal(db, convId);

    const got = await k.attachments.fetchMedia(orgId, convId, [id], new Map([[id, 1000]]));
    expect(got.get(id)?.data.byteLength).toBe(1000);
    const info = await k.attachments.mediaInfo(orgId, convId, [id]);
    expect(info.get(id)).toMatchObject({ size: big.length, pages: null });
    expect(typeof info.get(id)?.etag).toBe("string");

    const doc = userBlocks(agentRequests()[0] as ModelRequest).find((b) => b.type === "document");
    const sent =
      doc?.type === "document" && doc.source.kind === "base64"
        ? Buffer.from(doc.source.data, "base64").toString("utf8")
        : "";
    expect(sent.length).toBeLessThan(50_200);
    expect(sent).toContain(`characters of a ${big.length}-byte file.]`);

    // 提供方不支持按范围读（给了整个对象）：同样只留开头
    const real = k.host.list("object-store")[0]?.impl as ObjectStore;
    const noRange: ObjectStore = {
      ...real,
      head: (key) => real.head(key),
      get: (key) => real.get(key),
    };
    const svc = new AttachmentsService({
      db,
      storage: new StorageService({ provider: () => noRange, plugins: async () => [] }),
      config: () => k.config,
      canAccessConversation: async () => true,
      log: { info() {}, warn() {} },
    });
    const whole = await svc.fetchMedia(orgId, convId, [id], new Map([[id, 1000]]));
    expect(whole.get(id)?.data.byteLength).toBe(1000);
  });
});

describe("openForConversation（沙箱同步用）", { timeout: 30_000 }, () => {
  it("只返回绑定在该会话、已 ready、内容未被替换的附件", async () => {
    const id = await ready(owner, "notes.txt", "text/plain", TEXT);
    const convId = await conversationWith("see-1");
    // 未绑定 → null
    expect(await k.attachments.openForConversation(orgId, convId, id)).toBeNull();
    expect((await post(owner, convId, { text: "x", files: [id] })).statusCode).toBe(202);
    await waitForTerminal(db, convId);
    const got = await k.attachments.openForConversation(orgId, convId, id);
    expect(got).toMatchObject({ name: "notes.txt", contentType: "text/plain", size: TEXT.length });
    expect(Buffer.from(await new Response(got?.body).arrayBuffer()).equals(TEXT)).toBe(true);
    // 别的会话、别的组织、不存在的 id → null
    const conv2 = await conversationWith("see-1");
    expect(await k.attachments.openForConversation(orgId, conv2, id)).toBeNull();
    const org2 = await createOrg(owner, "Other org");
    expect(await k.attachments.openForConversation(org2, convId, id)).toBeNull();
    expect(
      await k.attachments.openForConversation(
        orgId,
        convId,
        "00000000-0000-4000-8000-000000000000",
      ),
    ).toBeNull();
    // 内容被替换（etag 不符）→ null
    await k.storage
      .kernel(orgId)
      .put(`attachments/${id}`, Buffer.from("name,qty\npear,9\n"), { contentType: "text/plain" });
    expect(await k.attachments.openForConversation(orgId, convId, id)).toBeNull();
  });
});

describe("待上传配额", { timeout: 30_000 }, () => {
  it("同一账号在组织里已有 50 个未 finalize 的附件 → 429 attachment.too_many_pending", async () => {
    await db
      .insertInto("attachments")
      .values(
        Array.from({ length: 50 }, (_, i) => ({
          id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
          org_id: orgId,
          account_id: ownerId,
          name: `p${i}.png`,
          content_type: "image/png",
          size: 1,
          object_key: `attachments/p${i}`,
          status: "pending",
          expires_at: sql<Date>`now() + interval '1 hour'`,
        })),
      )
      .execute();
    const body = { name: "a.png", contentType: "image/png", size: PNG.length };
    const res = await owner({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/attachments`,
      payload: body,
    });
    expect(res.statusCode, res.body).toBe(429);
    expect(res.json().error.code).toBe("attachment.too_many_pending");
    // 别的账号不受影响
    const ok = await other({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/attachments`,
      payload: body,
    });
    expect(ok.statusCode, ok.body).toBe(201);
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

  it("删对象失败：行保持 deleting、对象还在；下次运行重试成功", async () => {
    const id = await ready(owner, "old.png", "image/png", PNG);
    await db
      .updateTable("attachments")
      .set({ expires_at: sql<Date>`now() - interval '1 hour'` })
      .where("id", "=", id)
      .execute();
    const real = k.host.list("object-store")[0]?.impl as ObjectStore;
    let failDeletes = 1;
    const flaky: ObjectStore = {
      ...real,
      head: (key) => real.head(key),
      get: (key, o) => real.get(key, o),
      delete: async (key) => {
        if (failDeletes-- > 0) throw new Error("S3 503");
        return real.delete(key);
      },
    };
    const svc = new AttachmentsService({
      db,
      storage: new StorageService({ provider: () => flaky, plugins: async () => [] }),
      config: () => k.config,
      canAccessConversation: async () => false,
      log: { info() {}, warn() {} },
    });
    expect(await svc.deleteExpired()).toBe(0);
    const row = await db
      .selectFrom("attachments")
      .select("status")
      .where("id", "=", id)
      .executeTakeFirst();
    expect(row?.status).toBe("deleting");
    expect(await k.storage.kernel(orgId).head(`attachments/${id}`)).not.toBeNull();

    expect(await svc.deleteExpired()).toBe(1);
    expect(
      await db.selectFrom("attachments").select("id").where("id", "=", id).executeTakeFirst(),
    ).toBeUndefined();
    expect(await k.storage.kernel(orgId).head(`attachments/${id}`)).toBeNull();
  });
});
