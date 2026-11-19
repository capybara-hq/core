# Read for images, smaller generated images, references — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. In this repository it runs under the `wave-planned-subagent-development` skill.

**Goal:** `Read` shows images to the chat model (or has a configurable vision model read them),
reads attachments and artifacts by id, generated images default to about one megapixel,
`GenerateImage` texts explain references, and device file transfer gets fast.

**Architecture:**
- A `Read` of an image stores a copy as a `read` attachment of the calling conversation and logs
  it on `tool_result.media`.
- Request building renders those images after the turn's tool results, through the existing media
  pipeline, with a separate chunked-eviction window.
- A non-vision chat model gets a text answer from the new `vision` kernel purpose (built on the
  `web/extract.ts` template).
- `GenerateImage` picks sizes with a kernel helper (`standard` / `high`).
- The device fix is internal to `packages/device`.
- ark gains 1K sizes in the plugins repository.

**Tech Stack:** TypeScript, NestJS + Fastify kernel, Kysely / PostgreSQL, vitest, zod; the
`capybara-hq/plugins` repo for ark.

**Spec:** `docs/superpowers/specs/2026-11-19-vision-read-design.md`. Its open questions are
decided as recommended.

## Global Constraints

**Run and test rules:**
- Run tests from the repo root: `pnpm exec vitest run <path>`.
- A new unit test joins `packages/kernel/test/unit-tests.json`, a new container test
  `packages/kernel/test/container-tests.json`; integration is the default.
- No fixed sleeps and no per-test timeouts.

**Code rules:**
- English comments, identifiers and model-facing text.
- When you edit a file, translate the comments and test titles you touch
  (`pnpm check:english-comments --base origin/main`).
- Kernel: explicit `@Inject` on every constructor parameter; config through
  `KernelConfigService`; writes in `@Transactional()`; periodic jobs `@LockedCron`, provided only
  under `WorkerModule`.
- Tool texts are English and actionable (`check:tool-design`), and they state mechanism only, no
  advice.

**Purposes and config:**
- Purpose value: `"vision"`, kind `chat`, label `{ zh: "识图", en: "Vision" }`; it requires
  `capabilities.vision`.
- Config keys, all hot (regenerate `docs/config.md`):

  | Key | Default | Range |
  |---|---|---|
  | `models.imageStandardPixels` | 1048576 | 262144..16777216 |
  | `models.visionTimeoutMs` | 120000 | 5000..600000 |
  | `models.visionMaxOutputTokens` | 2000 | 100..16000 |
  | `attachments.readImagesPerRequest` | 6 | 2..20 |
  | `attachments.readMaxBytesPerConversation` | 536870912 | 0..17179869184 |
  | `attachments.readPurgeAfterHours` | 24 | 1..720 |

**Attachments and media:**
- Attachment purpose: `read`. Object key: `read-images/<id>`.
- Image limit: `MEDIA_LIMITS.imageBytes` (5 MiB). Sniffed types: `image/png`, `image/jpeg`,
  `image/gif`, `image/webp`.

**Exact texts** (spec §1.2, §1.5, §4; copy verbatim):

| Where | Text |
|---|---|
| Read result | `Read image <name> (<mediaType>, <size>, <W>×<H>; file_id <attachmentId>).` (omit `, <W>×<H>` when unknown) |
| Fallback answer | `<provider>/<model> read the image for you (this model cannot view images):\n<answer>` |
| No vision model | `This model cannot view images and the organization has no vision model; an org admin can set one under Models → Purposes → Vision.` |
| No device | `This agent has no device; pass file_id to read an attachment or artifact.` |
| PDF | `PDF document (<size>). Read does not parse PDFs; images it reads are shown, so pages rendered as images can be read.` |
| Too large | `Image <name> is <size>; the limit is 5 MB. Make a smaller copy and Read it.` |
| Label before a Read image | `Image from Read (file_id <id>):` |
| Read image, model without vision | `[This model cannot view images.]` |
| Read image dropped by the window | `[Image from Read (file_id <id>) not included in this request.]` |
| Pasted image, model without vision | `[Attached image "<name>" — this model cannot view images. Read with file_id <id> sends it to the organization's vision model, if one is set.]` |
| GenerateImage, extra result line | `The images are not shown to you; Read with file_id <artifact id> returns one.` |

- `REFERENCE_SENTENCE`, the `reference_images` description, `unknownReferenceText` and the `Read`
  description: verbatim from spec §4 and §1.5.

