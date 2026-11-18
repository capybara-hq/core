# Channel file delivery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. With 11 tasks in two repositories, `wave-planned-subagent-development` governs the dispatch (wave table below).

**Goal:** Every `artifact_created` in a conversation with a channel delivery target reaches the IM
chat or thread as a native file or image message, in log order, or as one link line naming the file
when it cannot be sent.

**Architecture:** `channel@1` gains an optional `sendFile` and `features.files` (SDK). The kernel's
`Delivery.handle` gets an `artifact_created` case: pure decisions (native or link line, image or
file, caps, the link text) live in a new `channels/file-delivery.ts`; the delivery reads the object
through `StorageService.kernel(orgId)` under a per-process slot limit and calls a new
`ChannelOutboundSession.sendFile` (120 s timeout). Durability is the existing outbox-owed delivery
job, `last_seq` resume and per-seq idempotency keys. The testing fakes learn file uploads; Slack,
Lark and Telegram implement `sendFile` in the plugins repository after the core release.

**Tech Stack:** TypeScript, Nest kernel, Kysely / PostgreSQL, BullMQ (existing channel queue),
`@capybara-hq/plugin-sdk`, `@capybara-hq/testing`, Vitest (unit, integration, container); plugins
repository with `@slack/web-api`, the Lark and Telegram HTTP clients.

**Spec:** [channel file delivery](../specs/2026-11-18-channel-file-delivery-design.md). Its open
questions are decided as it recommends (no org switch, no sub-agent artifacts, no coalescing,
default 20 MiB, no share-link fallback). Read it whole before any task, and the skills of the area
a task touches before that task:
[writing-channels](../../../.agents/skills/writing-channels/SKILL.md),
[writing-kernel-api](../../../.agents/skills/writing-kernel-api/SKILL.md),
[writing-object-store-providers](../../../.agents/skills/writing-object-store-providers/SKILL.md),
[adding-config](../../../.agents/skills/adding-config/SKILL.md),
[writing-extensions](../../../.agents/skills/writing-extensions/SKILL.md); in the plugins
repository its own `writing-channels` and `writing-plugins` skills.

## Global Constraints

- `channel@1` stays `channel@1`: `sendFile?` and `features.files?` are optional; `features.files` is present iff `sendFile` is implemented. No new `ChannelSendFailure` reason.
- `ChannelSendFileArgs.idempotencyKey`: same rules as `ChannelSendArgs.idempotencyKey` (at most 40 `[A-Za-z0-9_-]`). Keys: the file `key(seq)`, the link line `key(seq, "-link")`, a scheduled run's root `key(seq, "-root")`.
- `kind` is `image` iff the content type (parameters dropped, lower-cased) is in `IMAGE_MEDIA_TYPES` (png, jpeg, gif, webp) and `size <= features.files.imageMaxBytes ?? features.files.maxBytes`; else `file`. SVG is a file.
- Native send iff `features.files` and `sendFile` exist, `0 < size <= min(features.files.maxBytes, channels.fileMaxBytes)` and `objectKey` starts with `artifacts/<conversationId>/`.
- `channels.fileMaxBytes`: default `20_971_520`, `0` = never native; `channels.fileConcurrency`: default `4`, positive. Deployment level, not hot, no org level. Env `CAPYBARA_CHANNELS__FILE_MAX_BYTES`, `CAPYBARA_CHANNELS__FILE_CONCURRENCY`.
- Plugin call timeout for `sendFile`: `120_000` ms (text calls keep 15 s).
- Objects are read only through `StorageService.kernel(<connection row orgId>)`; the stored size is authoritative, the event's size is display data.
- `too_large`, `rejected` and a non-retryable `ChannelSendError` without a reason from `sendFile` → link line + advance, never counted as poison; `rejected` / no reason also writes the redacted message to the connection's `last_error`. `auth` / `target_gone` / retryable keep today's handling.
- The model-controlled file name always appears in inline code (`asCode`), never as a mention, link or markup; placeholders are filled with a replacer function (no `$` patterns).
- Link URL: `<publicUrl>/chat/<conversationId>#file=<artifactId>` (`conversationUrl` + `#file=`).
- Multi-replica: no new queue, job, outbox entry, table or migration; the only in-process addition is the per-process slot limit over this process's memory.
- English comments and identifiers; translate the comments and test titles you edit (`pnpm check:english-comments --base origin/main`); kernel IM phrases in zh and en, zh never says 企业 or `agent`.
- Plugins repository: one `@capybara-hq/plugin-sdk` instance, the `overrides` entry in `pnpm-workspace.yaml` moves with every SDK pin bump; upload URLs (Slack's signature, Telegram's bot token) never appear in an error message.

## Review Focus

