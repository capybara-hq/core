import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  fakeExtensionEntry,
  openSse,
  startTestPostgres,
  startTestRedis,
  startTestS3,
  type TestContainer,
  type TestS3,
} from "@capybara-hq/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { EventLog } from "../../src/conversations/event-log.js";
import {
  type AttachmentPurpose,
  type KernelSchemaDb,
  kernelDb,
} from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { StorageService } from "../../src/storage/storage.service.js";
import { truncateTables } from "../helpers/db.js";
import { onlyBuiltins } from "../helpers/disabled-tools.js";
import { asUser, cookieJar } from "../helpers/http.js";
import { accountsFor } from "../helpers/identity.js";
import { testMembers } from "../helpers/members.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import {
  createConv,
  createOrg,
  createOrgWithProviders,
  PW,
  postMessage,
  type Req,
  runConfig,
  session,
  startKernel,
  type TestKernel,
  waitForTerminal,
} from "../helpers/runs.js";

/** UI refresh B Task 10: a conversation's file outputs, grouped by source path into versions. */

const OBJECT_STORE = fakeExtensionEntry("fake-object-store");
const SANDBOX_FAKE = fileURLToPath(
  new URL("../fixtures/plugins/sandbox-fake/index.ts", import.meta.url),
);

let pgc: TestContainer;
let rd: TestContainer;
let s3: TestS3;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let k: TestKernel;
let root: string;

beforeAll(async () => {
  [pgc, rd, s3] = await Promise.all([startTestPostgres(), startTestRedis(), startTestS3()]);
  raw = createDb(pgc.url, 3);
  db = kernelDb(raw);
  root = await mkdtemp(join(tmpdir(), "cap-files-"));
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
});
afterAll(async () => {
  await k?.close();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop(), s3?.stop()]);
  if (root) await rm(root, { recursive: true, force: true });
});

let owner: Req;
let ownerCookie: () => string;
let other: Req;
let orgId: string;
let ownerId: string;

beforeEach(async () => {
  await truncateTables(raw, "capybara.sandboxes, capybara.accounts, capybara.orgs");
  const accounts = accountsFor(db);
  ownerId = (await accounts.createLocal({ login: "owner", password: PW, displayName: "O" })).id;
  const otherId = (await accounts.createLocal({ login: "other", password: PW, displayName: "X" }))
    .id;
  const jar = cookieJar();
  owner = asUser(k.http, jar);
  const login = await owner({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { login: "owner", password: PW },
  });
  expect(login.statusCode).toBe(200);
  ownerCookie = () => jar.header() as string;
  orgId = await createOrgWithProviders(k, owner);
  await testMembers(db).add(orgId, otherId, "member", ownerId);
  other = await session(k, "other");
});