**Process:**
- Replay: run `pnpm exec vitest run packages/kernel/test/evals/reconstruct.test.ts` before and
  after Task 6.
- Changesets: `@capybara-hq/plugin-sdk` (Task 1), `@capybara-hq/kernel` and
  `@capybara-hq/capybara` (Task 10), `@capybara-hq/device` (Task 8).

## Review Focus

1. **Org boundary:** a `file_id` from another conversation or org is unknown, never read.
   Task 3 tests a second org's artifact id.
2. **Long sessions:** a run that reads 11 images on a vision model keeps at most 6 Read images per
   request, and the request prefix changes only when the window evicts. Task 6 pins the eviction
   sequence over 11 reads.
3. **Mid-run model fallback:** a step that runs on a non-vision fallback rung after Read images
   gets the static text, and Read decides from that step's `model_call`. Task 7 tests a fallback
   step.
4. **Crashes:** a crash between object put and bind leaves only an unbound row with an expiry, and
   the existing cleanup collects it. Task 4 tests that an unbound `read` row is deleted by
   `deleteExpired`.
5. **No device:** an agent without a device can `Read` by `file_id` after `GenerateImage`. Task 7
   has an integration case without a sandbox.

---

## Wave plan (copy to the ledger)

| Task | Depends on | Files / areas | Risk | Wave | Review |
|---|---|---|---|---|---|
| 0 Config keys | — | config/schema.ts, docs/config.md | normal | 1 | batch |
| 1 SDK purpose + `vision` purpose | — | plugin-sdk hooks.ts, sdk api, models/purposes.ts, events.ts (usage enum), web purposes | normal | 1 | batch |
| 2 Image header sniffer | — | new media/image-header.ts | normal | 1 | batch |
| 8 Device transfer speed | — | packages/device | normal | 1 | batch |
| 9 ark 1K sizes | — | plugins repo plugins/ark | normal | 1 | own (other repo) |
| 3 Shared id lookup + GenerateImage | 0 | image/generate.ts, new conversation-files.ts | normal | 2 | batch |
| 4 `read` attachments | 0 | migration 0163, attachments.service.ts, attachments module | high | 2 | alone, most capable |
| 5 Vision call | 0, 1 | new tools/builtins/vision/ | high | 2 | alone, most capable |
| 6 Request building + replay | 2, 4 | build.ts, events.ts (tool_result.media), tokens.ts, reconstruct.ts, recorded-tools.ts, run-replay.ts, model-call.ts | high | 3 | alone, most capable |
| 7 Read tool | 2–6 | sandbox/read.ts, registry.ts, pipeline.ts, builtin-tools.ts | normal | 4 | alone |
| 10 Docs, changesets, pins | all | skills, changesets, bootstrap.json | normal | 5 | batch |

---

### Task 0: Config keys

**Files:**
- Modify: `packages/kernel/src/config/schema.ts` (the `models` section near `imagePromptMaxChars`;
  the `attachments` section near `requestMediaBytes`)
- Modify: `docs/config.md` (regenerated)
- Test: `packages/kernel/test/config/` (the existing schema defaults test)

**Interfaces:**
- Produces: `cfg.models.imageStandardPixels`, `cfg.models.visionTimeoutMs`,
  `cfg.models.visionMaxOutputTokens`, `cfg.attachments.readImagesPerRequest`,
  `cfg.attachments.readMaxBytesPerConversation` and `cfg.attachments.readPurgeAfterHours`, with
  the defaults and ranges of Global Constraints, each `hot: true` with an English description.

- [ ] **Step 1:** Add to the defaults test:
  `expect(parse({}).models.imageStandardPixels).toBe(1048576)`, the same for each key, and one
  out-of-range rejection per key.
- [ ] **Step 2:** Run it: `pnpm exec vitest run packages/kernel/test/config`. Expected: FAIL
  (unknown keys).
- [ ] **Step 3:** Add the six fields with `meta({ hot: true, description })`, following the
  `adding-config` skill.
- [ ] **Step 4:** Run `pnpm gen:config-docs` (the script the `adding-config` skill names), then
  the test. Expected: PASS; `pnpm check` has no config-docs diff.
- [ ] **Step 5:** Commit:
  `git add packages/kernel/src/config/schema.ts docs/config.md packages/kernel/test/config && git commit -m "feat(kernel): add config for vision reads and standard image size"`.

### Task 1: `vision` in the SDK purpose union and the kernel purpose

