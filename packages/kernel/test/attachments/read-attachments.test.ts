import { startTestPostgres, type TestContainer } from "@capybara-hq/testing";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type KernelConfig, KernelConfigSchema } from "../../src/config/schema.js";
import {
  ATTACHMENT_READ_PURGE_JOB,
  AttachmentCleanupJob,
} from "../../src/conversations/attachments.service.js";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { migrate } from "../../src/db/migrator.js";
import { createDb } from "../../src/db/pool.js";
import { LOCKED_JOB_BODY } from "../../src/infra/schedule/locked-tick.js";
import { KERNEL_MIGRATIONS_DIR } from "../../src/kernel.js";
import { PrefixedStorage } from "../../src/storage/storage.service.js";
import { attachmentsFor } from "../helpers/conversations.js";
import { truncateTables } from "../helpers/db.js";
import { MemoryObjectStore } from "../storage/memory-store.js";

/**
 * `read` attachments (vision-read design §1.2 step 4, §1.3): the copy the builtin Read stores with
 * the calling conversation, stored intent first (unbound row, put, bind), capped per conversation,
 * seen by the media lookups only, and purged after the conversation is deleted.
 */

const ORG = "00000000-0000-4000-8000-0000000000a1";
const PNG = new Uint8Array(Buffer.from("89504e470d0a1a0a0000000d49484452", "hex"));

let pg: TestContainer;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let mem: MemoryObjectStore;
let attachments: Record<string, unknown> = {};

const config = (): KernelConfig =>
  KernelConfigSchema.parse({
    db: { url: "postgres://x" },
    redis: { url: "redis://x" },
    masterKey: Buffer.alloc(32, 7).toString("base64"),
    attachments,
  });

const service = () =>
  attachmentsFor({
    db: raw,
    storage: new PrefixedStorage({ provider: () => mem, plugins: async () => [] }),
    config,
    canAccessConversation: async () => true,
    log: { info() {}, warn() {} },
  });

const file = (size = PNG.length) => ({
  name: "shot.png",
  contentType: "image/png",
  data: size === PNG.length ? PNG : new Uint8Array(size),
});

const conversation = async (id: string, deletedHoursAgo?: number) => {
  await sql`insert into capybara.conversations (id, org_id, agent_id, account_id)
    values (${id}, ${ORG}, 'ag1', 'a1')`.execute(raw);
  if (deletedHoursAgo !== undefined) {
    await sql`update capybara.conversations
      set deleted_at = now() - make_interval(hours => ${deletedHoursAgo}) where id = ${id}`.execute(
      raw,
    );
  }
};

const stored = (key: string) => [...mem.objects.keys()].some((k) => k.endsWith(`/${key}`));

const row = (id: string) =>
  db.selectFrom("attachments").selectAll().where("id", "=", id).executeTakeFirst();

const storeOk = async (conversationId: string, size?: number) => {
  const r = await service().storeRead(ORG, conversationId, "a1", file(size));
  if (!r.ok) throw new Error("expected the copy to be stored");
  return r;
};

beforeAll(async () => {
  pg = await startTestPostgres();
  raw = createDb(pg.url, 3);
  db = kernelDb(raw);
  await migrate(pg.url, { schema: "capybara", dir: KERNEL_MIGRATIONS_DIR });
});

afterAll(async () => {
  await raw?.destroy();
  await pg?.stop();
});

beforeEach(async () => {
  await truncateTables(
    db,
    "capybara.attachments, capybara.conversations, capybara.agents, capybara.orgs, capybara.accounts",
  );
  attachments = {};
  mem = new MemoryObjectStore();
  await sql`insert into capybara.accounts (id, display_name) values ('a1', 'A')`.execute(raw);
  await sql`insert into capybara.orgs (id, slug, name) values (${ORG}, 'o1', 'O')`.execute(raw);
  await sql`insert into capybara.agents (id, org_id, owner_account_id, visibility, current_version)
    values ('ag1', ${ORG}, 'a1', 'org', 1)`.execute(raw);
  await conversation("c1");
});

