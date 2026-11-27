import { copyFileSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startTestPostgres } from "@capybara-hq/testing";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../../src/db/migrator.js";
import { createDb } from "../../src/db/pool.js";
import { KERNEL_MIGRATIONS_DIR } from "../../src/kernel.js";

/**
 * 0188_file_library.sql (file library spec §1, §9): creates `blobs`, `files`, `conversation_files`,
 * extends `file_shares`, and copies chat attachments, delivered artifacts and share snapshots with
 * preserved ids. Migrates to the file before it, seeds old data, applies it, then runs it again
 * (idempotent: row counts unchanged).
 */
const FILE = "0188_file_library.sql";

let pg: Awaited<ReturnType<typeof startTestPostgres>>;
let db: ReturnType<typeof createDb>;
const dirs: string[] = [];

const copyMigrations = (pred: (f: string) => boolean) => {
  const dir = mkdtempSync(join(tmpdir(), "cap-mig-"));
  dirs.push(dir);
  for (const f of readdirSync(KERNEL_MIGRATIONS_DIR)) {
    if (f.endsWith(".sql") && pred(f)) copyFileSync(join(KERNEL_MIGRATIONS_DIR, f), join(dir, f));
  }
  return dir;
};

const BOUND = "10000000-0000-4000-8000-000000000001";
const UNBOUND = "10000000-0000-4000-8000-000000000002";
const PENDING = "10000000-0000-4000-8000-000000000003";
const NOT_SENT_YET = "10000000-0000-4000-8000-000000000004";
const READ_ATT = "10000000-0000-4000-8000-000000000005";
const V1 = "20000000-0000-4000-8000-000000000001";
const V2 = "20000000-0000-4000-8000-000000000002";
const GEN = "20000000-0000-4000-8000-000000000003";
const SHARE = "30000000-0000-4000-8000-000000000001";
const SHARE_UPLOAD = "30000000-0000-4000-8000-000000000002";

const attachment = (
  id: string,
  account: string,
  conversation: string | null,
  status: string,
  purpose = "chat",
) =>
  sql`insert into capybara.attachments
    (id, org_id, conversation_id, account_id, name, content_type, size, object_key, status, etag,
     pages, expires_at, purpose, created_at)
    values (${id}, 'o1', ${conversation}, ${account}, ${`${id}.pdf`}, 'application/pdf', 42,
      ${`attachments/${id}`}, ${status}, ${`etag-${id}`}, 3,
      ${conversation === null ? "2026-11-29T00:00:00Z" : null}, ${purpose},
      '2026-11-01T00:00:00Z')`.execute(db);

const artifact = (
  conversation: string,
  seq: number,
  id: string,
  sourcePath: string,
  size: number,
) =>
  sql`insert into capybara.conversation_events (conversation_id, seq, type, run_id, payload, created_at)
    values (${conversation}, ${seq}, 'artifact_created', null, ${JSON.stringify({
      artifactId: id,
      name: sourcePath.split("/").pop(),
      contentType: "text/markdown",
      size,
      objectKey: `artifacts/${conversation}/${id}`,
      sourcePath,
      callId: "call1",
      sha256: "a".repeat(64),
    })}::jsonb, ${`2026-11-02T00:00:0${seq}Z`})`.execute(db);

const userMessage = (conversation: string, seq: number, ids: string[]) =>
  sql`insert into capybara.conversation_events (conversation_id, seq, type, run_id, payload)
    values (${conversation}, ${seq}, 'user_message', null, ${JSON.stringify({
      content: [
        { type: "text", text: "look" },
        ...ids.map((id) => ({
          type: "document",
          source: { kind: "ref", attachmentId: id, mediaType: "application/pdf" },
        })),
      ],
      authorAccountId: "a1",
    })}::jsonb)`.execute(db);

const counts = async () => {
  const r = await sql<{ t: string; n: string }>`
    select 'blobs' as t, count(*) as n from capybara.blobs
    union all select 'files', count(*) from capybara.files
    union all select 'conversation_files', count(*) from capybara.conversation_files
    union all select 'shares_with_blob', count(*) from capybara.file_shares where blob_id is not null
  `.execute(db);
  return Object.fromEntries(r.rows.map((x) => [x.t, Number(x.n)]));
};

const file = async (id: string) =>
  (
    await sql<Record<string, unknown>>`select f.*, b.object_key, b.size as blob_size, b.etag,
        b.sha256, b.status as blob_status, b.org_id as blob_org
      from capybara.files f left join capybara.blobs b on b.id = f.blob_id
      where f.id = ${id}`.execute(db)
  ).rows[0];

const link = async (conversation: string, id: string) =>
  (
    await sql<{ role: string; first_seq: string | null; org_id: string }>`select role, first_seq,
      org_id from capybara.conversation_files
      where conversation_id = ${conversation} and file_id = ${id}`.execute(db)
  ).rows[0];

