# Attachments on demand: files for the device, fetched by a tool

- Date: 2026-11-17.
- Status: draft for maintainer review. The direction is the maintainer's, 2026-11-17: an uploaded
  file is **not** copied into the device by default; the model identifies a file it cannot read by
  an unsigned reference; a tool copies it into the device on demand, signing inside the kernel.
  Calls marked **(designer's call)** wait for the maintainer; the two already decided are noted.
- Decisions taken with the maintainer, 2026-11-17: on-demand replaces the automatic copy for **every**
  attachment type, not only for the new ones; clicking an image zooms **in the page** instead of
  opening a new tab; the user bubble keeps image thumbnails and file chips with no extra mark.
- Relates to: the environments design `2026-11-07-environments-design.md` §7.4 (per-conversation
  attachment paths), the conversation send design (attachments as message content), the
  [writing-tools](../../../.agents/skills/writing-tools/SKILL.md) skill (the tool contract), the
  [replay-evals](../../../.agents/skills/replay-evals/SKILL.md) skill (model-visible input),
  [writing-object-store-providers](../../../.agents/skills/writing-object-store-providers/SKILL.md)
  (the `ObjectStore` contract).

## 1. Why

Two problems today, one of them blocking the other:

1. **Only the model's media types can be uploaded.** `attachments.allowedTypes` is a `z.enum` of the
   plugin SDK's `IMAGE_MEDIA_TYPES` + `DOCUMENT_MEDIA_TYPES` (`config/schema.ts:1186`,
   `plugin-sdk/src/model.ts:82-89`). A person who wants the agent to process a spreadsheet cannot
   attach it: the composer refuses `xlsx` with "不支持这种文件类型" before any upload happens. The
   list is the *model input* contract; the device-side need has no entry at all.
2. **Every attachment is copied into the device before every sandbox call.** `syncAttachments`
   (`tools/builtins/sandbox/common.ts:498`, called at `:689`) runs on each `Bash` / `Read` / … call:
   a query of the conversation's attachments, a read of the `.capybara-sync.json` marker
   (`:220`), and the bytes of any attachment not yet copied. A conversation with a 15 MB PDF pays
   for it on the first call whether or not the agent ever opens it.

So the only way into the device is a model-readable attachment, and it always goes in. The design
turns that around: **any file the user hands over can be stored, the model only learns that it
exists, and the agent asks for it when it needs it.**

## 2. Goals

- A deployment accepts file types the model cannot read (a spreadsheet, an office document, an
  archive), stores them through the same upload path, and the agent can copy any of them into the
  device on demand.
- No attachment is copied without the agent asking for it.
- The identification the model sees is stable, carries no credentials, and survives replay.
- The user's view does not change for files, and images gain an in-page zoom.

## 3. Non-goals, anti-goals

- **Not** a second upload path: file attachments use the same register → presigned PUT → finalize
  flow, the same table and the same cleanup.
- **Not** a preview of office documents: `xlsx` opens as a download, as any file without a
  previewer does today (previewers are extensions, `files/previewers.ts`).
- **Not** org-level type policy: the accept list stays a deployment config item, as today.
- **Not** a way to keep the device's copies tidy or purge them: the workspace volume is the
  device's, as for every other file the agent writes.

## 4. Terms

- **Media attachment**: a type the model input contract carries — the four images, `application/pdf`
  and the text documents (`text/plain`, `text/markdown`, `text/csv`). The model gets the content.
- **File attachment**: any other accepted type (`xlsx`, `docx`, `pptx`, `zip`, `json` …). The model
  gets a one-line placeholder naming it; the bytes stay in the object store until a tool copies them.

## 5. Design

### 5.1 Accepted types

`attachments.allowedTypes` becomes the accept list for **both** kinds. The `z.enum` is replaced by a
content type string (`type/subtype`, lower case), still deployment config:

