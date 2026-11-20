import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import type { ConversationEvent } from "../../src/conversations/events.js";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import {
  type FileCardDetail,
  type FileLimits,
  FileRefSchema,
  THUMBNAIL_MAX_CHARS,
  THUMBNAIL_MAX_EDGE,
} from "../../src/platform/file-ref.js";
import { defineOperation, type PlatformOperation } from "../../src/platform/operation.js";
import { PlatformOperations } from "../../src/platform/registry.js";
import { StorageService } from "../../src/storage/storage.service.js";
import { builtinsOff } from "../helpers/disabled-tools.js";
import { accountsFor } from "../helpers/identity.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import {
  createConv,
  createOrgWithProviders,
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

/**
 * File references through the `Platform` tool and the pipeline (platform web parity spec §5,
 * Task 14): a write that takes a conversation file (`fileId`; a device file is delivered first)
 * resolves it at the policy step (limits, sha256, a thumbnail for an image) into the approval's
 * `detail.file`, and reads it again before the run, which refuses bytes that changed after the
 * person confirmed. A test-only operation is registered after the start.
 */

const fixture = (name: string) =>
  fileURLToPath(new URL(`../fixtures/plugins/${name}/index.ts`, import.meta.url));
const MEM_STORE = fixture("mem-store");
const OP = "platform.probe-file";
const MAX = 64 * 1024;
const CHANGED_TEXT = "The file changed after the person confirmed it; call the operation again.";

/** What the probe's handler saw, per run. */
const seen: { name: string; size: number; sha256: string; contentType: string }[] = [];

const ProbeInput = z.object({ file: FileRefSchema, images: z.boolean().default(false) }).strict();

const probe = defineOperation({
  id: OP,
  description: "Test only: stores a probe file.",
  input: ProbeInput,
  example: { file: { fileId: "7c1a5b0e-9a53-4c6b-8d64-2f5a1b0c3e77" }, images: false },
  authz: { orgAction: "agents.use" },
  mirrors: [],
  confirm: "personal",
  summary: (_i, ctx) => ({
    zh: `保存文件 ${ctx.file?.name ?? "?"}`,
    en: `Store the file ${ctx.file?.name ?? "?"}`,
  }),
  fileRef: (input) => {
    const limits: FileLimits = input.images
      ? { maxBytes: MAX, contentTypes: ["image/png", "image/jpeg", "image/webp"] }
      : { maxBytes: MAX };
    return { ref: input.file, limits };
  },
  run: async (_input, ctx) => {
    const f = ctx.file;
    if (f === undefined) throw new Error("no file");
    seen.push({ name: f.name, size: f.size, sha256: f.sha256, contentType: f.contentType });
    return { stored: true };
  },
}) as PlatformOperation;