beforeAll(async () => {
  pg = await startTestPostgres();
  db = createDb(pg.url, 3);
  await migrate(pg.url, { schema: "capybara", dir: copyMigrations((f) => f < FILE) });
  await sql`insert into capybara.orgs (id, slug, name) values ('o1', 'o1', 'O')`.execute(db);
  await sql`insert into capybara.accounts (id, display_name) values ('a1', 'A'), ('a2', 'B')`.execute(
    db,
  );
  await sql`insert into capybara.agents (id, org_id, owner_account_id, visibility, current_version)
    values ('ag1', 'o1', 'a1', 'org', 1), ('ag2', 'o1', 'a2', 'org', 1)`.execute(db);
  await sql`insert into capybara.conversations (id, org_id, agent_id, account_id)
    values ('c1', 'o1', 'ag1', 'a1'), ('c2', 'o1', 'ag2', 'a2')`.execute(db);
  // c1: a sent attachment (message seq 2) and one bound by a message still queued (no event)
  await attachment(BOUND, "a1", "c1", "ready");
  await attachment(NOT_SENT_YET, "a1", "c1", "ready");
  await sql`insert into capybara.conversation_events (conversation_id, seq, type, run_id, payload)
    values ('c1', 1, 'user_message', null, ${JSON.stringify({
      content: [{ type: "text", text: "hi" }],
      authorAccountId: "a1",
    })}::jsonb)`.execute(db);
  await userMessage("c1", 2, [BOUND]);
  await userMessage("c1", 3, [BOUND]);
  // a finalized composer file not sent yet, an upload never finalized, a Read copy (not chat)
  await attachment(UNBOUND, "a1", null, "ready");
  await attachment(PENDING, "a1", null, "pending");
  await attachment(READ_ATT, "a1", "c1", "ready", "read");
  // c2: two versions of one delivered file, one generated image
  await artifact("c2", 4, V1, "out/report.md", 10);
  await artifact("c2", 5, V2, "out/report.md", 20);
  await artifact("c2", 6, GEN, "generated/cat.png", 30);
  // shares: one of a delivered version (live snapshot), one of the bound upload (already swept)
  await sql`insert into capybara.file_shares
    (id, org_id, code, conversation_id, file_id, source_path, created_by, audience, name,
     content_type, size, object_key)
    values
    (${SHARE}, 'o1', 'code1', 'c2', ${V2}, 'out/report.md', 'a2', 'internal', 'report.md',
      'text/markdown', 20, ${`shares/${SHARE}/1`}),
    (${SHARE_UPLOAD}, 'o1', 'code2', 'c1', ${BOUND}, null, 'a1', 'external', 'x.pdf',
      'application/pdf', 42, null)`.execute(db);
  await migrate(pg.url, { schema: "capybara", dir: copyMigrations((f) => f <= FILE) });
});