**Files:**
- Modify: `packages/plugin-sdk/src/hooks.ts:56-75, 105-115, 233, 276` (union and docs)
- Modify: the generated SDK API file (`pnpm gen:sdk-api`)
- Create: `.changeset/<name>.md`, a patch for `@capybara-hq/plugin-sdk`
- Modify: `packages/kernel/src/conversations/events.ts:1034-1036` (`usage.purpose` gains `vision`)
- Modify: `packages/kernel/src/models/purposes.ts`:
  - `KERNEL_PURPOSES` gains an optional `requires?: { vision?: true }`;
  - `check()`, `resolve()` and `availability()` enforce it;
  - `PurposeView` exposes `requires`.
- Modify: the web purposes page (`apps/web/src/app/(app)/**/models/**` where purposes are edited)
  and the i18n zh/en messages
- Test: `packages/kernel/test/models/purposes.test.ts`

**Interfaces:**
- Produces:
  - SDK `ModelCallPurpose` includes `"vision"`;
  - kernel `KERNEL_PURPOSES` has
    `{ purpose: "vision", kind: "chat", requires: { vision: true }, label: { zh: "识图", en: "Vision" } }`;
  - `ModelPurposesService.resolve(orgId, "vision")` throws `ApiError("model.unconfigured")` when
    unmapped, or when the target's `capabilities.vision` is not true.

- [ ] **Step 1: Tests** in `purposes.test.ts`:
  - `"vision purpose refuses a chat model without vision on save"`: PUT a non-vision model-fake
    target, expect a field error on `model`.
  - `"vision purpose resolves a vision model"`.
  - `"a vision target that loses vision is unusable"`: re-declare the model-fake model with
    `vision: false`; expect `resolve` to throw `model.unconfigured` and `availability` to report
    `available: false`.
  - Update the `KERNEL_PURPOSES` snapshot at `:165`.
- [ ] **Step 2:** Run `pnpm exec vitest run packages/kernel/test/models/purposes.test.ts`.
  Expected: FAIL.
- [ ] **Step 3:** Implement the SDK union and docs, the kernel entry and the checks. The
  capability is read from the model list cache the service already uses for kind. The web page
  filters the model picker by `requires.vision`, and the label comes from i18n.
- [ ] **Step 4:** Run `pnpm gen:sdk-api`, the test, `pnpm check:sdk-api`,
  `pnpm check:sdk-api-changeset` and `pnpm check:i18n`. Expected: all PASS.
- [ ] **Step 5:** Commit:
  `git add packages/plugin-sdk packages/kernel/src/models/purposes.ts packages/kernel/src/conversations/events.ts packages/kernel/test/models/purposes.test.ts apps/web .changeset && git commit -m "feat: add the vision model purpose"`.

### Task 2: Image header sniffer

**Files:**
- Create: `packages/kernel/src/media/image-header.ts`
- Test: `packages/kernel/test/media/image-header.unit.test.ts` (add to `unit-tests.json`)

**Interfaces:**
- Produces:
  - `export type SniffedImage = { mediaType: "image/png" | "image/jpeg" | "image/gif" | "image/webp"; width?: number; height?: number }`
  - `export function sniffImage(bytes: Uint8Array): SniffedImage | null`
- Signatures are as in `attachments.service.ts:160-170`, which keeps its own boolean
  `sniffMatches`.
- Dimensions: PNG `IHDR`; JPEG, the first SOF0–SOF15 marker except DHT/DAC/JPG (so progressive
  SOF2 counts); GIF, the logical screen; WebP `VP8 ` / `VP8L` / `VP8X`.

- [ ] **Step 1: Tests**, with tiny hand-built byte fixtures:
  - a 3×2 PNG → `{ mediaType: "image/png", width: 3, height: 2 }`;
  - a baseline JPEG and a progressive JPEG → their sizes;
  - GIF89a 5×4;
  - each WebP variant;
  - a truncated PNG (signature only) → `{ mediaType: "image/png" }` with no width;
  - `%PDF-` → `null`;
  - an SVG text → `null`.
- [ ] **Step 2:** Run `pnpm exec vitest run packages/kernel/test/media/image-header.unit.test.ts`.
  Expected: FAIL.
- [ ] **Step 3:** Implement. It reads only the header (bounded loops, no decoding) and never
  throws on short input.
- [ ] **Step 4:** Run it. Expected: PASS.
- [ ] **Step 5:** Commit:
  `git add packages/kernel/src/media packages/kernel/test/media packages/kernel/test/unit-tests.json && git commit -m "feat(kernel): sniff image type and dimensions from the header"`.

