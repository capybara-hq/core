import { randomUUID } from "node:crypto";
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
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import type { Kernel } from "../../src/kernel.js";
import type { PreviewProbeState } from "../fixtures/plugins/preview-fake/index.js";
import { truncateTables } from "../helpers/db.js";
import { accountsFor } from "../helpers/identity.js";
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

/**
 * UI refresh B Task 11: `file-preview@1`. A fake provider (`preview-fake`) previews `.docx` as a view
 * and as an embed page; the kernel lists the previewers for a file in org order, renders through a
 * per-file read grant, and keeps a failing previewer to its own response.
 */

const OBJECT_STORE = fakeExtensionEntry("fake-object-store");
const PREVIEW_FAKE = fileURLToPath(
  new URL("../fixtures/plugins/preview-fake/index.ts", import.meta.url),
);
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

const probe = (): PreviewProbeState => {
  const g = globalThis as { __previewProbe?: PreviewProbeState };
  g.__previewProbe ??= { aborted: 0 };
  return g.__previewProbe;
};

let pgc: TestContainer;
let rd: TestContainer;
let s3: TestS3;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let k: Kernel;

beforeAll(async () => {
  [pgc, rd, s3] = await Promise.all([startTestPostgres(), startTestRedis(), startTestS3()]);
  raw = createDb(pgc.url, 3);
  db = kernelDb(raw);
  k = await startKernel(
    runConfig(
      { pg: pgc.url, redis: rd.url },
      {
        roles: ["api", "worker"],
        extensions: [MODEL_FAKE, OBJECT_STORE, PREVIEW_FAKE],
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
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop(), s3?.stop()]);
});

let owner: Req;
let other: Req;
let orgId: string;
let conv: string;

const errCode = (r: { json(): unknown }) => (r.json() as { error?: { code?: string } }).error?.code;

beforeEach(async () => {
  await truncateTables(raw, "capybara.accounts, capybara.orgs");
  const accounts = accountsFor(db);
  const ownerId = (await accounts.createLocal({ login: "owner", password: PW, displayName: "O" }))
    .id;
  const otherId = (await accounts.createLocal({ login: "other", password: PW, displayName: "X" }))
    .id;
  owner = await session(k, "owner");
  orgId = await createOrg(owner);
  await testMembers(db).add(orgId, otherId, "member", ownerId);
  other = await session(k, "other");
  conv = await createConv(owner, orgId, await createAgent(owner, orgId));
  delete probe().last;
  delete probe().read;
});

/** Stores an object and logs its `artifact_created` (as `sandbox_deliver` would). */
async function deliver(
  name: string,
  bytes: Buffer,
  contentType: string,
  loggedSize = bytes.byteLength,
): Promise<string> {
  const artifactId = randomUUID();
  const objectKey = `artifacts/${conv}/${artifactId}`;
  await k.storage.kernel(orgId).put(objectKey, bytes, {
    contentType,
    size: bytes.byteLength,
    signal: AbortSignal.timeout(10_000),
  });
  await k.runs.eventLog.append(conv, [
    {
      type: "artifact_created",
      payload: {
        artifactId,
        name,
        contentType,
        size: loggedSize,
        objectKey,
        sourcePath: `/workspace/${name}`,
        callId: `call-${name}`,
      },
    },
  ]);
  return artifactId;
}

const enable = async () => {
  const r = await owner({
    method: "PUT",
    url: `/api/v1/orgs/${orgId}/extensions/preview-fake`,
    payload: { enabled: true },
  });
  expect(r.statusCode, r.body).toBe(200);
};

const base = () => `/api/v1/orgs/${orgId}/conversations/${conv}/files`;
const previewers = async (fileId: string, req: Req = owner) => {
  const r = await req({ method: "GET", url: `${base()}/${fileId}/previewers` });
  return {
    status: r.statusCode,
    body: r.json() as {
      previewers: { plugin: string; id: string; kind: string; title: { en: string } }[];
    },
    r,
  };
};
const preview = (fileId: string, id: string, req: Req = owner) =>
  req({ method: "GET", url: `${base()}/${fileId}/previews/preview-fake/${id}?locale=zh` });

describe("file-preview@1", { timeout: 60_000 }, () => {
  it("lists previewers only once the extension is enabled in the org, and only accepting ones", async () => {
    const docx = await deliver("a.docx", Buffer.from("PK docx bytes"), DOCX);
    const pdf = await deliver("a.pdf", Buffer.from("%PDF"), "application/pdf");
    expect((await previewers(docx)).body.previewers).toEqual([]);
    await enable();
    const listed = (await previewers(docx)).body.previewers;
    expect(listed.map((p) => [p.plugin, p.id, p.kind])).toEqual([
      ["preview-fake", "docx", "view"],
      ["preview-fake", "docx-page", "embed"],
    ]);
    expect(listed[0]?.title.en).toBe("Document (view)");
    // the web caps the bytes it posts to an embed previewer at maxBytes (review M4)
    expect((listed as { maxBytes?: number }[]).map((p) => p.maxBytes)).toEqual([
      1024 * 1024,
      1024 * 1024,
    ]);
    expect((await previewers(pdf)).body.previewers).toEqual([]);
  });

  it("renders through a read grant for that one file, valid only during the call", async () => {
    await enable();
    const docx = await deliver("Report.DOCX", Buffer.from("PK docx bytes"), DOCX);
    const r = await preview(docx, "docx");
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toEqual({
      view: { blocks: [{ type: "text", markdown: "13 PK docx bytes" }] },
    });
    expect(probe().last).toMatchObject({
      orgId,
      conversationId: conv,
      locale: "zh",
      file: { id: docx, name: "Report.DOCX", contentType: DOCX, size: 13 },
    });
    // the grant expired with the call
    await expect(probe().read?.()).rejects.toThrow(/expired/);
  });

  it("a file over the previewer's maxBytes is not listed; the grant also caps the bytes it reads", async () => {
    await enable();
    const big = await deliver("big.docx", Buffer.alloc(10), DOCX, 2 * 1024 * 1024);
    expect((await previewers(big)).body.previewers).toEqual([]);
    expect(errCode(await preview(big, "docx"))).toBe("ui.not_found");
    // the log says small, the object is 2 MiB: read() rejects and the render fails alone
    const lying = await deliver("lying.docx", Buffer.alloc(2 * 1024 * 1024), DOCX, 100);
    const r = await preview(lying, "docx");
    expect(r.statusCode).toBe(502);
    expect(errCode(r)).toBe("ui.render_failed");
  });

  it("org order: an admin reorders and disables previewers", async () => {
    await enable();
    const docx = await deliver("a.docx", Buffer.from("PK"), DOCX);
    const url = `/api/v1/orgs/${orgId}/file-previewers`;
    const got = await owner({ method: "GET", url });
    expect(got.statusCode, got.body).toBe(200);
    expect(
      (
        got.json() as {
          items: { plugin: string; id: string; position: number; disabled: boolean }[];
        }
      ).items.map((i) => [i.id, i.position, i.disabled]),
    ).toEqual([
      ["docx", 0, false],
      ["docx-page", 1, false],
      ["hang", 2, false],
    ]);
    const put = await owner({
      method: "PUT",
      url,
      payload: {
        items: [
          { plugin: "preview-fake", id: "docx-page", disabled: false },
          { plugin: "preview-fake", id: "docx", disabled: true },
        ],
      },
    });
    expect(put.statusCode, put.body).toBe(200);
    expect(
      (put.json() as { items: { id: string; position: number; disabled: boolean }[] }).items.map(
        (i) => [i.id, i.position, i.disabled],
      ),
    ).toEqual([
      ["docx-page", 0, false],
      ["docx", 1, true],
      ["hang", 2, false],
    ]);
    expect((await previewers(docx)).body.previewers.map((p) => p.id)).toEqual(["docx-page"]);
    expect(errCode(await preview(docx, "docx"))).toBe("ui.not_found");
    // members cannot change the order
    const denied = await other({ method: "PUT", url, payload: { items: [] } });
    expect(denied.statusCode).toBe(403);
    // an unknown previewer is refused
    const unknown = await owner({
      method: "PUT",
      url,
      payload: { items: [{ plugin: "preview-fake", id: "nope", disabled: false }] },
    });
    expect(unknown.statusCode).toBe(400);
  });

  it("a reorder keeps rows of previewers it does not know and is audited", async () => {
    await enable();
    // a row of an extension that is disabled now (or not loaded on this replica)
    await db
      .insertInto("file_previewers")
      .values({ org_id: orgId, plugin: "gone", previewer_id: "x", position: 0, disabled: true })
      .execute();
    const url = `/api/v1/orgs/${orgId}/file-previewers`;
    const items = [{ plugin: "preview-fake", id: "docx", disabled: true }];
    const put = await owner({ method: "PUT", url, payload: { items } });
    expect(put.statusCode, put.body).toBe(200);
    const rows = await db
      .selectFrom("file_previewers")
      .select(["plugin", "previewer_id", "disabled"])
      .where("org_id", "=", orgId)
      .orderBy("plugin")
      .execute();
    expect(rows).toEqual([
      { plugin: "gone", previewer_id: "x", disabled: true },
      { plugin: "preview-fake", previewer_id: "docx", disabled: true },
    ]);
    const audits = await db
      .selectFrom("audit_events")
      .select(["action", "org_id", "detail"])
      .where("action", "=", "org.file_previewers.updated")
      .where("org_id", "=", orgId)
      .execute();
    expect(audits).toHaveLength(1);
    expect(audits[0]?.detail).toMatchObject({ items });
  });

  it("a hanging render times out alone with 504 ui.timeout and is aborted", async () => {
    await enable();
    const f = await deliver("x.hang", Buffer.from("h"), "application/octet-stream");
    const before = probe().aborted;
    const r = await preview(f, "hang");
    expect(r.statusCode).toBe(504);
    expect(errCode(r)).toBe("ui.timeout");
    expect(probe().aborted).toBe(before + 1);
  }, 30_000);

  it("another person cannot list or render the conversation's previews", async () => {
    await enable();
    const docx = await deliver("a.docx", Buffer.from("PK"), DOCX);
    expect((await previewers(docx, other)).status).toBe(404);
    expect((await preview(docx, "docx", other)).statusCode).toBe(404);
    // a file of another conversation is not found here
    expect((await previewers(randomUUID())).status).toBe(404);
  });

  it("an embed previewer's token is for that one file and conversation", async () => {
    await enable();
    const docx = await deliver("a.docx", Buffer.from("PK"), DOCX);
    const pdf = await deliver("a.pdf", Buffer.from("%PDF"), "application/pdf");
    const tokenUrl = `/api/v1/orgs/${orgId}/ui/embeds/preview-fake/docx-embed/token`;
    const ok = await owner({
      method: "POST",
      url: tokenUrl,
      payload: { conversationId: conv, fileId: docx },
    });
    expect(ok.statusCode, ok.body).toBe(200);
    const { token, src } = ok.json() as { token: string; src: string };
    expect(src).toBe("/plugin-ui/preview-fake/docx");
    const claims = JSON.parse(
      Buffer.from(token.split(".")[0] as string, "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    expect(claims).toMatchObject({
      contribution: "docx-embed",
      conversationId: conv,
      fileId: docx,
    });
    // no file → 400; a file no previewer of this embed accepts → 404; someone else → 404
    const noFile = await owner({
      method: "POST",
      url: tokenUrl,
      payload: { conversationId: conv },
    });
    expect(noFile.statusCode).toBe(400);
    const wrong = await owner({
      method: "POST",
      url: tokenUrl,
      payload: { conversationId: conv, fileId: pdf },
    });
    expect(wrong.statusCode).toBe(404);
    const stranger = await other({
      method: "POST",
      url: tokenUrl,
      payload: { conversationId: conv, fileId: docx },
    });
    expect(stranger.statusCode).toBe(404);
  });
});
