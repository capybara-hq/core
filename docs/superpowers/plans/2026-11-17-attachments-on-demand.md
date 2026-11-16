# Attachments on demand Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. With more than five tasks, `wave-planned-subagent-development` governs the dispatch (waves below).

**Goal:** Any file a person attaches is stored and identified to the model by an unsigned reference;
`FetchAttachment` copies it into the device when the agent needs it, and nothing is copied by default.

**Architecture:** The message log gains a `file` content block (never sent to a provider) beside the
existing image / document blocks; the kernel's request builder turns it — and any text attachment
above a size threshold — into one placeholder line carrying the store's unsigned URI. A new sandbox
builtin reads the bytes with the kernel's own store credentials and writes them into the workspace.
The automatic per-call sync and its marker disappear.

**Tech Stack:** TypeScript, Nest kernel, plugin SDK, Next web + `@capybara-hq/design`, Vitest
(jsdom for design, unit and integration for the kernel), Playwright e2e, the plugins repository
(`object-store-s3`).

**Spec:** [attachments on demand](../specs/2026-11-17-attachments-on-demand-design.md). Read it and
the skills it names ([writing-tools](../../../.agents/skills/writing-tools/SKILL.md),
[writing-web-ui](../../../.agents/skills/writing-web-ui/SKILL.md),
[replay-evals](../../../.agents/skills/replay-evals/SKILL.md),
[adding-config](../../../.agents/skills/adding-config/SKILL.md)) before the task that touches them.

## Global Constraints

- Model-facing text is English; UI text goes through i18n (zh and en); the zh UI says 平台 / 超级管理员 / 智能体.
- Tool keys contain no dots; tool descriptions and errors are English and actionable.
- Pre-0.1.0: no compatibility layer; change names and formats directly. Applied migrations stay immutable.
- Every new unit or container test joins its checked-in list in the same change (`packages/kernel/test/unit-tests.json`-style lists or `container-tests.json`).
- A change to a published package carries a changeset; SDK changes run `pnpm gen:sdk-api` and bump `@capybara-hq/plugin-sdk`.
- One writable field per concern: the kernel owns blocks and config; the web renders; no styles in `apps/web`.
- `pnpm exec vitest run <path>` from the repository root. `pnpm verify --fast` before each wave handoff.

## Review Focus

1. **A text attachment exactly at the threshold** (`8000` characters): inlined whole, no `[Truncated]` note anywhere, one character more becomes the reference (Tasks 3).
2. **An attachment whose row is gone or whose object is missing** when `FetchAttachment` runs: one actionable English error, the run continues, no placeholder lies about bytes (Tasks 3, 4).
3. **Two attachments sharing a file name**, and the same attachment fetched twice: stable distinct paths, the second call returns the same path (Tasks 4).
4. **A conversation switched from a vision model to one without it mid-run**: the image becomes the capability placeholder, nothing throws, `FetchAttachment` still copies the image file (Tasks 3, 4).
5. **A 20 MiB attachment** (the `attachments.maxBytes` ceiling) sent and fetched: no request carries its bytes, the copy succeeds under the lock, and a file above the ceiling is refused at upload (Tasks 2, 3, 4).

---

## Wave 1 — the contract

### Task 1: SDK — the `file` block, block sizes, and the store's URI

**Files:**
- Modify: `packages/plugin-sdk/src/model.ts` (the `ContentBlock` union around `:102-114`, `validateContentBlock` around `:160-175`)
- Modify: `packages/plugin-sdk/src/storage.ts` (the `ObjectStore` interface, `:24-63`)
- Modify: `packages/plugin-sdk/agent-docs/extension-points/object-store.md`
- Test: `packages/plugin-sdk/test/model.test.ts`, `packages/plugin-sdk/test/sandbox-operation.test.ts` (only if it exercises blocks)
- Regenerate: the SDK API snapshot (`pnpm gen:sdk-api`), plus a changeset