async function sandboxConversation(): Promise<string> {
  const res = await owner({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/agents`,
    payload: {
      definition: {
        name: "Coder",
        instructions: "Use the sandbox.",
        model: { provider: "model-fake", model: "fake-1" },
        disabledTools: onlyBuiltins(["Bash", "Deliver"].map((name) => ({ kind: "builtin", name }))),
      },
      visibility: "org",
    },
  });
  expect(res.statusCode, res.body).toBe(201);
  return createConv(owner, orgId, (res.json() as { agent: { id: string } }).agent.id);
}

async function callTool(conv: string, key: string, input: unknown, n: number): Promise<void> {
  await postMessage(owner, orgId, conv, `tool:${key}:${JSON.stringify(input)}`);
  await waitForTerminal(db, conv, n, 30_000);
}

/** Stores an object and logs its `artifact_created` (as `Deliver` would). */
async function deliver(
  conv: string,
  name: string,
  bytes: Buffer,
  contentType: string,
  sourcePath = `/workspace/${name}`,
): Promise<{ artifactId: string; objectKey: string }> {
  const artifactId = randomUUID();
  const objectKey = `artifacts/${conv}/${artifactId}`;
  await k.app
    .get(StorageService)
    .kernel(orgId)
    .put(objectKey, bytes, {
      contentType,
      size: bytes.byteLength,
      signal: AbortSignal.timeout(10_000),
    });
  await k.app.get(EventLog).append(conv, [
    {
      type: "artifact_created",
      payload: {
        artifactId,
        name,
        contentType,
        size: bytes.byteLength,
        objectKey,
        sourcePath,
        callId: `call-${name}`,
      },
    },
  ]);
  return { artifactId, objectKey };
}

interface FileOutput {
  id: string;
  name: string;
  contentType: string;
  size: number;
  sourcePath: string;
  version: number;
  versions: { id: string; size: number; createdAt: string }[];
  callId: string;
  createdAt: string;
  status: "available" | "removed";
  previewable: "image" | "text" | null;
  origin: "delivered" | "uploaded";
}
const filesUrl = (conv: string) => `/api/v1/orgs/${orgId}/conversations/${conv}/files`;
const listFiles = async (conv: string, query = "") => {
  const r = await owner({ method: "GET", url: `${filesUrl(conv)}${query}` });
  expect(r.statusCode, r.body).toBe(200);
  return r.json() as { files: FileOutput[]; next: string | null };
};

describe("file outputs", () => {
  it("two deliveries of one path are one file with two versions; delivering sends changed: files", async () => {
    const conv = await sandboxConversation();
    {
      await callTool(
        conv,
        "Bash",
        {
          description: "Write a report",
          command: "mkdir -p out && printf 'v1\\n' > out/report.md",
        },
        1,
      );
      await callTool(conv, "Deliver", { file_path: "/workspace/out/report.md" }, 2);
      const sse = await openSse(
        `http://127.0.0.1:${k.port}/api/v1/orgs/${orgId}/conversations/${conv}/stream`,
        { cookie: ownerCookie() },
      );
      try {
        await callTool(
          conv,
          "Bash",
          { description: "Update it", command: "printf 'v2 longer\\n' > out/report.md" },
          3,
        );
        await callTool(conv, "Deliver", { file_path: "/workspace/out/report.md" }, 4);
        await sse.until(
          (m) => m.some((x) => x.event === "changed" && x.data === '{"what":"files"}'),
          10_000,
          "changed: files",
        );
      } finally {
        sse.close();
      }
      const { files, next } = await listFiles(conv);
      expect(next).toBeNull();
      expect(files).toHaveLength(1);
      const f = files[0] as FileOutput;
      expect(f).toMatchObject({
        name: "report.md",
        sourcePath: "/workspace/out/report.md",
        version: 2,
        size: 10,
        status: "available",
        previewable: "text",
      });
      expect(f.versions.map((v) => v.size)).toEqual([10, 3]);
      expect(f.id).toBe(f.versions[0]?.id);
      const content = await owner({ method: "GET", url: `${filesUrl(conv)}/${f.id}/content` });
      expect(content.statusCode, content.body).toBe(200);
      expect(content.body).toBe("v2 longer\n");
      // an older version is readable by its id
      const old = await owner({
        method: "GET",
        url: `${filesUrl(conv)}/${f.versions[1]?.id}/content`,
      });
      expect(old.body).toBe("v1\n");
    }
  });

  it("newest first, paged by file id; removed objects are marked and their content is 410", async () => {
    const conv = await sandboxConversation();
    const a = await deliver(conv, "a.txt", Buffer.from("alpha"), "text/plain");
    await deliver(conv, "b.png", Buffer.from([0x89, 0x50, 0x4e, 0x47]), "image/png");
    await deliver(conv, "c.bin", Buffer.from([1, 2, 3]), "application/octet-stream");
    const page1 = await listFiles(conv, "?limit=2");
    expect(page1.files.map((f) => [f.name, f.previewable])).toEqual([
      ["c.bin", null],
      ["b.png", "image"],
    ]);
    expect(page1.next).toBe(page1.files[1]?.id);
    const page2 = await listFiles(conv, `?limit=2&after=${page1.next}`);
    expect(page2.files.map((f) => f.name)).toEqual(["a.txt"]);
    expect(page2.next).toBeNull();

    await k.app.get(StorageService).kernel(orgId).delete(a.objectKey);
    const after = await listFiles(conv);
    expect(after.files.find((f) => f.name === "a.txt")?.status).toBe("removed");
    expect(after.files.find((f) => f.name === "b.png")?.status).toBe("available");
    const gone = await owner({ method: "GET", url: `${filesUrl(conv)}/${a.artifactId}/content` });
    expect(gone.statusCode).toBe(410);
    expect((gone.json() as { error: { code: string } }).error.code).toBe(
      "conversation.artifact_removed",
    );

    // a new version of a listed file keeps its place (files are ordered by their first delivery),
    // so the cursor of page 1 still yields exactly the rest (review M2)
    await deliver(conv, "c.bin", Buffer.from([4]), "application/octet-stream");
    await deliver(conv, "a.txt", Buffer.from("alpha2"), "text/plain", "/workspace/a.txt");
    const again = await listFiles(conv, `?limit=2&after=${page1.next}`);
    expect(again.files.map((f) => [f.name, f.version])).toEqual([["a.txt", 2]]);
    expect((await listFiles(conv)).files.map((f) => f.name)).toEqual(["c.bin", "b.png", "a.txt"]);
  });

  it("text content: cut at `limit` with X-Content-Truncated; never served as HTML; images refused", async () => {
    const conv = await sandboxConversation();
    const t = await deliver(conv, "notes.txt", Buffer.from("0123456789abcdef"), "text/plain");
    const cut = await owner({
      method: "GET",
      url: `${filesUrl(conv)}/${t.artifactId}/content?limit=10`,
    });
    expect(cut.statusCode).toBe(200);
    expect(cut.body).toBe("0123456789");
    expect(cut.headers["x-content-truncated"]).toBe("true");
    expect(cut.headers["content-type"]).toMatch(/^text\/plain/);
    expect(cut.headers["x-content-type-options"]).toBe("nosniff");
    expect(cut.headers["cache-control"]).toContain("no-store");
    const whole = await owner({ method: "GET", url: `${filesUrl(conv)}/${t.artifactId}/content` });
    expect(whole.body).toBe("0123456789abcdef");
    expect(whole.headers["x-content-truncated"]).toBeUndefined();

    // a multi-byte character is never split at the cut
    const cjk = await deliver(conv, "cjk.txt", Buffer.from("中文字"), "text/plain");
    const half = await owner({
      method: "GET",
      url: `${filesUrl(conv)}/${cjk.artifactId}/content?limit=4`,
    });
    expect(half.body).toBe("中");

    const html = await deliver(conv, "page.html", Buffer.from("<script>x()</script>"), "text/html");
    const asText = await owner({
      method: "GET",
      url: `${filesUrl(conv)}/${html.artifactId}/content`,
    });
    expect(asText.statusCode).toBe(200);
    expect(asText.headers["content-type"]).toMatch(/^text\/plain/);
    expect(asText.headers["content-security-policy"]).toContain("sandbox");
    // every text type is served as plain text (a script or stylesheet never loads from here);
    // the stored type is in its own header
    const js = await deliver(conv, "app.js", Buffer.from("alert(1)"), "text/javascript");
    const jsText = await owner({
      method: "GET",
      url: `${filesUrl(conv)}/${js.artifactId}/content`,
    });
    expect(jsText.statusCode).toBe(200);
    expect(jsText.headers["content-type"]).toBe("text/plain; charset=utf-8");
    expect(jsText.headers["x-content-original-type"]).toBe("text/javascript");
    const css = await deliver(conv, "a.css", Buffer.from("a{}"), "text/css");
    const cssText = await owner({
      method: "GET",
      url: `${filesUrl(conv)}/${css.artifactId}/content`,
    });
    expect(cssText.headers["content-type"]).toBe("text/plain; charset=utf-8");

    const img = await deliver(conv, "dot.png", Buffer.from([0x89, 0x50]), "image/png");
    const refused = await owner({
      method: "GET",
      url: `${filesUrl(conv)}/${img.artifactId}/content`,
    });
    expect(refused.statusCode).toBe(400);
    expect((refused.json() as { error: { code: string } }).error.code).toBe(
      "conversation.artifact_not_previewable",
    );
    const unknown = await owner({
      method: "GET",
      url: `${filesUrl(conv)}/${randomUUID()}/content`,
    });
    expect(unknown.statusCode).toBe(404);
  });

  it("another member: 404 for the list and the content", async () => {
    const conv = await sandboxConversation();
    const t = await deliver(conv, "notes.txt", Buffer.from("secret"), "text/plain");
    for (const url of [filesUrl(conv), `${filesUrl(conv)}/${t.artifactId}/content`]) {
      const r = await other({ method: "GET", url });
      expect(r.statusCode, url).toBe(404);
      expect((r.json() as { error: { code: string } }).error.code).toBe("conversation.not_found");
    }
  });
});

