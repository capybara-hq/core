import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { ModelRequest } from "@capybara-hq/plugin-sdk";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { EventLog } from "../../src/conversations/event-log.js";
import type { ConversationEvent, EventPayload } from "../../src/conversations/events.js";
import { TITLE_PROMPT } from "../../src/conversations/titles.js";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { ExtensionHost } from "../../src/extensions/host.js";
import { FileDeliveries } from "../../src/files/deliveries.js";
import { StorageService } from "../../src/storage/storage.service.js";
import { type ArtifactStoreDeps, storeArtifacts } from "../../src/tools/builtins/artifacts.js";
import type { BuiltinCallContext } from "../../src/tools/registry.js";
import type { MediaProvider } from "../fixtures/plugins/model-media/index.js";
import { accountsFor } from "../helpers/identity.js";
import { blobKeyOf, seedLibraryFile } from "../helpers/library-files.js";
import { testMembers } from "../helpers/members.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import {
  createAgent,
  createConv,
  createOrgWithProviders,
  eventsOf,
  PW,
  type Req,
  runConfig,
  session,
  startKernel,
  type TestKernel,
  waitForTerminal,
} from "../helpers/runs.js";

/**
 * The file library on one kernel (`mem-store`):
 * - deliveries (file library spec §4 "Delivering"): a delivered or generated file's bytes become a
 *   shared blob of the org (an existing ready blob of the same sha256 is reused, no upload), and
 *   its `artifact_created` event and its library file (owner the conversation's owner, the
 *   conversation's agent, origin by source path) commit together; `storeArtifacts` is called
 *   directly against the real log and deliveries;
 * - the library routes (spec §6, §8): list, filters, collapse, search, cursor, usage, details,
 *   content / download / HTML twins, delete, and the owner check on every route.
 */

const fixture = (name: string) =>
  fileURLToPath(new URL(`../fixtures/plugins/${name}/index.ts`, import.meta.url));