**Interfaces:**
- Produces:
  ```ts
  // ContentBlock gains a fourth kind; image/document gain `size`.
  | { type: "image"; mediaType: ImageMediaType; source: MediaSource; name?: string; size?: number }
  | { type: "document"; mediaType: DocumentMediaType; source: MediaSource; name?: string; size?: number }
  | { type: "file"; mediaType: string; source: MediaSource; name?: string; size?: number }
  ```
  ```ts
  // ObjectStore (optional: a store without a notion of URIs keeps compiling)
  uri?(key: string): string; // "s3://bucket/key": unsigned, stable, no credentials
  ```
- Contract notes to write in the doc comments: a provider **never** receives a `file` block (the
  kernel resolves it to text before the request); `size` is display metadata (the UI chip, the
  reference line) and is never sent by a provider; `uri` returns an unsigned identifier, never a
  presigned URL.

- [ ] **Step 1: Write the failing SDK test**

In `packages/plugin-sdk/test/model.test.ts`, add:

```ts
it("a file block carries any content type and a display size, and validates", () => {
  const b = {
    type: "file" as const,
    mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    source: { kind: "base64" as const, data: "AAAA" },
    name: "电商工行.xlsx",
    size: 1_258_291,
  };
  expect(validateContentBlock(b, "user")).toEqual([]);
  // an image / document block carries the same display size
  expect(
    validateContentBlock(
      { type: "image", mediaType: "image/png", source: { kind: "base64", data: "AA" }, size: 2 },
      "user",
    ),
  ).toEqual([]);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm exec vitest run packages/plugin-sdk/test/model.test.ts -t "a file block carries any content type"`
Expected: FAIL (type error or a validation error naming an unknown type).

- [ ] **Step 3: Implement the SDK change**

Add the union member and `size?: number` to the three media kinds in `model.ts`; teach
`validateContentBlock` that `file` takes any non-empty `mediaType` string and that `size` is a
non-negative integer when present; add `uri?(key: string): string` to `ObjectStore` with the doc
comment above; document `file` in the object-store agent doc's block section only where it names
the kernel's usage (do not describe kernel behaviour a provider must implement).

- [ ] **Step 4: Regenerate and verify**

Run: `pnpm gen:sdk-api && pnpm exec vitest run packages/plugin-sdk && pnpm check:sdk-api`
Expected: the snapshot diff contains only the new member and method; tests pass.

- [ ] **Step 5: Changeset**

`pnpm changeset` → a **minor** bump of `@capybara-hq/plugin-sdk` (a new union member and an optional
method: existing providers compile, but the union is public API). Text: "ContentBlock: a `file`
block for attachments the model only references (never sent to a provider), `size` on the media
blocks, and the optional `ObjectStore.uri` for an unsigned object identifier."

- [ ] **Step 6: Commit**

```bash
git add packages/plugin-sdk .changeset && git commit -m "feat(sdk): a file content block, block sizes and the object store's uri"
```

---

## Wave 2 — kernel: acceptance, request building, the tool

### Task 2: accepted types and the block a file attachment writes

**Files:**
- Modify: `packages/kernel/src/config/schema.ts:1173-1220` (`attachments`)
- Create: `packages/kernel/src/conversations/media-types.ts` (`isImageContentType`, `isMediaContentType`)
- Modify: `packages/kernel/src/conversations/attachments.service.ts` (`create` validation, `limits()`, the column list and block builder of `bindForMessage` around `:460-545`; the local `isImage` moves to the new module)
- Modify: `docs/config.md` (regenerated by the config docs check)
- Test: `packages/kernel/test/attachments/attachments.service.test.ts`, `packages/kernel/test/attachments/attachments.http.test.ts`

**Interfaces:**
- Consumes: `ContentBlock`'s `file` member (Task 1).
- Produces:
  ```ts
  // config/schema.ts
  allowedTypes: z.array(z.string()) // "type/subtype", lower case; default:
  //   ["image/png","image/jpeg","image/gif","image/webp","application/pdf","text/plain",
  //    "text/markdown","text/csv",
  //    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  //    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  //    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  //    "application/zip","application/json"]

  // conversations/media-types.ts
  export function isImageContentType(ct: string): boolean      // IMAGE_MEDIA_TYPES
  export function isMediaContentType(ct: string): boolean      // image/*, application/pdf, text/plain|markdown|csv
  ```
  ```ts
  // attachments.service.ts: the message block for one ready attachment
  //   image content type  -> { type: "image",  mediaType, source, name, size }
  //   media content type  -> { type: "document", mediaType, source, name, size }
  //   anything else       -> { type: "file",   mediaType, source, name, size }
  ```