### Task 3: Shared conversation-file lookup, and GenerateImage size and texts

**Files:**
- Create: `packages/kernel/src/tools/builtins/conversation-files.ts`
- Modify: `packages/kernel/src/tools/builtins/image/generate.ts`:
  - `openReference` at `:431-457` uses the helper;
  - `REFERENCE_SENTENCE`, the descriptions of `reference_images` and `aspect_ratio`, and
    `unknownReferenceText` change;
  - a `resolution` input and the size helper are added;
  - the result gets its extra line.
- Test: `packages/kernel/test/tools/generate-image.test.ts`,
  `packages/kernel/test/tools/generate-image-spec.test.ts`,
  `packages/kernel/test/tools/image-size.unit.test.ts` (add to `unit-tests.json`)

**Interfaces:**
- Consumes: `cfg.models.imageStandardPixels` (Task 0).
- Produces:

  ```ts
  export interface ConversationFile { kind: "attachment" | "artifact"; id: string; name: string;
    contentType: string; size: number; open(): Promise<Uint8Array> }
  export function findConversationFile(
    deps: { db: KernelDb; attachments: Pick<AttachmentsService, "openForConversation">; storage: StorageService },
    q: { orgId: string; conversationId: string; rootConversationId: string; id: string },
  ): Promise<ConversationFile | null>
  export function pickStandardSize(
    info: ModelImageGenerationInfo,
    q: { aspectRatio?: ImageAspectRatio; resolution: "standard" | "high"; standardPixels: number },
  ): ImageSize
  ```

  - `findConversationFile`: an attachment of `conversationId` or `rootConversationId`, else an
    `artifact_created` of either, always in `orgId`. A non-UUID id gives `null`.
  - `pickStandardSize` lives in `image/size.ts`; its algorithm is spec §3.3.

- [ ] **Step 1: Tests:**
  - `image-size.unit.test.ts`:
    - the ark 5.5 1K+2K list with `3:4` standard → `864x1152`, high → `1728x2304`;
    - no aspect → the ratio of `defaultSize`;
    - a 2K-only list, standard `3:4` → `1728x2304`;
    - an equal-distance tie → the smaller area;
    - a single-size model → that size.
  - `generate-image.test.ts`:
    - `"accepts a Deliver'ed image as a reference"`;
    - `"an artifact id of another org is an unknown reference"` (Review Focus 1);
    - `"a sub-agent may reference its root's attachment"`;
    - `"standard resolution uses imageStandardPixels"`: with model-fake image sizes
      `[1024x1024, 2048x2048]`, the result says `at 1024x1024`, and `resolution: "high"` gives
      2048;
    - `"result names Read with file_id"`.
  - `generate-image-spec.test.ts`: the new texts verbatim.
- [ ] **Step 2:** Run the three files. Expected: FAIL.
- [ ] **Step 3:** Implement the helper, the size helper and the texts. Keep the literal-sentence
  guard of `generateImageSpec` (`:91-93`) in step with the new `REFERENCE_SENTENCE`.
- [ ] **Step 4:** Run the three files and `pnpm check:tool-design`. Expected: PASS.
- [ ] **Step 5:**
  `git add packages/kernel/src/tools/builtins packages/kernel/test/tools packages/kernel/test/unit-tests.json && git commit -m "feat(kernel): standard image size, any conversation image as reference"`.

### Task 4: `read` attachments (high risk: migration, storage, multi-replica)

**Files:**
- Create: `packages/kernel/src/migrations/0163_read_attachments.sql`
- Modify: `packages/kernel/src/conversations/attachments.service.ts`:
  - `objectKey` at `:142-147`;
  - `mediaInfo` / `fetchMedia` at `:643-716` filter `purpose IN ('chat','read')`;
  - a new `storeRead`;
  - a new purge job.
- Modify: the attachments module, if the job needs worker-only provision (follow the existing
  `ATTACHMENT_CLEANUP_JOB` at `:973`)
- Test: `packages/kernel/test/attachments/read-attachments.test.ts`,
  `packages/kernel/test/migrations/0163.test.ts`

**Interfaces:**
- Consumes: `cfg.attachments.readMaxBytesPerConversation`, `cfg.attachments.readPurgeAfterHours`
  (Task 0).