/** Uploads a chat attachment through the presigned flow and finalizes it; returns its id. */
async function upload(name: string, contentType: string, bytes: Buffer): Promise<string> {
  const created = await owner({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/attachments`,
    payload: { name, contentType, size: bytes.byteLength },
  });
  expect(created.statusCode, created.body).toBe(201);
  const c = created.json() as {
    id: string;
    upload: {
      method: "PUT" | "POST";
      url: string;
      headers: Record<string, string>;
      fields?: Record<string, string>;
    };
  };
  let up: Response;
  if (c.upload.method === "PUT") {
    up = await fetch(c.upload.url, { method: "PUT", headers: c.upload.headers, body: bytes });
  } else {
    const form = new FormData();
    for (const [key, v] of Object.entries(c.upload.fields ?? {})) form.append(key, v);
    form.append("file", new Blob([new Uint8Array(bytes)], { type: contentType }));
    up = await fetch(c.upload.url, { method: "POST", headers: c.upload.headers, body: form });
  }
  expect(up.status, await up.clone().text()).toBeLessThan(300);
  const fin = await owner({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/attachments/${c.id}/finalize`,
  });
  expect(fin.statusCode, fin.body).toBe(200);
  return c.id;
}

/** Stores an object and writes an attachment row directly (for rows the routes never produce). */
async function attachRow(
  conv: string | null,
  name: string,
  bytes: Buffer,
  contentType: string,
  o: {
    org?: string;
    purpose?: AttachmentPurpose;
    status?: "pending" | "ready";
    /** Record the stored object's etag, as finalize does. */
    etag?: boolean;
  } = {},
): Promise<string> {
  const id = randomUUID();
  const org = o.org ?? orgId;
  const objectKey = `attachments/${id}`;
  const store = k.app.get(StorageService).kernel(org);
  await store.put(objectKey, bytes, {
    contentType,
    size: bytes.byteLength,
    signal: AbortSignal.timeout(10_000),
  });
  const etag = o.etag ? ((await store.head(objectKey))?.etag ?? null) : null;
  if (o.etag) expect(etag).not.toBeNull();
  await db
    .insertInto("attachments")
    .values({
      id,
      org_id: org,
      conversation_id: conv,
      account_id: ownerId,
      name,
      content_type: contentType,
      size: bytes.byteLength,
      object_key: objectKey,
      status: o.status ?? "ready",
      purpose: o.purpose ?? "chat",
      etag,
    })
    .execute();
  return id;
}