let pgc: TestContainer;
let rd: TestContainer;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let k: TestKernel;
let owner: Req;
let ownerId: string;
let otherId: string;
let orgId: string;
let agentId: string;

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  raw = createDb(pgc.url, 3);
  db = kernelDb(raw);
  k = await startKernel(
    runConfig(
      { pg: pgc.url, redis: rd.url },
      {
        roles: ["api", "worker"],
        extensions: [MODEL_FAKE, fixture("mem-store"), fixture("model-media")],
      },
    ),
  );
  const accounts = accountsFor(db);
  ownerId = (await accounts.createLocal({ login: "owner", password: PW, displayName: "O" })).id;
  otherId = (await accounts.createLocal({ login: "other", password: PW, displayName: "X" })).id;
  owner = await session(k, "owner");
  orgId = await createOrgWithProviders(k, owner);
  const created = await owner({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/agents`,
    payload: {
      definition: {
        name: "Deliverer",
        instructions: "Deliver files.",
        model: { provider: "model-fake", model: "fake-1" },
      },
      visibility: "org",
    },
  });
  expect(created.statusCode, created.body).toBe(201);
  agentId = (created.json() as { agent: { id: string } }).agent.id;
});

afterAll(async () => {
  await k?.close();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

type Artifact = ConversationEvent & {
  type: "artifact_created";
  payload: EventPayload<"artifact_created">;
};
const artifactsOf = async (conv: string) =>
  (await eventsOf(db, conv)).filter((e): e is Artifact => e.type === "artifact_created");

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

const deps = (deliveries?: ArtifactStoreDeps["deliveries"]): ArtifactStoreDeps => ({
  deliveries: deliveries ?? k.app.get(FileDeliveries),
  eventLog: k.app.get(EventLog),
});

/** A call of the run's account `accountId` (not necessarily the conversation's owner). */
const ctx = (conversationId: string, accountId = ownerId): BuiltinCallContext => ({
  orgId,
  accountId,
  agentId,
  conversationId,
  rootConversationId: conversationId,
  callId: `call-${randomUUID().slice(0, 8)}`,
  signal: new AbortController().signal,
});

const file = (text: string, sourcePath = "/workspace/report.txt", name = "report.txt") => ({
  name,
  contentType: "text/plain",
  data: new TextEncoder().encode(text),
  sourcePath,
});

/** Counts the kernel store's puts under `blobs/` from now on. */
function countBlobPuts(): { count: () => number } {
  const storage = k.app.get(StorageService);
  const original = storage.kernel.bind(storage);
  let puts = 0;
  vi.spyOn(storage, "kernel").mockImplementation((org) => {
    const s = original(org);
    return {
      ...s,
      put: async (key, body, opts) => {
        if (key.startsWith("blobs/")) puts += 1;
        return s.put(key, body, opts);
      },
    };
  });
  return { count: () => puts };
}

async function blobKeys(): Promise<string[]> {
  const r = await k.app.get(StorageService).kernel(orgId).list("blobs/");
  return r.items.map((o) => o.key);
}

describe("deliveries on shared blobs", () => {
  it("two conversations delivering identical bytes share one blob, written once", async () => {
    const a = await createConv(owner, orgId, agentId);
    const b = await createConv(owner, orgId, agentId);
    const before = await blobKeys();
    const puts = countBlobPuts();
    try {
      const [x] = await storeArtifacts(deps(), ctx(a), [file("shared bytes")]);
      const [y] = await storeArtifacts(deps(), ctx(b), [file("shared bytes")]);
      expect(puts.count()).toBe(1);
      const [ea] = await artifactsOf(a);
      const [eb] = await artifactsOf(b);
      expect(ea?.payload.objectKey).toBe(eb?.payload.objectKey);
      expect(ea?.payload.objectKey).toMatch(/^blobs\//);
      const rows = await db
        .selectFrom("files")
        .select(["id", "blob_id"])
        .where("org_id", "=", orgId)
        .where("id", "in", [x?.artifactId as string, y?.artifactId as string])
        .execute();
      expect(rows).toHaveLength(2);
      expect(new Set(rows.map((r) => r.blob_id)).size).toBe(1);
      expect((await blobKeys()).filter((key) => !before.includes(key))).toEqual([
        ea?.payload.objectKey,
      ]);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("a delivery of bytes the org already holds puts nothing", async () => {
    const conv = await createConv(owner, orgId, agentId);
    await storeArtifacts(deps(), ctx(conv), [file("held already")]);
    const puts = countBlobPuts();
    try {
      const [again] = await storeArtifacts(deps(), ctx(conv), [file("held already")]);
      expect(again?.repeatOf).toBeUndefined();
      expect(puts.count()).toBe(0);
      expect(await artifactsOf(conv)).toHaveLength(2);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("the file is the conversation owner's, with its agent, origin by source path", async () => {
    const conv = await createConv(owner, orgId, agentId);
    // the call's account is another member: the file still belongs to the conversation's owner
    const stored = await storeArtifacts(deps(), ctx(conv, otherId), [
      file("delivered bytes", "/workspace/out/a.txt", "a.txt"),
      file("generated bytes", "generated/call-1/image.png", "image.png"),
    ]);
    const events = await artifactsOf(conv);
    expect(events.map((e) => e.payload.fileId)).toEqual(stored.map((s) => s.artifactId));
    const files = await db
      .selectFrom("files")
      .innerJoin("blobs", "blobs.id", "files.blob_id")
      .select([
        "files.id",
        "files.account_id",
        "files.agent_id",
        "files.origin",
        "files.status",
        "files.name",
        "files.size",
        "files.source_conversation_id",
        "files.source_path",
        "blobs.object_key",
        "blobs.sha256",
      ])
      .where("files.org_id", "=", orgId)
      .where("files.source_conversation_id", "=", conv)
      .orderBy("files.name")
      .execute();
    expect(files).toEqual([
      {
        id: stored[0]?.artifactId,
        account_id: ownerId,
        agent_id: agentId,
        origin: "delivered",
        status: "ready",
        name: "a.txt",
        size: "15",
        source_conversation_id: conv,
        source_path: "/workspace/out/a.txt",
        object_key: events[0]?.payload.objectKey,
        sha256: sha("delivered bytes"),
      },
      {
        id: stored[1]?.artifactId,
        account_id: ownerId,
        agent_id: agentId,
        origin: "generated",
        status: "ready",
        name: "image.png",
        size: "15",
        source_conversation_id: conv,
        source_path: "generated/call-1/image.png",
        object_key: events[1]?.payload.objectKey,
        sha256: sha("generated bytes"),
      },
    ]);
    const refs = await db
      .selectFrom("conversation_files")
      .select(["file_id", "role", "first_seq"])
      .where("org_id", "=", orgId)
      .where("conversation_id", "=", conv)
      .orderBy("first_seq")
      .execute();
    expect(refs).toEqual(
      events.map((e) => ({
        file_id: e.payload.artifactId,
        role: "delivered",
        first_seq: `${e.seq}`,
      })),
    );
  });

  it("a blob a deletion claims before the delivery commits is replaced by fresh bytes", async () => {
    const conv = await createConv(owner, orgId, agentId);
    const real = k.app.get(FileDeliveries);
    const claimed: string[] = [];
    const racing: ArtifactStoreDeps["deliveries"] = {
      ensureBlob: async (...args) => {
        const blob = await real.ensureBlob(...args);
        if (claimed.length === 0) {
          // the blob sweep claims it right after it was returned (unlocked)
          claimed.push(blob.id);
          await db
            .updateTable("blobs")
            .set({ status: "deleting" })
            .where("id", "=", blob.id)
            .where("org_id", "=", orgId)
            .execute();
        }
        return blob;
      },
      appendDelivered: (...args) => real.appendDelivered(...args),
    };
    const [stored] = await storeArtifacts(deps(racing), ctx(conv), [file("claimed bytes")]);
    // one event and one file, on the new blob; the rolled back attempt left nothing
    const events = await artifactsOf(conv);
    expect(events).toHaveLength(1);
    const row = await db
      .selectFrom("files")
      .innerJoin("blobs", "blobs.id", "files.blob_id")
      .select(["blobs.id", "blobs.status", "blobs.object_key", "blobs.sha256"])
      .where("files.org_id", "=", orgId)
      .where("files.id", "=", stored?.artifactId as string)
      .executeTakeFirstOrThrow();
    expect(row.id).not.toBe(claimed[0]);
    expect(row).toMatchObject({ status: "ready", sha256: sha("claimed bytes") });
    expect(events[0]?.payload.objectKey).toBe(row.object_key);
  });
});

/** A 1x1 transparent PNG. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

let members = 0;
/** A new member of the org with a library of their own (each test reads only its own files). */
async function member(): Promise<{ req: Req; id: string }> {
  members += 1;
  const login = `member${members}`;
  const id = (
    await accountsFor(db).createLocal({ login, password: PW, displayName: `M${members}` })
  ).id;
  await testMembers(db).add(orgId, id, "member", ownerId);
  return { req: await session(k, login), id };
}

/** A ready library upload of `accountId` (a blob of its own). */
const upload = (accountId: string, name: string, contentType: string, bytes: Uint8Array) =>
  seedLibraryFile(k.app, orgId, accountId, { name, contentType, bytes }, { status: "ready" });

/** Delivers one file into the member's conversation as `Deliver` does; returns the file id. */
async function deliver(
  conv: string,
  accountId: string,
  text: string,
  sourcePath: string,
  name: string,
): Promise<string> {
  const [stored] = await storeArtifacts(deps(), ctx(conv, accountId), [
    file(text, sourcePath, name),
  ]);
  return stored?.artifactId as string;
}

/** Pins a file's creation time (the list's order) to `minutes` after a fixed instant. */
const at = (id: string, minutes: number) =>
  db
    .updateTable("files")
    .set({ created_at: new Date(Date.UTC(2026, 10, 1, 12, minutes)) })
    .where("id", "=", id)
    .execute();

const lib = () => `/api/v1/orgs/${orgId}/files`;

interface ListView {
  id: string;
  name: string;
  contentType: string;
  size: number;
  origin: string;
  agentId: string | null;
  agentName?: string;
  sourceConversation: { id: string; title: string | null; deleted: boolean } | null;
  versions: number;
  createdAt: string;
  previewable: "image" | "text" | null;
}

async function list(req: Req, query = ""): Promise<{ files: ListView[]; next: string | null }> {
  const r = await req({ method: "GET", url: `${lib()}${query}` });
  expect(r.statusCode, r.body).toBe(200);
  expect(r.headers["cache-control"]).toBe("private, no-store");
  return r.json() as { files: ListView[]; next: string | null };
}
const names = async (req: Req, query = "") => (await list(req, query)).files.map((f) => f.name);

const errCode = (r: { json(): unknown }) => (r.json() as { error?: { code?: string } }).error?.code;

describe("the library routes", () => {
  it("lists the caller's ready files newest first, deliveries of one path collapsed to the newest", async () => {
    const m = await member();
    const conv = await createConv(m.req, orgId, agentId);
    await db.updateTable("conversations").set({ title: "Q3" }).where("id", "=", conv).execute();
    const notes = await upload(m.id, "notes.txt", "text/plain", Buffer.from("n"));
    const v1 = await deliver(conv, m.id, "v1", "/workspace/report.txt", "report.txt");
    const v2 = await deliver(conv, m.id, "v2!", "/workspace/report.txt", "report.txt");
    const chart = await deliver(conv, m.id, "c", "generated/call-1/chart.png", "chart.png");
    // a draft (a composer upload not sent) and a deleted file are not in the library
    await seedLibraryFile(k.app, orgId, m.id, {
      name: "draft.txt",
      contentType: "text/plain",
      bytes: Buffer.from("d"),
    });
    const gone = await upload(m.id, "gone.txt", "text/plain", Buffer.from("g"));
    await db.updateTable("files").set({ status: "deleted" }).where("id", "=", gone).execute();
    await at(notes, 1);
    await at(v1, 2);
    await at(v2, 3);
    await at(chart, 4);
    const out = await list(m.req);
    expect(out.next).toBeNull();
    expect(out.files).toEqual([
      {
        id: chart,
        name: "chart.png",
        contentType: "text/plain",
        size: 1,
        origin: "generated",
        agentId,
        agentName: "Deliverer",
        sourceConversation: { id: conv, title: "Q3", deleted: false },
        versions: 1,
        createdAt: new Date(Date.UTC(2026, 10, 1, 12, 4)).toISOString(),
        previewable: "text",
      },
      expect.objectContaining({ id: v2, name: "report.txt", size: 3, versions: 2 }),
      {
        id: notes,
        name: "notes.txt",
        contentType: "text/plain",
        size: 1,
        origin: "upload",
        agentId: null,
        sourceConversation: null,
        versions: 1,
        createdAt: new Date(Date.UTC(2026, 10, 1, 12, 1)).toISOString(),
        previewable: "text",
      },
    ]);
    // another account's library is its own
    expect((await list(owner)).files.map((f) => f.id)).not.toContain(notes);
  });

  it("filters by origin, agent, type and name, and pages with a cursor", async () => {
    const m = await member();
    const conv = await createConv(m.req, orgId, agentId);
    const ids = [
      await upload(m.id, "Quarterly-REPORT.pdf", "application/pdf", Buffer.from("%PDF")),
      await upload(m.id, "photo.png", "image/png", PNG),
      await upload(m.id, "data.json", "application/json; charset=utf-8", Buffer.from("{}")),
      await upload(m.id, "archive.zip", "application/zip", Buffer.from("PK")),
      await deliver(conv, m.id, "r", "/workspace/report.md", "report.md"),
    ];
    for (const [i, id] of ids.entries()) await at(id, 10 + i);
    expect(await names(m.req, "?origin=upload")).toEqual([
      "archive.zip",
      "data.json",
      "photo.png",
      "Quarterly-REPORT.pdf",
    ]);
    expect(await names(m.req, "?origin=delivered")).toEqual(["report.md"]);
    expect(await names(m.req, `?agentId=${agentId}`)).toEqual(["report.md"]);
    expect(await names(m.req, "?type=image")).toEqual(["photo.png"]);
    expect(await names(m.req, "?type=document")).toEqual(["Quarterly-REPORT.pdf"]);
    expect(await names(m.req, "?type=text")).toEqual(["report.md", "data.json"]);
    expect(await names(m.req, "?type=other")).toEqual(["archive.zip"]);
    // q: a case-insensitive substring of the name (the composer's @ search)
    expect(await names(m.req, "?q=rEpOrT&limit=8")).toEqual(["report.md", "Quarterly-REPORT.pdf"]);
    expect(await names(m.req, "?q=%25")).toEqual([]);
    // pages of two, newest first, each file once
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page = await list(m.req, `?limit=2${cursor ? `&cursor=${cursor}` : ""}`);
      expect(page.files.length).toBeLessThanOrEqual(2);
      seen.push(...page.files.map((f) => f.id));
      cursor = page.next;
    } while (cursor !== null);
    expect(seen).toEqual([...ids].reverse());
    // a cursor the route did not hand out, a limit out of range
    for (const q of ["?cursor=not-a-cursor", "?limit=0", "?limit=101", "?type=video"]) {
      const r = await m.req({ method: "GET", url: `${lib()}${q}` });
      expect(r.statusCode, q).toBe(400);
    }
  });

  it("usage counts the distinct blobs of the caller's ready files; another account's use never shows", async () => {
    const m = await member();
    const n = await member();
    const a = await createConv(m.req, orgId, agentId);
    const b = await createConv(m.req, orgId, agentId);
    const c = await createConv(n.req, orgId, agentId);
    const usage = async (req: Req) => {
      const r = await req({ method: "GET", url: `${lib()}/usage` });
      expect(r.statusCode, r.body).toBe(200);
      return r.json();
    };
    expect(await usage(m.req)).toEqual({ files: 0, bytes: 0 });
    // the same bytes delivered twice: two files on one blob
    await deliver(a, m.id, "twelve bytes", "/workspace/a.txt", "a.txt");
    await deliver(b, m.id, "twelve bytes", "/workspace/b.txt", "b.txt");
    const own = await upload(m.id, "own.txt", "text/plain", Buffer.from("four"));
    expect(await usage(m.req)).toEqual({ files: 3, bytes: 12 + 4 });
    // another member delivered the same bytes: each sees only their own files
    await deliver(c, n.id, "twelve bytes", "/workspace/c.txt", "c.txt");
    expect(await usage(n.req)).toEqual({ files: 1, bytes: 12 });
    expect(await usage(m.req)).toEqual({ files: 3, bytes: 16 });
    // a deleted file no longer counts
    expect((await m.req({ method: "DELETE", url: `${lib()}/${own}` })).statusCode).toBe(204);
    expect(await usage(m.req)).toEqual({ files: 2, bytes: 12 });
  });

  it("details name the owner's conversations and the versions; a deleted conversation keeps its files", async () => {
    const m = await member();
    const conv = await createConv(m.req, orgId, agentId);
    const later = await createConv(m.req, orgId, agentId);
    const v1 = await deliver(conv, m.id, "one", "/workspace/plan.md", "plan.md");
    const v2 = await deliver(conv, m.id, "two!", "/workspace/plan.md", "plan.md");
    await at(v1, 20);
    await at(v2, 21);
    // the person sent the newest version in another conversation
    await db
      .insertInto("conversation_files")
      .values({ conversation_id: later, file_id: v2, org_id: orgId, role: "attached" })
      .execute();
    const get = async (id: string) => {
      const r = await m.req({ method: "GET", url: `${lib()}/${id}` });
      expect(r.statusCode, r.body).toBe(200);
      expect(r.headers["cache-control"]).toBe("private, no-store");
      return r.json() as {
        file: ListView;
        conversations: { id: string; title: string | null; deleted: boolean }[];
        versions: { id: string; size: number; createdAt: string }[];
      };
    };
    const d = await get(v2);
    expect(d.file).toMatchObject({ id: v2, name: "plan.md", origin: "delivered", versions: 2 });
    expect(d.conversations).toEqual([
      { id: conv, title: null, deleted: false },
      { id: later, title: null, deleted: false },
    ]);
    expect(d.versions.map((v) => [v.id, v.size])).toEqual([
      [v2, 4],
      [v1, 3],
    ]);
    // an older version reads as itself, with the same versions
    expect((await get(v1)).file).toMatchObject({ id: v1, size: 3, versions: 2 });
    // deleting the conversation keeps its files; the source shows as deleted
    expect(
      (await m.req({ method: "DELETE", url: `/api/v1/orgs/${orgId}/conversations/${conv}` }))
        .statusCode,
    ).toBe(204);
    const [entry] = (await list(m.req)).files;
    expect(entry).toMatchObject({
      id: v2,
      versions: 2,
      sourceConversation: { id: conv, deleted: true },
    });
    expect((await get(v2)).conversations).toEqual([
      { id: conv, title: null, deleted: true },
      { id: later, title: null, deleted: false },
    ]);
  });

  it("content and download are the conversation routes' twins", async () => {
    const m = await member();
    const text = await upload(m.id, "notes.txt", "text/plain", Buffer.from("line 1\nline 2\n"));
    const png = await upload(m.id, "dot.png", "image/png", PNG);
    const content = await m.req({ method: "GET", url: `${lib()}/${text}/content?limit=6` });
    expect(content.statusCode, content.body).toBe(200);
    expect(content.body).toBe("line 1");
    expect(content.headers).toMatchObject({
      "content-type": "text/plain; charset=utf-8",
      "x-content-original-type": "text/plain",
      "x-content-truncated": "true",
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
      "content-security-policy": "sandbox; default-src 'none'",
    });
    const notText = await m.req({ method: "GET", url: `${lib()}/${png}/content` });
    expect(notText.statusCode).toBe(400);
    expect(errCode(notText)).toBe("conversation.artifact_not_previewable");
    // the 302, `as=url`, `inline=1` for a bitmap; the web's cache-busting retry=1 is accepted
    const key = await blobKeyOf(db, png);
    const redirect = await m.req({ method: "GET", url: `${lib()}/${png}/download?retry=1` });
    expect(redirect.statusCode, redirect.body).toBe(302);
    expect(redirect.headers.location).toBe(`https://store.test/kernel/${orgId}/${key}`);
    expect(redirect.headers["cache-control"]).toBe("private, max-age=60");
    const asUrl = await m.req({ method: "GET", url: `${lib()}/${png}/download?as=url&inline=1` });
    expect(asUrl.statusCode, asUrl.body).toBe(200);
    expect(asUrl.json()).toEqual({ url: `https://store.test/kernel/${orgId}/${key}` });
    expect(asUrl.headers["cache-control"]).toBe("private, no-store");
    // the bytes gone: 410 file.deleted
    await k.app.get(StorageService).kernel(orgId).delete(key);
    const gone = await m.req({ method: "GET", url: `${lib()}/${png}/download` });
    expect(gone.statusCode).toBe(410);
    expect(errCode(gone)).toBe("file.deleted");
  });

  it("an HTML library file renders as a sandboxed document through its token", async () => {
    const m = await member();
    const html = await upload(m.id, "page.html", "text/html", Buffer.from("<h1>Hi</h1>"));
    const txt = await upload(m.id, "t.txt", "text/plain", Buffer.from("t"));
    const minted = await m.req({ method: "POST", url: `${lib()}/${html}/html-token` });
    expect(minted.statusCode, minted.body).toBe(200);
    const { path } = minted.json() as { path: string; expiresIn: number };
    const doc = await k.http.inject({ method: "GET", url: path });
    expect(doc.statusCode, doc.body).toBe(200);
    expect(doc.body).toBe("<h1>Hi</h1>");
    expect(doc.headers["content-security-policy"]).toContain("sandbox");
    expect(doc.headers["cache-control"]).toBe("private, no-store");
    const refused = await m.req({ method: "POST", url: `${lib()}/${txt}/html-token` });
    expect(refused.statusCode).toBe(400);
    // the token stops serving once the file is deleted
    expect((await m.req({ method: "DELETE", url: `${lib()}/${html}` })).statusCode).toBe(204);
    expect((await k.http.inject({ method: "GET", url: path })).statusCode).toBe(404);
  });

  it("deleting a file whose blob another account also uses leaves that account's reads intact", async () => {
    const m = await member();
    const n = await member();
    const a = await createConv(m.req, orgId, agentId);
    const b = await createConv(n.req, orgId, agentId);
    const mine = await deliver(a, m.id, "shared text", "/workspace/s.txt", "s.txt");
    const theirs = await deliver(b, n.id, "shared text", "/workspace/s.txt", "s.txt");
    const blobs = await db
      .selectFrom("files")
      .select("blob_id")
      .where("id", "in", [mine, theirs])
      .execute();
    expect(new Set(blobs.map((r) => r.blob_id)).size).toBe(1);
    expect((await m.req({ method: "DELETE", url: `${lib()}/${mine}` })).statusCode).toBe(204);
    const usage = async (req: Req) =>
      (await req({ method: "GET", url: `${lib()}/usage` })).json() as unknown;
    expect(await usage(m.req)).toEqual({ files: 0, bytes: 0 });
    expect(await usage(n.req)).toEqual({ files: 1, bytes: 11 });
    const content = await n.req({ method: "GET", url: `${lib()}/${theirs}/content` });
    expect(content.statusCode, content.body).toBe(200);
    expect(content.body).toBe("shared text");
    const download = await n.req({ method: "GET", url: `${lib()}/${theirs}/download?as=url` });
    expect(download.statusCode, download.body).toBe(200);
    expect((await list(n.req)).files.map((f) => f.id)).toEqual([theirs]);
  });

  it("a group's versions count every ready version; the details list at most twenty", async () => {
    const m = await member();
    const conv = await createConv(m.req, orgId, agentId);
    let last = "";
    for (let i = 0; i < 21; i++) {
      last = await deliver(conv, m.id, `v${i}`, "/workspace/log.txt", "log.txt");
      await at(last, 30 + i);
    }
    const [entry] = (await list(m.req)).files;
    expect(entry).toMatchObject({ id: last, versions: 21 });
    const d = (await m.req({ method: "GET", url: `${lib()}/${last}` })).json() as {
      file: { versions: number };
      versions: unknown[];
    };
    expect(d.file.versions).toBe(21);
    expect(d.versions).toHaveLength(20);
  });

  it("another account gets 404 file.not_found on every route", async () => {
    const m = await member();
    const n = await member();
    const id = await upload(m.id, "mine.html", "text/html", Buffer.from("<p>x</p>"));
    const routes: { method: "GET" | "POST" | "DELETE"; url: string }[] = [
      { method: "GET", url: `${lib()}/${id}` },
      { method: "GET", url: `${lib()}/${id}/content` },
      { method: "GET", url: `${lib()}/${id}/download` },
      { method: "GET", url: `${lib()}/${id}/download?as=url` },
      { method: "GET", url: `${lib()}/${id}/previewers` },
      { method: "GET", url: `${lib()}/${id}/previews/preview-fake/docx` },
      { method: "POST", url: `${lib()}/${id}/html-token` },
      { method: "DELETE", url: `${lib()}/${id}` },
    ];
    for (const r of routes) {
      const res = await n.req(r);
      expect(res.statusCode, `${r.method} ${r.url}`).toBe(404);
      expect(errCode(res), `${r.method} ${r.url}`).toBe("file.not_found");
    }
    expect((await list(n.req)).files).toEqual([]);
    // an unknown id is the same answer
    const unknown = await m.req({ method: "GET", url: `${lib()}/${randomUUID()}` });
    expect(errCode(unknown)).toBe("file.not_found");
    // the file is untouched
    expect((await list(m.req)).files.map((f) => f.id)).toEqual([id]);
  });

  it("deleting a file revokes its shares, and later model requests render the placeholder", async () => {
    const provider = k.app
      .get(ExtensionHost)
      .list("model-provider")
      .find((p) => p.plugin === "model-media")?.impl as MediaProvider;
    const seeing = await createAgent(owner, orgId, { provider: "model-media", model: "see-1" });
    const conv = await createConv(owner, orgId, seeing);
    const id = await seedLibraryFile(k.app, orgId, ownerId, {
      name: "cat.png",
      contentType: "image/png",
      bytes: PNG,
    });
    const post = (payload: Record<string, unknown>) =>
      owner({
        method: "POST",
        url: `/api/v1/orgs/${orgId}/conversations/${conv}/messages`,
        payload,
      });
    expect((await post({ text: "look", files: [id] })).statusCode).toBe(202);
    await waitForTerminal(db, conv);
    const share = await owner({
      method: "POST",
      url: `${lib()}/${id}/shares`,
      payload: { audience: "internal", expiresInDays: 7 },
    });
    expect(share.statusCode, share.body).toBe(201);
    const shareId = (share.json() as { share: { id: string } }).share.id;

    expect((await owner({ method: "DELETE", url: `${lib()}/${id}` })).statusCode).toBe(204);
    const row = await db
      .selectFrom("files")
      .select(["status", "deleted_at"])
      .where("id", "=", id)
      .executeTakeFirstOrThrow();
    expect(row.status).toBe("deleted");
    expect(row.deleted_at).not.toBeNull();
    const revoked = await db
      .selectFrom("file_shares")
      .select(["revoked_at", "revoke_reason"])
      .where("id", "=", shareId)
      .executeTakeFirstOrThrow();
    expect(revoked.revoke_reason).toBe("file_deleted");
    expect(revoked.revoked_at).not.toBeNull();
    // gone from the library; a second delete is not found
    expect((await list(owner)).files.map((f) => f.id)).not.toContain(id);
    expect(errCode(await owner({ method: "DELETE", url: `${lib()}/${id}` }))).toBe(
      "file.not_found",
    );

    provider.requests.length = 0;
    expect((await post({ text: "again" })).statusCode).toBe(202);
    await waitForTerminal(db, conv, 2);
    const [req] = provider.requests.filter(
      (r) => r.purpose !== "suggestion" && !r.system.some((x) => x.text === TITLE_PROMPT),
    );
    const texts = (req as ModelRequest).messages
      .flatMap((msg) => (msg.role === "user" ? msg.content : []))
      .map((b) => (b.type === "text" ? b.text : b.type));
    expect(texts).toContain('[Attachment "cat.png" is no longer available.]');
    expect(texts).not.toContain("image");
  });
});
