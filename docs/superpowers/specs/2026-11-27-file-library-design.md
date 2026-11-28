# File library: files as their own entity, content-addressed storage, a Files page

Status: approved by the maintainer (2026-11-28, decisions below). Mockups: the "2 · 文件（产物管理）" row of the
composer canvas (`Files.dc.html`, `FilesDark.dc.html`) and the `@` menu boards of row 1.

## Intent

A person's files are scattered across conversations. A file an agent delivered can only be found by
opening the conversation it came from and looking at the right panel, and a file the person uploaded
once has to be uploaded again to use it in another conversation (the kernel refuses to bind an upload
to a second conversation). The same bytes are stored once per upload, once per delivery and once per
share.

This project makes a file a thing of its own, owned by one person, that conversations only refer to;
stores its bytes once per org by content hash; adds a Files page (a list of everything the person
uploaded or an agent delivered to them, with a preview beside it and sharing from there); and lets the
composer's `@` search those files so a person attaches a file they already have instead of uploading
it again.

## Goals

- **File entity.** A file (`files` row) belongs to one account, has a name, a type and a size, and
  points to the bytes. Conversations refer to files (`conversation_files`); one file can be attached
  in any number of the owner's conversations.
- **Content-addressed bytes.** Bytes live in a blob (`blobs` row + one object), keyed by sha256 within
  an org. Uploads, deliveries and shares of the same bytes in one org share one blob. A blob is
  deleted only when nothing refers to it.
- **Files page** (`/files`, a first-level navigation entry): the person's files, grouped by time,
  filtered by origin (delivered by an agent / uploaded), agent and type, searched by name; a preview
  beside the list (the existing previewers); details (origin, conversation, times referenced);
  actions: attach in a new conversation, share, download, delete.
- **`@` attaches library files.** In the composer, the text after `@` searches the person's files
  together with connector resources; picking a file attaches it to the message without an upload.
- **Share from the Files page**, with the rules of the file sharing spec; a share refers to the
  file's blob instead of copying it (a blob never changes, so a share is still a snapshot).
- Every existing upload, delivered file and share is moved into the new model; ids stay the same, so
  every reference already in an event log keeps resolving.

## Non-goals

- Sharing files between people, team folders, or an org-wide library: a file has one owner; the
  conversation access rule (owner only) is unchanged.
- Folders, tags, renaming the bytes' type, editing files in place.
- Storage quotas. Usage is computed and shown (see §8); limits are a follow-up once usage is visible.
- Model-facing copies (`attachments` purpose `read`: Read images, tool-result images) and the other
  non-chat purposes (`skill-package`, `agent-avatar`): they stay in `attachments` as they are.
- A conversation purge. Deleted conversations are soft-deleted today and nothing purges them; this
  project does not add one (see open question Q1 for what deleting a conversation does to its files).
- Dedup across orgs.

## Anti-goals (a failure even if it works)

- A way to learn whether someone else in the org has a file (an upload that is skipped, faster, or
  answered differently because another account already stored the same bytes).
- A presigned upload that can overwrite bytes another file already uses.
- An agent reaching a library file the person did not attach to the conversation.
- A reference already in an event log that stops resolving because of the migration.
- Bytes deleted while a file, a share or a pending write still needs them.

## Facts this design builds on (origin/main, 2026-11-27)

Paths relative to `packages/kernel/src`.

- **Uploads.** `attachments` (`migrations/0022_attachments.sql`) holds chat uploads and other purposes
  (`skill-package`, `agent-avatar`, `read`; 0024, 0068, 0163). Bytes at
  `kernel/<org>/attachments/<id>`; the user's file name never enters a key. Create presigns a POST
  (`presignPut`, size enforced by the store, TTL 300 s) and inserts a `pending` row; finalize (uploader
  only) HEADs the object, checks size and type, sniffs the signature, counts PDF pages, records the
  `etag`. A presigned form can be reused within its TTL, so reads check size + etag
  (`attachmentContentMatches`, `storedMatches`). `bindForMessage` (in the caller's transaction, rows
  `FOR UPDATE`) binds a chat upload to one conversation once and forever and returns content blocks
  `{ source: { kind: "ref", attachmentId } }`. Unbound pending uploads expire after 24 h
  (`attachment-cleanup`, hourly `@LockedCron`).