- Produces:

  ```ts
  storeRead(orgId: string, conversationId: string, accountId: string | null,
    file: { name: string; contentType: string; data: Uint8Array }):
    Promise<{ ok: true; attachmentId: string; size: number } | { ok: false; reason: "cap" }>
  ```

- Order inside `storeRead`:
  1. check the cap (the sum of `size` of the conversation's `read` rows plus the new size, over the
     cap → `{ ok: false, reason: "cap" }`; 0 means always refuse);
  2. insert the row unbound (`conversation_id NULL`, `status 'pending'`, `expires_at` = the unbound
     TTL, `purpose 'read'`);
  3. `put` to `read-images/<id>`;
  4. one `@Transactional` update that binds it (`conversation_id`, `status 'ready'`,
     `expires_at NULL`, `size`, `etag`).
- Purge: `@LockedCron("0 * * * *", { name: "attachments-read-purge" })`, worker only. It claims up
  to 500 `read` rows whose conversation has `deleted_at < now() - readPurgeAfterHours`, deletes
  each object, then deletes the rows, using the claim and delete pattern of `deleteExpired`.
- `boundRows`, `listForConversation`, `openForConversation`, `bindForMessage` and `downloadUrl`
  stay `purpose = 'chat'`.

- [ ] **Step 1: Tests:**
  - `0163.test.ts`: the check constraint accepts `read`, and running the migration twice is
    idempotent.
  - `read-attachments.test.ts`:
    - `storeRead` binds a row and `mediaInfo` / `fetchMedia` return it;
    - `listForConversation` and `openForConversation` do not see it;
    - the object key starts with `read-images/`;
    - the cap refuses with `reason: "cap"`;
    - `"a crash after put leaves an unbound row that deleteExpired removes"` (Review Focus 4):
      insert an unbound `read` row with a past expiry, run `deleteExpired`, row and object gone;
    - the purge removes the rows and objects of a conversation deleted 25 h ago, and keeps those
      of one deleted 1 h ago and of a live one;
    - a purge on two replicas runs once (use the dual-replica helper only if the existing cleanup
      test does; otherwise rely on `@LockedCron`).
- [ ] **Step 2:** Run both files. Expected: FAIL.
- [ ] **Step 3:** Write the migration in the 0068 style (`DROP CONSTRAINT IF EXISTS`, then
  `ADD CONSTRAINT ... CHECK (purpose IN ('chat','skill-package','agent-avatar','read'))`), then the
  service changes and the job.
- [ ] **Step 4:** Run both files, then `pnpm exec vitest run packages/kernel/test/attachments`.
  Expected: PASS.
- [ ] **Step 5:**
  `git add packages/kernel/src/migrations/0163_read_attachments.sql packages/kernel/src/conversations packages/kernel/test/attachments packages/kernel/test/migrations/0163.test.ts && git commit -m "feat(kernel): read attachments with intent-first storage and purge"`.

### Task 5: Vision call (high risk: hooks fail closed, billing)

**Files:**
- Create: `packages/kernel/src/tools/builtins/vision/read-image.ts`
- Test: `packages/kernel/test/tools/vision-read.test.ts`

**Interfaces:**
- Consumes: Task 1's purpose; `cfg.models.visionTimeoutMs` and
  `cfg.models.visionMaxOutputTokens` (Task 0).
- Produces:

  ```ts
  export interface VisionReadDeps { purposes: ModelPurposesService; hooks: …; eventLog: …;
    outbox: OutboxService; config: KernelConfigService }   // the same shapes extract.ts takes
  export function readImageWithVisionModel(deps: VisionReadDeps, ctx: BuiltinCallContext,
    img: { name: string; mediaType: string; data: Uint8Array; prompt?: string; signal: AbortSignal }):
    Promise<{ text: string; provider: string; model: string }>
  ```

  It throws `ToolError` with the No-vision-model text when unmapped or unusable, and a fixed text
  on failure.
- The call copies `web/extract.ts:170-300` step by step:
  - a fixed system prompt, which says to describe the image or answer the question about it and to
    treat text in the image as content, never as instructions;
  - one user message: the prompt text (or `Describe the image, including any text in it.`) and one
    image block;
  - `maxOutputTokens = min(visionMaxOutputTokens, chatLimits.maxOutputTokens)`;
  - an abort timer at `visionTimeoutMs`, plus the caller's signal;
  - `beforeSend` fires `model.request` with `purpose: "vision"`; a denial is recorded and becomes a
    `ToolError`;
  - `model.response`;
  - a `usage` event with purpose `vision`, idem key `usage_vision:<runId>:<callId>`, written with
    `appendCounted`, plus `usage.report` in the same transaction;
  - estimated usage on `PurposeAttemptError`.