describe("storeRead", () => {
  it("binds a ready row that mediaInfo and fetchMedia return", async () => {
    const r = await storeOk("c1");
    expect(r.size).toBe(PNG.length);
    expect(await row(r.attachmentId)).toMatchObject({
      conversation_id: "c1",
      status: "ready",
      purpose: "read",
      expires_at: null,
      account_id: "a1",
      name: "shot.png",
      content_type: "image/png",
      object_key: `read-images/${r.attachmentId}`,
    });
    expect(stored(`read-images/${r.attachmentId}`)).toBe(true);
    const svc = service();
    expect((await svc.mediaInfo(ORG, "c1", [r.attachmentId])).get(r.attachmentId)).toMatchObject({
      size: PNG.length,
    });
    const got = (await svc.fetchMedia(ORG, "c1", [r.attachmentId])).get(r.attachmentId);
    expect(got?.mediaType).toBe("image/png");
    expect(Buffer.from(got?.data ?? []).equals(Buffer.from(PNG))).toBe(true);
    // another conversation does not see it
    await conversation("c2");
    expect((await svc.fetchMedia(ORG, "c2", [r.attachmentId])).get(r.attachmentId)).toBeNull();
  });

  it("is invisible to the chat attachment lookups", async () => {
    const r = await storeOk("c1");
    const svc = service();
    expect(await svc.listForConversation(ORG, "c1")).toEqual([]);
    expect(await svc.boundRows(ORG, "c1", r.attachmentId)).toEqual([]);
    expect(await svc.openForConversation(ORG, "c1", r.attachmentId)).toBeNull();
  });

  it("falls back to the conversation's account when the call has none", async () => {
    const r = await service().storeRead(ORG, "c1", null, file());
    if (!r.ok) throw new Error("expected the copy to be stored");
    expect((await row(r.attachmentId))?.account_id).toBe("a1");
  });

  it("refuses with reason cap past the per-conversation cap, and always at 0", async () => {
    attachments = { readMaxBytesPerConversation: 100 };
    await storeOk("c1", 60);
    expect(await service().storeRead(ORG, "c1", "a1", file(41))).toEqual({
      ok: false,
      reason: "cap",
    });
    // exactly at the cap still fits; another conversation has its own budget
    await storeOk("c1", 40);
    await conversation("c2");
    await storeOk("c2", 100);
    attachments = { readMaxBytesPerConversation: 0 };
    expect(await service().storeRead(ORG, "c2", "a1", file(1))).toEqual({
      ok: false,
      reason: "cap",
    });
    // a refusal stores nothing
    expect(
      await db
        .selectFrom("attachments")
        .select("id")
        .where("conversation_id", "is", null)
        .execute(),
    ).toEqual([]);
    expect(mem.objects.size).toBe(3);
  });

  it("leaves the unbound row for deleteExpired when the put fails", async () => {
    mem.put = async () => {
      throw new Error("S3 503");
    };
    await expect(service().storeRead(ORG, "c1", "a1", file())).rejects.toThrow("S3 503");
    const [left] = await db.selectFrom("attachments").selectAll().execute();
    expect(left).toMatchObject({ conversation_id: null, status: "pending", purpose: "read" });
    expect(left?.expires_at).not.toBeNull();
  });

  it("a crash after put leaves an unbound row that deleteExpired removes", async () => {
    const id = "00000000-0000-4000-8000-00000000c0de";
    await db
      .insertInto("attachments")
      .values({
        id,
        org_id: ORG,
        account_id: "a1",
        name: "shot.png",
        content_type: "image/png",
        size: PNG.length,
        object_key: `read-images/${id}`,
        status: "pending",
        purpose: "read",
        expires_at: sql<Date>`now() - interval '1 hour'`,
      })
      .execute();
    await mem.put(`kernel/${ORG}/read-images/${id}`, PNG, { contentType: "image/png" });
    expect(await service().deleteExpired()).toBe(1);
    expect(await row(id)).toBeUndefined();
    expect(stored(`read-images/${id}`)).toBe(false);
  });
});

describe("read purge", () => {
  it("removes the rows and objects of a conversation deleted past readPurgeAfterHours", async () => {
    await conversation("old", 25);
    await conversation("recent", 1);
    const gone = await storeOk("old");
    const kept = await storeOk("recent");
    const live = await storeOk("c1");
    // a chat attachment of the old conversation is not this purge's
    await db
      .insertInto("attachments")
      .values({
        id: "chat-1",
        org_id: ORG,
        conversation_id: "old",
        account_id: "a1",
        name: "a.png",
        content_type: "image/png",
        size: 1,
        object_key: "attachments/chat-1",
        status: "ready",
      })
      .execute();

    expect(await service().purgeRead()).toBe(1);
    expect(await row(gone.attachmentId)).toBeUndefined();
    expect(stored(`read-images/${gone.attachmentId}`)).toBe(false);
    for (const id of [kept.attachmentId, live.attachmentId]) {
      expect(await row(id)).toBeDefined();
      expect(stored(`read-images/${id}`)).toBe(true);
    }
    expect(await row("chat-1")).toBeDefined();

    // the hours are read at run time (hot)
    attachments = { readPurgeAfterHours: 1 };
    await sql`update capybara.conversations set deleted_at = now() - interval '2 hours'
      where id = 'recent'`.execute(raw);
    expect(await service().purgeRead()).toBe(1);
    expect(await row(kept.attachmentId)).toBeUndefined();
  });

  it("keeps a row whose object delete failed and retries it on the next run", async () => {
    await conversation("old", 25);
    const r = await storeOk("old");
    const del = mem.delete.bind(mem);
    let fail = 1;
    mem.delete = async (key) => {
      if (fail-- > 0) throw new Error("S3 503");
      return del(key);
    };
    expect(await service().purgeRead()).toBe(0);
    expect((await row(r.attachmentId))?.status).toBe("deleting");
    expect(await service().purgeRead()).toBe(1);
    expect(await row(r.attachmentId)).toBeUndefined();
  });

  it("is an hourly locked cron on the worker's cleanup job (once per tick across replicas)", () => {
    const body = Reflect.getMetadata(LOCKED_JOB_BODY, AttachmentCleanupJob.prototype.purgeRead) as
      | { name: string }
      | undefined;
    expect(body?.name).toBe(ATTACHMENT_READ_PURGE_JOB);
    expect(ATTACHMENT_READ_PURGE_JOB).toBe("attachments-read-purge");
  });
});