- [ ] **Step 1: Write the failing kernel test**

In `attachments.http.test.ts`, beside the existing media case (the one asserting image/document
blocks, `:237-244`):

```ts
it("an xlsx becomes a file block with its size and never carries bytes", async () => {
  const id = await ready(owner, "电商工行.xlsx", XLSX, XLSX_BYTES);
  await post(owner, conv, { text: "按分行汇总", files: [id] });
  const user = (await eventsOf(db, conv)).find((e) => e.type === "user_message");
  expect(user?.payload.content[1]).toEqual({
    type: "file",
    mediaType: XLSX,
    source: { kind: "ref", attachmentId: id },
    name: "电商工行.xlsx",
    size: XLSX_BYTES.length,
  });
  // the log and the request carry no bytes of it
  expect(JSON.stringify(await eventsOf(db, conv))).not.toContain(XLSX_BYTES.toString("base64"));
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm exec vitest run packages/kernel/test/attachments/attachments.service.test.ts -t "xlsx"`
Expected: FAIL (`attachment.type_not_allowed`, and no `blocksForMessage` branch producing a `file` block).

- [ ] **Step 3: Implement**

`allowedTypes` becomes `z.array(z.string())` validated by a `contentType()` helper (lower case,
`type/subtype`, no parameters) with the default list above; keep `maxBytes` / `imageMaxBytes` /
`maxPerMessage` / `requestMediaBytes` untouched. In `create`, the membership test is unchanged in
shape (`cfg.allowedTypes.includes(ct)`), so the web sees the same error code. In the block builder,
branch as the Interfaces block says and include `size: Number(r.size)`.

- [ ] **Step 4: Verify**

Run: `pnpm exec vitest run packages/kernel/test/attachments && pnpm check:config-docs`
Expected: PASS; `docs/config.md` regenerated with the new default list and description.

- [ ] **Step 5: Commit**

```bash
git add packages/kernel/src/config packages/kernel/src/conversations packages/kernel/test/attachments docs/config.md
git commit -m "feat(kernel): accept file attachment types and log them as file blocks"
```

### Task 3: the model sees a reference, never a truncated text

**Files:**
- Modify: `packages/kernel/src/runtime/context/build.ts` (`TEXT_INLINE_MAX_CHARS` `:166`, `mediaMode` `:200`, `mediaBlocks` `:210`, `mediaRefs` `:250`, `planMedia`, `resolveMedia` `:437`, the placeholder helpers `:358`)
- Modify: `packages/kernel/src/conversations/attachments.service.ts` (`mediaInfo` `:568`: add `uri`)
- Test: `packages/kernel/test/runtime/context/build.test.ts`, `packages/kernel/test/attachments/media-request.test.ts`, the zero-drift fixtures named by the replay-evals skill
- Docs: one `DriftReason` for the changed text inline rule, wherever the request-building changes record them

**Interfaces:**
- Consumes: the `file` block (Task 1), `ObjectStore.uri?` (Task 1), `allowedTypes` / `isMediaContentType` (Task 2).
- Produces:
  ```ts
  // MediaInfo gains the unsigned URI; attachments.mediaInfo fills it:
  //   uri: this.storage.kernel(orgId).uri?.(row.object_key) ?? `capybara://attachments/${row.id}`
  interface MediaInfo { size: number; pages: number | null; etag?: string | null; uri: string }

  // The reference line (one text block):
  //   [Attached file "<name>" (<mediaType>), <bytes> — this model cannot read its content.
  //    Unsigned object reference: <uri>. Use FetchAttachment with the file name or this reference
  //    to copy it into the device.]
  // Text above the threshold replaces the first sentence:
  //   <bytes> of text; not sent inline. The file is available in the device on request.
  ```

- [ ] **Step 1: Write the failing tests**

In `build.test.ts` (pure builder, no I/O):

```ts
it("a file block becomes one reference line and never carries bytes", () => {
  // a one-message log with a file block; mediaInfo: size + uri; media: bytes present
  const { request, meta } = build(requestWith(fileBlock, info, bytes));
  expect(textOf(request)).toContain(
    'Unsigned object reference: s3://bucket/kernel/<org>/attachments/<id>',
  );
  expect(textOf(request)).toContain("Use FetchAttachment");
  expect(meta.mediaTokens).toBe(0);
});