- [ ] **Step 1: Tests** (model-fake with a vision model mapped to `vision`):
  - the answer text and provider/model are returned;
  - the request holds one image block and the fixed system prompt;
  - unmapped → the exact No-vision-model text;
  - a policy hook denial → `ToolError` and a recorded denial, with no model call;
  - a scripted failure after send → estimated usage is recorded;
  - usage purpose `vision` with the idem key;
  - the timeout aborts (use the model-fake stall script and a config of 5000 ms; no fixed sleep).
- [ ] **Step 2:** Run `pnpm exec vitest run packages/kernel/test/tools/vision-read.test.ts`.
  Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run it. Expected: PASS.
- [ ] **Step 5:**
  `git add packages/kernel/src/tools/builtins/vision packages/kernel/test/tools/vision-read.test.ts && git commit -m "feat(kernel): read an image with the vision purpose model"`.

### Task 6: Request building and replay (high risk: model-visible history)

**Files:**
- Modify: `packages/kernel/src/conversations/events.ts:1209-1222`: `tool_result` gains
  `media?: { attachmentId: string; name: string; mediaType: string; size: number }[]`.
- Modify: `packages/kernel/src/runtime/context/build.ts`:
  - `mediaBlocks` (`:237`), `planMedia` (`:314`), `resolveMedia` (`:509`), `placeholder()`
    (`:438`);
  - tool-result rendering (`:970-990`).
- Modify: `packages/kernel/src/runtime/context/tokens.ts` (the Read images count).
- Modify: `packages/kernel/src/evals/recorded-tools.ts:93-151, 258-265` (copy `media`),
  `packages/kernel/src/evals/reconstruct.ts`, `packages/kernel/src/evals/run-replay.ts`.
- Modify: `packages/kernel/src/runtime/prompt-suggestions.ts` (exclude Read images), only if it
  uses `mediaBlocks`.
- Test: `packages/kernel/test/runtime/context/build.test.ts`,
  `packages/kernel/test/attachments/media-request.test.ts`,
  `packages/kernel/test/evals/reconstruct.test.ts`,
  `packages/kernel/test/evals/run-replay.test.ts`

**Interfaces:**
- Consumes: Task 4's `read` rows (`mediaInfo` / `fetchMedia` see them).
- Produces: `tool_result.media` is logged and rendered.
  - **Ordering:** in a tool-results user message, after all `tool_result` blocks, for each result
    with `media` in call order: the text `Image from Read (file_id <id>):`, then the image (vision)
    or `[This model cannot view images.]` (no vision).
  - **Read-image window:** count only Read images, newest first. When the count exceeds
    `readImagesPerRequest`, keep the newest `floor(readImagesPerRequest / 2)`. A dropped one
    renders the "not included" text.
  - **Determinism:** "exceeds" is decided from the log alone. Walk the Read images in log order,
    with a kept-set that resets to its newest half whenever it overflows, so the kept-set changes
    only at overflow points.
  - Pasted images keep the existing cap and budget; Read images also count toward both.
  - The pasted-image placeholder changes to the Global Constraints text (it gains the attachment
    id).

- [ ] **Step 1:** Run `pnpm exec vitest run packages/kernel/test/evals/reconstruct.test.ts` and
  record that it is green before any change.
- [ ] **Step 2: Tests:**
  - `build.test.ts`:
    - `"renders a Read image after the tool results"` (exact block order);
    - `"non-vision model gets the static Read text"`;
    - `"Read window evicts in chunks"` (Review Focus 2): log 11 Read images one per step and assert
      which ids are kept at each step:
      - kept-set after reads 1–6: all;
      - read 7: {5, 6, 7};
      - reads 8–10: {5…10};
      - read 11: {9, 10, 11};

      and the prefix before the first image block is byte-identical between consecutive steps
      that do not overflow;
    - `"pasted placeholder names the attachment id"`.
  - `media-request.test.ts`: a provider rejection of a Read image writes `media_excluded` and the
    next request renders it as rejected.
  - `reconstruct.test.ts`: zero-drift fixtures for a Read image on a vision model, a fallback read
    on a non-vision model, and a sub-agent Read image; a deleted object gives `media_missing`.
  - `run-replay.test.ts`: a recorded `media` survives full-run replay.
