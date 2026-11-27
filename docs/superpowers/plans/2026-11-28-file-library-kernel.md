# File library, part 1: kernel, SDK and the composer's upload path

> **For agentic workers:** REQUIRED SUB-SKILL: wave-planned-subagent-development (a layer on
> superpowers:subagent-driven-development). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Files become account-owned rows referenced by conversations, bytes become per-org
content-addressed blobs shared by files and shares, existing attachments/artifacts/shares are
migrated with preserved ids, and the kernel serves the library routes the Files page (part 2) needs.

**Spec:** [2026-11-27-file-library-design.md](../specs/2026-11-27-file-library-design.md) (binding,
including its "Maintainer decisions"). Issue #971.

**Architecture:** One expand migration (`0188_file_library.sql`) creates `blobs`, `files`,
`conversation_files`, extends `file_shares`, copies data with preserved ids and ships RLS policies. A
new `BlobsService` owns bytes (dedup rule, intent-first writes, outbox deletions); a new
`LibraryFilesService` owns file rows (upload, finalize, attach, delete, list); every byte read in the
kernel resolves `file → blob` (never an event's `objectKey`, never `attachments` for chat). Shares
point at blobs. A daily `blob-sweep` and a resumable `file-library-hash` job keep storage tight.

**Tech stack:** NestJS kernel, Kysely on PostgreSQL, BullMQ, object-store@1, vitest + testcontainers.

**Delivery:** PR 1 (`feat/file-library-kernel`, this plan) carries the kernel, the SDK change and
the minimal web changes that keep the composer working on the new routes (`check:web-api-parity`
fails otherwise). PR 2 (`feat/file-library-web`, plan `2026-11-28-file-library-web.md`) carries the
Files page, navigation and the composer's search query, stacked on PR 1.

## Cross-cutting rules (every task)

Read AGENTS.md and the area skill named in the task before writing code.

- **Every byte read goes `file → blob`.** Never read by an `artifact_created.objectKey` (a hashing
  merge can delete that object) and never resolve a chat file through `attachments`. `attachments`
  keeps only the non-chat purposes `read`, `skill-package`, `agent-avatar`.
- **Refs resolve two ways.** A media ref id is either a `files` id referenced by the conversation
  (`conversation_files`) or a `read`-purpose attachment bound to it (Read copies, tool-result images).
  Both resolvers stay; a lookup tries files first, then `read` attachments.
- **Reads check `size` + `etag`** of the blob exactly like `attachmentContentMatches` does today; a
  mismatch is "gone" (placeholder), never served.
- **Org scope.** Every query on `blobs` / `files` / `conversation_files` / `file_shares` runs under the
  org scope; deployment-wide loops sit in `asPlatform(reason)` with a `// org-filter: deployment-wide …`
  marker; per-org work goes through `runJob` with `orgId` in the job data.
- **Outbox.** Every owed object deletion is an outbox row in the same transaction, deterministic id
  without `:` (`blob-delete-<blobId>`, `file-staging-delete-<fileId>`), registered in
  `infra/outbox/registry.ts`, dispatched in `runtime/maintenance.ts`. The handler re-checks the row
  before deleting (a blob still `ready` and referenced is never deleted; a staging key adopted by a
  blob is never deleted).
- **No process state, no timers.** Locks via `LockService` only outside transactions; concurrent
  finalizes resolve through the `(org_id, sha256)` unique index.
- **Comments, test titles, errors in English.** Tests: integration by default; a new unit or container
  test joins its checked-in list (see test-portfolio spec). No fixed sleeps, no per-test timeouts.
- **Commits:** Conventional Commits, body lines ≤ 100, end with
  `Co-Authored-By: Capybara <noreply@capybarahq.com>`, `Refs #971`. Stage only your own paths.
- Run tests from the repo root: `pnpm exec vitest run <path>`.

## Shared interfaces (fixed up front so waves can run in parallel)

```ts
// packages/kernel/src/files/blobs.service.ts
export type BlobRow = { id: string; orgId: string; sha256: string | null; size: number;
  etag: string | null; objectKey: string; status: "pending" | "ready" | "deleting" | "gone" };
export const blobObjectKey = (sha256: string) => `blobs/${sha256}`;
export const stagingObjectKey = (fileId: string) => `uploads/${fileId}`;
@Injectable() export class BlobsService {
  /** Kernel-written bytes (deliveries): reuse a ready blob with this hash (any dedup_after), else
   *  pending row (own tx) → put blobs/<sha> → ready. Returns the ready blob. */
  ensureFromBytes(orgId: string, sha256: string, bytes: Uint8Array,
    opts: { contentType: string; signal?: AbortSignal }): Promise<BlobRow>;
  /** Mandatory tx. Upload finalize: dedup to a ready blob with dedup_after <= now(), else adopt the
   *  staging object (ON CONFLICT (org_id, sha256) DO NOTHING; loser points at winner). Owes the
   *  staging deletion when not adopted. */
  resolveUpload(orgId: string, fileId: string, v: { sha256: string; size: number;
    etag: string | null }): Promise<{ blob: BlobRow; adopted: boolean }>;
  /** Open bytes with the size/etag check; null when certainly gone, throws on transient errors. */
  open(orgId: string, blob: Pick<BlobRow, "id" | "objectKey" | "size" | "etag">,
    opts?: { range?: { start: number; end?: number }; signal?: AbortSignal }):
    Promise<{ head: ObjectHead; body: ReadableStream<Uint8Array> } | null>;
  head(orgId: string, blob: Pick<BlobRow, "id" | "objectKey" | "size" | "etag">): Promise<ObjectHead | null>;
}

// packages/kernel/src/files/library-files.service.ts
export type FileOrigin = "upload" | "delivered" | "generated";
export type FileStatus = "uploading" | "draft" | "ready" | "deleted";
export type LibraryFile = { id: string; orgId: string; accountId: string; blobId: string | null;
  name: string; contentType: string; size: number; pages: number | null; origin: FileOrigin;
  status: FileStatus; agentId: string | null; sourceConversationId: string | null;
  sourcePath: string | null; createdAt: Date; deletedAt: Date | null };
/** A file a conversation (or its root / sub-agent set) refers to, with its blob. */
export type ReferencedFile = LibraryFile & { blob: BlobRow; conversationId: string };
@Injectable() export class LibraryFilesService {
  create(orgId, accountId, input: { name; contentType; size; sha256; purpose: "composer" | "library" }):
    Promise<{ file: FileView; upload: PresignedUpload | null; expiresAt: string | null }>;
  finalize(orgId, accountId, fileId): Promise<FileView>;
  discard(orgId, accountId, fileId): Promise<void>;           // composer removal before send
  /** Mandatory tx. Replaces AttachmentsService.bindForMessage. */
  attachForMessage(orgId, conversationId, accountId, ids: readonly string[], firstSeq?: number):
    Promise<LogContentBlock[]>;
  /** Mandatory tx. Delivery rows (id = artifactId), idempotent (ON CONFLICT DO NOTHING). */
  recordDelivered(orgId, conversationId, rows: readonly { id; blobId; name; contentType; size;
    origin: "delivered" | "generated"; sourcePath; agentId: string | null; firstSeq: number }[]): Promise<void>;
  /** Files referenced by any of the given conversations, status ready, blob ready. */
  referenced(orgId, conversationIds: readonly string[], ids?: readonly string[]): Promise<ReferencedFile[]>;
  owned(orgId, accountId, fileId): Promise<LibraryFile & { blob: BlobRow | null }>; // file.not_found otherwise
  delete(orgId, accountId, fileId): Promise<void>;
}

// packages/kernel/src/shares/revoke.ts (extended, task K7)
revokeSharesIn(db, outbox, where: { conversationId } | { orgId; createdBy } | { shareIds } | { fileIds: string[] },
  reason: LifecycleRevokeReason /* + "file_deleted" */): Promise<number>;
```

Exact parameter types are the implementer's to settle in K4; later tasks read K4's code, not this
sketch, when they differ.

## Wave plan

| Task | Depends on | Files / areas | Risk | Wave | Review |
|---|---|---|---|---|---|
| K1 Migration 0188 + schema types + migration test | – | `migrations/0188_file_library.sql`, `db/kernel-schema.ts`, `test/migrations/0188.test.ts` | high | 1 | alone, most capable |
| K2 Ref rename `attachmentId`→`fileId` (SDK + log alias + readers), `FilePreviewArgs.conversationId?`, sdk-api, changeset | – | `plugin-sdk/src/{model,file-preview}.ts`, `conversations/events.ts`, `runtime/**`, `evals/reconstruct.ts`, `tools/result-images.ts`, `tools/builtins/sandbox/read.ts`, the block builder in `attachments.service.ts`, sdk-api report, `.changeset/*`, web mirror types | normal (replay) | 1 | batched + zero-drift evidence |
| K3 Errors + config `files.deletedRetentionDays` | – | `errors.ts`, `config/schema.ts`, `docs/config.md`, web `messages/{zh,en}.json` (errors.file only) | normal | 1 | batched |
| K4 Blobs + upload/finalize/discard/attach + draft cleanup + files controller (create/finalize/discard/limits) + outbox handlers + dual-replica finalize test | K1, K3 | `files/blobs.service.ts`, `files/library-files.service.ts`, `files/library.module.ts`, `files/library.controller.ts`, `files/library.schemas.ts`, `files/draft-cleanup.job.ts`, outbox registry, maintenance dispatch, worker module, `attachments.controller.ts` (remove chat POST/finalize), attachments service chat paths, platform-ops exemption check, tests | high | 2 | alone |
| K5 Read path: send, media, conversation files, FetchAttachment, Deliver `file_id`, previewer/html resolvers, artifact download | K2, K4 | `conversations/{conversations.service,queue.service,files,artifacts}.ts`, `runtime/run-steps.ts`, `conversations/prompt-suggestions.ts`, `evals/{step,run}-replay.ts`, `tools/builtins/{conversation-files,sandbox/fetch-attachment}.ts`, `files/previewers.ts` (resolver only), `html/html-document.service.ts`, `platform/file-ref.ts`, tests | high (agent reach) | 3 | alone |
| K6 Deliveries on blobs + channel delivery | K4 | `tools/builtins/artifacts.ts`, `tools/builtins/image/generate.ts` (deps only), `channels/{file-delivery,outbound}.ts`, tests | high (intent-first) | 3 | alone |
| K7 Shares on blobs + library share create + revoke by file | K5 | `shares/**`, `migrations` none, tests | high | 4 | alone |
| K8 Library routes (list/get/content/download/previewers/previews/html-token/usage/delete) + embed token for library files + Platform ops/exclusions | K5 | `files/library.controller.ts` (read routes), `files/library-query.ts`, `files/previewers.{ts,controller.ts}` (file-scoped twins), `ui/{embed-token,views}.ts`, `html/*` (file token kind), `platform/{ops/files.ops.ts,route-schemas.ts,exclusions.ts,platform-ops.module.ts}`, tests | normal | 4 | batched |
| K9 Blob sweep + hashing job + dual-replica tests | K6, K7 | `files/blob-sweep.job.ts`, `files/hash-job.ts`, worker module, queue names, `test/files/sweep*.test.ts`, container tests | high | 5 | alone |
| K10 Web adaptation (composer on `/files`, hashing, `sourceUrls`, ref alias in timeline) | K4, K5 | `apps/web/src/lib/{attachments,file-source,conversations,timeline}.ts`, `components/use-draft-files.ts`, conversation components reading refs, web tests | normal | 5 | batched |
| K11 AGENTS.md area rule + final verify | all | `AGENTS.md`, skill touch-ups (writing-object-store-providers key list) | normal | 6 | final review |

K7 and K8 share `files/library.controller.ts`? No: K7 adds `POST files/:id/shares` to
`shares/shares.controller.ts`; K8 owns `files/library.controller.ts`. K8's DELETE calls
`revokeSharesIn(..., { fileIds }, "file_deleted")` from K7; K8 writes against the signature above
and K7 lands first within the wave if merge order matters (cherry-pick order K7, K8).

---

## Task K1: Migration 0188, schema types, migration test (high)

**Read first:** writing-migrations skill; `migrations/0161_file_shares.sql`, `0182_rls_policies.sql`,
`0187_*.sql` (policy style); `test/migrations/0143.test.ts`, `0163.test.ts` (test pattern).

**Files:** create `packages/kernel/src/migrations/0188_file_library.sql`,
`packages/kernel/test/migrations/0188.test.ts`; modify `packages/kernel/src/db/kernel-schema.ts`
(add `BlobsTable`, `FilesTable`, `ConversationFilesTable`, extend `FileSharesTable`, register them
on the `KernelDatabase` interface).

Schema (ids `text`, like the rest of the kernel):

- `blobs (id text PK, org_id text NOT NULL REFERENCES orgs(id) ON DELETE CASCADE, sha256 text NULL
  CHECK (sha256 ~ '^[0-9a-f]{64}$'), size bigint NOT NULL CHECK (size >= 0), etag text, object_key
  text NOT NULL, status text NOT NULL CHECK (status IN ('pending','ready','deleting','gone')),
  dedup_after timestamptz NOT NULL DEFAULT now(), created_at timestamptz NOT NULL DEFAULT now())`;
  `CREATE UNIQUE INDEX blobs_org_sha256_key ON blobs (org_id, sha256) WHERE sha256 IS NOT NULL`;
  `blobs_unhashed_idx (org_id, id) WHERE sha256 IS NULL`; `blobs_status_idx (status, created_at)
  WHERE status <> 'ready'`.
- `files (id text PK, org_id … CASCADE, account_id text NOT NULL REFERENCES accounts(id) ON DELETE
  CASCADE, blob_id text REFERENCES blobs(id), name text NOT NULL, content_type text NOT NULL, size
  bigint NOT NULL, pages integer, origin text NOT NULL CHECK (origin IN
  ('upload','delivered','generated')), status text NOT NULL CHECK (status IN
  ('uploading','draft','ready','deleted')), agent_id text, source_conversation_id text REFERENCES
  conversations(id) ON DELETE SET NULL, source_path text, staging_key text, expires_at timestamptz, created_at
  timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz, CHECK (status = 'uploading' OR blob_id
  IS NOT NULL))`. Indexes: `files_library_idx (org_id, account_id, created_at DESC, id DESC) WHERE
  status = 'ready'`; `files_blob_idx (blob_id)`; `files_expiry_idx (expires_at) WHERE status IN
  ('uploading','draft')`; `files_deleted_idx (deleted_at) WHERE status = 'deleted'`;
  `files_source_idx (source_conversation_id, source_path)`; search: `files_name_lower_idx (org_id,
  account_id, lower(name) text_pattern_ops) WHERE status='ready'` (prefix-free `q` search uses
  `position(lower($q) in lower(name)) > 0` over the account's rows, bounded by the library index;
  pg_trgm is not assumed present: record this choice in the migration header).
  `agent_id` has no FK (agents can be deleted; the library keeps the id as a label).
- `conversation_files (conversation_id text REFERENCES conversations(id) ON DELETE CASCADE, file_id
  text REFERENCES files(id) ON DELETE CASCADE, org_id … CASCADE, role text NOT NULL CHECK (role IN
  ('attached','delivered')), first_seq bigint, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY
  KEY (conversation_id, file_id))`; `conversation_files_file_idx (file_id)`.
- `file_shares`: `ADD COLUMN IF NOT EXISTS blob_id text REFERENCES blobs(id)`, `source_file_id text
  REFERENCES files(id) ON DELETE SET NULL`; `ALTER COLUMN conversation_id DROP NOT NULL` (library
  shares have no conversation); replace the `revoke_reason` check to add `'file_deleted'` (needs the
  `-- capybara:allow-destructive <reason>` comment on the `DROP CONSTRAINT`); `file_shares_blob_idx
  (blob_id) WHERE blob_id IS NOT NULL`; `file_shares_source_file_idx (source_file_id)`.
- RLS: `DROP POLICY IF EXISTS org_scope ON <t>; CREATE POLICY org_scope ON <t> USING
  (rls_admits(org_id)) WITH CHECK (rls_admits(org_id));` for `blobs`, `files`, `conversation_files`.

Data copy (idempotent: every insert `ON CONFLICT DO NOTHING`, every update guarded):

Migrated blob ids are derived, so a re-run and the file rows compute the same id:
`md5('blob:' || org_id || '/' || object_key)::uuid::text`.

1. Chat attachments `purpose='chat' AND status='ready' AND conversation_id IS NOT NULL` → blob
   (derived id, `sha256 NULL, size, etag, object_key, status 'ready', dedup_after now()`); file
   (`id = attachment id, account_id, blob_id, name, content_type, size, pages, origin 'upload',
   status 'ready', source_conversation_id = conversation_id, created_at`); conversation_files
   (`role 'attached', first_seq` = the seq of the first `user_message` event whose payload contains
   the id, or NULL when not found — use a lateral subquery over `conversation_events` filtered by
   conversation and `payload::text LIKE '%' || id || '%'`, measured acceptable since it runs once).
2. Ready chat attachments with `conversation_id IS NULL` (finalized, not sent) → file `draft` with
   `expires_at` kept, blob as above. Pending chat attachments → file `uploading`, `blob_id NULL`,
   `expires_at` kept (the staging key is the old key; `file-draft-cleanup` deletes
   `attachments/<id>` for migrated uploading rows: K4 handles keys by reading the row, see K4).
   Store the old key for uploading rows: add `files.staging_key text` (null for new rows, which use
   `uploads/<id>`). Simpler and explicit; document it in the migration.
3. Every `artifact_created` event (distinct `payload->>'artifactId'`, earliest event per id) → blob
   keyed by its `objectKey` (dedup identical keys via the md5 id), file (`id = artifactId`, owner =
   `conversations.account_id` of the event's conversation, `origin` = `'generated'` when
   `sourcePath LIKE 'generated/%'` else `'delivered'`, `agent_id = conversations.agent_id`,
   `source_conversation_id`, `source_path`, `size`, `content_type`, `name`, `status 'ready'`,
   `created_at = event created_at`), conversation_files (`role 'delivered'`, `first_seq` = event seq).
   Check the actual column names on `conversations` (`account_id`/`owner`, `agent_id`) before
   writing the SQL. Rows of deleted conversations are migrated too (maintainer decision: files stay).
4. Shares: for every share with `object_key IS NOT NULL` → blob keyed by its snapshot key, set
   `blob_id`, set `source_file_id = file_id` when a file with that id exists; then
   `object_key = NULL` for those rows (the blob owns the object now; K7 changes liveness to
   `blob_id IS NOT NULL`).

**Test (`test/migrations/0188.test.ts`, integration):** migrate to 0187, seed an org, two accounts,
a conversation per account, chat attachments (bound ready, unbound ready, pending), two
`artifact_created` events with the same `sourcePath` (two versions) and one `generated/…`, a share
with a snapshot key; migrate 0188; assert: every old id is a `files` row with the right owner/
origin/status, blobs carry the old keys and sizes/etags, conversation_files rows and `first_seq`,
share has `blob_id` and null `object_key`, RLS policies exist on the three tables, re-running the
file is a no-op (row counts equal). Add the test file to the integration list if the portfolio
requires (integration is the default).

- [ ] Write the failing migration test; run it (fails: no file).
- [ ] Write the migration and schema types; run the test until green; `pnpm check:migrations`,
      `pnpm check:org-filter`.
- [ ] Commit `feat(kernel): file library schema and data migration`.

## Task K2: Ref rename, SDK change, zero-drift (normal, replay-sensitive)

**Read first:** replay-evals skill; `packages/plugin-sdk/src/model.ts` (`MediaSource`,
`validateMediaBlock`), `conversations/events.ts:389-400, 599-627, 2118`, `runtime/context/build.ts`,
`evals/reconstruct.ts:480-520`.

- [ ] **Before:** run `pnpm exec vitest run packages/kernel/test/evals/reconstruct.test.ts
      packages/kernel/test/evals/step-replay.test.ts packages/kernel/test/evals/run-replay.test.ts`
      and record the pass list in the report.
- [ ] SDK: `MediaSource = { kind: "base64"; data } | { kind: "ref"; fileId: string }`; rename
      `isAttachmentId` → keep as is or add `isFileId` (same regex) and update `validateMediaBlock`
      messages to "file id". `FilePreviewConversationArgs.conversationId?: string` (doc comment: absent
      for a library file previewed outside a conversation). Update SDK tests.
- [ ] Log schema: `RefMediaSourceSchema` accepts `{ kind: "ref", fileId }` and, as a parse alias,
      `{ kind: "ref", attachmentId }` mapped to `fileId` (a `z.preprocess` or `z.union(...).transform`;
      keep the compile-time equality with the SDK type passing). The stored JSON is never rewritten.
      Add a unit test: an old event with `attachmentId` parses to `fileId`; a new one round-trips.
- [ ] Mechanically switch every reader of `source.attachmentId` to `source.fileId` (list in the
      fact sheet: `runtime/context/build.ts`, `runtime/model-call.ts`, `runtime/media-cache.ts`,
      `evals/reconstruct.ts`, `tools/result-images.ts`, `tools/builtins/sandbox/read.ts`,
      `conversations/attachments.service.ts` block builder, `conversations/queue.service.ts`). Record
      fields that are not content blocks keep their names (`model_call.request.media[].attachmentId`,
      `tool_result.media[].attachmentId`, `media_excluded.attachmentIds`, `QueuedFile.attachmentId`):
      no format churn there. The media cache key must not change value (it is keyed by the id).
- [ ] Web mirror: `apps/web/src/lib/conversations.ts` `MediaSource` becomes
      `{ kind: "ref"; fileId?: string; attachmentId?: string }` with a helper `refId(source)` returning
      `fileId ?? attachmentId` (the events API serves stored payloads, so old logs carry
      `attachmentId`); switch web readers (`timeline.ts`, `Thread.tsx`, `PendingBubbles.tsx`,
      `ConversationView.tsx`) to `refId`. Verify how the events route serializes payloads; if it
      re-parses through the schema, the alias already yields `fileId` and the helper is still harmless.
- [ ] `pnpm gen:sdk-api`; add `.changeset/file-library-sdk.md` bumping `@capybara-hq/plugin-sdk`
      (patch/minor per the repo's rc convention: look at recent changesets) describing both changes.
- [ ] **After:** rerun the three replay test files; the pass list must equal the before list, and
      add a reconstruct case: a log with `attachmentId` refs reconstructs with zero drift.
- [ ] `pnpm typecheck`, `pnpm check:sdk-api`; commit `refactor(sdk): media refs name a file id`.

## Task K3: Errors and config (normal)

**Read first:** adding-config skill; `errors.ts`; `config/schema.ts` (`storage.purgeDeletedOrgsAfterDays`).

- [ ] `ERROR_CODES`: `"file.not_found": 404`, `"file.not_ready": 409`, `"file.hash_mismatch": 422`,
      `"file.deleted": 410`, `"file.too_large": 413`, `"file.type_not_allowed": 415`,
      `"file.too_many_pending": 429` (the attachment.* codes stay for non-chat purposes).
- [ ] Config: top-level `files: z.strictObject({ deletedRetentionDays: z.number().int().positive()
      .default(30).meta(meta({ description: "Days a deleted file keeps its bytes before the blob sweep
      may delete them." })) }).default({ deletedRetentionDays: 30 })`. Upload limits keep reading
      `attachments.*` (max size, types, `unboundTtlHours`, `maxPerMessage`). `pnpm gen:config-docs`.
- [ ] Web copy: `errors.file.*` in `apps/web/messages/zh.json` and `en.json` (zh actionable, e.g.
      `hash_mismatch`: "文件在上传时发生变化，请重新上传。"); `pnpm check:i18n`,
      `pnpm exec vitest run tools/checks/test/error-copy.test.ts`.
- [ ] Commit `feat(kernel): file library error codes and retention config`.

## Task K4: Blobs, upload, finalize, attach, draft cleanup (high)

**Read first:** writing-kernel-api, writing-object-store-providers; `attachments.service.ts`
(create / finalize / sniff / pages / `deleteExpired` claim pattern / `bindForMessage`),
`shares/share-objects.ts` (outbox delete handler), `runtime/maintenance.ts`, `infra/outbox/registry.ts`,
`roles/worker.module.ts`, `tools/checks/src/platform-ops.ts` (`ATTACHMENT_ROUTES` exemption).

Create `files/blobs.service.ts`, `files/library-files.service.ts`, `files/library.module.ts`
(`LibraryFilesModule`, imports `StorageModule`, `ConversationAccessModule`, `OutboxModule` as needed;
exports both services), `files/library.controller.ts` (`@Controller("api/v1/orgs/:orgId/files")`,
every route `@OrgAction("agents.use")` + `requireUser`), `files/library.schemas.ts` (zod schemas,
`createZodDto`, a `LIBRARY_FILE_ROUTES` export for Platform), `files/draft-cleanup.job.ts`,
`files/blob-objects.ts` (outbox handlers `blob-delete`, `file-staging-delete`).

Behavior (spec §3, §4 "Sending"):

- `POST /files` body `{ name, contentType, size, sha256 (hex64), purpose: "composer" | "library" }`
  (strict). Admission = today's `admit()` for chat (types, `attachments.maxBytes`, pending cap counted
  over the account's `uploading`+`draft` files). **Instant path** only when the caller has a `ready`
  or `draft` file whose ready blob has this sha256: insert a new file row on that blob (`draft` for
  composer with `expires_at`, `ready` for library) and answer `{ file, upload: null, expiresAt }`.
  Otherwise insert `uploading` (`expires_at` +`unboundTtlHours`) **before** presigning
  `uploads/<fileId>` with `maxSize = size`, TTL 300 s. Response shape identical in both cases
  except `upload`.
- `POST /files/:id/finalize` (uploader only; idempotent when already draft/ready): HEAD (missing →
  `file.not_ready`), size/type checks, sniff, PDF pages (reuse the exported helpers from
  `attachments.service.ts`, move them to `files/content-checks.ts` if cleaner), **stream the whole
  object to compute sha256**; mismatch → delete the staging object, mark the row expired, throw
  `file.hash_mismatch`. Then one `@Transactional()`: `BlobsService.resolveUpload` (dedup only to a
  `ready` blob with `dedup_after <= now()`; else insert a blob adopting `uploads/<id>` with
  `etag` from HEAD and `dedup_after = now() + interval '300 seconds'` (the presign TTL constant),
  `ON CONFLICT (org_id, sha256) WHERE sha256 IS NOT NULL DO NOTHING`, re-select the winner; when not
  adopted owe `file-staging-delete-<fileId>`), set `blob_id`, status `draft` (composer) / `ready`
  (library), `expires_at` (draft only). Same answer and same work whether the bytes existed or not.
  **Tightening of the spec's conflict rule (anti-goal: no file may point at a blob whose upload form
  another account can still use):** on conflict, the loser points at the winner only when the
  winner's `dedup_after <= now()` or the winner's adopting file belongs to the same account;
  otherwise the loser keeps its staging object as its own blob row with `sha256 NULL` (allowed by
  the partial unique index) and the hashing job (K9) merges it once the winner's `dedup_after` has
  passed. The answer is the same in every branch. Write this case as a test.
- `DELETE /files/:id/draft` → `discard` (owner; only `uploading`/`draft` with no
  `conversation_files` row): status `deleted`, `deleted_at now()`, staging deletion owed when the
  file had no blob or the blob was its own adopted staging object with no other file (the sweep
  covers the rest).
- `GET /files/limits` (moves from `GET attachments/limits`, same body).
- `attachForMessage` (mandatory tx): validation as `bindForMessage` (`attachments.maxPerMessage`,
  duplicates → `validation_failed` path `files`); `SELECT … FROM files WHERE org_id AND id IN (…)
  ORDER BY id FOR UPDATE`; not found / other account / deleted / expired draft → `file.not_found`;
  `uploading` → `file.not_ready`, details `[{ path: "files", message, fileId }]`; drafts become
  `ready` (`expires_at NULL`, `source_conversation_id` set when null); insert `conversation_files`
  (`attached`, `first_seq`) `ON CONFLICT DO NOTHING`; return blocks with `source: { kind: "ref",
  fileId }` (same block shapes as today). No "already used" refusal. Wire it in
  `ConversationsService.bindIn` **in K5** (K4 only provides it and tests it directly).
- Chat paths of `AttachmentsService` (`create`/`finalize` for purpose `chat`, `bindForMessage`) are
  deleted; `attachments.controller.ts` loses `POST /`, `POST :id/finalize`, `GET limits` (chat);
  `GET :id/download` stays for `read` purpose. Callers of `create(..., "agent-avatar"|"skill-package")`
  are untouched.
- `FileDraftCleanupJob` (`@LockedCron("0 * * * *", { name: "file-draft-cleanup" })`, under
  `WorkerModule`, `runOnce()` for tests): claim expired `uploading`/`draft` rows deployment-wide in
  `asPlatform` with the org-filter marker (`FOR UPDATE SKIP LOCKED LIMIT 100`), mark `deleted`,
  owe the staging deletion for `uploading` rows (`staging_key ?? uploads/<id>`) and for drafts whose
  blob was adopted from their own staging key and is referenced by no other file (else the sweep).
  Add `"FileDraftCleanupJob"` to `test/lifecycle/roles.test.ts`. `AttachmentCleanupJob` stays for
  the non-chat purposes.
- Outbox: register `blob-delete` and `file-staging-delete` (queue `cap-kernel-maintenance`, attempts
  10, exp backoff, `removeOnComplete`); handlers re-check: `file-staging-delete` never deletes a key
  equal to some blob's `object_key`; `blob-delete` only deletes a blob in `deleting` status, deletes
  the object, then the row (K9 owes it; K4 writes the handler).
- Platform: the files upload routes replace the attachments ones in the `platform-op-upload`
  exemption (`tools/checks/src/platform-ops.ts`: `ATTACHMENT_ROUTES` → the files `POST /files`,
  `POST /files/:id/finalize`, `GET /files/limits`, `DELETE /files/:id/draft`), each `internal` in
  `exclusions.ts` with a reason containing "a person's file into a conversation"; update the check's
  fixture test first (red), then the check. Remove the old attachment exclusions that no longer exist.
- Register `LibraryFilesModule` in `http/api.module.ts` (controller) and `roles/worker.module.ts`
  (cleanup job).

**Tests:** `test/files/upload.http.test.ts` (integration): instant path same account; cross-account
upload always presigns and the response has the same keys; finalize hash mismatch; dedup to an
existing blob only after `dedup_after` (set it in the past with SQL to prove the branch both ways);
reused staging form within TTL treated as gone by later reads (size/etag); attaching one file in two
conversations; another account's id → `file.not_found`; draft expiry by the cleanup job
(`runOnce`), staging deletion owed via outbox (drain the maintenance queue as existing tests do).
`test/files/finalize.dual.test.ts` (container project, add to the container list): two replicas
finalize identical uploads of two accounts concurrently → one blob with that sha256, both files
ready, exactly one staging deletion owed. Port the relevant cases of
`test/attachments/attachments.http.test.ts` (chat parts) and delete those parts there.

- [ ] Tests first (red), then implementation, then green; `pnpm check:kernel-conventions`,
      `pnpm check:org-filter`, `pnpm check:outbox-registry`, `pnpm check:platform-ops`, typecheck.
- [ ] Commit `feat(kernel): content-addressed blobs and file uploads`.

## Task K5: Read path (high: agent reach)

**Read first:** replay-evals, writing-tools; `conversations/files.ts`, `conversations/artifacts.ts`,
`tools/builtins/conversation-files.ts`, `tools/builtins/sandbox/fetch-attachment.ts`,
`runtime/run-steps.ts:90-100`, `files/previewers.ts:321-400`, `html/html-document.service.ts`.

- [ ] **Before:** zero-drift run as in K2 (record).
- [ ] Send path: `ConversationsService.bindIn` and the queue path call
      `LibraryFilesService.attachForMessage`; `QueuedFile` keeps `attachmentId` (value = file id).
      Update `test/helpers/conversations.ts` seam (`bindFiles`).
- [ ] Media: a `ConversationMedia` provider (in `files/`) implementing `mediaInfo` / `fetchMedia`
      with today's contract: files referenced by the conversation (`referenced`) joined to ready blobs,
      plus `read` attachments via `AttachmentsService` (keep its read-purpose code); size/etag from
      the blob; `uri` = `store.uri?.(blob key) ?? "capybara://files/<id>"`; image downscale cache keyed
      exactly as before (by id). Wire it in `run-steps.ts`, `prompt-suggestions.ts`, eval replays.
      A deleted file (status `deleted`) or a `gone` blob → absent → existing placeholder.
- [ ] `ConversationFiles` (`list`, `file`, `identify`, `latestAvailable`, `content`): uploads and
      deliveries come from `conversation_files` + `files` + `blobs` (deliveries still grouped by
      `source_path` per conversation, versions newest first, same `FileOutput` shape, `origin`
      mapped `upload→"uploaded"`, `delivered|generated→"delivered"`); `status: "removed"` when the
      file is deleted or the blob is gone/mismatched. `file()` returns the blob's `objectKey`,
      `recorded {size, etag}`. Keep the HEAD-per-item behavior. Add `fileId`-based link data if the
      web needs it (none required: ids are file ids).
- [ ] `findConversationFile` (Deliver `file_id`, Read, GenerateImage inputs, Platform file refs) and
      `FetchAttachment` resolve through `referenced` over the same conversation set as today
      (conversation, root, sub-agents below) plus `read` attachments; FetchAttachment's list =
      files referenced by the root with role `attached` (uploads), names as today. Deliver's
      description says "a file id of this conversation". A library file the person never attached
      is unreachable: test with FetchAttachment, Deliver `file_id`, Read.
- [ ] `ConversationArtifacts.downloadUrl/preview` (conversation-scoped download route) read through
      the file's blob. Previewer registry and HTML document service already go through
      `ConversationFiles.file` (verify; no event `objectKey` reads remain:
      `grep -rn "objectKey" packages/kernel/src` and justify every remaining hit in the report).
- [ ] **After:** zero-drift rerun equal to before; add a reconstruct case where a migrated file
      (row inserted the 0188 way) resolves with zero drift and a deleted file reports `media_missing`.
- [ ] Update affected tests (`test/conversations/files.http.test.ts`, `test/attachments/media-*.test.ts`,
      `test/tools/sandbox/fetch-attachment.test.ts`, `test/tools/sandbox/sandbox-tools.test.ts`,
      `test/evals/reconstruct.test.ts` helpers that insert into `attachments`).
- [ ] Commit `feat(kernel): conversations resolve files through the library`.

## Task K6: Deliveries on blobs, channel delivery (high: intent-first)

**Read first:** writing-tools; `tools/builtins/artifacts.ts`, `channels/file-delivery.ts`,
`channels/outbound.ts:1360-1420`.

- [ ] `storeArtifacts`: per file `BlobsService.ensureFromBytes(orgId, sha256, data)` (reuse any ready
      blob; else pending intent in its own tx → `put blobs/<sha256>` → ready); then one
      `@Transactional` unit: `eventLog.appendInReport(conversationId, events)` + `recordDelivered`
      for the fresh events (owner = conversation owner, `agent_id` = conversation agent, origin
      `generated` when `sourcePath` starts with `generated/`), then `notify` after commit. The event
      payload gains `fileId` (= artifactId) and `objectKey` = the blob key; schema change in
      `events.ts` (`fileId: z.uuid().optional()`, optional because old logs lack it). Repeat
      semantics (scope by sha256, race loser) unchanged; no object cleanup on failure anymore (a
      ready blob may serve others; an orphan pending/ready blob is the sweep's).
- [ ] Channel delivery: `planFileDelivery` checks the file is referenced by the conversation
      (`conversation_files` row) instead of the key prefix; `readArtifactCapped` reads the blob via
      `BlobsService.open`. Update `test/channels/file-delivery.test.ts`, `outbound-files*.test.ts`.
- [ ] Tests: delivery reuses an existing blob (no second `put`: spy on the store or count objects
      under `blobs/`); two conversations delivering the same bytes share a blob; file rows and
      `conversation_files` exist with the right owner/origin; `test/tools/delivery-scope*.test.ts`,
      `generate-image.test.ts`, `sandbox-artifacts.dual.test.ts` green.
- [ ] Commit `feat(kernel): deliveries store bytes as shared blobs`.

## Task K7: Shares on blobs (high)

**Read first:** file-sharing spec (`docs/superpowers/specs/2026-11-18-file-sharing-design.md`);
`shares/**`.

- [ ] `create` (conversation-scoped route) resolves the file through `ConversationFiles.file` → the
      file row: store `blob_id`, `source_file_id`, `conversation_id`; **no copy**; `object_key` stays
      null. New `POST /api/v1/orgs/:orgId/files/:fileId/shares` (same body) in `shares.controller.ts`:
      owner check through `LibraryFilesService.owned`, `conversation_id NULL`; the anonymous guest
      cannot create (`rejectAnonymousGuest`) — apply to both creates. `GET files/:fileId/shares` (list
      for the dialog) likewise.
- [ ] `refresh` ("update to latest"): newest ready file of the same account with the same
      `source_conversation_id` + `source_path` after the current `source_file_id`; repoints `blob_id`,
      `source_file_id`, bumps `generation`; no copy, no old-generation deletion.
- [ ] Liveness (`liveness.ts`): live = not revoked, not expired, `blob_id IS NOT NULL` and blob
      `ready`, the source file (when set) is not `deleted` and still owned by the creator, and, when
      `conversation_id` is set, the existing `creatorStillHasAccess`. `share-open.service.ts` and
      share previews stream through `BlobsService.open` with the size/etag check.
- [ ] `revokeSharesIn` gains `{ fileIds }` and reason `file_deleted`; no per-share object deletion
      owed for blob-backed rows. Share sweep: step 1 unchanged; step 2 "free" = `blob_id = NULL` for
      shares revoked/expired more than `RETAIN_DAYS` ago; step 3 (orphans under `shares/`) is removed
      (no kernel code writes there anymore; migrated snapshot objects are blobs). The
      `share-object-delete` handler stays for rows already owed at deploy time but refuses a key that
      any blob uses.
- [ ] `views` `newer_delivery`: newer ready file in the same `source_path` group (files table, not
      `artifact_created`).
- [ ] Tests: update `test/shares/*.test.ts`; add: share from the library references the blob (no new
      object under `shares/`); deleting the file revokes its shares (`file_deleted`) and the public
      link stops; update to latest repoints; guest cannot share.
- [ ] Commit `feat(kernel): shares reference blobs`.

## Task K8: Library routes and Platform operations (normal)

**Read first:** writing-kernel-api (Platform tool section), writing-extension-ui (previewers);
`platform/ops/conversations.ops.ts:377-571`, `platform/ops/shares.ops.ts`, `platform/exclusions.ts`,
`files/previewers.controller.ts`, `ui/embed-token.ts:110-125`, `ui/views.ts:545-570`.

Routes on `files/library.controller.ts` (owner only, `@OrgAction("agents.use")`, `requireUser`,
`cache-control: private, no-store`):

- `GET /files?origin=upload|delivered|generated&agentId=&type=image|document|text|other&q=&limit=(1..100, default 50)&cursor=`
  → `{ files: LibraryFileView[], next }`, the caller's `ready` files newest first, deliveries of one
  `(source_conversation_id, source_path)` collapsed to the newest with `versions` count. `q` =
  case-insensitive substring of the name. `LibraryFileView = { id, name, contentType, size, origin,
  agentId, agentName?, sourceConversation: { id, title, deleted } | null, versions, createdAt,
  previewable }`. This is the composer's `@` search route (`?q=<text>&limit=8`).
- `GET /files/usage` → `{ bytes, files }` (distinct blobs of the caller's ready files).
- `GET /files/:id` → view + `conversations: [{ id, title, deleted }]` (owner's only) + `versions:
  [{ id, size, createdAt }]`.
- `GET /files/:id/content?limit=`, `GET /files/:id/download?as=url&inline=1`,
  `GET /files/:id/previewers`, `GET /files/:id/previews/:plugin/:previewerId?locale=`,
  `POST /files/:id/html-token`: twins of the conversation-scoped routes, same headers/CSP. Previewer
  identity `{ source: "conversation", orgId, accountId, file }` without `conversationId`.
- `DELETE /files/:id` → status `deleted`, `deleted_at`, `revokeSharesIn({ fileIds: [id] },
  "file_deleted")` in the same transaction, `afterCommit` publish `files` changed for each referring
  conversation.
- Embed tokens: `ui/embed-token.ts` accepts `fileId` without `conversationId` = library file, checked
  with `LibraryFilesService.owned`; `PreviewerRegistry.embedAllowed` takes an optional
  `conversationId`.
- Platform: `platform/ops/files.ops.ts` with `files.list` (mirrors GET /files; `confirm: "read"`,
  cursor paging via `ops/paging.ts`), `files.get`, `files.usage`, `files.delete` (mirrors DELETE;
  description: hands the person a link to the Files page to confirm the deletion there; `run` checks
  ownership and returns `{ id, name }` without deleting; `handoff` link `/files#item=<id>`; `confirm:
  "read"`). Exclusions: content/download/previewers/previews/html-token → `transport`; share create/
  list by file → `human-only` / `internal` like the conversation-scoped ones. `FILE_ROUTES` into
  `route-schemas.ts`. `pnpm check:platform-ops`, `pnpm exec vitest run tools/checks/test/platform-parity.test.ts`.
- Tests: `test/files/library.http.test.ts` (list filters, collapse, `q`, cursor, usage hides other
  accounts' sharing, details, delete makes later model requests render the placeholder, another
  account → 404 on every route), `test/files/previewers.http.test.ts` library cases,
  `test/platform/ops-files.test.ts`.
- [ ] Commit `feat(kernel): file library routes and platform operations`.

## Task K9: Blob sweep and hashing job (high)

**Read first:** writing-kernel-api (queues, `@LockedCron`, `runJob`); `shares/sweep.job.ts`,
`catalog/scope-sync.ts` (fan-out), `infra/queue/queue-names.ts`.

- [ ] `BlobSweepJob` (`@LockedCron("20 4 * * *", { name: "blob-sweep" })`, WorkerModule,
      `runOnce(signal)`), per org (deployment-wide claim loop in `asPlatform` with marker, or a
      fan-out of per-org jobs through `runJob`): (a) `deleted` files older than
      `files.deletedRetentionDays` → delete rows (cascades `conversation_files`); (b) `ready` blobs
      older than 24 h with no file row in `uploading|draft|ready` and none `deleted` within retention,
      and no share with that `blob_id` → `deleting` + owe `blob-delete-<id>` in the same transaction;
      (c) `pending` blobs older than 1 h with no file → same. Claims use `FOR UPDATE SKIP LOCKED` and
      re-check the "no reference" condition inside the claiming statement; `files`/`file_shares`
      inserts that point at a blob lock it `FOR KEY SHARE` implicitly through the FK, so a blob turned
      `deleting` must also be refused by `resolveUpload` / `ensureFromBytes` (they only reuse `ready`).
- [ ] Hashing: `file-library-hash` dispatcher job (maintenance queue or its own queue registered in
      `KERNEL_QUEUES` + health list; job id `file-library-hash`, no `:`), enqueued by a
      `@LockedInterval` kickoff under WorkerModule when unhashed blobs exist; it fans out per org jobs
      `file-library-hash-<orgId>-<batchStartId>` (deterministic, resumable: each processes up to N
      blobs with `sha256 IS NULL AND status = 'ready' AND dedup_after <= now()`, ordered by id
      after its cursor, then enqueues the next batch id). Per blob: stream the
      object (`BlobsService` without size check), compute sha256; missing object → status `gone`;
      then one transaction: set `sha256` if no other blob has it, else (only when the existing
      blob is `ready` and its `dedup_after <= now()`; otherwise leave this blob for a later batch)
      repoint `files.blob_id` and `file_shares.blob_id` to the existing blob, mark this one
      `deleting` and owe `blob-delete-<id>`. Verify the size/etag of the bytes read against the row
      (a staging object replaced within its form's TTL is hashed again later, never merged as is).
- [ ] Tests: `test/files/blob-sweep.test.ts` (keeps blobs referenced by a deleted-within-retention
      file or a recent share; deletes unreferenced; pending > 1 h; deleted files past retention go),
      `test/files/hash-job.test.ts` (two identical migrated objects merge into one blob, files and
      shares repointed, duplicate object deleted after the outbox drains; missing object → gone →
      placeholder), `test/files/blob-sweep.dual.test.ts` (container: sweep and hash run once per tick
      across two replicas). Add `BlobSweepJob` and the kickoff to `roles.test.ts`.
- [ ] Commit `feat(kernel): blob sweep and migration hashing job`.

## Task K10: Web keeps working on the new routes (normal)

**Read first:** writing-web-ui; `apps/web/src/lib/attachments.ts`, `components/use-draft-files.ts`,
`lib/file-source.ts`, `lib/conversations.ts`.

- [ ] `lib/attachments.ts` → `lib/uploads.ts` (or keep the file, rename functions): hash with
      `crypto.subtle.digest("SHA-256", await file.arrayBuffer())` (hex), `POST /files` with
      `purpose: "composer"`; when `upload === null` skip the storage POST and finalize; else upload
      and `POST /files/:id/finalize`. `getUploadLimits` → `GET /files/limits`. Removing a draft calls
      `DELETE /files/:id/draft` (best effort) after aborting. `markFailed` reads `details[].fileId`.
      Error codes `file.*` replace `attachment.*` where the routes changed.
- [ ] `file-source.ts`: uploaded files download through `GET /files/:id/download` (the conversation
      `files` list's ids are file ids). Keep artifact URLs (the kernel route still works).
- [ ] `pnpm check:web-api-parity`, `pnpm check:web-ui`, update `apps/web/test/attachments.test.ts`,
      `chat-files.test.tsx`, `file-panel.test.tsx`; `pnpm exec vitest run` on them.
- [ ] Commit `feat(web): composer uploads go through the file library`.

## Task K11: Rules and final verification

- [ ] AGENTS.md: add the spec's **Files** area rule (one line, under "Rules by area", after "File
      sharing"); update `writing-object-store-providers` skill's key list (`kernel/<org>/blobs/`,
      `uploads/`). `pnpm check:agent-docs`.
- [ ] Changeset for `@capybara-hq/capybara` (images: kernel behavior) if the repo convention needs
      one beyond the SDK changeset.
- [ ] `pnpm verify --fast`; then `pnpm exec vitest run` on every changed/added test file.
- [ ] Final whole-branch review (most capable model), fixes, push, PR.