- defaults (designer's call): today's media list, plus
  `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`,
  `application/vnd.openxmlformats-officedocument.wordprocessingml.document`,
  `application/vnd.openxmlformats-officedocument.presentationml.presentation`,
  `application/zip`, `application/json`.
  These are what a person hands an agent to process with code; the older binary formats
  (`xls`, `doc`, `ppt`) and archives a deployment bans are left to configuration.
- `attachments.maxBytes` (20 MiB) applies to every type as today; `imageMaxBytes` (5 MiB) still caps
  images, which are model input.
- The web keeps reading the list from `GET /attachments/limits`; the refusal copy
  (`apps/web/src/lib/attachments.ts:182` `typeList`, message `fileTypeNotAllowed`) lists at most
  six labels and then "等 N 种 / and N more", so the line stays readable once the list grows.

### 5.2 What the model sees

`resolveMedia` (`runtime/context/build.ts:437`) decides by type instead of by capability:

| Accepted type | Model gets |
|---|---|
| image, and the model has vision | image block (bytes), as today |
| `application/pdf`, and the model reads documents | document block (bytes), as today |
| `text/plain`, `text/markdown`, `text/csv` | inline text, or a capped text document block for a model that reads documents — as today |
| **any other accepted type** | **one placeholder line** |

The placeholder (model-facing English, one text block):

```
[Attached file "电商工行.xlsx"
 (application/vnd.openxmlformats-officedocument.spreadsheetml.sheet), 1.2 MB — this model cannot
 read its content. Unsigned object reference: s3://<bucket>/kernel/<orgId>/attachments/<attachmentId>.
 Use FetchAttachment with the file name or this reference to copy it into the device.]

```

- The existing capability placeholders (`build.ts:358`, "this model cannot view images / read
  documents") stay for media a model cannot take.
- `mediaMode` (`build.ts:200`) must stop treating an unknown `document` media type as "bytes":
  a document block whose type is not media is always a placeholder, whatever the model's
  capabilities say.
- Replay: the log block keeps its shape (`{ type: "document", mediaType, source: { ref }, name }`,
  `conversations/attachments.service.ts:528-540`); the placeholder is derived from the block and the
  config, so a rebuild of the same log produces the same text. Logs written before this change never
  held a file attachment (uploads were refused), so no `DriftReason` is needed; the zero-drift
  fixtures run before and after the change.

### 5.3 The unsigned reference

- Form: `s3://<bucket>/<object key>`, the key the attachment row already stores
  (`attachments/<id>`, `attachments.service.ts:119`, with the kernel's `kernel/<orgId>/` prefix).
- Composed by the store, not the kernel: the `ObjectStore` contract gains an **optional**
  `uri?(key: string): string` — "the canonical URI of a key in this store: unsigned, stable, no
  credentials (`s3://bucket/key`)". The kernel falls back to `capybara://attachments/<id>` when the
  store has none (the test fakes, a store with no notion of URIs). Optional so every existing
  implementation compiles unchanged.
- **Never a presigned URL.** A presigned GET lives 300 s (`attachments.service.ts:28`) and is a
  credential: it must not enter the log, a model request or a replay. Signing happens inside the
  kernel when the tool reads the bytes, and the URL never leaves it — the sandbox could not reach
  the object store's internal address anyway (its egress proxy refuses private addresses).
- The reference is **not a capability**: every use resolves through the attachment row, with the
  org, conversation and owner checks the download path already makes.

### 5.4 The tool: `FetchAttachment`

- Key `fetch_attachment`, display name `FetchAttachment`; a builtin of the sandbox group, offered
  only when a sandbox is usable (`unavailableWhenNoSandbox`, `sandbox/common.ts:787`). Name follows
  `WebFetch` / `ReadToolOutput`: the verb says what it does — fetch the file *into* the device.
- Input: `{ file: string }` — the file name as the user's message shows it, the unsigned reference,
  or the attachment id (designer's call: the name is what the model always has; the other two are
  accepted for exactness). `keyArgs: ["file"]` for the tool row.
- Output: `{ path, size }` in the result's structured value, and the prose "Copied <name> to
  <path>." The path is the one the auto-copy used: `<workspace>/attachments/<conversation12>/<name>`
  (`sandbox/common.ts:216`).
- Behaviour: resolve the attachment among this conversation's ready attachments → read the bytes
  with the kernel's store (`AttachmentsService.openForConversation`) → write them with the held
  provider's `writeFile` (the call the removed sync made, `sandbox/common.ts:543`) → return. The
  sandbox session, device lease and abort signal are the ones every sandbox tool uses
  (`withSandbox`); the device protocol's preparation purpose `"attachments"`
  (`plugin-sdk/src/sandbox-operation.ts:185`) is untouched by this change.
- Names are stable: `assignAttachmentNames` (`sandbox/common.ts:443`) runs over the conversation's
  whole attachment list, so a given attachment always lands on the same name (`-2`, `-3` on a
  clash). Copying the same file twice rewrites identical bytes and returns the same path.
- Errors (English, actionable, no internals): no attachment by that name ("this conversation has:
  a.xlsx, b.csv"), not finalized yet, deleted since, file storage unavailable, no device in this
  conversation. Failures are ordinary tool errors; the run continues.
- Policy: `defaultPolicy: "allow"`, and **not** in `SANDBOX_ASK_TOOL_NAMES`
  (`tools/builtin-names.ts:78`) — it copies the user's own attachment into the workspace and
  executes nothing; `Bash` and the write tools keep the org's `sandboxToolPolicy` gate. (designer's
  call to revisit if the maintainer wants it behind `ask`.)
- Multi-replica: no new state. Two calls for different files write different paths; the same file
  twice is the same bytes. The copy runs under the device lease like any sandbox call, and a lost
  lease aborts it like any other.

### 5.5 No automatic copy

- `syncAttachments` (`sandbox/common.ts:498`), `copyAttachments` (`:531`), the marker
  `.capybara-sync.json` (`:220`) and the "Attachments copied into the sandbox" notice (`:691`) are
  removed; `withSandbox` no longer touches attachments at all.
- The tool descriptions that promise the copy are rewritten: `Bash` (`sandbox/bash.ts:55`) and
  `Read` (`sandbox/read.ts:32`) say the user's attachments are *not* in the device until
  `FetchAttachment` copies one, and name the tool.
- Files copied by the old behaviour stay on the device's volume; nothing reads the marker again, and
  the files are the device's like any other.
- Environments design §7.4's attachment paragraph is rewritten to this rule (the path and the
  per-conversation directory stay).

### 5.6 The user's bubble

- **Files**: unchanged — the type badge, name and size chip (`design/src/conversation/bubble.tsx`,
  `BubbleAttachments`); clicking opens the file as today (a new tab through `openDownload`). No
  mark distinguishes a file attachment from a media one (maintainer, 2026-11-17).
- **Images**: the 56 px thumbnail stays; clicking opens an in-page zoom instead of a new tab: an
  overlay over the page showing the image (up to 86vw × 86vh), the file name and a download action;
  Esc, a click outside and the close button close it; focus returns to the thumbnail; reduced motion
  leaves it still. Built on the design system's `Dialog` primitive
  (`design/src/overlays/dialog.tsx:33`) — a `ImageZoom` component in `design/src/conversation/`,
  used by the user bubble (the web's `BubbleAttachments` click handler stops calling `openDownload`
  for images; `apps/web/src/components/conversation/Thread.tsx:704`).

## 6. Limits and configuration

- `attachments.allowedTypes`: the extended list (§5.1); `docs/config.md` regenerated
  (`adding-config` skill).
- `attachments.maxBytes`, `imageMaxBytes`, `maxPerMessage`, `requestMediaBytes` keep their meaning.
  A file attachment does not consume `requestMediaBytes` (it is never sent as bytes).

## 7. Failure modes

| Case | What happens |
|---|---|
| A type not in the list | refused before the upload (web precheck) and at `POST /attachments` (kernel), as today |
| Sent with no device in the conversation | allowed; `FetchAttachment` answers with the no-sandbox text and the model tells the person |
| The attachment is deleted before the tool runs | the tool answers that it is gone; the chip already shows the removed state |
| Storage unavailable | the tool answers "file storage is unavailable"; the run continues |
| Very large file | capped at upload by `attachments.maxBytes` |
| The device's volume was reset | the next `FetchAttachment` copies the file again (no marker to disagree) |

## 8. Tests

- **kernel unit**: `resolveMedia` renders the placeholder for a file type with and without document
  capability, and never touches the bytes cache; `mediaMode` no longer sends an unknown document
  type as bytes; `FetchAttachment` resolves a name, a reference and an id, produces the stable name
  and the clash suffix, and maps each error.
- **kernel integration / dual replica**: upload an `xlsx` through the fake object store, send it,
  call `FetchAttachment`, and read the bytes back from the device — identical content; two calls
  return the same path; the file survives a suspend/resume.
- **web**: the composer accepts the new types when the limits say so; the refusal copy truncates the
  list; the image zoom opens and closes (jsdom for the component, the e2e for the click).
- **replay**: zero-drift fixtures before and after; a log holding a file attachment rebuilds to the
  same request, with the placeholder identical across rebuilds.

## 9. Migration

- No database change: `attachments.content_type` already stores any type.
- No compatibility layer (pre-0.1.0): the automatic copy is deleted, not kept behind a switch.

## 10. What this does not change

- The upload flow (register → presigned PUT → finalize), the cleanup of unused uploads, the
  per-conversation directory, the `attachments/` root and the staging grant.
- Media handling for images, PDF and text documents.
- Delivery of agent-made files (`Deliver`) and the file panel.

## 11. Open questions

1. **The default file-type set** (§5.1): the list above is the designer's; the maintainer trims it
   (e.g. whether `zip` is acceptable by default in a corporate deployment).
2. **`FetchAttachment` behind the org's `ask` policy?** Proposed: no (§5.4); the alternative is one
   more approval for a copy of the user's own file.
3. **The SDK's optional `uri?`** (§5.3) — an SDK change (`pnpm gen:sdk-api` plus a
   `@capybara-hq/plugin-sdk` changeset, and the S3 store's implementation in the plugins
   repository) versus keeping only the `capybara://attachments/<id>` fallback. Proposed: add it,
   because the reference then names the object's real home and stays readable to a person debugging
   a log.

## 12. Consequences for other documents

- `docs/superpowers/specs/2026-11-07-environments-design.md` §7.4: the attachment paragraph becomes
  "copied on demand by `FetchAttachment`".
- Tool descriptions: `Bash` (`sandbox/bash.ts:55`), `Read` (`sandbox/read.ts:32`).
- `plugin-sdk` agent docs: the object-store page gains `uri`.
- The plugins repository: `object-store-s3` implements `uri`; the fake stores keep compiling
  (optional method).