1. A file name carrying `$&`, `` ` ``, `<@U1>`, a URL or a newline → the link and root lines show it verbatim inside inline code; nothing becomes a mention or link (Task 3 tests).
2. A content type like `IMAGE/PNG; charset=binary` → image; `image/svg+xml`, `image/heic` → file (Task 3 tests).
3. The stored object is larger than the event's `size` claims (event 10 B, object cap + 1 B) → link line; the read stops at the cap instead of buffering it all (Task 3 `readArtifactCapped` test).
4. A plugin throws a non-retryable `ChannelSendError` with no `reason` from `sendFile` → treated as `rejected` (link line + `last_error`), not as a stuck event (Task 5 test).
5. Shutdown while a delivery waits for a file slot → the job is handed back (`shutdown`), no link line is sent and no slot leaks (Task 3 slot test, Task 5 mapping).

---

## File map

| Path | Change | Task |
|---|---|---|
| `packages/plugin-sdk/src/channel.ts` | `features.files?`, `sendFile?`, `ChannelFile`, `ChannelSendFileArgs` | 1 |
| `packages/plugin-sdk/src/cards.ts` | export `asCode` | 1 |
| `packages/plugin-sdk/agent-docs/extension-points/channel.md`, `api/plugin-sdk.api.md` | one sentence; regenerated | 1 |
| `packages/testing/src/fake-channel.ts`, `fixtures/extensions/fake-im/src/channel.ts`, `src/index.ts`, `src/fixtures.ts` | `/send-file`, fake-im `sendFile` | 2 |
| `packages/kernel/test/fixtures/plugins/chan-mini/index.ts` | declares `features.files` | 2 |
| `packages/kernel/src/channels/file-delivery.ts` (new) | decisions, link text, capped read, slots | 3 |
| `packages/kernel/src/channels/phrases.ts`, `features.ts` | three phrases; `adaptTarget` | 3 |
| `packages/kernel/src/config/schema.ts`, `docs/config.md` | two fields | 3 |
| `packages/kernel/src/storage/storage.service.ts`, `tools/builtins/artifacts.ts` | shared `isStorageUnavailable` | 3 |
| `packages/kernel/src/channels/connections.service.ts`, `outbound.ts`, `channels.module.ts` | session `sendFile`, the case | 5 |
| `packages/testing/src/fake-slack.ts`, `fake-lark.ts`, `fake-telegram.ts` | upload endpoints | 4 |
| `.agents/skills/writing-channels/SKILL.md`, `docs/deploy/README.md` | docs | 6 |
| `packages/kernel/test/channels/outbound-files.dual.test.ts` (new) | crash mid-upload | 7 |
| plugins repo: root pins, skill; `plugins/slack`, `plugins/lark`, `plugins/telegram` | `sendFile` | 8–11 |

## Wave plan

| Task | Depends on | Files / areas | Risk | Wave | Review |
|---|---|---|---|---|---|
| 1 SDK contract | — | plugin-sdk | normal | 1 | batched |
| 2 fake-channel + fake-im | 1 | testing (channel fake), chan-mini | normal | 2 | batched |
| 3 decisions, phrases, config | 1 | kernel channels (new file), config, storage helper | normal | 2 | batched |
| 4 platform fakes | 1, 2 (index.ts) | testing (slack/lark/telegram fakes) | normal | 3 | batched |
| 5 kernel delivery | 1, 2, 3 | kernel outbound, connections, module; integration tests | **high** (cross-tenant read, multi-replica delivery) | 3 | alone, most capable |
| 6 docs and skills | 1, 3 | skill, deploy doc | normal | 3 | batched |
| 7 dual-replica test | 5 | kernel container test | **high** (multi-replica) | 4 | alone |
| — core release (Version Packages PR publishes `plugin-sdk`, `testing`, `kernel`) | 1–7 | — | — | gate | — |
| 8 plugins: pins + skill | release | plugins root, skill | normal | P1 | batched |
| 9 Slack `sendFile` | 8 | `plugins/slack` | **high** (signed upload URL, scope mapping) | P2 | alone |
| 10 Lark `sendFile` | 8 | `plugins/lark` | normal | P2 | batched |
| 11 Telegram `sendFile` | 8 | `plugins/telegram` | **high** (bot token in the upload URL) | P2 | alone |

---

## Part A: core (capybara-hq/core)

### Task 1: SDK contract `sendFile`

**Files:**
- Modify: `packages/plugin-sdk/src/channel.ts:200-245` (the `Channel` interface; new types next to `ChannelSendArgs`)
- Modify: `packages/plugin-sdk/src/cards.ts:218` (`asCode` becomes `export function asCode`)
- Modify: `packages/plugin-sdk/agent-docs/extension-points/channel.md` (hand-written part)
- Regenerate: `packages/plugin-sdk/api/plugin-sdk.api.md`
- Create: `.changeset/channel-send-file-sdk.md`
- Test: `packages/plugin-sdk/test/channel.test.ts`, `packages/plugin-sdk/test/cards.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface ChannelFile {
    name: string; contentType: string; kind: "image" | "file"; data: Uint8Array;
  }
  export interface ChannelSendFileArgs {
    config: unknown; target: ChannelTarget; file: ChannelFile;
    signal: AbortSignal; locale: Locale; idempotencyKey?: string;
  }
  // Channel:
  features: { cards: boolean; edit: boolean; threads: boolean; minEditIntervalMs?: number;
              files?: { maxBytes: number; imageMaxBytes?: number } };
  sendFile?(args: ChannelSendFileArgs): Promise<{ messageId?: string }>;
  export function asCode(s: string): string; // unchanged body
  ```

- [ ] **Step 1: Write the failing tests.** In `channel.test.ts`, a type-level case
  `it("a channel may implement sendFile and declare features.files")` that builds a `Channel` object
  literal with `features.files: { maxBytes: 10, imageMaxBytes: 5 }` and a `sendFile` returning
  `{}` and asserts with `expectTypeOf<Parameters<NonNullable<Channel["sendFile"]>>[0]>().toEqualTypeOf<ChannelSendFileArgs>()`;
  a second literal without either still type-checks. In `cards.test.ts`:
  `expect(asCode("a`b")).toBe("``a`b``")`, `expect(asCode("<@U1>")).toBe("`<@U1>`")`,
  `expect(asCode("x\ny")).toBe("\n```\nx\ny\n```")`.
- [ ] **Step 2: Run** `pnpm exec vitest run packages/plugin-sdk/test/channel.test.ts packages/plugin-sdk/test/cards.test.ts` — FAIL (`asCode` / `ChannelSendFileArgs` not exported).
- [ ] **Step 3: Implement.** JSDoc in English: `files` "present iff `sendFile` is implemented; the
  kernel never hands a file larger than `maxBytes`, and sends `kind: "image"` only within
  `imageMaxBytes ?? maxBytes`"; `sendFile` "one message per file; the kernel picks `kind`; an
  extension may send an `image` as a file when the platform refuses it as an image, never the
  reverse; `messageId` when the platform returns it; failures as `send`; never put an upload URL in
  an error". `channel.md`: one sentence after the replies sentence: "Files: implement the optional
  `sendFile` and declare `features.files` (the platform's bot limits); the kernel sends each
  conversation artifact as one message and falls back to a link line without it."
- [ ] **Step 4: Run** the two tests — PASS; `pnpm gen:sdk-api`, then `pnpm check:sdk-api` and `pnpm check:agent-docs` — clean.
- [ ] **Step 5: Changeset** `.changeset/channel-send-file-sdk.md`: `"@capybara-hq/plugin-sdk": minor`,
  text: "`channel@1` gains the optional `sendFile` and `features.files` (one conversation artifact
  per message, `ChannelSendFileArgs`, `ChannelFile`); `asCode` is exported." Run `pnpm check:sdk-api-changeset`.
- [ ] **Step 6: Commit** `feat(sdk): optional sendFile and features.files on channel@1`.

### Task 2: fake-channel `/send-file` and fake-im `sendFile`

**Files:**
- Modify: `packages/testing/src/fake-channel.ts` (routes, records, `failNext` / `delayNext` path union)
- Modify: `packages/testing/fixtures/extensions/fake-im/src/channel.ts:168-230` (`makeFakeImChannel`)
- Modify: `packages/testing/fixtures/extensions/fake-im/src/index.ts:110` (fake-im declares files)
- Modify: `packages/kernel/test/fixtures/plugins/chan-mini/index.ts` (declares files)
- Modify: `packages/testing/src/index.ts` (export `FakeChannelSentFile`), `packages/testing/src/fixtures.ts:24` (table row mentions `sendFile`)
- Create: `.changeset/testing-channel-files.md` (`"@capybara-hq/testing": minor`)
- Test: `packages/testing/test/fake-channel.test.ts`

**Interfaces:**
- Consumes: `ChannelFile`, `ChannelSendFileArgs`, `features.files` (Task 1).
- Produces:
  ```ts
  export interface FakeChannelSentFile {
    appId: string; target: ChannelTarget; name: string; contentType: string;
    kind: "image" | "file"; data: Buffer; sha256: string; messageId: string; pid: number;
    idempotencyKey?: string; locale?: "zh" | "en"; at: number;
  }
  // FakeChannelServer gains:
  sentFiles: FakeChannelSentFile[];
  duplicateFiles: FakeChannelSentFile[];
  failNext(path: "/send" | "/update" | "/send-file", ...same params);
  delayNext(path: "/send" | "/update" | "/send-file", delayMs, opts?);
  ```
  Wire format of fake-im `sendFile`: `POST <platformUrl>/send-file` JSON
  `{ appId, target, file: { name, contentType, kind, data: <base64> }, idempotencyKey, locale }`,
  answer `{ messageId }` (`of_<n>`); errors through the existing `post()` classification.
  `makeFakeImChannel` attaches `sendFile` iff `features.files` is given.
  Caps: fake-im `files: { maxBytes: 20_971_520, imageMaxBytes: 10_485_760 }`; chan-mini
  `files: { maxBytes: 131_072, imageMaxBytes: 32_768 }`; chan-noedit, chan-plain, chan-slowedit
  stay without files (the link-line fixtures).

- [ ] **Step 1: Write the failing tests** in `fake-channel.test.ts` (direct HTTP, no kernel):
  `/send-file` records name, type, kind, the decoded bytes and their sha256, the target and key;
  a repeat with the same `(appId, idempotencyKey)` lands in `duplicateFiles` with the same
  `messageId` when `dedupeSends` is true and in `sentFiles` twice when false;
  `failNext("/send-file", 400, 1, undefined, "rejected")` answers `{ reason: "rejected" }` without
  recording; `textIncludes` in the match is compared with the file name; `delayNext("/send-file", …)`
  records at arrival and answers late.
- [ ] **Step 2: Run** `pnpm exec vitest run packages/testing/test/fake-channel.test.ts` — FAIL.
- [ ] **Step 3: Implement** the route in the existing `sendOrUpdate` style (reuse `failures`,
  `delays`, `byKey`), the fake-im `sendFile`, the feature declarations.
- [ ] **Step 4: Run** the test — PASS; `pnpm typecheck`.
- [ ] **Step 5: Commit** `test(testing): fake channel file sends and fake-im sendFile`.

### Task 3: file delivery decisions, phrases and config

**Files:**
- Create: `packages/kernel/src/channels/file-delivery.ts`
- Modify: `packages/kernel/src/channels/phrases.ts` (three entries before `runStopped`)
- Modify: `packages/kernel/src/channels/features.ts` (extract `adaptTarget`)
- Modify: `packages/kernel/src/config/schema.ts:1213-1312` (two fields + the `.default({...})` block)
- Modify: `packages/kernel/src/storage/storage.service.ts` (export `isStorageUnavailable`), `packages/kernel/src/tools/builtins/artifacts.ts:43-45` (use it, drop the local `isStorageGone`)
- Regenerate: `docs/config.md`
- Test: `packages/kernel/test/channels/file-delivery.test.ts` (new, unit), `packages/kernel/test/channels/features.test.ts`
- Modify: `packages/kernel/test/unit-tests.json` (add `"channels/file-delivery.test.ts"` in order)

**Interfaces:**
- Consumes: `Channel["features"]`, `asCode`, `IMAGE_MEDIA_TYPES`, `ObjectStore` (SDK); `conversationUrl` (`channels/cards.ts`).
- Produces (all exported from `file-delivery.ts`):
  ```ts
  type ArtifactPayload = Extract<ConversationEvent, { type: "artifact_created" }>["payload"];
  export type FileDeliveryPlan =
    | { mode: "native"; kind: "image" | "file"; cap: number }
    | { mode: "link"; reason: "unsupported" | "disabled" | "too_large" | "empty" | "foreign_key" };
  export function planFileDelivery(input: {
    conversationId: string; artifact: Pick<ArtifactPayload, "objectKey" | "size" | "contentType">;
    features: Channel["features"]; canSendFile: boolean; fileMaxBytes: number;
  }): FileDeliveryPlan;
  export function fileKind(contentType: string, size: number,
    files: NonNullable<Channel["features"]["files"]>): "image" | "file";
  export function formatFileSize(bytes: number): string;
  export function fileLinkText(input: { name: string; size: number; artifactId: string;
    conversationId: string; base: string | undefined; locale: ChannelLocale }): string;
  export function fileRootText(name: string, locale: ChannelLocale): string;
  export type CappedRead =
    | { kind: "ok"; data: Uint8Array } | { kind: "missing" } | { kind: "too_large" } | { kind: "unavailable" };
  export function readArtifactCapped(store: ObjectStore, key: string, cap: number,
    signal: AbortSignal): Promise<CappedRead>;
  export class FileSlots {
    constructor(limit: number);
    /** Resolves with a release function; rejects with `signal.reason` when aborted while waiting. */
    acquire(signal: AbortSignal): Promise<() => void>;
  }
  // features.ts
  export function adaptTarget(features: Channel["features"], target: ChannelTarget): ChannelTarget;
  // storage.service.ts
  export function isStorageUnavailable(e: unknown): boolean; // ApiError storage.unavailable or ExtensionPointUnavailableError
  ```
  Decision order in `planFileDelivery`: foreign key → `foreign_key`; `size === 0` → `empty`;
  no `features.files` or `!canSendFile` → `unsupported`; `fileMaxBytes === 0` → `disabled`;
  `size > cap` (`cap = min(files.maxBytes, fileMaxBytes)`) → `too_large`; else native with
  `fileKind`. `formatFileSize`: `< 1024` → `"<n> B"`, else 1024-based with one decimal and
  `KB` / `MB` / `GB` (`1536` → `"1.5 KB"`, `2_411_724` → `"2.3 MB"`, `1_073_741_824` → `"1.0 GB"`).
  `readArtifactCapped`: `get` null → `missing`; `head.size > cap` → `too_large` (cancel the body);
  bytes passing `cap` while reading → `too_large` (cancel the reader); `isStorageUnavailable` →
  `unavailable`; any other error rethrown (retryable).
  Phrases (exact copy; `{name}` is already `asCode(name)`):
  - `fileOnWeb`: en `"{name} ({size}) is in the web conversation: {url}"`, zh `"{name}（{size}）在网页会话里：{url}"`
  - `fileOnWebNoLink`: en `"{name} ({size}) was delivered; open the conversation in Capybara on the web to get it."`, zh `"{name}（{size}）已交付，请在网页上打开 Capybara 中的这个会话获取。"`
  - `fileDelivered`: en `"Delivered {name}."`, zh `"已交付文件 {name}。"`
  Config: `fileMaxBytes: z.number().int().nonnegative().default(20_971_520)`, description
  "Largest conversation file a channel delivery sends into the IM chat as a native file or image,
  in bytes; larger files, and every file when 0, become one line linking to the web conversation.
  Each worker replica holds at most fileConcurrency such files in memory at once";
  `fileConcurrency: z.number().int().positive().default(4)`, description "How many conversation
  files one worker replica reads and uploads to IM platforms at the same time; further file
  deliveries wait for a slot". Both added to the section's `.default({...})`.

- [ ] **Step 1: Write the failing unit tests** in `file-delivery.test.ts` (no app, no containers):
  - `planFileDelivery`: native image for a 1 KiB `image/png` on `{maxBytes: 100_000, imageMaxBytes: 10_000}`; `image/png` of 20_000 → native `file`; `IMAGE/PNG; charset=binary` → image; `image/svg+xml` and `image/heic` → file; `size: 0` → `empty`; key `artifacts/other-conv/x` → `foreign_key`; no `files` or `canSendFile: false` → `unsupported`; `fileMaxBytes: 0` → `disabled`; `size` over `min(maxBytes, fileMaxBytes)` from either side → `too_large`, and `cap` equals the min.
  - `formatFileSize`: `512`, `1536`, `2_411_724`, `1_073_741_824` as above.
  - `fileLinkText`: en with base `https://cap.example` equals ``"`report.pdf` (2.3 MB) is in the web conversation: https://cap.example/chat/c1#file=a1"``; zh equals ``"`report.pdf`（2.3 MB）在网页会话里：https://cap.example/chat/c1#file=a1"``; without base the `fileOnWebNoLink` text; names `` a`b ``, `<@U1>`, `https://evil.example`, `$&x`, `a\nb` appear exactly as `asCode(name)` (the `$&` case proves the replacer function).
  - `fileRootText("chart.png", "en")` equals ``"Delivered `chart.png`."``.
  - `readArtifactCapped` on `MemoryObjectStore` (`packages/kernel/test/storage/memory-store.ts`): ok returns the bytes; missing key → `missing`; object of cap + 1 → `too_large`; a store whose `get` returns `head.size: 10` but a body of cap + 1 bytes → `too_large` with the reader cancelled; a store throwing `storageUnavailable()` → `unavailable`; a store throwing `new Error("ECONNRESET")` rejects.
  - `FileSlots(2)`: a third `acquire` waits until one release; aborting a waiting `acquire` rejects it and the next release still admits the following waiter (no leaked slot); releasing twice frees one slot only.
  - Config via `resolveConfig(base, env)` (as `test/config/channels-webhook.test.ts`): defaults `20_971_520` and `4`; env `CAPYBARA_CHANNELS__FILE_MAX_BYTES=0` accepted; `-1` and `CAPYBARA_CHANNELS__FILE_CONCURRENCY=0` throw `ConfigError`.
  In `features.test.ts`: `adaptTarget` drops `threadId` when `threads` is false and returns the same target otherwise; `adaptToFeatures` cases stay green.