it("a text attachment at the threshold is inlined whole; one character more is a reference", () => {
  // two logs: 8 000 chars (inline, no "[Truncated") and 8 001 (reference, no body text)
});
```

In `media-request.test.ts`: the oversized text is not fetched (`model_call` media outcomes carry no
`bytes` for it), and a `file` block is never fetched even though its info is.

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm exec vitest run packages/kernel/test/runtime/context/build.test.ts packages/kernel/test/attachments/media-request.test.ts`
Expected: FAIL — the file block renders as an empty document, the threshold is 50 000.

- [ ] **Step 3: Implement**

1. `TEXT_INLINE_MAX_CHARS = 8_000` (the `TEXT_FETCH_MAX_BYTES` derivation follows it).
2. `mediaMode` gains `"reference"`: a `file` block is always a reference; an image/document keeps
   today's rule.
3. `mediaBlocks` includes `file` blocks (they need their `MediaInfo`, not their bytes), and
   `blocksOf`'s "does this message hold media" test (`build.ts`, the `some(...)` at the top of
   `buildModelRequest`) counts `file` too — else the reference never renders.
4. `planMedia` never puts a `file` block or a text block whose `info.size > TEXT_FETCH_MAX_BYTES`
   into `fetch`/`caps`.
5. `resolveMedia`: a `file` block → the reference line; a text block whose size is over the
   threshold → the reference line with the "not sent inline" sentence; otherwise exactly today's
   path (including the existing `capText` note as a safety for a row whose size lied).
6. `attachments.mediaInfo` adds `uri` as the Interfaces block says, and `StorageService.kernel`
   forwards `uri` from the underlying store.

- [ ] **Step 4: Verify**

Run: `pnpm exec vitest run packages/kernel/test/runtime packages/kernel/test/attachments`
Expected: PASS.

- [ ] **Step 5: The zero-drift fixtures and the DriftReason**

Run the fixture tests the replay-evals skill names before and after; record the difference for logs
that inlined a text attachment above 8 000 characters as one `DriftReason` entry in the place that
skill specifies. No other request changes.

- [ ] **Step 6: Commit**

```bash
git add packages/kernel/src/runtime packages/kernel/src/conversations/attachments.service.ts packages/kernel/src/storage packages/kernel/test docs/superpowers
git commit -m "feat(kernel): reference file attachments instead of copying or inlining them"
```

### Task 4: `FetchAttachment`

