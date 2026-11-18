# Channel file delivery: conversation artifacts reach the IM user

- Date: 2026-11-18.
- Status: draft for maintainer review.
- Scope agreed with the maintainer: everything that writes `artifact_created` reaches the IM
  conversation (the `Deliver` tool, `GenerateImage` images, any later producer), not a special
  case for one tool. Images show as images where the platform allows it.
- Relates to: the transactional outbox design `2026-11-12-transactional-outbox-design.md` (§8.1,
  owed channel deliveries), the scheduled tasks design `2026-11-11-scheduled-tasks-design.md` (§8,
  a group run's thread bound at its first post), the file sharing design
  `2026-11-18-file-sharing-design.md` (considered as a fallback, not used, §3.6), the image
  generation design `2026-11-17-image-generation-design.md`; skills
  [writing-channels](../../../.agents/skills/writing-channels/SKILL.md),
  [writing-object-store-providers](../../../.agents/skills/writing-object-store-providers/SKILL.md),
  [writing-kernel-api](../../../.agents/skills/writing-kernel-api/SKILL.md),
  [writing-extensions](../../../.agents/skills/writing-extensions/SKILL.md),
  [adding-config](../../../.agents/skills/adding-config/SKILL.md).

## 1. Why

A person who talks to an agent in Slack, Lark or Telegram asks for a report, a chart or an image.
The agent delivers it (`Deliver`, `GenerateImage`), the web conversation shows it in its files, and
the IM thread gets the agent's text ("here is the report") and nothing else. The file is reachable
only by signing in to the web and finding the conversation. The channel contract cannot carry a
file at all, and the outbound delivery ignores the event that announces one.

## 2. Goals and non-goals

### Goals

- Every `artifact_created` in a conversation with a channel delivery target is sent into that
  target (the chat, or the thread in it) as a native file message, in log order with the text.
- Images (`png`, `jpeg`, `gif`, `webp` within the platform's image limit) are sent as images
  (inline preview); everything else as a file attachment.
- When a file cannot be sent (the channel has no file support, it is over a size limit, the
  platform refuses it, the stored object is gone), the person gets one line in its place that names
  the file and links to it in the web conversation. Nothing is dropped silently.
- Same durability as text today: owed through the outbox, resumed from `channel_deliveries.last_seq`
  after a crash, one idempotency key per artifact.
- One optional addition to `channel@1`; Slack, Lark and Telegram implement it in the plugins repo.

### Non-goals

- **Inbound files.** Files a person sends to the bot stay ignored, as today
  (`packages/plugin-sdk/src/channel.ts:53-54`, "attachments, images, files and the like are
  ignored"). A separate design.
- **Sub-agents' artifacts.** A sub-agent's `Deliver` writes `artifact_created` into the child
  conversation's log (`storeArtifacts` appends to `ctx.conversationId`,
  `packages/kernel/src/tools/builtins/artifacts.ts:92`), which the parent's delivery never reads.
  The web files panel lists only the conversation's own deliveries too
  (`packages/kernel/src/conversations/files.ts:12-17`, no child conversations). A sub-agent hands
  its result back and the parent delivers what the person needs. See open question 2.
- **Share links.** No `/s/<code>` link is created for channels (§3.6).
- Editing or deleting a file message after it is sent; albums or media groups (one message per
  artifact); captions written by the model.
- Files produced before the conversation got its channel target (delivery starts at the binding
  position, `ChannelJobs.bind`, `packages/kernel/src/channels/jobs.ts:123-155`).

## 3. Current state (origin/main, 2026-11-18)

- **Contract.** `Channel` has `features { cards, edit, threads, minEditIntervalMs? }`
  (`packages/plugin-sdk/src/channel.ts:216`), `send(ChannelSendArgs) -> { messageId }` (`:229`)
  and `update` (`:238`). `ChannelSendArgs` carries `config`, `target`, `message`, `signal`,
  `locale`, an optional `idempotencyKey` of at most 40 `[A-Za-z0-9_-]` characters (`:109-135`).
  `OutboundMessage` is `{ text; cards? }` (`packages/plugin-sdk/src/cards.ts:77-80`): no files.
  Non-retryable failure reasons are `auth`, `target_gone`, `rejected`, `too_large` (`:259`);
  any other exception counts as retryable.
- **Producers.** `storeArtifacts` puts each file under the kernel prefix at
  `artifacts/<conversationId>/<artifactId>` and appends one `artifact_created` per file in one
  append (`packages/kernel/src/tools/builtins/artifacts.ts:56-106`), with payload `{ artifactId,
  name, contentType, size, objectKey, sourcePath, callId }`
  (`packages/kernel/src/conversations/events.ts:1334-1345`). `Deliver`
  (`tools/builtins/sandbox/deliver.ts`, up to `sandbox.deliverMaxBytes`, default 100 MiB,
  `config/schema.ts:1707-1716`) and `GenerateImage` (`tools/builtins/image/generate.ts`) both call
  it. The event is appended during the tool call: after the step's `assistant_message` that
  contains the `tool_use`, before the run's final reply.
- **Outbound delivery.** `ChannelOutbound` / `Delivery` (`packages/kernel/src/channels/outbound.ts`)
  read the conversation log after `channel_deliveries.last_seq` under a per-conversation lock and
  hand each event to `Delivery.handle` (`:1009-1120`). It handles `assistant_message`, cards,
  `connection_required`, run endings; every other type, `artifact_created` included, falls into
  `default: return` (`:1117-1118`) and is skipped. Each delivered event advances `last_seq` in a
  transaction conditional on the previous value (`advanceIn`, `:494-533`); the idempotency key of
  an event is a hash of `<conversation>-<seq>[suffix]` (`:677-680`, `jobs.ts:46-48`). Non-retryable
  failures stop the round (`auth`, `target_gone`) or count towards skipping the event after 3
  (`countFailure`, `:778-812`, `POISON_FAILURES`); retryable ones are rethrown for BullMQ backoff
  (`:757-762`, `deliverBackoff` `:196-201`). Deliveries are owed through the outbox with the job id
  `deliver-<conversation>-<seq>` (`deliver-job.ts:14-15`, `:36-47`).
- **Sends.** `ChannelConnections.outbound` builds the session: `adaptToFeatures` strips `threadId`
  when `threads` is false and turns cards into text when `cards` is false
  (`packages/kernel/src/channels/features.ts:15-35`), each call has a 15 s timeout
  (`connections.service.ts:82`, `:1064-1091`). A scheduled group run's first post binds its
  thread to the posted message's id (`Delivery.send` + `bindThreadIn`, `outbound.ts:996-1007`,
  `:542-574`).
- **Downloads need the web.** The artifact download route redirects to a presigned URL for a
  signed-in viewer of the conversation (`conversations.controller.ts:487-490`), so a link to it is
  useless in IM. The web opens one file in the right panel with `/chat/<id>#file=<fileId>`
  (`apps/web/src/lib/right-area.ts:1-6`, `:56`), and an older version's id resolves too
  (`apps/web/src/components/conversation/RightArea.tsx:393`). Cards already link to
  `conversationUrl(base, id)` = `<publicUrl>/chat/<id>` (`channels/cards.ts:156-162`).
- **File sharing** (merged, `packages/kernel/src/shares`): a share is created only by a person on
  the web; "creating a share from a channel conversation's chat, or by the agent through a tool" is
  a non-goal and creating is `human-only` in the Platform tool (file sharing spec, Non-goals and
  §10). External links need the platform and org switches (§8).
- **Plugins** (capybara-hq/plugins, read-only here):
  - Slack posts with `chat.postMessage` through `@slack/web-api`
    (`plugins/slack/src/channel.ts:661-704`),
    ignores the idempotency key (Ruling R5), features `{ cards, edit, threads: true }` (`:477`).
    The manifest's bot scopes have no `files:write` (`plugins/slack/guides/slack-app.md:51-59`);
    the `bot-scopes` setup check compares against `REQUIRED_BOT_SCOPES`
    (`plugins/slack/src/setup-checks.ts:21`).
  - Lark sends `msg_type: "interactive"` with the key as `uuid`, and replies into a thread with
    `/messages/<root>/reply` and `reply_in_thread: true` (`plugins/lark/src/channel.ts:495-530`);
    its API client sends JSON only (`plugins/lark/src/api.ts:110-113`). The README asks for
    `im:message:send_as_bot` only (`plugins/lark/README.md:36`).
  - Telegram calls `sendMessage` with JSON bodies (`plugins/telegram/src/api.ts:1-9`), threads by
    `reply_parameters` + `message_thread_id` and records each sent message's thread
    (`plugins/telegram/src/channel.ts:312-356`).
- **Fakes** (`packages/testing/src`): `fake-channel.ts` records `/send` and `/update`;
  `fake-slack.ts` answers `chat.postMessage` / `chat.update` (`:379-417`); `fake-lark.ts`,
  `fake-telegram.ts` have no upload endpoints. The `fake-im` fixture implements `send` / `update`
  (`packages/testing/fixtures/extensions/fake-im/src/channel.ts:214`).

## 4. Design

### 4.1 Contract: an optional `sendFile` on `channel@1`

Additive and optional, so it stays `channel@1` (a channel without it keeps working; the kernel
falls back to the link line). Pre-0.1.0, so no version negotiation either way.

```ts
// packages/plugin-sdk/src/channel.ts (shape only)
interface Channel {
  features: {
    cards: boolean; edit: boolean; threads: boolean; minEditIntervalMs?: number;
    /** Present iff `sendFile` is implemented. */
    files?: { maxBytes: number; imageMaxBytes?: number };
  };
  sendFile?(args: ChannelSendFileArgs): Promise<{ messageId?: string }>;
}

interface ChannelSendFileArgs {
  config: unknown;
  target: ChannelTarget;          // after adaptToFeatures (no threadId without threads)
  file: {
    name: string;                 // display name, as delivered
    contentType: string;
    kind: "image" | "file";       // chosen by the kernel, see below
    data: Uint8Array;             // the whole file, size <= the caps below
  };
  signal: AbortSignal;
  locale: Locale;
  idempotencyKey?: string;        // same rules as ChannelSendArgs.idempotencyKey
}
```

- **Bytes as a buffer.** Every target API needs the length up front (Slack's upload URL takes
  `length`; Lark and Telegram take multipart bodies), a retry must send the same bytes again, and
  the size is bounded by the caps of §4.3. A stream would save memory only for files the caps
  already exclude. A presigned URL is not used: Telegram would fetch it from its own servers (the
  object store need not be public, and the link would leave the deployment), and the plugins would
  need `ctx.net` rules for the store's host.
- **`kind`.** The kernel sends `image` when `contentType` (without parameters, lower case) is in
  `IMAGE_MEDIA_TYPES` (`packages/plugin-sdk/src/model.ts:114`: png, jpeg, gif, webp) and `size <=
  features.files.imageMaxBytes ?? maxBytes`; otherwise `file`. SVG is a file (no platform renders
  it inline, and it can carry script). A plugin may still send an `image` as a file when the
  platform refuses it as a photo (e.g. Telegram's photo dimension rules); it never does the reverse.
- **`messageId` optional.** Slack's `files.completeUploadExternal` does not return the message's
  `ts` reliably (the share appears asynchronously), and the kernel never edits a file message, so
  the id is used only to bind a scheduled run's thread (§4.4). A plugin returns it when the
  platform gives it.
- **Failures** use `ChannelSendError` with the existing reasons: `too_large` (the platform's limit,
  lower than declared), `rejected` (type refused, missing permission or scope, content refused),
  `auth`, `target_gone`; retryable for rate limits, 5xx and network errors. No new reason: the
  kernel handles `too_large` and `rejected` the same way here (the link line, §4.5).
- The JSDoc of `send` keeps saying "text"; `sendFile` is documented in the same file and in the
  hand-written agent doc `packages/plugin-sdk/agent-docs/extension-points/channel.md` (one
  sentence). `pnpm gen:sdk-api` plus a changeset bumping `@capybara-hq/plugin-sdk`.

### 4.2 Kernel: `artifact_created` in the outbound delivery

`Delivery.handle` gains a case for `artifact_created`; nothing else in the producers changes, so
every present and future producer is covered by writing the event. The case, for the event at
`seq` with payload `a`:

1. **Check.** `a.objectKey` must start with `artifacts/<this conversation id>/` (defence in
   depth: the key is read under the conversation's own org prefix anyway, §4.7). A size of 0 goes
   to the link line (Lark refuses empty files; an empty file in a chat helps no one).
2. **Decide.** Send natively when the session's `features.files` is present and `sendFile` exists,
   and `a.size <= min(features.files.maxBytes, channels.fileMaxBytes)`. Otherwise go to the link
   line without reading the object.
3. **Read.** `storage.kernel(orgId).get(a.objectKey)` and read the body into one buffer, stopping
   with the link line as soon as it passes the cap (the stored size is authoritative, the event's
   is display data). A missing object (`null`, removed from storage) or `storage.unavailable` goes
   to the link line: the web cannot serve it either, and retrying would block the conversation's
   delivery behind a deployment problem. At most `channels.fileConcurrency` reads and uploads run
   at once per replica (a process-local semaphore guarding this process's memory; it holds no
   shared state, so it is not a multi-replica concern); a delivery waits for a slot.
4. **Send.** Through a new `ChannelOutboundSession.sendFile` that applies `adaptToFeatures` to the
   target (thread stripped when `threads` is false) and calls the plugin with a 120 s timeout
   (uploads take longer than the 15 s of text calls) and the idempotency key `key(seq)`.
5. **Advance.** `advance(seq)` as for any delivered event. The buffer is released.

`ChannelOutbound` gets `StorageService` injected (passed into `DeliveryDeps`).

### 4.3 Caps

- `channels.fileMaxBytes` (new, default 20 MiB = 20 971 520, `0` = never send files natively, every
  artifact becomes a link line): the deployment's cap per file. It bounds memory
  (`fileConcurrency` × `fileMaxBytes` per replica, 80 MiB by default) and is the super admin's
  switch to keep files out of IM entirely.
- `channels.fileConcurrency` (new, default 4): see §4.2 step 3.
- The plugin's `features.files.maxBytes` / `imageMaxBytes`: what the platform accepts for a bot
  (Slack 1 GiB, Lark file 30 MiB / image 10 MiB, Telegram document 50 MB / photo 10 MB; §6).
- Both are deployment-level (env, file, Nacos), not org-overridable, not hot (read at job start,
  like the other `channels.*` fields). `docs/config.md` regenerated.

### 4.4 Order, batching, threads

- **Log order.** The delivery handles events one by one in `seq` order, so a file appears where the
  agent delivered it: after the text of the step that called the tool ("I'll put this in a PDF"),
  before the final reply ("here is the report"). This matches how the web shows it and needs no
  buffering. A streaming draft cannot be open at that point: the step's `assistant_message`
  finalized it before the tool ran, and the next step's deltas start after the tool result.
- **One message per artifact.** `storeArtifacts` writes several events in one append when a call
  delivers several files; each is its own seq, its own key and its own message. No albums.
- **Threads.** The stored target (chat, thread) is used as for text. A channel without threads gets
  the file in the chat.
- **Scheduled group run whose first post is a file** (`threadPending`, `outbound.ts:1001-1005`):
  the thread must be bound to a message id, which `sendFile` may not return. The kernel first sends
  a one-line text root (`phrase("fileDelivered")`, the name in inline code) with the key
  `key(seq, "-root")` through the ordinary `send` (which binds the thread), then the file into the
  thread. If `sendFile` returns a `messageId` and the thread is still pending (never true after the
  root), nothing more happens.

### 4.5 Failures and the link line

The **link line** is one text message sent with `send` and the key `key(seq, "-link")`:

- with `http.publicUrl` set: `phrase("fileOnWeb")`, e.g. en "`report.pdf` (2.3 MB) is in the web
  conversation: <publicUrl>/chat/<conversationId>#file=<artifactId>", zh
  "`report.pdf`（2.3 MB）在网页会话里：…";
- without it: `phrase("fileOnWebNoLink")`, "`report.pdf` (2.3 MB) was delivered; open the
  conversation in Capybara on the web to get it."
- The name is model-controlled, so it is put in inline code (the rule of `renderCardAsText`; the
  helper `asCode` in `cards.ts:218` is private today and becomes an export of the SDK, or the
  kernel gets its own copy: builder's choice). No mention, link or markup from a file name.
- The link opens for whoever may read the conversation (the visibility of the conversation
  stream): in a group thread other members get the line but not the file, exactly as with the
  card links today. The text names the file so they can ask the owner.

| Situation | Outcome |
|---|---|
| No `sendFile` / no `features.files`, `fileMaxBytes` 0, over a cap, size 0 | link line, advance |
| Object missing or storage unavailable | link line, advance (log `warn`) |
| `sendFile` throws non-retryable `too_large` | link line, advance (log `info`) |
| `sendFile` throws non-retryable `rejected` | link line, advance; the redacted message goes to the connection's `last_error` (a missing scope shows on the connection page) |
| `sendFile` throws non-retryable `auth` / `target_gone` | as for text: stop the round, `last_error` for `auth`, scheduled task paused (`outbound.ts:737-751`) |
| `sendFile` throws retryable / any other error | rethrown: BullMQ backoff with `retryAfterMs` (`deliverBackoff`); after the last attempt the job fails and the next event resumes from `last_seq` |
| The link line itself fails non-retryably | the existing poison counting of the event (`countFailure`): after 3 the event is skipped with "handle on web" |

`too_large` and `rejected` do not count towards the poison limit: the link line is the planned
degradation, and the event is delivered by it.

### 4.6 Durability, idempotency, multi-replica

- **Owed already.** `artifact_created` is an event append of a conversation with a channel target,
  so its delivery job is owed in the append's transaction (`oweDelivery`, transactional outbox
  §8.1; job id `deliver-<conversation>-<seq>`, no `:`). No new queue, job, outbox entry or table.
- **Resume.** The send happens before `advance(seq)`; a crash in between re-runs the event on any
  replica from `last_seq` with the same key `key(seq)` (and `-root` / `-link`). Lark maps the key
  to the message's `uuid` (deduplicated for an hour), so the resend shows no second file; the
  orphaned upload (`image_key` / `file_key`) is harmless. Slack and Telegram have no idempotent
  upload: a crash in that window shows the file twice, the accepted cost already ruled for text
  (Ruling R5 in the Slack plugin). The window is the upload's length, not longer.
- **No new state.** The bytes live in the job's memory for one send; the decision reads only the
  log, the connection's features and config. The per-conversation delivery lock (renewed every
  TTL/3, `runtime/conversation-lock.ts:30`) and the BullMQ job lock outlive a 120 s upload; a lost
  lease is noticed at the next check and `advance` is conditional, so a second holder never
  advances twice.
- The semaphore of §4.2 is per process by design (it guards this process's memory), the only
  in-process state added.

### 4.7 Governance and security

- **Tenancy.** The object is read with `storage.kernel(<the connection row's orgId>)`, which equals
  the conversation's org (a delivery target is bound by an inbound message of that org's
  connection), and the key is checked against the conversation (§4.2 step 1). One org's delivery
  cannot read another's objects: the kernel adds the `kernel/<orgId>/` prefix
  (writing-object-store-providers).
- **What leaves.** The file goes to the same chat that already receives the agent's text, so no new
  audience. The file's creation already passed `tool.preExecute` policy hooks and the command
  review (for `Deliver`). The deployment can keep files out of IM (`channels.fileMaxBytes: 0`). An
  org-level switch is open question 1.
- **Egress.** The upload goes to the platform's API, called by the channel plugin as its text sends
  are; the org egress ceiling governs sandboxes and devices, not channel plugins, so it does not
  apply.
- **Secrets.** Plugin errors are redacted with the session's redactor before logs and `last_error`
  (`outbound.ts:770-772`); upload URLs (Slack's carry a signature, Telegram's carry the token) never
  go into an error message (writing-channels, failure classification).

### 4.8 Why not share links (file sharing)

Considered as the fallback and rejected for now:

- An external share created automatically is the agent publishing outside the org, which the file
  sharing design makes a person's act (creating is `human-only`, external needs both switches).
- An internal share needs a signed-in member, the same requirement as the conversation link, and
  adds a snapshot copy and a row per artifact for no gain.
- Depending on it would make channel delivery wait on a line still in acceptance.

If the maintainer later wants IM recipients without web access to open large files, an explicit
per-org opt-in "channel shares" can be added on top of §4.5 without changing the contract.

## 5. Edge cases

- **A file version later replaced** (same `sourcePath` delivered again): each delivery is its own
  event and its own message; `#file=<artifactId>` of an older version still opens (the panel
  resolves version ids).
- **Conversation deleted while delivering:** the delivery row goes with it; the next read finds no
  row and the job ends (`outbound.ts:694`).
- **Connection rotated or disabled mid-upload:** the existing recheck (`recheckConnection`) runs
  between events; an upload in flight finishes or fails with `auth`.
- **Replica without the plugin (rolling upgrade):** unchanged `pending` path. A replica whose
  plugin version lacks `sendFile` sends the link line: an artifact delivered during an upgrade may
  arrive as a link instead of a file. Accepted.
- **Run aborted after the file was delivered:** the artifact exists in the log and is sent; abort
  closes only the draft.
- **Approval or question pending:** independent events, delivered in order.
- **Very many files in one call** (an agent delivering 30 images): 30 messages, paced by the
  platform's rate limits through the retryable path. No coalescing (open question 3).

## 6. Per-plugin follow-ups (capybara-hq/plugins)

Each plugin declares `features.files` and implements `sendFile`; README and setup guide name the
new permission; tests run against the extended fakes (§7). All limits below are the platforms'
documented bot limits as of 2026-11, to be re-checked by the implementer.

- **Slack.** `features.files: { maxBytes: 1 GiB, imageMaxBytes: 1 GiB }` (the kernel cap decides
  in practice). `files.getUploadURLExternal(filename, length)` → POST the bytes to `upload_url` →
  `files.completeUploadExternal({ files: [{ id, title: name }], channel_id, thread_ts? })`
  (`WebClient.filesUploadV2` does all three). Images preview inline by themselves, so `kind` needs
  no different call. Add `files:write` to both manifests and `REQUIRED_BOT_SCOPES`: an app created
  before the change fails the `bot-scopes` setup check with the missing scope named, and until it
  is fixed `missing_scope` maps to `rejected` (link line + `last_error`). No `messageId` returned
  unless the response carries `shares.*.ts`.
- **Lark.** `features.files: { maxBytes: 30 MiB, imageMaxBytes: 10 MiB }`. `image`: `POST
  /open-apis/im/v1/images` (multipart, `image_type=message`) → `image_key` → message `msg_type:
  "image"`; `file`: `POST /open-apis/im/v1/files` (multipart, `file_type` from the extension:
  `pdf`, `doc`, `xls`, `ppt`, `mp4`, `opus`, else `stream`) → `file_key` → `msg_type: "file"`.
  Send or reply-in-thread exactly as text, with the key as `uuid`. The API client gains a
  multipart call. Permission: the app needs the upload permission for images and files
  (`im:resource`, 获取与上传图片或文件资源; confirm the name); without it the platform's error maps
  to `rejected`. Returns `messageId`.
- **Telegram.** `features.files: { maxBytes: 50 MB, imageMaxBytes: 10 MB }`. `image` → `sendPhoto`,
  falling back to `sendDocument` when Telegram refuses the photo (dimensions, ratio); `file` →
  `sendDocument`; multipart with `reply_parameters` / `message_thread_id` as for text, and the sent
  message recorded in the thread store. The API client gains a multipart call (the token stays out
  of errors). Returns `messageId`. No permission change.

The plugins move to the new `@capybara-hq/plugin-sdk` together (one SDK instance in that repo:
a pnpm override when bumping, as before).

## 7. Testing

- **Unit (kernel, no app):** the decision function (native vs link line by features, caps, size 0,
  image kind by type and `imageMaxBytes`, SVG is a file); the link line text in zh and en with and
  without `publicUrl`, the name in inline code (a name with backticks, `<@U1>`, a URL).
- **Integration (`packages/kernel/test/channels/outbound.test.ts`, on `fake-im`):**
  - a `Deliver` / scripted `artifact_created` in an IM conversation reaches `/send-file` with the
    bytes (sha256), name, type, kind, the thread, the key; order relative to the step text and the
    final reply;
  - `chan-mini` / `chan-noedit` (no `sendFile`) get the link line; `channels.fileMaxBytes: 0` and an
    oversized file get it without reading the object;
  - the fake answers `too_large` / `rejected` → link line, `last_error` only for `rejected`;
    retryable 429 → retried with `retryAfterMs`; `target_gone` stops the round;
  - object deleted from storage → link line;
  - a scheduled group run whose first post is a file: root text, then the file in the bound thread;
  - redelivery after a simulated crash between send and advance passes the same key (the fake's
    `idempotencyKey` dedupe shows one file).
- **Dual-replica (`container` project):** an artifact delivered while the replica holding the
  delivery dies mid-upload is delivered by the other replica, once on a key-honouring fake.
- **Fakes (`packages/testing`):** `fake-channel` records `/send-file` (`sentFiles`, deduped by
  key like `/send`) and can answer a scripted failure; `fake-im` declares `features.files` and
  implements `sendFile`; `startFakeSlack` gains `files.getUploadURLExternal`, the upload URL and
  `files.completeUploadExternal`; `startFakeLark` gains `/open-apis/im/v1/images` and `/files`
  (multipart) and `msg_type` image / file; `startFakeTelegram` gains `sendPhoto` / `sendDocument`
  (multipart). Each records the bytes for assertions.
- **Plugins repo:** each plugin's channel tests against its fake (happy path, thread, the
  permission error mapped to `rejected`, Telegram photo-to-document fallback); a live test per
  platform behind its existing `CAPYBARA_TEST_*` variables.
- New tests join their checked-in lists in the same change (integration is the default).

## 8. Rollout

1. Core: SDK addition + `gen:sdk-api` + changeset; kernel case, session method, config fields
   (`docs/config.md`), phrases; fakes and `fake-im`; tests. Without plugin support every artifact
   in IM becomes a link line, already an improvement and safe to release alone.
2. Plugins: Slack, Lark, Telegram `sendFile` + manifests / READMEs / setup checks, one PR each or
   together, after the SDK release.
3. Bootstrap pins in `packages/kernel/bootstrap.json` move with the next plugin releases.
4. Release notes tell Slack and Lark admins to add the new scope / permission (the Slack setup
   check shows it).

## 9. Open questions (with recommendations)

1. **An org-level switch for files in IM?** Recommendation: no, not now. The text of the same reply
   already goes there; the deployment has `channels.fileMaxBytes: 0`. Add `orgAccess` on the field
   later if an org asks.
2. **Sub-agents' artifacts:** deliver a child conversation's `artifact_created` into the parent's
   thread? Recommendation: no, keep parity with the web files panel (own conversation only); the
   parent delivers what the person needs. Revisit together with the panel.
3. **Coalesce several files of one call** into one message where the platform supports it (Slack
   multi-file upload, Telegram media group)? Recommendation: no; one artifact, one message, one key
   keeps the resume logic per seq.
4. **Default `channels.fileMaxBytes`:** 20 MiB keeps memory bounded and covers reports and images;
   Lark caps at 30 MiB, Telegram at 50 MB. Recommendation: 20 MiB, raise per deployment.
5. **Share-link fallback** for files that cannot be sent natively? Recommendation: no (§4.8).

## AGENTS.md rules touched

- **Multi-replica discipline.** Followed without new mechanisms: the delivery stays owed through
  the outbox (`deliver-<conversation>-<seq>`, no `:`), resumes from `last_seq` with a deterministic
  key per artifact, `advance` stays conditional; the only in-process addition is a semaphore over
  this process's own memory, not shared state.
- **Config.** Two new deployment fields `channels.fileMaxBytes` and `channels.fileConcurrency`
  (env `CAPYBARA_CHANNELS__FILE_MAX_BYTES`, `CAPYBARA_CHANNELS__FILE_CONCURRENCY`), not hot, no org
  level; `docs/config.md` regenerated.
- **Channels:** ack semantics unchanged (outbound only); `sendFile` follows the `ChannelSendError`
  classification; kernel tests on `fake-im`, `startFakeSlack`, `startFakeLark`, `startFakeTelegram`.
- **SDK public API.** `Channel.sendFile?`, `features.files?`, `ChannelSendFileArgs` (and possibly
  the `asCode` export): `pnpm gen:sdk-api` and a changeset bumping `@capybara-hq/plugin-sdk`; the
  agent doc `extension-points/channel.md` gains a sentence.
- **Object storage.** Read only through `StorageService.kernel(orgId)`; the kernel adds the prefix.
- **Language / i18n.** New kernel IM phrases in zh and en (`channels/phrases.ts`); English code and
  comments.
- **Runtime and replay.** Untouched: nothing model-visible changes, no `DriftReason`.
- **Tests.** Unit tests need no app; integration one app per file; the dual-replica case lives in
  the `container` project and joins its list.
- No new rule for AGENTS.md: the channels line ("ack only after `onEvent` resolves; long
  connections held only by the gateway role") stays as is; the detail goes into the
  writing-channels skills (core and plugins).