- [ ] **Step 2: Run** `pnpm exec vitest run packages/kernel/test/channels/file-delivery.test.ts packages/kernel/test/channels/features.test.ts` — FAIL.
- [ ] **Step 3: Implement** the functions, phrases, `adaptTarget` (used by `adaptToFeatures`),
  config fields, `isStorageUnavailable` and its use in `artifacts.ts`. Fill placeholders with
  `s.replace(/\{(name|size|url)\}/g, (_, k) => values[k])`. `FileSlots` is a plain class (a counter
  and a FIFO of waiters), not a provider.
- [ ] **Step 4: Run** the tests — PASS; `pnpm gen:config-docs`, `pnpm check:config-docs`, `pnpm check:test-portfolio`, `pnpm test:unit`.
- [ ] **Step 5: Commit** `feat(kernel): channel file delivery decisions, phrases and config`.

### Task 4: Slack, Lark and Telegram fakes accept uploads

**Files:**
- Modify: `packages/testing/src/fake-slack.ts` (methods `files.getUploadURLExternal`, `files.completeUploadExternal`; route `POST /upload/<fileId>`)
- Modify: `packages/testing/src/fake-lark.ts` (`POST /open-apis/im/v1/images`, `POST /open-apis/im/v1/files`, multipart; `msg_type` `image` / `file` checked in `checkContent`; `FakeLarkApi` gains `"image_upload" | "file_upload"`)
- Modify: `packages/testing/src/fake-telegram.ts` (`sendPhoto`, `sendDocument`, multipart)
- Modify: `packages/testing/src/index.ts` (the new record types)
- Create: `.changeset/testing-platform-uploads.md` (`"@capybara-hq/testing": minor`)
- Test: `packages/testing/test/fake-slack.test.ts`, `packages/testing/test/fake-telegram.test.ts`, `packages/testing/test/fake-lark.test.ts` (new)