const errCode = (r: { json(): unknown }) => (r.json() as { error?: { code?: string } }).error?.code;

describe("uploaded attachments (file preview: attachments join the conversation's files)", () => {
  it("a sent attachment is listed with the delivered files, newest first, and its text is served", async () => {
    const conv = await sandboxConversation();
    const delivered = await deliver(conv, "report.md", Buffer.from("# r"), "text/markdown");
    const att = await upload("notes.txt", "text/plain", Buffer.from("hello attachment"));
    const sse = await openSse(
      `http://127.0.0.1:${k.port}/api/v1/orgs/${orgId}/conversations/${conv}/stream`,
      { cookie: ownerCookie() },
    );
    try {
      const sent = await owner({
        method: "POST",
        url: `/api/v1/orgs/${orgId}/conversations/${conv}/messages`,
        payload: { text: "hi", files: [att] },
      });
      expect(sent.statusCode, sent.body).toBe(202);
      // the page reads the files again: the sent attachment is one of them now
      await sse.until(
        (m) => m.some((x) => x.event === "changed" && x.data === '{"what":"files"}'),
        10_000,
        "changed: files",
      );
    } finally {
      sse.close();
    }
    await waitForTerminal(db, conv, 1, 30_000);

    const { files, next } = await listFiles(conv);
    expect(next).toBeNull();
    expect(files.map((f) => [f.id, f.origin])).toEqual([
      [att, "uploaded"],
      [delivered.artifactId, "delivered"],
    ]);
    const up = files[0] as FileOutput;
    expect(up).toMatchObject({
      name: "notes.txt",
      contentType: "text/plain",
      size: 16,
      sourcePath: "notes.txt",
      version: 1,
      callId: "",
      status: "available",
      previewable: "text",
    });
    expect(up.versions).toEqual([{ id: att, size: 16, createdAt: up.createdAt }]);

    const content = await owner({ method: "GET", url: `${filesUrl(conv)}/${att}/content` });
    expect(content.statusCode, content.body).toBe(200);
    expect(content.headers["content-type"]).toBe("text/plain; charset=utf-8");
    expect(content.headers["x-content-original-type"]).toBe("text/plain");
    expect(content.body).toBe("hello attachment");

    // the extension previewers of an attachment are listed (none are loaded here)
    const pv = await owner({ method: "GET", url: `${filesUrl(conv)}/${att}/previewers` });
    expect(pv.statusCode, pv.body).toBe(200);
    expect(pv.json()).toEqual({ previewers: [] });
  });

  it("paging with limit=1 walks both kinds once each, newest first", async () => {
    const conv = await sandboxConversation();
    const a = (await deliver(conv, "a.txt", Buffer.from("a"), "text/plain")).artifactId;
    const b = await attachRow(conv, "b.png", Buffer.from([0x89, 0x50]), "image/png");
    const c = (await deliver(conv, "c.bin", Buffer.from([1]), "application/octet-stream"))
      .artifactId;
    const d = await attachRow(conv, "d.bin", Buffer.from([2]), "application/octet-stream");
    const seen: [string, string, string | null][] = [];
    let after: string | null = null;
    for (let i = 0; i < 10; i++) {
      const page = await listFiles(conv, `?limit=1${after ? `&after=${after}` : ""}`);
      for (const f of page.files) seen.push([f.id, f.origin, f.previewable]);
      after = page.next;
      if (!after) break;
    }
    expect(seen).toEqual([
      [d, "uploaded", null],
      [c, "delivered", null],
      [b, "uploaded", "image"],
      [a, "delivered", "text"],
    ]);
    // an attachment whose object is gone is marked removed and its content is 410
    const gone = await attachRow(conv, "e.txt", Buffer.from("e"), "text/plain");
    await k.app.get(StorageService).kernel(orgId).delete(`attachments/${gone}`);
    expect((await listFiles(conv)).files.find((f) => f.id === gone)?.status).toBe("removed");
    const r = await owner({ method: "GET", url: `${filesUrl(conv)}/${gone}/content` });
    expect(r.statusCode).toBe(410);
  });

  it("an attachment whose object changed after finalize is removed: listed so, 410 on content", async () => {
    const conv = await sandboxConversation();
    const store = k.app.get(StorageService).kernel(orgId);
    const replace = async (id: string, bytes: Buffer) =>
      store.put(`attachments/${id}`, bytes, {
        contentType: "text/plain",
        size: bytes.byteLength,
        signal: AbortSignal.timeout(10_000),
      });
    // same size, other bytes: only the etag tells
    const swapped = await attachRow(conv, "s.txt", Buffer.from("aaaa"), "text/plain", {
      etag: true,
    });
    await replace(swapped, Buffer.from("bbbb"));
    // another size: the size tells (also with no etag recorded)
    const resized = await attachRow(conv, "r.txt", Buffer.from("aaaa"), "text/plain");
    await replace(resized, Buffer.from("longer bytes"));
    const intact = await attachRow(conv, "i.txt", Buffer.from("same"), "text/plain", {
      etag: true,
    });
    const listed = new Map((await listFiles(conv)).files.map((f) => [f.id, f.status]));
    expect(listed).toEqual(
      new Map([
        [intact, "available"],
        [resized, "removed"],
        [swapped, "removed"],
      ]),
    );
    for (const id of [swapped, resized]) {
      const r = await owner({ method: "GET", url: `${filesUrl(conv)}/${id}/content` });
      expect(r.statusCode).toBe(410);
      expect(errCode(r)).toBe("conversation.artifact_removed");
      const pv = await owner({ method: "GET", url: `${filesUrl(conv)}/${id}/previewers` });
      expect(pv.statusCode).toBe(410);
      expect(errCode(pv)).toBe("conversation.artifact_removed");
    }
    const ok = await owner({ method: "GET", url: `${filesUrl(conv)}/${intact}/content` });
    expect(ok.body).toBe("same");
  });

  it("only this conversation's ready chat uploads in this org: everything else is not found", async () => {
    const conv = await sandboxConversation();
    const elsewhere = await sandboxConversation();
    const otherOrg = await createOrg(owner, "Other");
    const txt = Buffer.from("secret text");
    const ids = {
      otherOrg: await attachRow(conv, "o.txt", txt, "text/plain", { org: otherOrg }),
      otherConversation: await attachRow(elsewhere, "c.txt", txt, "text/plain"),
      unbound: await attachRow(null, "u.txt", txt, "text/plain"),
      skillPackage: await attachRow(conv, "s.txt", txt, "text/plain", {
        purpose: "skill-package",
      }),
      pending: await attachRow(conv, "p.txt", txt, "text/plain", { status: "pending" }),
    };
    expect((await listFiles(conv)).files).toEqual([]);
    for (const [what, id] of Object.entries(ids)) {
      for (const url of [`${filesUrl(conv)}/${id}/content`, `${filesUrl(conv)}/${id}/previewers`]) {
        const r = await owner({ method: "GET", url });
        expect(r.statusCode, `${what} ${url}`).toBe(404);
        expect(errCode(r), what).toBe("conversation.artifact_not_found");
      }
    }
  });

  it("a member who cannot read the conversation gets its usual refusal for an attachment", async () => {
    const conv = await sandboxConversation();
    const att = await attachRow(conv, "n.txt", Buffer.from("secret"), "text/plain");
    for (const url of [
      filesUrl(conv),
      `${filesUrl(conv)}/${att}/content`,
      `${filesUrl(conv)}/${att}/previewers`,
    ]) {
      const r = await other({ method: "GET", url });
      expect(r.statusCode, url).toBe(404);
      expect(errCode(r), url).toBe("conversation.not_found");
    }
  });
});