let pgc: TestContainer;
let rd: TestContainer;
let db: KernelSchemaDb;
let destroyDb: () => Promise<void>;
let k: TestKernel;
let owner: Req;
let ownerId: string;
let orgId: string;
let agentId: string;

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  const raw = createDb(pgc.url, 3);
  db = kernelDb(raw);
  destroyDb = () => raw.destroy();
  k = await startKernel(
    runConfig(
      { pg: pgc.url, redis: rd.url },
      {
        roles: ["api", "worker"],
        extensions: [MODEL_FAKE, MEM_STORE],
      },
    ),
  );
  k.app.get(PlatformOperations).register([probe]);
  ownerId = (
    await accountsFor(db).createLocal({ login: "owner", password: PW, displayName: "Owner" })
  ).id;
  owner = await session(k, "owner");
  orgId = await createOrgWithProviders(k, owner);
  const res = await owner({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/agents`,
    payload: {
      definition: {
        name: "Mine",
        instructions: "Be helpful.",
        model: { provider: "model-fake", model: "fake-1" },
        disabledTools: builtinsOff("Platform"),
      },
      visibility: "private",
    },
  });
  expect(res.statusCode, res.body).toBe(201);
  agentId = (res.json() as { agent: { id: string } }).agent.id;
});

afterAll(async () => {
  await k?.close();
  await destroyDb?.();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

type Ev<T extends ConversationEvent["type"]> = Extract<ConversationEvent, { type: T }>;
const ofType = <T extends ConversationEvent["type"]>(evs: ConversationEvent[], t: T) =>
  evs.filter((e): e is Ev<T> => e.type === t);
const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const callText = (params: Record<string, unknown>) =>
  `tool:Platform:${JSON.stringify({ action: "call", operation: OP, params })}`;

/** A ready `chat` attachment of `conv`; returns its id. */
async function attachment(conv: string, bytes: Uint8Array, name: string, contentType: string) {
  const id = randomUUID();
  const objectKey = `attachments/${id}`;
  await k.app.get(StorageService).kernel(orgId).put(objectKey, bytes, {
    contentType,
    size: bytes.byteLength,
  });
  await db
    .insertInto("attachments")
    .values({
      id,
      org_id: orgId,
      conversation_id: conv,
      account_id: ownerId,
      name,
      content_type: contentType,
      size: bytes.byteLength,
      object_key: objectKey,
      status: "ready",
      etag: null,
      purpose: "chat",
    })
    .execute();
  return id;
}

const approvalRequested = (conv: string) =>
  waitFor(
    async () => ofType(await eventsOf(db, conv), "approval_requested")[0],
    20_000,
    "approval_requested",
  );

const fileOfApproval = async (id: string) => {
  const row = await db
    .selectFrom("approvals")
    .select(["detail", "scopes"])
    .where("id", "=", id)
    .executeTakeFirstOrThrow();
  return { file: (row.detail as { file?: FileCardDetail } | null)?.file, scopes: row.scopes };
};

const approve = (approvalId: string) =>
  owner({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/approvals/${approvalId}/decision`,
    payload: { decision: "approve", scope: "once" },
  });

const lastResult = async (conv: string) =>
  ofType(await eventsOf(db, conv), "tool_result").at(-1)?.payload;

/** Calls the probe and approves its card; returns the card's file and the call's result. */
async function confirmedCall(conv: string, params: Record<string, unknown>) {
  await postMessage(owner, orgId, conv, callText(params));
  const asked = await approvalRequested(conv);
  const card = await fileOfApproval(asked.payload.approvalId);
  const ok = await approve(asked.payload.approvalId);
  expect(ok.statusCode, ok.body).toBe(200);
  await waitForTerminal(db, conv, 1, 30_000);
  return { card, result: await lastResult(conv) };
}

/** Calls the probe where it is refused before the card; returns the result. */
async function refusedCall(conv: string, params: Record<string, unknown>) {
  await postMessage(owner, orgId, conv, callText(params));
  await waitForTerminal(db, conv, 1, 30_000);
  expect(ofType(await eventsOf(db, conv), "approval_requested")).toEqual([]);
  expect(
    await db.selectFrom("approvals").select("id").where("conversation_id", "=", conv).execute(),
  ).toEqual([]);
  return lastResult(conv);
}