afterAll(async () => {
  await db?.destroy();
  await pg?.stop();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe("0188_file_library", () => {
  it("turns a sent chat attachment into a ready upload referenced by its conversation", async () => {
    const f = await file(BOUND);
    expect(f).toMatchObject({
      org_id: "o1",
      account_id: "a1",
      name: `${BOUND}.pdf`,
      content_type: "application/pdf",
      size: "42",
      pages: 3,
      origin: "upload",
      status: "ready",
      agent_id: null,
      source_conversation_id: "c1",
      source_path: null,
      staging_key: null,
      expires_at: null,
      object_key: `attachments/${BOUND}`,
      blob_size: "42",
      etag: `etag-${BOUND}`,
      sha256: null,
      blob_status: "ready",
      blob_org: "o1",
    });
    expect(f?.created_at).toEqual(new Date("2026-11-01T00:00:00Z"));
    expect(await link("c1", BOUND)).toEqual({ role: "attached", first_seq: "2", org_id: "o1" });
    // bound by a queued message not yet in the log: referenced, no seq known
    expect(await link("c1", NOT_SENT_YET)).toEqual({
      role: "attached",
      first_seq: null,
      org_id: "o1",
    });
  });

  it("turns unsent and unfinished chat uploads into draft and uploading files", async () => {
    expect(await file(UNBOUND)).toMatchObject({
      status: "draft",
      origin: "upload",
      source_conversation_id: null,
      expires_at: new Date("2026-11-29T00:00:00Z"),
      object_key: `attachments/${UNBOUND}`,
      blob_status: "ready",
    });
    expect(await file(PENDING)).toMatchObject({
      status: "uploading",
      blob_id: null,
      staging_key: `attachments/${PENDING}`,
      expires_at: new Date("2026-11-29T00:00:00Z"),
    });
    expect(await file(READ_ATT)).toBeUndefined();
    const links = await sql`select 1 from capybara.conversation_files
      where file_id in (${UNBOUND}, ${PENDING})`.execute(db);
    expect(links.rows).toEqual([]);
  });

  it("turns every delivered version into a file owned by the conversation's owner", async () => {
    for (const [id, origin, size, seq] of [
      [V1, "delivered", "10", "4"],
      [V2, "delivered", "20", "5"],
      [GEN, "generated", "30", "6"],
    ] as const) {
      expect(await file(id)).toMatchObject({
        account_id: "a2",
        agent_id: "ag2",
        origin,
        status: "ready",
        size,
        content_type: "text/markdown",
        source_conversation_id: "c2",
        object_key: `artifacts/c2/${id}`,
        blob_size: size,
        etag: null,
        sha256: null,
        blob_status: "ready",
      });
      expect(await link("c2", id)).toEqual({ role: "delivered", first_seq: seq, org_id: "o1" });
    }
    expect(await file(V1)).toMatchObject({ source_path: "out/report.md", name: "report.md" });
    expect(await file(GEN)).toMatchObject({ source_path: "generated/cat.png" });
  });

  it("moves a share's snapshot into a blob and links its source file", async () => {
    const r = await sql<Record<string, unknown>>`select s.object_key as share_key, s.source_file_id,
        s.conversation_id, b.object_key, b.size, b.status, b.org_id
      from capybara.file_shares s left join capybara.blobs b on b.id = s.blob_id
      where s.id = ${SHARE}`.execute(db);
    expect(r.rows[0]).toEqual({
      share_key: null,
      source_file_id: V2,
      conversation_id: "c2",
      object_key: `shares/${SHARE}/1`,
      size: "20",
      status: "ready",
      org_id: "o1",
    });
    const swept = await sql<Record<string, unknown>>`select blob_id, source_file_id
      from capybara.file_shares where id = ${SHARE_UPLOAD}`.execute(db);
    expect(swept.rows[0]).toEqual({ blob_id: null, source_file_id: null });
  });

  it("lets library shares have no conversation and be revoked for a deleted file", async () => {
    await sql`insert into capybara.file_shares
      (id, org_id, code, conversation_id, file_id, created_by, audience, name, content_type, size,
       revoked_at, revoke_reason)
      values ('30000000-0000-4000-8000-0000000000ff', 'o1', 'code3', null, ${UNBOUND}, 'a1',
        'internal', 'x', 'text/plain', 1, now(), 'file_deleted')`.execute(db);
    await expect(
      sql`update capybara.file_shares set revoke_reason = 'nope'
        where id = '30000000-0000-4000-8000-0000000000ff'`.execute(db),
    ).rejects.toThrow(/file_shares_revoke_reason_check/);
    await sql`delete from capybara.file_shares
      where id = '30000000-0000-4000-8000-0000000000ff'`.execute(db);
  });

  it("enforces the file and blob invariants", async () => {
    await expect(
      sql`insert into capybara.files (id, org_id, account_id, name, content_type, size, origin, status)
        values ('bad1', 'o1', 'a1', 'x', 'text/plain', 1, 'upload', 'ready')`.execute(db),
    ).rejects.toThrow(/check/);
    await expect(
      sql`insert into capybara.blobs (id, org_id, sha256, size, object_key, status)
        values ('bad2', 'o1', 'XYZ', 1, 'k', 'ready')`.execute(db),
    ).rejects.toThrow(/check/);
    const sha = "b".repeat(64);
    await sql`insert into capybara.blobs (id, org_id, sha256, size, object_key, status)
      values ('ok1', 'o1', ${sha}, 1, 'blobs/x', 'ready')`.execute(db);
    await expect(
      sql`insert into capybara.blobs (id, org_id, sha256, size, object_key, status)
        values ('ok2', 'o1', ${sha}, 1, 'blobs/y', 'ready')`.execute(db),
    ).rejects.toThrow(/blobs_org_sha256_key/);
    await sql`delete from capybara.blobs where id = 'ok1'`.execute(db);
  });

  it("ships the org_scope policy on the three new tables", async () => {
    const r = await sql<{ tablename: string; qual: string; with_check: string }>`
      select tablename, qual, with_check from pg_policies
      where schemaname = 'capybara' and policyname = 'org_scope'
        and tablename in ('blobs', 'files', 'conversation_files')
      order by tablename`.execute(db);
    expect(r.rows.map((x) => x.tablename)).toEqual(["blobs", "conversation_files", "files"]);
    for (const row of r.rows) {
      expect(row.qual).toMatch(/rls_admits\(org_id\)/);
      expect(row.with_check).toMatch(/rls_admits\(org_id\)/);
    }
  });

  it("is idempotent", async () => {
    const before = await counts();
    expect(before).toEqual({ blobs: 7, files: 7, conversation_files: 5, shares_with_blob: 1 });
    const text = readFileSync(join(KERNEL_MIGRATIONS_DIR, FILE), "utf8");
    await sql.raw(`set search_path to capybara; ${text}`).execute(db);
    expect(await counts()).toEqual(before);
  });
});