- [ ] **Step 3:** Run the four files. Expected: FAIL.
- [ ] **Step 4:** Implement. Media lookups keep using the calling conversation's id. Read copies
  belong to the calling conversation (Task 4 / Task 7), so no root widening is needed.
- [ ] **Step 5:** Run the four files plus
  `pnpm exec vitest run packages/kernel/test/runtime/context packages/kernel/test/attachments packages/kernel/test/evals`.
  Expected: PASS, and the reconstruct suite stays zero-drift.
- [ ] **Step 6:**
  `git add packages/kernel/src/conversations/events.ts packages/kernel/src/runtime packages/kernel/src/evals packages/kernel/test && git commit -m "feat(kernel): render Read images in requests and replays"`.

### Task 7: The `Read` tool

**Files:**
- Modify: `packages/kernel/src/tools/builtins/sandbox/read.ts` (input, description, keyArgs,
  image branch, PDF text, timeout, availability)
- Modify: `packages/kernel/src/tools/registry.ts:136-163`: `BuiltinResult` gains
  `media?: ToolResultMedia[]` (the Task 6 shape)
- Modify: `packages/kernel/src/tools/pipeline.ts:~1518`: write `tool_result.media` for builtin
  sources only, like `loadedTools`
- Modify: `packages/kernel/src/tools/builtins/builtin-tools.ts`: pass the Task 3 / 4 / 5 deps to
  `sandboxReadTool`
- Test: `packages/kernel/test/tools/sandbox/read-images.test.ts`,
  `packages/kernel/test/tools/sandbox/file-tools.test.ts` (existing text reads unchanged)

**Interfaces:**
- Consumes: `sniffImage` (T2); `findConversationFile` (T3); `storeRead` (T4);
  `readImageWithVisionModel` (T5); `tool_result.media` (T6).
- Behaviour, in spec §1.1–1.2 order:
  1. Validate `file_path` xor `file_id`.
  2. A `file_id` read never enters `inToolSandbox`. A `file_path` read with no usable sandbox
     returns the No-device text as a `ToolError`.
  3. For a path: `stat` first. Over 5 MiB with an image extension or unknown type, read only the
     head (or skip the read) and give the Too-large text. A `truncated` read also gives the
     Too-large text.
  4. `sniffImage`. `null` + `%PDF-` → the PDF text; `null` + binary → the existing text; text →
     the existing numbered lines.
  5. Image: decide vision from the latest `model_call` of `ctx.runId` (provider and model), then
     the model list's `capabilities.vision`. Without vision → T5 (errors propagate, nothing is
     stored).
  6. `storeRead` on `ctx.conversationId`, never the root. With `cap`, the result says the image is
     not stored and will not stay in the history, and carries no `media`.
  7. Return the result text plus `media`.
- Availability: listed when a sandbox is usable or the object store is available.
- `timeoutMs` = max(the sandbox timeout, `visionTimeoutMs` + 10 s).
- Description: spec §1.5 verbatim. `keyArgs: ["file_path", "file_id"]`.

- [ ] **Step 1: Tests** in `read-images.test.ts`:
  - **Vision model, PNG on the device:** the text is `Read image a.png (image/png, … , 3×2; file_id <uuid>).`,
    `tool_result.media` has one entry, and the next model request holds the image.
  - **Non-vision model + vision purpose:** the fallback paragraph; the next request has the static
    text.
  - **Non-vision model without the purpose:** the exact error; no `read` row.
  - **`file_id` reads:**
    - an attachment: a copy with a new id;
    - an artifact from `GenerateImage`.
  - **No device** (Review Focus 5): an agent without a sandbox and with an object store; `Read` is
    listed; `file_id` works; `file_path` gives the No-device text.
  - **Fallback step** (Review Focus 3): script the vision model to fail so the step runs on a
    non-vision fallback; the Read in that step uses the vision purpose.
  - **Limits and other files:**
    - a 6 MiB PNG gives the Too-large text, with no row;
    - a PDF gives the PDF text;
    - an SVG is read as text.
  - **Sub-agent:** the copy has the sub-agent's `conversation_id`.
  - **Bad input:** `file_path` and `file_id` together give an error naming both.
- [ ] **Step 2:** Run
  `pnpm exec vitest run packages/kernel/test/tools/sandbox/read-images.test.ts packages/kernel/test/tools/sandbox/file-tools.test.ts`.
  Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the two files, `packages/kernel/test/tools`, and
  `pnpm check:tool-design`. Expected: PASS.