describe("Platform file references", () => {
  it("a conversation attachment resolves with its sha256, bound on a once-only card", async () => {
    const conv = await createConv(owner, orgId, agentId);
    const bytes = new TextEncoder().encode("hello, file reference\n");
    const fileId = await attachment(conv, bytes, "notes.txt", "text/plain");
    const before = seen.length;
    const { card, result } = await confirmedCall(conv, { file: { fileId } });
    expect(card.file).toEqual({
      name: "notes.txt",
      size: bytes.byteLength,
      sha256: sha256(bytes),
      contentType: "text/plain",
    });
    // the card shows these bytes: never remembered
    expect(card.scopes).toEqual(["once"]);
    expect(result?.isError).toBe(false);
    expect(seen.slice(before)).toEqual([
      {
        name: "notes.txt",
        size: bytes.byteLength,
        sha256: sha256(bytes),
        contentType: "text/plain",
      },
    ]);
    // the approvals view carries the file for the card
    const list = await owner({ method: "GET", url: `/api/v1/orgs/${orgId}/approvals` });
    expect(list.statusCode, list.body).toBe(200);
    const views = (list.json() as { approvals: { file?: FileCardDetail }[] }).approvals;
    expect(views.some((a) => a.file?.sha256 === sha256(bytes))).toBe(true);
  });

  it("a device path is refused by the params, naming Deliver", async () => {
    const conv = await createConv(owner, orgId, agentId);
    const result = await refusedCall(conv, { file: { path: "/workspace/out/plugin.tgz" } });
    expect(result?.isError).toBe(true);
    expect(result?.content).toContain("Deliver the file first, then pass its fileId.");
  });

  it("an over-limit file is refused before the card, with no approval row", async () => {
    const conv = await createConv(owner, orgId, agentId);
    const big = new Uint8Array(MAX + 10).fill(0x61);
    const fileId = await attachment(conv, big, "big.txt", "text/plain");
    const result = await refusedCall(conv, { file: { fileId } });
    expect(result?.isError).toBe(true);
    expect(result?.content).toContain(
      `The file is ${MAX + 10} bytes; this operation takes at most ${MAX}.`,
    );
  });

  it("a file of another type is refused before the card", async () => {
    const conv = await createConv(owner, orgId, agentId);
    const fileId = await attachment(conv, new TextEncoder().encode("x"), "a.txt", "text/plain");
    const result = await refusedCall(conv, { file: { fileId }, images: true });
    expect(result?.content).toContain(
      "The file is text/plain; this operation takes image/png, image/jpeg, image/webp.",
    );
  });

  it("an unknown file id is refused before the card with the way to name one", async () => {
    const conv = await createConv(owner, orgId, agentId);
    const result = await refusedCall(conv, { file: { fileId: randomUUID() } });
    expect(result?.content).toContain("is not a file of this conversation");
  });

  it("an image gets a WebP thumbnail of at most 24 KiB and 160 px", async () => {
    const conv = await createConv(owner, orgId, agentId);
    const png = await sharp({
      create: { width: 1200, height: 800, channels: 3, background: { r: 200, g: 40, b: 30 } },
    })
      .png()
      .toBuffer();
    const fileId = await attachment(conv, new Uint8Array(png), "cat.png", "image/png");
    const { card, result } = await confirmedCall(conv, { file: { fileId }, images: true });
    expect(result?.isError).toBe(false);
    const thumb = card.file?.thumbnail;
    expect(thumb).toMatch(/^data:image\/webp;base64,/);
    expect((thumb as string).length).toBeLessThanOrEqual(THUMBNAIL_MAX_CHARS);
    const meta = await sharp(
      Buffer.from((thumb as string).slice("data:image/webp;base64,".length), "base64"),
    ).metadata();
    expect(meta.format).toBe("webp");
    expect(Math.max(meta.width, meta.height)).toBe(THUMBNAIL_MAX_EDGE);
    // the summary names the file the card shows
    const row = await db
      .selectFrom("approvals")
      .select("summary")
      .where("conversation_id", "=", conv)
      .executeTakeFirstOrThrow();
    expect((row.summary as { en: string } | null)?.en).toBe("Store the file cat.png");
  });

  it("a file whose stored bytes change after the card is refused at the run; nothing is stored", async () => {
    const conv = await createConv(owner, orgId, agentId);
    const shown = new TextEncoder().encode("the bytes the person saw\n");
    const fileId = await attachment(conv, shown, "plugin.tgz", "application/gzip");
    await postMessage(owner, orgId, conv, callText({ file: { fileId } }));
    const asked = await approvalRequested(conv);
    expect((await fileOfApproval(asked.payload.approvalId)).file?.sha256).toBe(sha256(shown));
    // the object behind the id is replaced while the card waits (same size: it still opens)
    const other = new TextEncoder().encode("other bytes, same length\n");
    expect(other.byteLength).toBe(shown.byteLength);
    await k.app.get(StorageService).kernel(orgId).put(`attachments/${fileId}`, other, {
      contentType: "application/gzip",
      size: other.byteLength,
    });
    const before = seen.length;
    const ok = await approve(asked.payload.approvalId);
    expect(ok.statusCode, ok.body).toBe(200);
    await waitForTerminal(db, conv, 1, 30_000);
    const result = await lastResult(conv);
    expect(result?.isError).toBe(true);
    expect(result?.content).toContain(CHANGED_TEXT);
    expect(seen.slice(before)).toEqual([]);
  });
});