**Interfaces:**
- Produces:
  ```ts
  // fake-slack
  export interface FakeSlackFile { id: string; filename: string; title?: string; channel: string;
    threadTs?: string; data: Buffer; at: number }
  FakeSlackServer.files: FakeSlackFile[];      // completed uploads only
  // files.getUploadURLExternal(filename, length) → { ok, upload_url: `${url}/upload/<id>`, file_id }
  // POST /upload/<id>: raw body or one multipart file part; byte length must equal `length`, else 400
  // files.completeUploadExternal(files: JSON [{id,title}], channel_id, thread_ts?) → { ok, files: [{ id, title }] }
  //   unknown or not uploaded id → { ok: false, error: "invalid_arguments" }; no `shares` in the answer
  // fake-lark
  export interface FakeLarkUpload { kind: "image" | "file"; key: string; fileType?: string;
    fileName?: string; data: Buffer; at: number }
  FakeLarkServer.uploads: FakeLarkUpload[];
  // images: fields image_type=message, image → { code: 0, data: { image_key } }
  // files: fields file_type, file_name, file → { code: 0, data: { file_key } }
  // create / reply with msg_type image|file: content {"image_key"} / {"file_key"} must name a known upload, else 230001
  // fake-telegram
  FakeTelegramMessage gains file?: { kind: "photo" | "document"; name: string; contentType: string; data: Buffer };
  // sendPhoto(photo) / sendDocument(document): multipart, chat_id, reply_parameters, message_thread_id as JSON fields
  ```
  Multipart parsing: `await new Response(rawBuffer, { headers: { "content-type": … } }).formData()`
  (the `fake-e2b.ts:609` pattern); the fakes' existing `failNext` / delay mechanisms cover the new
  methods (Telegram tests inject `PHOTO_INVALID_DIMENSIONS` on `sendphoto` with `failNext`).