- **Deliveries.** `Deliver` (`tools/builtins/sandbox/deliver.ts`) reads the file from the device into
  memory (cap `sandbox.deliverMaxBytes`, 100 MB), `storeArtifacts` (`tools/builtins/artifacts.ts`)
  computes sha256, `put`s `artifacts/<conversationId>/<artifactId>` and appends `artifact_created`
  (`{ artifactId, name, contentType, size, objectKey, sourcePath, callId, sha256? }`, not
  model-visible). One delivery per delivery scope by sha256 (`conversations/delivery-scope.ts`).
  Versions are not stored: `ConversationFiles.list` groups `artifact_created` events by `sourcePath`.
  `GenerateImage` delivers through the same path.
- **The model sees refs.** Bytes never enter the event log (`conversations/events.ts:389`). At request
  build, `mediaInfo` / `fetchMedia` resolve refs of rows bound to this conversation; `planMedia`
  budgets from declared row sizes; a missing row renders a "no longer available" placeholder;
  `fetchMedia` returns null only when certainly gone and throws on transient errors. Replay fetches
  media by reference; deleted media is drift `media_missing`, a changed etag `media_changed`
  (`evals/reconstruct.ts`, replay-evals skill).
- **Device.** Uploads reach a device only through `FetchAttachment`, which copies a bound chat upload to
  `<workspace>/attachments/<rootConversationId>/<name>`.
- **Deletion.** Conversations are soft-deleted (`markDeleted`); nothing deletes chat uploads or
  delivered objects of deleted conversations. Org purge (`storage-org-purge`) deletes `kernel/<org>/`.
- **Shares** (`shares/`, `0161_file_shares.sql`) copy the file's bytes into `shares/<id>/<generation>`
  before inserting the row (`object-store@1` has no copy), free snapshots through the outbox and a daily
  sweep. A share is live while its creator can still open the conversation.
- **`object-store@1`** has `put`, `get` (range), `head` (optional etag), `delete`, `deletePrefix`,
  `presignPut` (size enforced by the store), `presignGet`; no copy, no checksum options
  (`plugin-sdk/src/storage.ts`).
- **Access.** A conversation belongs to one account and only its owner sees it
  (`conversations/access.ts`). No storage quotas or byte accounting exist.
- A content-addressed precedent: plugin packages at `deployment/plugins/blobs/<sha256>.tgz`.

## Approaches

1. **Blob + file + reference tables, dedup per org** (chosen). Bytes are immutable blobs keyed by
   sha256 per org; a file is the person-visible entry; conversations refer to files. Uploads,
   deliveries and shares all reuse blobs.
2. **Keep `attachments`, drop the one-conversation rule.** Smallest change, but delivered files stay
   in event logs only (no library without scanning every conversation), no dedup, shares still copy.
3. **Dedup per account only.** No cross-account leak to think about, but the same report attached by
   ten colleagues is stored ten times. Rejected: the leak is closed by the upload rule in §3 instead,
   so per-org dedup costs nothing in privacy.

## Design

### 1. Data (one migration, schema `capybara`, RLS in the same file)

`blobs`: the bytes.