**Files:**
- Create: `packages/kernel/src/tools/builtins/sandbox/fetch-attachment.ts`
- Modify: `packages/kernel/src/tools/builtin-names.ts` (`BUILTIN` `:11`, `SANDBOX_TOOL_NAMES` `:47`, `BUILTIN_TOOL_KINDS` `:202`)
- Modify: `packages/kernel/src/tools/builtins/sandbox/index.ts` (register the tool, update the file's doc comment)
- Modify: `packages/kernel/src/tools/builtins/sandbox/common.ts` (export the name helpers the tool reuses: `attachmentsDir`, `assignAttachmentNames`)
- Test: `packages/kernel/test/tools/sandbox/fetch-attachment.test.ts` (new; add `"tools/sandbox/fetch-attachment.test.ts"` to `packages/kernel/test/unit-tests.json`)

**Interfaces:**
- Consumes: `SandboxToolDeps` (`attachments.listForConversation`, `attachments.openForConversation`), `withSandbox`, `attachmentsDir(roots, conversationId)`, `assignAttachmentNames`, `unavailableWhenNoSandbox`.
- Produces:
  ```ts
  // ToolSpec name "FetchAttachment"; input { file: string }; result value { path: string; size: number };
  // human text: `Copied ${name} to ${path}.`
  export function sandboxFetchAttachmentTool(deps: SandboxToolDeps): BuiltinTool;
  ```

- [ ] **Step 1: Write the failing test**

```ts
it("copies an attachment by name and returns the stable path", async () => {
  // fake sandbox provider + a conversation with one xlsx attachment (memory store)
  const a = await run(tool, { file: "电商工行.xlsx" });
  expect(a.path).toBe("/workspace/attachments/6f40dd430000/电商工行.xlsx");
  const b = await run(tool, { file: "电商工行.xlsx" });
  expect(b.path).toBe(a.path); // idempotent
});

it("accepts the unsigned reference and the attachment id", async () => {/* … */});

it("names what the conversation has when the file is unknown", async () => {
  const r = await run(tool, { file: "nope.xlsx" });
  expect(r.error).toMatch(/No attachment named "nope.xlsx"; this conversation has: /);
});

it("is not offered without a usable sandbox", async () => {
  expect(await available(ctxWithoutDevice)).toBe(false);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm exec vitest run packages/kernel/test/tools/sandbox/fetch-attachment.test.ts`
Expected: FAIL (no such tool).

- [ ] **Step 3: Implement**

Resolve `file` to an attachment: exact name, then `s3://…/attachments/<id>` (tail match on the id),
then a bare UUID; among `listForConversation`, `status === "ready"`. Copy with
`openForConversation(orgId, conversationId, id)` → `provider.writeFile(path, bytes, signal)` inside
`withSandbox`, with the path from `assignAttachmentNames(list, new Set())`. Map failures to
`ToolError` with the messages the spec lists (no such file + up to five names, not finalized,
deleted, storage unavailable, no device via `unavailableWhenNoSandbox`). `defaultPolicy: "allow"`,
out of `SANDBOX_ASK_TOOL_NAMES`, kind `"tool"`, `keyArgs: ["file"]`.

- [ ] **Step 4: Verify**

Run: `pnpm exec vitest run packages/kernel/test/tools/sandbox && pnpm check:tool-design && pnpm check:kernel-conventions`
Expected: PASS; the tool-design check's rules (English description, actionable errors, key grammar)
are satisfied without exclusion entries.

- [ ] **Step 5: Commit**

```bash
git add packages/kernel/src/tools packages/kernel/test/tools/sandbox
git commit -m "feat(tools): FetchAttachment copies a conversation attachment into the device"
```

---

## Wave 3 — removal, web, design

### Task 5: delete the automatic copy

**Files:**
- Modify: `packages/kernel/src/tools/builtins/sandbox/common.ts` (remove `syncAttachments` `:498`, `copyAttachments` `:531`, the marker helpers `:208-231`, the notice `:689-692`; keep `attachmentsDir`, `assignAttachmentNames`, `sanitizeName`)
- Modify: `packages/kernel/src/tools/builtins/sandbox/bash.ts:55` and `read.ts:32` (descriptions)
- Modify: `docs/superpowers/specs/2026-11-07-environments-design.md` §7.4
- Test: `packages/kernel/test/tools/sandbox/sandbox-tools.test.ts`, `sandbox-helpers.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
it("a sandbox call no longer copies attachments or mentions them", async () => {
  // a conversation with one ready attachment; run Bash
  expect(await provider.listFiles("/workspace/attachments")).toEqual([]);
  expect(result.notices).not.toContain("Attachments copied into the sandbox");
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm exec vitest run packages/kernel/test/tools/sandbox/sandbox-tools.test.ts -t "no longer copies"`
Expected: FAIL (the file is copied today).

- [ ] **Step 3: Implement**

Delete the functions and their call site; rewrite the two tool descriptions to say attachments are
not in the device until `FetchAttachment` copies one; rewrite the environments spec paragraph to the
same rule (path and per-conversation directory unchanged). Remove now-dead tests that asserted the
copy and the marker; keep `assignAttachmentNames`' tests.

- [ ] **Step 4: Verify**

Run: `pnpm exec vitest run packages/kernel/test/tools/sandbox && pnpm check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/kernel/src/tools packages/kernel/test/tools/sandbox docs/superpowers/specs
git commit -m "refactor(sandbox): stop copying attachments before every call"
```

### Task 6: web accepts the new types and keeps the refusal line short

**Files:**
- Modify: `apps/web/src/lib/attachments.ts` (`DEFAULT_LIMITS` `:33`, `BY_EXTENSION` `:47`, `attachmentTypeLabel` `:186`, `typeList` `:182`)
- Modify: `apps/web/src/components/use-draft-files.ts` (`errorText`, around `:235-250`)
- Test: `apps/web/src/lib/attachments.test.ts` (or the file's existing test), `apps/web/src/components/use-draft-files.test.tsx`

**Interfaces:**
- Produces: `typeList(types)` joins at most six labels then `等 N 种` / `and N more`;
  `attachmentTypeLabel` learns XLSX / DOCX / PPTX / ZIP / JSON.

- [ ] **Step 1: Write the failing tests**

```ts
it("lists at most six labels then a count", () => {
  expect(typeList(FOURTEEN_TYPES)).toBe("PNG / JPEG / GIF / WebP / PDF / TXT 等 14 种");
  expect(typeList(FOURTEEN_TYPES_EN, "en")).toBe("PNG / JPEG / GIF / WebP / PDF / TXT and 14 total");
});
it("labels the office types", () => {
  expect(attachmentTypeLabel(XLSX)).toBe("XLSX");
  expect(attachmentTypeLabel("application/zip")).toBe("ZIP");
});
```

- [ ] **Step 2: Run and watch them fail** — `pnpm exec vitest run apps/web/src/lib/attachments.test.ts`

- [ ] **Step 3: Implement** — the label map and the truncating `typeList` (take the locale from the caller, not a global); extend `BY_EXTENSION` with `xlsx`, `docx`, `pptx`, `zip`, `json`; `DEFAULT_LIMITS.types` gains the new default content types so a pre-fetch render does not refuse them.

- [ ] **Step 4: Verify** — `pnpm exec vitest run apps/web/src/lib/attachments.test.ts apps/web/src/components/use-draft-files.test.tsx && pnpm check:web-ui`

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/attachments.ts apps/web/src/components/use-draft-files.ts apps/web/src/lib/attachments.test.ts apps/web/src/components/use-draft-files.test.tsx
git commit -m "feat(web): accept office and archive attachments with a short refusal line"
```

### Task 7: clicking an image zooms in the page

**Files:**
- Create: `packages/design/src/conversation/image-zoom.tsx`
- Modify: `packages/design/src/conversation/index.ts` (export), `packages/design/src/styles/conversation.css` (the dialog frame and the image)
- Modify: `apps/web/src/components/conversation/Thread.tsx:640-712` (the `atts` mapping and the `onOpen` handler)
- Modify: `apps/web/src/lib/timeline.ts:85-90` and `messageFiles` `:443-457` (carry the block's `size`)
- Test: `packages/design/test/image-zoom.test.tsx` (new), `apps/web/e2e/chat.spec.ts` (one case)

**Interfaces:**
- Produces:
  ```tsx
  export function ImageZoom(props: {
    open: boolean;
    onOpenChange(open: boolean): void;
    src: string;
    name: string;
    size?: string;
    onDownload(): void;
  }): JSX.Element;
  ```
  Built on `Dialog` (`overlays/dialog.tsx`): the image at up to 86vw × 86vh, a caption with the
  name, "下载" / "Download" (`files.download`) and the dialog's close (`overlay.close`).
- Produces: `MessageFile` gains `size?: number`, filled from the block (`file` blocks included:
  `kind` becomes `"image" | "document" | "file"`), and the bubble renders it with `formatBytes`
  (the chip the maintainer approved: badge, name, size).

- [ ] **Step 1: Write the failing jsdom test**

```tsx
it("opens on the thumbnail, shows the name, closes on Escape and downloads", async () => {
  // render BubbleAttachments with one image + a spy onOpen; the caller opens ImageZoom
  // assert role="dialog" with the name, the download button, Escape closes and focus returns
});

it("a file chip shows its size", () => {
  // BubbleAttachments with { kind: "file", name: "电商工行.xlsx", type: "XLSX", size: "1.2 MB" }
});
```

- [ ] **Step 2: Run and watch it fail** — `pnpm exec vitest run packages/design/test/image-zoom.test.tsx`

- [ ] **Step 3: Implement** the component; carry `size` through `MessageFile` → `BubbleAttachment`
  (the chip renders `formatBytes`); wire the web: an image attachment sets the zoom state instead of
  calling `openDownload`, a file chip keeps calling `openDownload` exactly as today.

- [ ] **Step 4: Verify** — `pnpm exec vitest run packages/design && pnpm check:web-ui && pnpm exec playwright test apps/web/e2e/chat.spec.ts -g "zoom"`
  (the e2e needs the container-backed global setup; run it under the container project)

- [ ] **Step 5: Changeset**

`pnpm changeset` → patch `@capybara-hq/design` and patch `@capybara-hq/web` (fixed group with
`@capybara-hq/capybara`): "Clicking an image attachment zooms in the page with a download action
instead of opening a tab."

- [ ] **Step 6: Commit**

```bash
git add packages/design apps/web .changeset
git commit -m "feat(web): zoom image attachments in the page"
```

---

## Wave 4 — the plugins repository

### Task 8: `object-store-s3` reports its URI; every plugin compiles on the new SDK

**Files (worktree of `capybara-hq/plugins`):**
- Modify: `plugins/object-store-s3/src/index.ts` (the `ObjectStore` literal at `:129`)
- Test: `plugins/object-store-s3/test/*` (the store's unit tests)
- Regenerate: the plugin's dependency on `@capybara-hq/plugin-sdk` (`capybara-plugin sync-versions` plus the release flow for the new SDK version)

**Interfaces:**
- Consumes: `ObjectStore.uri?` from Task 1.
- Produces: `uri(key) => `s3://${bucket}/${key}`` for the S3 store.

- [ ] **Step 1: Write the failing test** — `expect(store.uri?.("kernel/org/attachments/x")).toBe("s3://capybara/kernel/org/attachments/x")`
- [ ] **Step 2: Run and watch it fail** — the method is absent
- [ ] **Step 3: Implement** — return the bucket-qualified URI; no signing, no network
- [ ] **Step 4: Verify every plugin** — `pnpm -r typecheck && pnpm -r test && pnpm -r check` in the plugins worktree, against the SDK version Task 1 produced (`pnpm link` or the published rc)
- [ ] **Step 5: Changeset and release** — a patch of `@capybara-hq/plugin-object-store-s3`; publish through the repository's release flow, and note the version the kernel's manual acceptance should install
- [ ] **Step 6: Commit** in the plugins worktree with its own message

---

## Wave 5 — verification and acceptance

### Task 9: repository gates and the live acceptance

**Files:** none created; the change registers in `tools/ci` only if a new container test is added
(Task 4's test is unit; Task 7's is e2e, already covered by the web job).

- [ ] **Step 1:** `pnpm verify --fast` — expect four green checks.
- [ ] **Step 2:** `pnpm verify` (full) — expect the affected packages' tests green; record the exact failure output if not.
- [ ] **Step 3:** On argus, set `CAPYBARA_EXTENSION_CONFIG`'s `attachments.allowedTypes` only if the deployment overrides the default; otherwise leave it and confirm the new default via `GET /api/v1/orgs/<org>/attachments/limits` (returns the extended list).
- [ ] **Step 4:** Manual acceptance in the running deployment: upload an `xlsx`, send it, ask the agent to summarize the first sheet; expect (a) the chip with `XLSX` and the size, (b) one tool call to `FetchAttachment` in the transcript, (c) files under `attachments/` in the device, (d) no `head attachments/…` failing before the fetch.
- [ ] **Step 5:** Acceptance for the image zoom and the short refusal copy; record screenshots in the PR body.
- [ ] **Step 6:** Open the PR from the worktree with the changesets, the spec link and the DriftReason note; link the plugins-repository PR.