- [ ] **Step 1: Write the failing tests**: Slack three-step upload into a thread records one `FakeSlackFile` with the bytes; a length mismatch is refused; completing an unknown id fails. Lark: image upload then `msg_type: "image"` reply-in-thread with a `uuid` records the upload and the message, a repeated `uuid` answers the same `message_id`; an unknown `file_key` fails 230001. Telegram: `sendPhoto` and `sendDocument` with `message_thread_id` record `file` and the thread; `failNext("sendphoto", { status: 400, description: "Bad Request: PHOTO_INVALID_DIMENSIONS" })` answers that envelope.
- [ ] **Step 2: Run** `pnpm exec vitest run packages/testing/test/fake-slack.test.ts packages/testing/test/fake-lark.test.ts packages/testing/test/fake-telegram.test.ts` — FAIL.
- [ ] **Step 3: Implement** in each fake's existing dispatch style; the Lark and Telegram handlers need the raw `Buffer` body for multipart (their `readBody` returns a string today: read bytes for these routes).
- [ ] **Step 4: Run** the tests — PASS; `pnpm typecheck`.
- [ ] **Step 5: Commit** `test(testing): Slack, Lark and Telegram fakes accept file uploads`.

### Task 5: kernel delivers `artifact_created` (high risk)

**Files:**
- Modify: `packages/kernel/src/channels/connections.service.ts:82` (`FILE_CALL_TIMEOUT_MS = 120_000`), `:1064-1091` (`outbound` adds `sendFile`), `:1110-1130` (`ChannelOutboundSession`)
- Modify: `packages/kernel/src/channels/outbound.ts` (imports; `DeliveryDeps` `:204-221`; constructor `:263-305`; `recordError` `:479` loses `private`; `Delivery.run` catch `:733`; `handle` `:1009-1120` new case; new private methods after `approvalCardAt`)
- Modify: `packages/kernel/src/channels/channels.module.ts:45` (import `StorageModule`)
- Create: `packages/kernel/test/channels/outbound-files.test.ts` (integration, one app)
- Modify: `packages/kernel/test/schedules/channel-delivery.test.ts` (add `mem-store`, one case)
- Create: `.changeset/channel-file-delivery-kernel.md` (`"@capybara-hq/kernel": minor`)

**Interfaces:**
- Consumes: Task 1 types; Task 3 `planFileDelivery`, `readArtifactCapped`, `FileSlots`, `fileLinkText`, `fileRootText`, `adaptTarget`; Task 2 `FakeChannelSentFile`, chan-mini caps.
- Produces:
  ```ts
  // ChannelOutboundSession (present iff channel.sendFile && channel.features.files)
  sendFile?: (target: ChannelTarget, file: ChannelFile, idempotencyKey?: string,
              locale?: ChannelLocale) => Promise<{ messageId?: string }>;
  // DeliveryDeps gains
  storage: Pick<StorageService, "kernel">;
  fileSlots: FileSlots;             // one per ChannelOutbound, limit = channels.fileConcurrency at construction
  writes: Pick<ChannelOutbound, "advanceIn" | "bindThreadIn" | "recordError">;
  // outbound.ts
  class DeliveryShutdownError extends Error {}   // run() maps it to { kind: "shutdown" }
  private async deliverArtifact(e: Extract<ConversationEvent, { type: "artifact_created" }>): Promise<void>;
  private async linkLine(seq: number, a: ArtifactPayload): Promise<void>; // send(key(seq,"-link")) + advance(seq)
  ```
  `deliverArtifact` flow: `planFileDelivery` (canSendFile = `this.s.sendFile !== undefined`) → link
  plan: `linkLine`. Native: `acquire(this.stopping)` (abort → `DeliveryShutdownError`); after the
  slot, `lease.lost` → `DeliveryLostError`; `readArtifactCapped(storage.kernel(this.s.row.orgId), …,
  AbortSignal.timeout(120_000))`; not ok → `linkLine` (`warn` for missing / unavailable); when
  `threadPending`, `send({ text: fileRootText }, key(seq, "-root"))` first (binds the thread);
  `sendFile(this.target, { name, contentType, kind, data }, key(seq), this.locale)`; catch a
  non-retryable `ChannelSendError` whose reason is `too_large` (log `info`), `rejected` or undefined
  (`writes.recordError(connectionId, redact(message))`) → `linkLine`; everything else rethrown to
  `run()`'s existing handling; `finally` releases the slot; success → `advance(seq)`.