| column | meaning |
|---|---|
| `id` | uuid, primary key |
| `org_id` | `REFERENCES orgs(id) ON DELETE CASCADE` |
| `sha256` | hex; null only for a migrated blob not yet hashed (§9); unique `(org_id, sha256)` where not null |
| `size`, `etag` | as stored; reads check them like `attachmentContentMatches` does today |
| `object_key` | relative to `kernel/<org>/`; new blobs `blobs/<blobId>` (always kernel writes: deliveries and finalized uploads' verified copies, §3); migrated blobs keep their old key |
| `status` | `pending` (intent written, bytes not confirmed) \| `ready` \| `deleting` |
| `dedup_after` | the time from which another account's upload may resolve to this blob (§3) |
| `created_at` | |

`files`: what a person sees.

| column | meaning |
|---|---|
| `id` | uuid, primary key; migrated rows keep the attachment or artifact id |
| `org_id`, `account_id` | owner; `account_id REFERENCES accounts(id)` |
| `blob_id` | `REFERENCES blobs(id)`; null while `status = 'uploading'` |
| `name`, `content_type`, `size`, `pages` | metadata (as today) |
| `origin` | `upload` \| `delivered` \| `generated` |
| `status` | `uploading` (presigned, not finalized) \| `draft` (finalized in a composer, not yet sent) \| `ready` \| `deleted` |
| `agent_id` | the agent that delivered it (null for uploads) |
| `source_conversation_id` | where it was delivered (or first sent); `ON DELETE SET NULL` |
| `source_path` | the version group of a delivery (`sourcePath`); null for uploads |
| `expires_at` | for `uploading` / `draft` only |
| `created_at`, `deleted_at` | |

`conversation_files`: which conversation refers to which file.

| column | meaning |
|---|---|
| `conversation_id` | `REFERENCES conversations(id) ON DELETE CASCADE` |
| `file_id` | `REFERENCES files(id) ON DELETE CASCADE` |
| `org_id` | for RLS |
| `role` | `attached` (sent in a message) \| `delivered` |
| `first_seq` | the event that first referred to it |
| primary key | `(conversation_id, file_id)` |

`file_shares` gains `blob_id` (`REFERENCES blobs(id)`) and `source_file_id`; `object_key` stays only
for shares not yet migrated (§9) and is dropped by a later contract migration.

Indexes: `files (account_id, created_at DESC) WHERE status = 'ready'` for the library,
`files (blob_id)` and `file_shares (blob_id)` for the sweep, a trigram or `lower(name)` index for
search (left to the builder, sized by measured row counts).

Every table carries `org_id` and ships its `org_scope` policy (`rls_admits(org_id)`).

### 2. Access

- A file is visible to its owner (`account_id`) only, and only while `status = 'ready'` (drafts to
  their composer). This matches conversation access: files of a conversation are the conversation
  owner's files, so no file becomes visible to anyone who could not see it before.
- The model and the device reach a file only through `conversation_files` of the conversation (or its
  root, as today for `FetchAttachment`): an agent never sees the library, only what the person
  attached or the agent delivered in that conversation.
- Files of the anonymous guest account (channel guests) exist as today but cannot be shared (no
  sign-in), as in the sharing spec.

### 3. Uploading

1. The web hashes the file (`crypto.subtle.digest`, the upload cap is 20 MiB; streaming hashing is a
   follow-up if the cap rises) and calls `POST /orgs/:orgId/files` with
   `{ name, contentType, size, sha256, purpose: "composer" | "library" }`.
2. **Same account, same bytes:** if the caller already has a `ready` or `draft` file whose blob has
   this sha256, the kernel creates the new `files` row on that blob at once and answers
   `{ file, upload: null }`. Nothing new is learned: the caller already holds those bytes.
3. **Otherwise** (including when another account in the org has the bytes): the kernel inserts a
   `files` row (`uploading`, `expires_at` +24 h) and presigns a POST to a staging key
   `uploads/<fileId>` (never to a `blobs/` key: a presigned form must not be able to overwrite a
   blob other files use). The web uploads and calls `POST …/files/:id/finalize`.
4. **Finalize** (uploader only) does today's checks (HEAD size and type, signature sniff, PDF pages) and
   **reads the object to compute sha256**; a mismatch with the declared hash deletes the staging
   object and fails (`file.hash_mismatch`). Then, in one transaction:
   - a `ready` blob with this sha256 and `dedup_after <= now()` exists → the file points to it; the
     staging object's deletion is owed through the outbox;
   - else → a new blob adopts the staging object (`object_key = uploads/<fileId>`, `etag` from the
     HEAD, `dedup_after = now() + presign TTL`), inserted with `ON CONFLICT (org_id, sha256) DO
     NOTHING`; on conflict the loser points to the winner and owes its staging object's deletion.
   The file becomes `draft` (composer) or `ready` (library page).
5. The answer and the time it takes are the same whether or not the bytes existed in the org: the
   bytes are always uploaded and always read once at finalize.

**Builder amendment (2026-11-28, implementation review).** Adopting the staging object leaves a
hole: the uploader's form stays valid for its TTL after finalize, so rewriting through it and
reading the file afterwards tells whether the file was deduplicated onto another account's blob
(it still reads) or adopted its own object (it reads as gone), and a rewritten adopted object can
poison a hash for later uploads. The implementation therefore never adopts a staging object:
finalize, having read and hashed the bytes, always writes them to a fresh kernel-owned key
`blobs/<blobId>` (intent row first), then in one transaction, under a per-hash advisory lock
(`BlobHashLock`), either points the file at an existing ready blob of that hash (the extra copy
becomes `deleting`, its deletion owed and deferred) or marks its own blob ready with the hash (a
blob of that hash that is no longer ready gives the hash up first; the `(org_id, sha256)` unique
index is the backstop); the staging object's deletion is always owed. Jobs a request owes are never
due within it (no outbox fast path runs while the caller waits), and dropping an upload (discard,
draft expiry) always owes one deferred `file-release` job that decides what to free. Every branch does the same work, no form can write a key a blob uses, and
`dedup_after` is set to the creation time (kept for migrated rows). The declared hash and the upload
purpose are stored on the `files` row at create (`sha256`, `upload_purpose`).

`dedup_after` closes the reuse window: a presigned form stays valid for its TTL, so within it the
uploader could replace the staging object; no other account's file is pointed at that blob until the
form has expired. Reads keep checking size + etag, so a replaced object is treated as gone (as today).

A composer upload removed before sending is discarded (today's `discardUpload`); `draft` files expire
after 24 h (`file-draft-cleanup`, the renamed `attachment-cleanup`, hourly `@LockedCron`).

### 4. Sending, delivering, generating

- **Sending.** The message's `files: [id]` (renamed from attachment ids; same field) must be the
  sender's `draft` or `ready` files. `bindForMessage` becomes `attachForMessage`: in the caller's
  transaction, rows `FOR UPDATE`, it turns drafts into `ready`, inserts `conversation_files`
  (`attached`, `first_seq`), and returns the same content blocks with `source: { kind: "ref", fileId }`.
  The "already used in another conversation" refusal is removed.
- **Delivering.** `storeArtifacts` already has the sha256 in memory:
  - a `ready` blob with that sha256 exists in the org (any `dedup_after`: the kernel wrote or verified
    those bytes itself) → no `put`;
  - else → insert a `pending` blob (intent, own transaction), `put` `blobs/<blobId>`, settle it as §3 does.
    A `pending` blob older than one hour with no file is deleted by the sweep (§7).
  Then, with the `artifact_created` events, insert one `files` row per delivered file (`delivered` or
  `generated`, `agent_id`, `source_conversation_id`, `source_path`, owner = the conversation's owner)
  and its `conversation_files` row. The event gains `fileId` (= the new file's id, which stays the
  artifact id) and `objectKey` now names the blob's key. One delivery per scope by sha256 is unchanged.
- **Channel delivery** checks that the file is referenced by the conversation instead of checking the
  `artifacts/<conversationId>/` key prefix.

### 5. The model, replay and the device

- `mediaInfo` / `fetchMedia` resolve a ref through `conversation_files` → `files` → `blobs` and return
  the blob's size and etag, so request building and the media records stay as they are.
- A ref in an existing log (`attachmentId`) is the same id as the migrated file (§9), so old logs
  resolve unchanged. The content block's field is renamed to `fileId`; the reader accepts the logged
  `attachmentId` key only as a parse alias of the same id, so the logged bytes are untouched and no
  model-visible text changes (no `DriftReason`). Zero-drift fixture tests run before and after.
- A file the person deletes renders the existing "no longer available" placeholder in later requests,
  and replays of earlier runs report `media_missing`, as for a deleted attachment today.
- `FetchAttachment` (model-facing name unchanged) and `Deliver`'s `file_id` resolve files referenced by
  the conversation or its root.

### 6. The Files page and the `@` search

Routes (session or API token of the person; `@OrgAction("agents.use")`):

- `GET /orgs/:orgId/files?origin=&agentId=&type=&q=&cursor=` — the caller's `ready` files, newest
  first; deliveries of the same `source_path` in the same conversation collapse to the newest with a
  `versions` count.
- `GET …/files/:id` — details, `conversations` (ids and titles referring to it, owner-visible only),
  `versions`.
- `GET …/files/:id/content`, `…/download`, `…/previewers`, `…/previews/:plugin/:previewerId` — the
  conversation-scoped routes' file-scoped twins with the owner check. `FilePreviewArgs.conversationId`
  becomes optional (a library upload has none): an SDK public API change.
- `DELETE …/files/:id` — `deleted_at` / `status = 'deleted'`; its shares are revoked in the same
  transaction (`file_deleted`); conversations that referred to it show it as no longer available.
- `POST …/files/:id/shares` — the sharing spec's create, keyed by file; the share stores `blob_id`
  (no copy). "Update to latest" picks the newest file of the same `source_path` group. A share is live
  while its creator owns the file and the file is not deleted (replaces "could still open the
  conversation"; for shares created from a conversation, the conversation check stays as well).

Web (`apps/web`, page template + design components, every read a `defineQuery`, every write
`useAppMutation`):

- **Navigation:** "文件" between 定时任务 and 更多.
- **Size classes** (layout adapts in the template, never in the page):
  - expanded (≥ 841): list card and preview card side by side (mockup `Files.dc.html`).
  - medium (600–840): the shell is the 48 rail (mobile layout spec §4.3); list and preview stand
    as two panes only when both fit (§5.2 there), otherwise the list fills the content area and
    picking a file opens the preview as a side sheet, as the conversation's right area does on
    medium (the design overlay primitive); closing returns to the list with the row still selected.
    The StatusBar shows, as on every medium and expanded page.
  - compact (< 600): Files is a pushed page under the floating back button (mobile layout spec
    §4.1), no StatusBar; rows show icon, name and one meta line (origin · size · time); the source tabs
    become a full-width segmented control; agent and type filters move into one 筛选 button opening a
    sheet; search collapses to an icon that expands the field; the preview is its own screen with a
    top bar (back, share, download, more). Controls take the mobile sizes.
- **Composer `@`:** the `@` menu queries `GET …/files?q=<text after @>&limit=8` for its 文件 group,
  below the 连接器 group and above 会话 (superseded by the composer inline tokens spec §4: the
  connectors' resources are no longer searched together with files, they sit on a second level);
  picking a file inserts a `file` token at the caret (composer inline tokens spec 2026-11-28 §1;
  its
  id goes into the message's `tokens`, not `files`; uploads by drop, paste or ＋ 上传文件 stay cards in
  the attachment strip). On compact the menu is a bottom sheet.
- **Conversation right panel:** unchanged list; each file links to its page in Files.

### 7. Deleting bytes

A daily `@LockedCron` `blob-sweep` (WorkerModule):

- blobs `ready` with no `files` row (other than `deleted` rows older than `files.deletedRetentionDays`,
  default 30) and no live or recent share (`file_shares.blob_id`, shares freed by the existing share
  sweep rules) and older than 24 h → `deleting`, object deletion owed through the outbox
  (`blob-delete-<id>`), row deleted when the object is gone;
- `pending` blobs older than one hour with no file → same;
- `deleted` files older than the retention → row deleted (`conversation_files` rows go with it; logs
  keep their refs and render the placeholder).

Staging objects of uploads that never finalized are deleted with their expired `uploading` rows by
`file-draft-cleanup`. Org purge is unchanged (everything is under `kernel/<org>/`).

### 8. Usage

`GET …/files/usage` → the caller's usage = the sum of the sizes of the distinct blobs their ready files
point to (so other accounts' sharing of a blob is invisible to them), shown on the Files page. The org
total (sum of the org's blobs) appears on the org admin's storage line. No limits in this project.

### 9. Migration of existing data

1. **Schema migration (SQL only, in one transaction):** create the three tables and the `file_shares`
   columns; insert a blob (`sha256` null, `status` `ready`, `object_key` = the old key, `dedup_after`
   = now) and a file with **the same id** for every `ready` chat attachment and every distinct
   `artifact_created` artifact id (payload fields from `conversation_events`, owner = the
   conversation's owner, `source_path` from the payload); `conversation_files` from the attachments'
   `conversation_id` and from each artifact's conversation; for each share, a blob for its snapshot
   object and `blob_id`. Unbound pending chat attachments become `uploading` files. Ids are preserved,
   so every logged ref resolves on the first request after the deploy; no runtime fallback to
   `attachments` exists.
2. **Hashing job** (BullMQ, deterministic id `file-library-hash`, WorkerModule, resumable by cursor):
   for each blob with `sha256` null, stream the object, compute sha256, then in one transaction either
   set it or, when a blob with that hash exists, repoint files and shares to that blob and owe the
   duplicate object's deletion. A missing object marks the blob gone (its files render the
   placeholder, as today).
3. A later contract migration drops `file_shares.object_key` and the chat purpose from `attachments`
   once the job reports done on every deployment we run.

## Errors

`file.not_found`, `file.not_ready`, `file.hash_mismatch`, `file.deleted`, `share.file_unavailable`
(existing, now also for a deleted file); each registered with an actionable message, zh / en in the
web. Removed: `attachment.not_found`'s "already used in another conversation" case.

## Tests (outline)

- Kernel integration: upload same-account instant path; cross-account upload always uploads and the
  answer has the same shape; finalize hash mismatch; dedup to an existing blob only after
  `dedup_after`; concurrent finalize of the same bytes (one blob, loser's staging object owed);
  sending a file in two conversations; agent cannot reach an unattached library file (`FetchAttachment`,
  `Deliver` `file_id`); delivery reuses a blob; deleting a file revokes its shares and later requests
  render the placeholder; share from the library references the blob; sweep keeps blobs referenced by
  a deleted-within-retention file or a recent share and deletes the rest.
- Migration test: a database with chat attachments, deliveries (two versions), a share; after the
  migration every old id resolves, `ConversationFiles.list` is unchanged, the hashing job merges two
  identical objects into one blob.
- Replay: zero-drift fixtures before and after; a log with `attachmentId` refs reconstructs with no
  drift.
- Dual-replica (container project): two replicas finalizing identical uploads; hashing job and sweep
  run once per tick.
- Web: Files page states (empty, filtered empty, each preview kind), the three size classes, `@`
  grouping and attaching a library file without an upload, share dialog from the page.

## Maintainer decisions (2026-11-28)

- **Deleting a conversation** keeps its files in the library; the Files page shows the source as a
  deleted conversation. Files are deleted only from the Files page (or with the account / org).
- **Dedup scope:** per org, with the upload rule of §3 (no existence signal across accounts).
- **Uploading on the Files page** without a conversation: yes (`FilePreviewArgs.conversationId`
  becomes optional).
- **Retention:** a deleted file keeps its bytes 30 days (`files.deletedRetentionDays`, default 30).

## Left to the builder

- Migration number, the search index choice, page template and component choices (writing-web-ui),
  copy wording, the exact grouping of the list ("今天 / 本周 / 更早").

## AGENTS.md rules touched

- **Multi-replica discipline.** Intent first: a `pending` blob row before the delivery `put`; the
  upload's file row before the presign. Owed object deletions go through the outbox with
  deterministic ids (`blob-delete-<id>`, staging deletions). `blob-sweep` and `file-draft-cleanup`
  are `@LockedCron` under `WorkerModule`; the hashing job is a BullMQ job with a deterministic id and
  no `:` in names. Concurrent writes of the same bytes (finalizes, deliveries, hashing merges) are
  serialized by a transaction-scoped lock per org and hash (`BlobHashLock`) around the step that
  decides which blob holds the hash; the `(org_id, sha256)` unique index is the backstop. No
  process state.
- **Org scope / RLS.** Three new tables with `org_id`, each with its `org_scope` policy in the same
  migration; every query runs under the org scope; the sweep and the hashing job run per org through
  `runJob`.
- **Migrations.** One expand migration (tables, columns, data copy with preserved ids); a later
  contract migration drops `file_shares.object_key` and the chat purpose of `attachments`. Applied
  migrations untouched.
- **Runtime and replay.** The log stays the source of truth with refs only; ids are preserved so old
  refs resolve; the content block's key is renamed with a parse alias, no model-visible text changes,
  no `DriftReason`; zero-drift fixture tests before and after.
- **Object storage.** Key prefixes added by the kernel (`blobs/`, `uploads/` under `kernel/<org>/`);
  presigned upload size still enforced by the store; a presigned upload only writes a staging key;
  finalize copies the verified bytes to a kernel-owned blob key; no user file name in a key.
- **File sharing.** "A share is a snapshot" holds: a share refers to an immutable blob instead of a
  copy; switches, expiry and HTML rules unchanged.
- **Web UI / Mobile.** New page from a design template and components, reads `defineQuery`, writes
  `useAppMutation`; size-class adaptation (§6) lives in the template and overlay primitives, not the
  page; zh copy uses 智能体.
- **Platform tool.** New routes: operations for list, get, usage, delete (delete returns a handoff
  link card, a person confirms on the web), upload as a file reference (`platform-op-upload`); create
  share stays `human-only` like the conversation-scoped create; content, download and preview routes
  are `transport` exclusions.
- **SDK public API.** `FilePreviewArgs.conversationId` optional: `pnpm gen:sdk-api` and a changeset
  bumping `@capybara-hq/plugin-sdk`.
- **Kernel.** New `FilesModule` with `@Injectable` providers, DTOs via `createZodDto`, errors
  registered; `AttachmentsService` keeps the non-chat purposes.
- New area rule to add to AGENTS.md: "**Files:** a file belongs to one account and reaches a
  conversation only by reference; bytes are per-org blobs keyed by sha256, shared by files and shares,
  deleted only by the blob sweep when nothing refers to them; a presigned upload never targets an
  existing blob, and another account's upload resolves to a blob only after its upload form expired."