- [ ] **Step 5:**
  `git add packages/kernel/src/tools packages/kernel/test/tools && git commit -m "feat(kernel): Read shows images and reads attachments and artifacts by id"`.

### Task 8: Device file transfer speed

**Files:**
- Modify: `packages/device/src/exec/mac-operation-backend.ts:368-407`,
  `packages/device/src/server-ops.ts:544-551` and the native helper client (as the measurement
  shows)
- Create: `.changeset/<name>.md`, a patch for `@capybara-hq/device`
- Test: `packages/device/test/mac-operation-backend.test.ts`, a new
  `packages/device/test/transfer-timing.test.ts`

**Interfaces:**
- The WebSocket protocol does not change.
- Produces: the measured numbers in the commit message.

- [ ] **Step 1: Timing.** Add debug-level stage timings: digest, serialise, helper spawn, helper
  write and read, total. Write `transfer-timing.test.ts`, a 5 MB `writeFile`, then `readFile` of
  the same path through the backend. It asserts byte-exact equality and logs the stage timings.
  It runs on macOS only (`it.runIf(process.platform === "darwin")`).
- [ ] **Step 2:** Run `pnpm exec vitest run packages/device/test/transfer-timing.test.ts` and
  record the per-stage numbers in the ledger.
- [ ] **Step 3:** Remove the dominant costs:
  - digest the request with the data replaced by its sha256 (hashed once);
  - pass the payload to the helper without a second base64 and JSON round trip (raw bytes after a
    length-prefixed JSON header on stdin, if the helper protocol is local to the package).
- [ ] **Step 4:** Rerun. Expected: byte-exact, and the total for each direction under 2 s on the
  dev Mac. Run `pnpm exec vitest run packages/device`. Expected: PASS.
- [ ] **Step 5:**
  `git add packages/device .changeset && git commit -m "perf(device): transfer file bytes without re-encoding and hashing the payload"`.
  The commit body gives the before and after numbers.

### Task 9: ark 1K sizes (plugins repository)

**Files** (in `/Users/grant/Capybara/plugins`, its own worktree and branch
`feat/ark-1k-sizes`):
- Modify: `plugins/ark/src/tables.ts:75-123` (the `ONE_K` list joined to `WITH_1K`; the comment)
- Test: `plugins/ark/test/tables.test.ts` (or the existing tables test); the live image test

**Interfaces:**
- Produces: 5.5, 5.0 flash, 5.0 pro and 4.0 list
  `1024x1024, 1152x864, 864x1152, 1248x832, 832x1248, 1280x720, 720x1280` plus the 2K set; the
  default stays `2048x2048`.

- [ ] **Step 1:** Unit test: each family's sizes, all at or above 921,600 px for the 1K families;
  5.0 lite and 4.5 unchanged.
- [ ] **Step 2:** Run it. Expected: FAIL. Implement. Run it. Expected: PASS.
- [ ] **Step 3:** Live check on `doubao-seedream-5-5-261028`: one generation per new size. Use the
  repo's live test, with the key loaded inside the command from `~/.capybara-test.env`, never
  printed. Record which sizes passed. Drop any size the vendor refuses and record why.
- [ ] **Step 4:** Update the table comment: the 1K set, and 5.5 returning PNG. Add a changeset for
  the ark plugin.
- [ ] **Step 5:** Commit and open a plugins PR. Release and the core `bootstrap.json` pin happen in
  Task 10.

### Task 10: Docs, changesets, pins

**Files:**
- Modify: `.agents/skills/writing-tools/SKILL.md` (the `Read` and `GenerateImage` sections)
- Modify: `.agents/skills/writing-model-providers/SKILL.md` (the `vision` purpose and capability
  requirement)
- Modify: `.agents/skills/replay-evals/SKILL.md` (`tool_result.media`)
- Create: `.changeset/<name>.md` for `@capybara-hq/kernel` and `@capybara-hq/capybara`
- Modify: `packages/kernel/bootstrap.json`, the ark pin after the plugins release (a separate
  follow-up commit or PR when the release lands)

- [ ] **Step 1:** Update the three skills with the facts above (no new rules).
- [ ] **Step 2:** Add the changeset and run `pnpm verify`. Expected: ok.
- [ ] **Step 3:**
  `git add .agents .changeset && git commit -m "docs: document Read images, the vision purpose and standard image size"`.
- [ ] **Step 4:** After the plugins PR is merged and released, bump the ark pin in
  `bootstrap.json`, then run `pnpm check:bootstrap` and commit.