- [ ] **Step 1: Write the failing integration tests** in `outbound-files.test.ts` (one kernel:
  `MODEL_FAKE` with models `fake-1` and `{ id: "fake-image", kind: "image_generation" }`,
  `mem-store`, `sandbox-fake` when `GenerateImage` needs it (as `test/tools/generate-image.test.ts`),
  `chan-mini`, `chan-noedit`; `http.publicUrl: "https://cap.example"`, `deliveryIdleMs: 1000`;
  `startFakeChannelServer({ dedupeSends: false })`; a helper `deliverArtifact(conv, name, bytes,
  type)` that puts the object with `StorageService.kernel(orgId)` and appends `artifact_created`
  through `EventLog.append`, as `test/conversations/files.http.test.ts:141-178`). At least six
  `it`s (`check:test-portfolio` small-app rule):
  1. A DM `tool:GenerateImage:{"prompt":"a cat"}` (image purpose mapped to `fake-image`) → one `sentFiles` entry: `kind: "image"`, `contentType: "image/png"`, `sha256` of `FAKE_PNG_BASE64`, `idempotencyKey === idempotencyKey(`${conv}-${seq}`)` for the event's seq, and its `at` is before the final reply's `sent` entry.
  2. Two artifacts in one append in a group thread (a 1 KiB `application/pdf`, a 40 KiB `image/png`) → two `sentFiles` in seq order, both with the thread's `threadId`, kinds `file` and `file` (the PNG is over chan-mini's `imageMaxBytes` 32 768).
  3. On a chan-noedit connection a 1 KiB `report.pdf` → no file; one `sent` text equal to ``"`report.pdf` (1.0 KB) is in the web conversation: https://cap.example/chat/<conv>#file=<artifactId>"`` with key `idempotencyKey(`${conv}-${seq}-link`)`.
  4. On chan-mini a 200 KiB file and an empty file → two link lines, no `sentFiles`; delivery `last_seq` reaches the conversation's.
  5. An artifact whose object was deleted from storage before delivery → link line.
  6. `failNext("/send-file", 413, 1, undefined, "too_large")` → link line, connection `last_error` unchanged; `failNext("/send-file", 400, 1, undefined, "rejected")` → link line and `last_error` starts with `delivery failed:`; `failNext("/send-file", 400)` with no reason → the same as `rejected` (Review Focus 4).
  7. `failNext("/send-file", 429, 1, 50)` → exactly one `sentFiles` entry after the retry, with the same key.
  8. `failNext("/send-file", 404, 1, undefined, "target_gone")` → no link line, delivery `last_seq` stays before the artifact's seq.
  In `schedules/channel-delivery.test.ts` (add `mem-store` to its extensions): a group scheduled run on chan-mini whose first logged output is an artifact (append it while the run's scripted reply is still waiting) → first `sent` is the root text ``"Delivered `chart.png`."`` with key suffix `-root`, then the file with `target.threadId` equal to the root's `messageId`, then the run's reply in the same thread; `pending_thread_account_id` is null.
- [ ] **Step 2: Run** `pnpm exec vitest run packages/kernel/test/channels/outbound-files.test.ts packages/kernel/test/schedules/channel-delivery.test.ts` — FAIL (no files sent; artifacts skipped).
- [ ] **Step 3: Implement** the session method (`adaptTarget`, `AbortSignal.timeout(FILE_CALL_TIMEOUT_MS)`, `locale`, the key when given), `StorageService` injected into `ChannelOutbound` (explicit `@Inject(StorageService)`) and passed into `DeliveryDeps` with a `FileSlots(config.get().channels.fileConcurrency)`, `recordError` exposed through `writes`, the `artifact_created` case calling `deliverArtifact`, `DeliveryShutdownError` mapped in `run()`. Translate the Chinese comments on lines you edit.
- [ ] **Step 4: Run** the two files — PASS; then `pnpm exec vitest run packages/kernel/test/channels/outbound.test.ts packages/kernel/test/channels/outbox-delivery.test.ts` (unchanged behaviour), `pnpm check:kernel-conventions`, `pnpm check:test-portfolio`, `pnpm check:english-comments --base origin/main`, `pnpm typecheck`, `pnpm lint`.
- [ ] **Step 5: Changeset** `.changeset/channel-file-delivery-kernel.md`: "Conversation files (`Deliver`, `GenerateImage`, every `artifact_created`) reach the IM chat or thread through the optional `channel@1` `sendFile`, images as images; a file that cannot be sent becomes one line linking to the web conversation. New config `channels.fileMaxBytes` (default 20 MiB, 0 = links only) and `channels.fileConcurrency` (default 4)."
- [ ] **Step 6: Commit** `feat(kernel): deliver conversation artifacts into channels`.

### Task 6: docs and skills

**Files:**
- Modify: `.agents/skills/writing-channels/SKILL.md` (`## channel@1` block at `:36`, a new `### sendFile` subsection after `### send / update` `:124-133`, the kernel tests line `:267`)
- Modify: `docs/deploy/README.md` (the channels section near `:354`: memory bound `fileConcurrency × fileMaxBytes` per worker replica, `fileMaxBytes: 0` keeps files out of IM)

**Interfaces:**
- Consumes: Task 1 contract, Task 3 config names and phrases, Task 5 behaviour (from the spec §4).

- [ ] **Step 1: Write** the skill subsection: the contract shape; how the kernel decides (native vs link line, kind, caps, the foreign-key and empty checks); the keys `key(seq)` / `-link` / `-root`; the failure table of spec §4.5 including "no reason = `rejected`"; the scheduled root; the per-process slots; the tests (`outbound-files.test.ts`, `outbound-files.dual.test.ts`, `file-delivery.test.ts`, the fakes' upload endpoints). Update the description front matter only if it must name `sendFile` (`pnpm check:skills-frontmatter`).
- [ ] **Step 2: Run** `pnpm check:skills-frontmatter`, `pnpm check:terms`, `pnpm lint` — clean.
- [ ] **Step 3: Commit** `docs: channel file delivery in the writing-channels skill and the deploy guide`.

### Task 7: dual-replica crash mid-upload (high risk)

**Files:**
- Create: `packages/kernel/test/channels/outbound-files.dual.test.ts`
- Modify: `packages/kernel/test/container-tests.json` (add `"channels/outbound-files.dual.test.ts"` in order)

**Interfaces:**
- Consumes: Task 2 `delayNext("/send-file")`, `sentFiles`, `duplicateFiles`; Task 5 behaviour.

- [ ] **Step 1: Write the test** on `createDualReplicaHarness` (bootstrap as `outbound.dual.test.ts:68-143`) with `MODEL_FAKE` (+ `fake-image`), `fake-object-store` on `startTestS3()` (shared by both replicas, config as `test/conversations/files.http.test.ts:69-79`), `sandbox-fake` if `GenerateImage` needs it, `chan-mini`; `runtime: { jobLockMs: 2000, stalledIntervalMs: 1000 }`; a key-honouring platform `startFakeChannelServer()` (dedupe on). `it("the replica uploading a file dies; the other replica resends it with the same key and the chat shows one file")`: `platform.delayNext("/send-file", 30_000)`; a DM `tool:GenerateImage:{"prompt":"x"}`; wait for `sentFiles[0]`; kill the replica whose pid is on it; wait for a `duplicateFiles` entry from the survivor with the same `idempotencyKey`; wait until `channel_deliveries.last_seq` equals the conversation's `last_seq`; then `sentFiles` has length 1 and the run's final reply was sent once. No fixed sleeps, no per-test timeouts.
- [ ] **Step 2: Run** `pnpm exec vitest run packages/kernel/test/channels/outbound-files.dual.test.ts` — PASS (the behaviour exists since Task 5; prove the test can fail by temporarily changing the file key suffix in `deliverArtifact` locally and seeing a second `sentFiles` entry, then revert).
- [ ] **Step 3: Run** `pnpm check:test-portfolio` — clean.
- [ ] **Step 4: Commit** `test(kernel): channel file delivery survives a replica dying mid-upload`.

After Task 7: `pnpm verify`, the PR (issue linked), the final whole-branch review, merge, and the
Version Packages PR that publishes `@capybara-hq/plugin-sdk`, `@capybara-hq/testing` and
`@capybara-hq/kernel`. Part B starts only once those versions are on npm.

---

## Part B: plugins (capybara-hq/plugins, after the core release)

Work in a plugins worktree (`pnpm wt:new <branch>` there). Each plugin keeps its own README and
changeset; versions move through that repository's Version Packages PR. No channel plugin is a
bootstrap plugin in `packages/kernel/bootstrap.json`, so core needs no pin change.

### Task 8: SDK and testing pins, plugins skill

**Files:**
- Modify: `package.json` (root devDependencies `@capybara-hq/plugin-sdk`, `@capybara-hq/testing` to the released versions)
- Modify: `pnpm-workspace.yaml` (`overrides."@capybara-hq/plugin-sdk"` to the same version)
- Modify: `pnpm-lock.yaml` (`pnpm install`)
- Modify: `.agents/skills/writing-channels/SKILL.md` (a `sendFile` section: declare `features.files` with the platform's bot limits, the kernel picks `kind`, image may fall back to file never the reverse, one message per call, map the platform's missing-permission error for uploads to `rejected` not `auth`, never put an upload URL or token in an error, the fakes' upload endpoints)

- [ ] **Step 1:** Bump the pins and the override, `pnpm install`.
- [ ] **Step 2: Run** `pnpm why @capybara-hq/plugin-sdk` — one version; `pnpm exec vitest run plugins/connector-mcp/test/kernel plugins/connector-openapi/test/kernel` — PASS (the single-instance rule).
- [ ] **Step 3:** Write the skill section; `pnpm check`, `pnpm lint`, `pnpm typecheck`.
- [ ] **Step 4: Commit** `chore: plugin-sdk and testing with channel sendFile`.

### Task 9: Slack `sendFile` (high risk)

**Files:**
- Modify: `plugins/slack/src/channel.ts` (`features` at `:477` gains `files`; `sendFile`)
- Modify: `plugins/slack/src/errors.ts` (an upload variant of the mapping)
- Modify: `plugins/slack/src/setup-checks.ts:21` (`REQUIRED_BOT_SCOPES` gains `files:write`)
- Modify: `plugins/slack/guides/slack-app.md`, `plugins/slack/guides/slack-app.zh.md` (manifest `bot:` scopes gain `- files:write # upload conversation files`), `plugins/slack/README.md`, `plugins/slack/package.json` (SDK range `^<released>`)
- Create: `.changeset/slack-send-file.md` (minor; tells admins to add `files:write` and reinstall the app)
- Test: `plugins/slack/test/channel.test.ts`, `plugins/slack/test/setup-checks.test.ts`, `plugins/slack/test/guides.test.ts`, `plugins/slack/test/live/slack.live.test.ts`

**Interfaces:**
- Consumes: `ChannelSendFileArgs` (Task 1), `startFakeSlack` uploads (Task 4).
- Produces: `features.files: { maxBytes: 1_073_741_824, imageMaxBytes: 1_073_741_824 }`;
  `sendFile` = `apiCall("files.getUploadURLExternal", { filename: name, length })` → `fetch(upload_url, { method: "POST", body: data, signal })` → `apiCall("files.completeUploadExternal", { files: JSON.stringify([{ id, title: name }]), channel_id: target.chatId, thread_ts: target.threadId })`; returns `{ messageId }` only when the answer carries `files[0].shares.*.<channel>[0].ts`, else `{}`. `kind` makes no difference. The key is ignored (Ruling R5).
  Error mapping for the three calls: the general table, except `missing_scope` / `not_allowed_token_type` → `rejected` (not `auth`: a missing `files:write` must not stall the conversation's text); a failed upload POST → `ChannelSendError("files upload failed with status <n>", …)` (5xx / 429 retryable, 413 `too_large`, else `rejected`), with no URL in the message.

- [ ] **Step 1: Write the failing tests:** against `startFakeSlack`, a file into a thread records one `FakeSlackFile` with the same bytes, `channel` and `threadTs`; `failNext("files.getUploadURLExternal", { error: "missing_scope" })` throws a non-retryable `rejected`; an upload POST answering 500 is retryable and its error message contains neither the upload URL nor its path; the `bot-scopes` check names `files:write` as missing for a token without it; the guides test sees `files:write` in both manifests. Live (inside the existing `CAPYBARA_TEST_LIVE_TOOLS` + `CAPYBARA_TEST_SLACK_*` gate, only when `CAPYBARA_TEST_SLACK_CHANNEL` is set): send a small PNG as `image` and a small text file as `file`.
- [ ] **Step 2: Run** `pnpm exec vitest run plugins/slack/test/channel.test.ts plugins/slack/test/setup-checks.test.ts plugins/slack/test/guides.test.ts` — FAIL.
- [ ] **Step 3: Implement**; the README's scope table and setup steps name `files:write`.
- [ ] **Step 4: Run** the tests — PASS; `pnpm exec vitest run plugins/slack/test/kernel` (unchanged, green); `pnpm check`; the live test once with the env file loaded inside the command. The kernel side of the flow is proven in core (Tasks 5, 7); no new embedded-kernel case here.
- [ ] **Step 5: Commit** `feat(slack): send conversation files with files:write`.

### Task 10: Lark `sendFile`

**Files:**
- Modify: `plugins/lark/src/api.ts` (a multipart `upload<T>(creds, path, form: FormData, o)` beside `call`, own timeout `115_000`)
- Modify: `plugins/lark/src/channel.ts` (`features` at `:324` gains `files`; `sendFile`)
- Modify: `plugins/lark/src/errors.ts` (upload variant: `99991672` → `rejected`)
- Modify: `plugins/lark/README.md` (permission table gains the upload permission), `plugins/lark/package.json` (SDK range)
- Create: `.changeset/lark-send-file.md` (minor; tells admins to add the permission)
- Test: `plugins/lark/test/channel.test.ts`, `plugins/lark/test/live/lark.live.test.ts`

**Interfaces:**
- Produces: `features.files: { maxBytes: 31_457_280, imageMaxBytes: 10_485_760 }`; `image` → `POST /open-apis/im/v1/images` (`image_type=message`, `image`) → `msg_type: "image"`, content `{"image_key"}`; `file` → `POST /open-apis/im/v1/files` (`file_type` from the lower-cased extension: `pdf`; `doc`/`docx` → `doc`; `xls`/`xlsx` → `xls`; `ppt`/`pptx` → `ppt`; `mp4`; `opus`; else `stream`; `file_name`, `file`) → `msg_type: "file"`, content `{"file_key"}`; then create or reply-in-thread exactly like text with `uuid = uuidFor(idempotencyKey, 0)`; returns `{ messageId }`. Confirm the permission name (`im:resource`, 获取与上传图片或文件资源) against Lark's documentation and write the confirmed name into the README.

- [ ] **Step 1: Write the failing tests** against `startFakeLark`: an image into a thread uploads then replies with `reply_in_thread: true`, `msg_type: "image"` and the key as `uuid`; a `.docx` is uploaded with `file_type: "doc"`, an unknown extension with `stream`; a repeated call with the same key yields the same `message_id`; `failNext("image_upload", { code: 99991672 })` throws non-retryable `rejected`. Live (existing `CAPYBARA_TEST_LARK_*` gate): an image and a file into `CAPYBARA_TEST_LARK_CHAT_ID`.
- [ ] **Step 2: Run** `pnpm exec vitest run plugins/lark/test/channel.test.ts` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS; `pnpm check`; the live test once.
- [ ] **Step 5: Commit** `feat(lark): send conversation files as images and files`.

### Task 11: Telegram `sendFile` (high risk)

**Files:**
- Modify: `plugins/telegram/src/api.ts` (`upload<T>(method, fields: Record<string, string>, file: { field: string; name: string; contentType: string; data: Uint8Array }, signal)`, own timeout `115_000`, errors through `TelegramApiError` with no URL)
- Modify: `plugins/telegram/src/channel.ts` (`features` at `:216` gains `files`; `sendFile`; record the sent message in the thread store as `send` does)
- Modify: `plugins/telegram/src/errors.ts` (413 → `too_large`), `plugins/telegram/README.md`, `plugins/telegram/package.json` (SDK range)
- Create: `.changeset/telegram-send-file.md` (minor)
- Test: `plugins/telegram/test/channel.test.ts`, `plugins/telegram/test/api.test.ts`, `plugins/telegram/test/live/telegram.live.test.ts`

**Interfaces:**
- Produces: `features.files: { maxBytes: 50_000_000, imageMaxBytes: 10_000_000 }`; `image` → `sendPhoto`; a 400 whose description contains `PHOTO_` or `IMAGE_PROCESS_FAILED` → one retry as `sendDocument`; `file` → `sendDocument`; fields `chat_id`, `reply_parameters` / `message_thread_id` as for text (JSON-encoded where the Bot API expects objects); returns `{ messageId: String(message_id) }`.

- [ ] **Step 1: Write the failing tests** against `startFakeTelegram`: a photo into a topic records `file.kind: "photo"` with `messageThreadId`; with `failNext("sendphoto", { status: 400, description: "Bad Request: PHOTO_INVALID_DIMENSIONS" })` the same call ends as one `document`; a document records its name; a 413 maps to `too_large`; a network failure's error message does not contain the bot token (`api.test.ts`). Live (existing `CAPYBARA_TEST_TELEGRAM_*` gate): a photo and a document into `CAPYBARA_TEST_TELEGRAM_CHAT_ID`.
- [ ] **Step 2: Run** `pnpm exec vitest run plugins/telegram/test/channel.test.ts plugins/telegram/test/api.test.ts` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS; `pnpm check`; the live test once.
- [ ] **Step 5: Commit** `feat(telegram): send conversation files as photos and documents`.

After Tasks 9–11: `pnpm verify` in the plugins repository, one PR (or one per plugin), merge, the
plugins Version Packages PR. Release notes (the changesets) tell Slack admins to add `files:write`
and Lark admins to add the upload permission.
