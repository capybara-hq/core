# Image Generation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. With more than five tasks, plan the waves first (`wave-planned-subagent-development`).

**Goal:** Make `image_generation` models callable: a builtin `GenerateImage` tool and `ctx.models.generateImage`, both resolved through the kernel purpose `image`, implemented by provider plugins through an optional `generateImage` on `model-provider@2`.

**Architecture:** The SDK gains the provider method, the facts on `ModelInfo`, a pure size picker and a result validator. A new kernel service `ModelImages` (`models/images.ts`) prepares a call (purpose target → bound provider, size, count, params), fires the hooks, calls with a timeout and validates. Two callers use it: the `GenerateImage` builtin (stores artifacts, writes the usage event, optional device copy) and `ctx.models.generateImage` (a `model_usage` row with its outbox delivery). `model-fake` gets a scripted image model so every kernel test runs without a vendor.

**Tech Stack:** TypeScript, NestJS kernel, Kysely/PG, vitest, `@capybara-hq/testing`, Next web app.

**Spec:** [docs/superpowers/specs/2026-11-17-image-generation-design.md](../specs/2026-11-17-image-generation-design.md) (approved 2026-11-18, all designer's calls accepted). Read it before your task; section numbers below refer to it.

## Global Constraints

- Model-facing text (tool description, tool results, errors) is English; UI text goes through i18n (zh and en), zh says 智能体 / 平台, never 企业 or `agent`.
- Tool key `GenerateImage` (no dots); kernel purpose `image`, kind `image_generation`; `ModelCallPurpose` / `UsagePurpose` member `"image"`.
- Aspect ratios exactly `"1:1" | "4:3" | "3:4" | "3:2" | "2:3" | "16:9" | "9:16"`.
- Config (hot): `models.imageTimeoutMs` default `300000` (max `600000`), `models.imageMaxPerCall` default `4` (1..10), `models.imagePromptMaxChars` default `4000` (1..32000).
- Tool `n` is 1..4 in its schema; the effective cap is `min(models.imageMaxPerCall, model maxImages)`. Over the cap is a validation error, never a silent clip.
- `GenerateImage` `defaultPolicy: "allow"`.
- New `ModelErrorKind` `refusal`, not retryable.
- No retries inside providers; no in-process state, no timers outside the per-call timeout (multi-replica discipline).
- Migrations expand-only, `IF NOT EXISTS`; next file number is `0146`.
- SDK change → `pnpm gen:sdk-api` + a `@capybara-hq/plugin-sdk` changeset; config change → `pnpm gen:config-docs`; each published package touched gets a changeset.
- A new unit test file joins `packages/kernel/test/unit-tests.json` in the same task (integration is the default).
- Run tests from the repo root: `pnpm exec vitest run <path>`.

## Review Focus

1. **A provider that breaks the contract** (URLs instead of bytes, `n - 1` images, `image/svg+xml`, bad base64): the call fails as `ModelError("server")`, nothing is stored, no usage event for images never delivered. → Task 4 test `rejects an invalid provider result and stores nothing`.
2. **Partial storage failure** (image 2 of 3 fails to upload, or the event append fails): no `artifact_created` for any of them and the uploaded objects are deleted; the result is a tool error. → Task 6 test `stores all images or none`.
3. **Abort between the provider answer and storage**: nothing stored, no artifact events. → Task 6 test `abort after the provider answered stores nothing`.
4. **Prompt length in CJK text**: `imagePromptMaxChars` counts code points, not UTF-16 units or bytes; a 4 000-character Chinese prompt passes. → Task 4 test `counts prompt length in code points`.
5. **Mapping goes stale between listing and call** (the admin disables the mapped model mid-run): the call fails with the actionable "No image model is configured…" error, not a 500. → Task 6 test `a model disabled after listing fails the call with the unavailable text`.

---

## Waves

| Wave | Tasks | Why together |
|---|---|---|
| 1 | 1 | The SDK contract everything imports |
| 2 | 2, 3 | Disjoint files: `plugins/model-fake` + `packages/testing` vs registry/purposes |
| 3 | 4 | `ModelImages`: needs 2 (fake model) and 3 (resolvable kind) |
| 4 | 5, 6 | Disjoint: ctx/extension path vs the builtin tool |
| 5 | 7, 8 | Web vs docs |

Task 5 (migration, usage reporting, cross-tenant admission) and Task 6 (command review of `file_path`, storage) are reviewed alone on the most capable model.

---

### Task 1: SDK contract

**Files:**
- Modify: `packages/plugin-sdk/src/model.ts` (types, `refusal`, validators, size picker)
- Modify: `packages/plugin-sdk/src/hooks.ts` (purpose unions, image hook payloads)
- Modify: `packages/plugin-sdk/src/ctx.ts` (`ExtensionModels.generateImage`, describe facts)
- Modify: `packages/plugin-sdk/src/permissions.ts` (`permissions.models` kind)
- Test: `packages/plugin-sdk/test/image-generation.test.ts` (new)
- Generated: `packages/plugin-sdk/api/plugin-sdk.api.md`; changeset `.changeset/sdk-image-generation.md`

**Interfaces — Produces** (all exported from `@capybara-hq/plugin-sdk`):
```ts
export const IMAGE_ASPECT_RATIOS: readonly ["1:1","4:3","3:4","3:2","2:3","16:9","9:16"];
export type ImageAspectRatio = (typeof IMAGE_ASPECT_RATIOS)[number];
export interface ImageSize { width: number; height: number }
export interface ModelImageGenerationInfo { sizes: ImageSize[]; defaultSize: ImageSize; maxImages: number; maxReferenceImages: number; outputMediaTypes: ImageMediaType[] }
// ModelInfo.imageGeneration?: ModelImageGenerationInfo
export interface ImageGenerateRequest { model: string; prompt: string; size: ImageSize; n: number; referenceImages?: { mediaType: ImageMediaType; data: string }[]; params: Record<string, ParamValue> }
export interface ImageGenerateResult { images: { mediaType: ImageMediaType; data: string }[]; revisedPrompt?: string; usage: ModelUsage }
// ModelProvider.generateImage?(req: ImageGenerateRequest, opts: { signal: AbortSignal } & ModelCallOptions): Promise<ImageGenerateResult>
// ModelUsage.outputImages?: number
// ModelErrorKind gains "refusal" (in ALL_KINDS, not in RETRYABLE)
export function isValidImageGenerationInfo(x: unknown): x is ModelImageGenerationInfo;
export function validateImageGenerateResult(req: ImageGenerateRequest, info: ModelImageGenerationInfo, res: unknown): string | null;
export function pickImageSize(info: ModelImageGenerationInfo, opts: { size?: ImageSize; aspectRatio?: ImageAspectRatio }): { ok: true; size: ImageSize } | { ok: false; error: string };
// hooks.ts
// ModelCallPurpose gains "image" (so UsagePurpose does too)
export interface ImageRequestHookPayload { purpose: "image"; orgId: string; provider: string; model: string; prompt: string; size: ImageSize; n: number; referenceImages: HookMediaPlaceholder[]; /* conversation call: */ accountId?: string; agentId?: string; agentVersion?: number; conversationId?: string; runId?: string; parent?: HookParentScope; step?: number; callId?: string; /* extension call: */ extension?: string; imagePurpose?: string }
export interface ImageResponseHookPayload { /* same identity fields as ImageRequestHookPayload, without prompt/size/n/referenceImages */ outcome: "ok" | "failed"; images: { mediaType: string; size: number }[]; revisedPrompt?: string; usage: ModelUsage | null; latencyMs: number; errorCode?: string }
// ModelRequestHookPayload = ModelCallRequestHookPayload | EmbeddingRequestHookPayload | ImageRequestHookPayload
// the "model.response" mount's payload = ModelResponseHookPayload | ImageResponseHookPayload
// ctx.ts
export interface ExtensionImageGenerateRequest { orgId: string; purpose: string; prompt: string; size?: ImageSize; aspectRatio?: ImageAspectRatio; n?: number; referenceImages?: { mediaType: ImageMediaType; data: string }[]; signal?: AbortSignal }
export interface ExtensionImageGenerateResult { images: { mediaType: ImageMediaType; data: string }[]; revisedPrompt?: string; model: { provider: string; id: string }; size: ImageSize }
// ExtensionModels.generateImage(req: ExtensionImageGenerateRequest): Promise<ExtensionImageGenerateResult>
// ExtensionModelTarget.imageGeneration?: ModelImageGenerationInfo
// permissions.models[].kind: "chat" | "embedding" | "image_generation"
```

- [ ] **Step 1: Write the failing tests** in `packages/plugin-sdk/test/image-generation.test.ts`:

```ts
const info: ModelImageGenerationInfo = {
  sizes: [{ width: 1024, height: 1024 }, { width: 1536, height: 1024 }, { width: 1024, height: 1536 }, { width: 2048, height: 2048 }],
  defaultSize: { width: 1024, height: 1024 },
  maxImages: 4, maxReferenceImages: 2, outputMediaTypes: ["image/png"],
};
test("pickImageSize: no size or ratio gives the default", () =>
  expect(pickImageSize(info, {})).toEqual({ ok: true, size: { width: 1024, height: 1024 } }));
test("pickImageSize: ratio picks the closest ratio, ties by area closest to the default", () => {
  expect(pickImageSize(info, { aspectRatio: "3:2" })).toEqual({ ok: true, size: { width: 1536, height: 1024 } });
  // 1:1 matches 1024² and 2048²: 1024² is the default's area
  expect(pickImageSize(info, { aspectRatio: "1:1" })).toEqual({ ok: true, size: { width: 1024, height: 1024 } });
  expect(pickImageSize(info, { aspectRatio: "16:9" })).toEqual({ ok: true, size: { width: 1536, height: 1024 } });
});
test("pickImageSize: an undeclared exact size names the declared ones", () => {
  const r = pickImageSize(info, { size: { width: 999, height: 999 } });
  expect(r.ok).toBe(false);
  expect(!r.ok && r.error).toContain("1024x1024, 1536x1024, 1024x1536, 2048x2048");
});
test("validateImageGenerateResult", () => {
  const req = { model: "m", prompt: "p", size: info.defaultSize, n: 2, params: {} };
  const png = { mediaType: "image/png" as const, data: "iVBORw0KGgo=" };
  const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputImages: 2 };
  expect(validateImageGenerateResult(req, info, { images: [png, png], usage })).toBeNull();
  expect(validateImageGenerateResult(req, info, { images: [png], usage })).toMatch(/2 images/);
  expect(validateImageGenerateResult(req, info, { images: [png, { mediaType: "image/jpeg", data: "x" }], usage })).toMatch(/image\/jpeg/);
  expect(validateImageGenerateResult(req, info, { images: [png, { mediaType: "image/png", data: "not base64!" }], usage })).toMatch(/base64/);
});
test("isValidImageGenerationInfo rejects a default size not in sizes, maxImages < 1, unknown media types", ...);
test("refusal is a model error kind and not retryable", () => {
  expect(isRetryableKind("refusal")).toBe(false);
  expect(new ModelError("refusal", "x").kind).toBe("refusal");
});
test("permissions.models accepts image_generation", () =>
  expect(validatePermissions("p", { models: [{ purpose: "p.img", kind: "image_generation", label: { zh: "图", en: "Img" } }] })).toEqual([]));
```

(Use the permissions validator's actual exported name from `permissions.ts`.)

- [ ] **Step 2: Run, expect FAIL** — `pnpm exec vitest run packages/plugin-sdk/test/image-generation.test.ts` (missing exports).
- [ ] **Step 3: Implement** the Produces block. Size picker: closest by `|log(w/h) − log(rw/rh)|`; ties (within 1e-9) by `|w·h − default area|`, then declaration order. The error text is `Size WxH is not offered by this model; use one of <list "WxH" joined by ", ">.` The validator: count equals `req.n` ("expected N images, got M"), each type in `outputMediaTypes`, data matches `/^[A-Za-z0-9+/]+={0,2}$/` and is non-empty. Update the module comments of `ModelKind` (image_generation now callable) and of `ExtensionModels`.
- [ ] **Step 4: Run, expect PASS**; then `pnpm gen:sdk-api` and `pnpm typecheck` (kernel compile errors from the widened unions are expected only where exhaustive switches exist; fix those by treating `"image"` like `"web_fetch"` and `refusal` like `invalid_request` in non-retry paths).
- [ ] **Step 5: Commit** with a changeset (`@capybara-hq/plugin-sdk` patch): `feat(sdk): image generation contract on model-provider@2`.

---

### Task 2: `model-fake` image model and conformance cases

**Files:**
- Modify: `plugins/model-fake/src/index.ts` (config: `imageGeneration` fields per model), `plugins/model-fake/src/script.ts` (`generateImage`)
- Modify: `packages/testing/src/model-conformance.ts` (image cases), `packages/testing/src/media-samples.ts` (a 1×1 PNG constant if none exists)
- Test: `plugins/model-fake/test/model-fake.test.ts`, `plugins/model-fake/test/conformance.test.ts`

**Interfaces:**
- Consumes: Task 1 types.
- Produces: a model-fake model configured with `kind: "image_generation"` lists `imageGeneration` = `{ sizes: [1024², 1536×1024, 1024×1536], defaultSize: 1024², maxImages: 4, maxReferenceImages: 2, outputMediaTypes: ["image/png"] }` and answers `generateImage` with `n` copies of `FAKE_PNG_BASE64` (exported from `packages/testing`), `usage.outputImages = n`, `revisedPrompt` = `"revised: " + prompt`. Prompt scripts (first word of the prompt): `refuse` → `ModelError("refusal", "Scripted refusal")`; `stall` → waits until the signal aborts; `fail <kind>` → that `ModelError`; `short` → returns `n − 1` images; `url` → returns `data: "https://example.invalid/x.png"`.
- Conformance: `ConformanceTarget.expect.imageGeneration?: { model: string }` runs: lists valid `imageGeneration`; `generateImage` with `n: 1` passes `validateImageGenerateResult`; `n: 2` returns two images.

- [ ] **Step 1: Failing tests** in `model-fake.test.ts`: `"generates n scripted images"` (n=3 → 3 × `FAKE_PNG_BASE64`, `outputImages` 3, revisedPrompt), `"refuse script raises refusal"`, `"stall waits for abort"`, `"short returns one image too few"`; `conformance.test.ts` sets `expect.imageGeneration`.
- [ ] **Step 2: Run, expect FAIL** — `pnpm exec vitest run plugins/model-fake/test`.
- [ ] **Step 3: Implement.** The model's config gains optional `maxImages`/`maxReferenceImages` (defaults 4 / 2); an `image_generation` model without them gets the defaults above. Update the module comment listing the scripts.
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** with changesets for `@capybara-hq/testing` and the model-fake package: `feat(model-fake): scripted image generation model`.

---

### Task 3: Registry and the `image` purpose

**Files:**
- Modify: `packages/kernel/src/runtime/providers.ts` (`ResolvedModelInfo`, `ExpectedKind`, listing rule, `lookup`)
- Modify: `packages/kernel/src/models/purposes.ts` (`PurposeKind`, `KERNEL_PURPOSES`, `check`)
- Modify: `packages/kernel/src/extensions/` permission reading if it narrows `permissions.models` kinds (grep `"embedding"` there)
- Test: `packages/kernel/test/models/purposes.test.ts`, the registry test that covers kinds (grep `ProviderRegistry` under `packages/kernel/test/runtime`)

**Interfaces:**
- Produces: `export type PurposeKind = "chat" | "embedding" | "image_generation"` (purposes.ts; used by `PurposeView.kind`, `Declared.kind`, the purpose decl type); `ResolvedModelInfo.kind: "chat" | "embedding" | "image_generation"`; `ExpectedKind = "chat" | "embedding" | "image_generation" | "callable"`; `ProviderRegistry.resolve(orgId, ref, { kind: "image_generation" })` returns `{ provider, info }` with `info.imageGeneration` defined and `provider.generateImage` bound to the org's call options.
- Listing rule (§5.1): an `image_generation` model whose `imageGeneration` is present but invalid (`!isValidImageGenerationInfo`) is dropped with `warnDropped("malformed image generation info")`; one with valid info and a provider with `generateImage` is callable; otherwise listed but list-only (resolve throws the existing unavailable error).
- `KERNEL_PURPOSES` gains `{ purpose: "image", kind: "image_generation", label: { zh: "图片生成", en: "Image generation" } }`; a mapping to a non-image model fails `check` with `this purpose needs an image_generation model, not <kind>`.

- [ ] **Step 1: Failing tests:** `"an image model with info and generateImage resolves as image_generation"`; `"an image model without generateImage stays listed and does not resolve"`; `"malformed imageGeneration is dropped with one warning"`; purposes: `"image purpose maps to an image model"`, `"image purpose refuses a chat model"`, `"unmapped image purpose resolves to model.unconfigured"` (no fallback, unlike `title`).
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run, expect PASS**, plus `pnpm exec vitest run packages/kernel/test/models`.
- [ ] **Step 5: Commit:** `feat(kernel): image_generation models resolve through the image purpose`.

---

### Task 4: `ModelImages` service

**Files:**
- Create: `packages/kernel/src/models/images.ts`
- Modify: `packages/kernel/src/models/models.module.ts` (provide + export `ModelImages`)
- Modify: `packages/kernel/src/config/schema.ts` (three `models.*` keys next to `embedTimeoutMs`); regenerate `docs/config.md` (`pnpm gen:config-docs`)
- Test: `packages/kernel/test/models/images.test.ts` (integration, model-fake)

**Interfaces:**
- Consumes: Task 1 (`pickImageSize`, `validateImageGenerateResult`, payload types), Task 3 (`resolve(..., { kind: "image_generation" })`, `ModelPurposesService.resolve`).
- Produces:
```ts
export interface ImageCallInput { prompt: string; size?: ImageSize; aspectRatio?: ImageAspectRatio; n?: number; referenceImages?: { mediaType: ImageMediaType; data: string }[] }
export interface PreparedImageCall { ref: { provider: string; model: string }; info: ModelImageGenerationInfo; request: ImageGenerateRequest }
export type ImageHookIdentity =
  | { kind: "conversation"; scope: HookScope; step: number; callId: string }
  | { kind: "extension"; extension: string; imagePurpose: string };
export class ImageCallDenied extends Error { constructor(readonly verdict: HookDenial) }
@Injectable() export class ModelImages {
  /** Resolves the org's target for `purpose`; validates prompt, n, references; picks the size; sanitizes the mapping's params. Throws ApiError("validation_failed", <actionable text>) or ApiError("model.unconfigured"). */
  prepare(orgId: string, purpose: string, input: ImageCallInput): Promise<PreparedImageCall>;
  /** Fires model.request (denial → ImageCallDenied, nothing sent), calls generateImage under models.imageTimeoutMs, validates (invalid → ModelError("server")), fires model.response (observe; also on failure, not on user abort). */
  run(orgId: string, prepared: PreparedImageCall, who: ImageHookIdentity, signal: AbortSignal, hooks: HookRunner | undefined): Promise<ImageGenerateResult & { latencyMs: number }>;
}
```
- Validation texts (English): prompt empty → `prompt must not be empty`; too long → `prompt has N characters; the limit is M`; n over cap → `n must be at most C for this model`; references over → `this model takes no reference images` / `this model takes at most K reference images`; reference type/size → `reference image K must be PNG, JPEG, GIF or WebP up to 5 MB`.
- Timeout follows `ModelEmbeddings.callWithTimeout` (copy the pattern: race, abort the signal, drop a late answer, remove the listener); the timeout error text is `Model P/M did not finish generating images within N ms`.

- [ ] **Step 1: Failing tests** (one app per file, model-fake image model mapped to `image`):
  - `prepares the default size and n=1`; `picks the size from aspect_ratio`;
  - `counts prompt length in code points` (4 000 × "图" passes, 4 001 fails);
  - `refuses n above min(imageMaxPerCall, maxImages)`; `refuses references to a model with maxReferenceImages 0`;
  - `fires model.request with placeholders and no bytes`; `a policy denial throws ImageCallDenied and calls no provider` (fake policy hook from `@capybara-hq/testing`);
  - `fires model.response with image sizes and no bytes`;
  - `rejects an invalid provider result and stores nothing` (scripts `short` and `url` → `ModelError` kind `server`);
  - `a refusal surfaces as ModelError refusal`; `times out at models.imageTimeoutMs` (set it low via the test config seam; script `stall`).
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement**, plus config keys with `hot: true` meta and descriptions; `pnpm gen:config-docs`.
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit:** `feat(kernel): ModelImages prepares and runs image generation calls`.

---

### Task 5: `ctx.models.generateImage`, usage rows and reporting

**Files:**
- Modify: `packages/kernel/src/models/images.ts` (add `generateForExtension`, `describeForExtension`, `recordExtensionUsage`)
- Modify: `packages/kernel/src/ctx/create-ctx.ts` (`deps.models` gains `generateImage`; `describe` dispatches on the declared purpose's kind), `packages/kernel/src/extensions/host.ts` (inject `ModelImages`)
- Create: `packages/kernel/src/migrations/0146_model_usage_image_kind.sql`
- Modify: `packages/kernel/src/db/kernel-schema.ts` (columns), `packages/kernel/src/runtime/usage-report.ts` (payload of a `model_usage` row), `packages/kernel/src/runtime/hook-calls.ts` (`imageDeniedAudit`)
- Test: `packages/kernel/test/models/image-extension.test.ts` (new), `packages/kernel/test/models/model-kinds-usage-migration.test.ts` (extend)

**Interfaces:**
- Consumes: Task 4 `ModelImages.prepare/run`, `ImageCallDenied`.
- Produces:
  - `ModelImages.generateForExtension(plugin: string, declared: DeclaredModelPurposes, req: ExtensionImageGenerateRequest, signal: AbortSignal, hooks: HookRunner | undefined): Promise<ExtensionImageGenerateResult>` — admission identical to `ModelEmbeddings.admit` but for kind `image_generation` (`model.purpose_unknown`, `extension.not_enabled`); denial → one `hook.denied` audit row (`imageDeniedAudit`) and `ApiError("model.hook_denied")`; success → `recordExtensionUsage` then return.
  - `ModelImages.describeForExtension(plugin, declared, { orgId, purpose }): Promise<ExtensionModelTarget | null>` (`kind: "image_generation"`, `imageGeneration` cloned; unconfigured → null).
  - Migration:
    ```sql
    ALTER TABLE model_usage ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'embedding';
    ALTER TABLE model_usage ADD COLUMN IF NOT EXISTS output_images integer NOT NULL DEFAULT 0;
    ```
  - `recordExtensionUsage` (`@Transactional()`): inserts `kind: 'image_generation'`, `input_tokens`, `output_images` and owes `usage-model-<id>` through `UsageReportJobs.oweModelUsage` in the same transaction.
  - `usage-report.ts`: a `model_usage` row's payload has `purpose: row.kind === "image_generation" ? "image" : "embedding"` and `usage.outputImages = row.output_images` when > 0.

- [ ] **Step 1: Failing tests:**
  - `refuses an undeclared purpose`, `refuses an org where the extension is off`, `refuses a declared embedding purpose` (kind mismatch);
  - `returns images and writes one model_usage row with kind and output_images, delivery owed` (read the outbox row);
  - `usage.report delivers purpose image with outputImages` (fake usage subscriber extension);
  - `a policy denial writes hook.denied, rejects model.hook_denied, records no usage`;
  - `describe returns image facts; null when unmapped`;
  - migration test: existing rows read `kind = 'embedding'`, `output_images = 0`.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run, expect PASS**, plus `pnpm exec vitest run packages/kernel/test/models packages/kernel/test/ctx`.
- [ ] **Step 5: Commit** with a kernel changeset: `feat(kernel): ctx.models.generateImage with usage rows and reporting`.

---

### Task 6: The `GenerateImage` builtin

**Files:**
- Create: `packages/kernel/src/tools/builtins/image/generate.ts`, `packages/kernel/src/tools/builtins/image/index.ts`
- Create: `packages/kernel/src/tools/builtins/artifacts.ts` (artifact storage shared with `Deliver`)
- Modify: `packages/kernel/src/tools/builtins/sandbox/deliver.ts` (use `storeArtifacts`; behaviour unchanged)
- Modify: `packages/kernel/src/tools/builtin-names.ts` (`BUILTIN.GenerateImage`, in `BUILTIN_TOOL_NAMES`, kind `"tool"`)
- Modify: `packages/kernel/src/tools/builtins/builtin-tools.ts` (register; inject `ModelImages`)
- Modify: `packages/kernel/src/conversations/events.ts` (`usage.purpose` enum + `"image"`; `ModelUsageShape.outputImages: count.optional()`; the doc comment)
- Modify: `packages/kernel/src/sandbox/review/review.service.ts` (`REVIEWED_TOOLS` + `GenerateImage`; it counts as a write; `pathOf` already reads `file_path`, a call without it is `notReviewed`), `packages/kernel/src/tools/pipeline.ts:511` (`reviewKindOf` → `"write"` for `GenerateImage`), the written-paths read at `review.service.ts:411` includes `GenerateImage`
- Test: `packages/kernel/test/tools/generate-image.test.ts` (integration), `packages/kernel/test/tools/builtin-names.test.ts` (web copy), `packages/kernel/test/tools/deliver*.test.ts` (unchanged, must stay green)

**Interfaces:**
- Consumes: Task 4 (`ModelImages.prepare/run`, `ImageCallDenied`), Task 3 (`resolve`).
- Produces:
  - `storeArtifacts(deps: { storage: StorageService; eventLog: EventLog }, ctx: BuiltinCallContext, files: { name: string; contentType: string; data: Uint8Array; sourcePath?: string }[]): Promise<{ artifactId: string; name: string; size: number }[]>` — uploads every object, then appends all `artifact_created` events in **one** `eventLog.append`; any failure deletes every uploaded object (best effort) and rethrows; checks `ctx.signal` before the append; publishes `files` once. Storage unavailability maps to the existing `NO_STORAGE` tool error.
  - `generateImageTool(deps: { images: ModelImages; storage; eventLog; stepLog; config; log; hooks?: HookRunner; sandbox deps for file_path }): BuiltinTool` with `defaultPolicy: "allow"`, `timeoutMs: () => config.models.imageTimeoutMs + 60_000`.
  - Input schema exactly §5.3 (`prompt` required string; `aspect_ratio` enum; `n` integer 1..4; `reference_images` array of strings, maxItems 4; `name` string 1..100, no `/` or `\`; `file_path` string); `additionalProperties: false`. Description: the §5.3 text.
  - `unavailable(scope)`: `null` only when `ModelPurposesService.resolve(orgId, "image")` and `ProviderRegistry.resolve(orgId, target.model, { kind: "image_generation" })` both succeed and storage is available. Texts: `No image model is configured for this organization.` / the `Deliver` no-storage text.
  - Run order: prepare (validation errors → `ToolError` with the Task 4 text) → resolve references (an attachment id via `attachments.openForConversation` on the conversation `fetch-attachment.ts` resolves; an artifact id via an `artifact_created` row of the calling conversation or its root; anything else → `reference_images[K] is not an attachment or generated image of this conversation`) → `run` with `{ kind: "conversation", scope: hookScope(...), step, callId }` → size check per image against `sandbox.deliverMaxBytes` (`ModelError("server")`, nothing stored) → `storeArtifacts` (names `<name ?? "image">-<i>.<ext>`, or without `-<i>` when n = 1) → usage event (`purpose: "image"`, `callId`, `outputImages`; `appendCounted` as `extract.ts` does; idemKey `usage_image:<runId>:<callId>`) → optional device copy → result.
  - Device copy: in `inSandbox`, each path from `checkToolWritable(file_path with -<i> before the extension when n > 1, s)` under `withPathLease`, `p.writeFile`. No device → result line `Not written to the device: this conversation has no device.`
  - Result text exactly the §5.3 shape: `Generated N image(s) with P/M at WxH and delivered them to the user:` then `- <name> (artifact <id>, <type>, <size>)` lines, `Revised prompt: …` when given, `Written to the device: …` when copied. `display`: zh `生成图片 <clip(prompt, 160)>`, en `Generated images: <clip(prompt, 160)>`.
  - Errors: `ImageCallDenied` → `hook_denied` event + audit (copy `extract.ts recordDenial`, purpose `image`, idemKey `hook_denied_image:<runId>:<callId>`) and `ToolError("An org policy blocked this image request; continue without it or ask the user.")`; `refusal` → `The image model refused this prompt: <message>. Rephrase it or ask the user.`; other `ModelError` → `Image generation failed: <message>. Retry once, or continue without the image.`; `model.unconfigured` at run time → `No image model is configured for this organization.`

- [ ] **Step 1: Failing tests** (`generate-image.test.ts`, model-fake image model; fake object store):
  - `hidden while the image purpose is unmapped`, `hidden when the mapped model is disabled in the org`, `hidden without object storage`, `listed once mapped`;
  - `generates two images: two artifact_created events with the callId, one usage event with outputImages 2, the result text`;
  - `n above the cap is a validation error` (n=4 with `imageMaxPerCall` 2);
  - `reference images by attachment id and by an earlier artifact id reach the provider as bytes`; `an unknown reference id names the index`;
  - `stores all images or none` (fake store fails the second put → no artifact events, first object deleted, tool error);
  - `abort after the provider answered stores nothing`;
  - `a policy denial: hook_denied event, no provider call, no usage, the denial text`;
  - `refusal and timeout become their tool errors`;
  - `a model disabled after listing fails the call with the unavailable text`;
  - `file_path writes into the device with -1/-2 suffixes`; `file_path without a device still delivers and says so`;
  - `file_path outside the workspace in auto mode goes through the command review` (review fake decides `ask`; the call waits for approval) and `without file_path the call is not reviewed`;
  - `a recorded GenerateImage call replays from its result without a provider call` (`RecordedToolPipeline`).
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement**; refactor `Deliver` onto `storeArtifacts` and keep its tests green.
- [ ] **Step 4: Run, expect PASS**: the new file, `packages/kernel/test/tools`, `packages/kernel/test/sandbox/review`, and the zero-drift fixtures (`pnpm exec vitest run packages/kernel/test/runtime/reconstruct.test.ts`) before and after.
- [ ] **Step 5: Commit** with a kernel changeset: `feat(kernel): GenerateImage builtin tool`.

---

### Task 7: Web

**Files:**
- Modify: `apps/web/src/lib/agents.ts` (`BUILTIN_TOOLS` + `"GenerateImage"`; `IMAGE_TOOL_PURPOSE = "image"`), `apps/web/src/lib/timeline.ts` (builtin names copy, if it lists them)
- Modify: `apps/web/src/components/agent/ToolsSection.tsx`, `apps/web/src/components/agent-template/EditSections.tsx` (list `GenerateImage` only while the org's `image` purpose has an effective target, or when the agent turned it off — same shape as `WEB_TOOL_POINTS`)
- Modify: `apps/web/src/lib/models.ts` and the purpose editors in `apps/web/src/app/(app)/admin/models/view.tsx`, `apps/web/src/app/(app)/settings/models/view.tsx` (purpose kind `image_generation` offers image models only; the unmapped hint)
- Modify: `apps/web/messages/zh.json`, `apps/web/messages/en.json`
- Test: the existing view tests of those pages (grep `ToolsSection` / `models/view` under `apps/web/test`), `packages/kernel/test/tools/builtin-names.test.ts`

**Interfaces:**
- Consumes: the purposes API (`kind: "image_generation"` in `PurposeView`), the existing tool row (delivered images already render inline through `ImageOutput` / `ImageViewer` in `Thread.tsx`: **no thumbnail work**).
- Produces: hint copy — zh `有可用的图片生成模型，但尚未指定用途。指定后，智能体才能生成图片。`, en `Image generation models are available but no purpose uses one yet. Map the Image generation purpose so agents can generate images.`; tool label zh `生成图片`, en `Generate images`.

- [ ] **Step 1: Failing tests:** `ToolsSection hides GenerateImage while the image purpose is unmapped`, `shows it once mapped`, `shows it when turned off`; models view: `the image purpose offers only image models`, `the hint shows with image models and no mapping`; builtin names copy test.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement** with design components only (`pnpm check:web-ui`); reads via `defineQuery`.
- [ ] **Step 4: Run, expect PASS** plus `pnpm check:i18n`, `pnpm check:web-ui`.
- [ ] **Step 5: Commit** (changeset on `@capybara-hq/capybara` for the image): `feat(web): GenerateImage in the agent form and the image purpose`.

---

### Task 8: Docs and rules

**Files:**
- Modify: `AGENTS.md` (Model providers line: callable kinds are `chat` (`stream`), `embedding` (`embed`) and `image_generation` (`generateImage`); Extensions line: `ctx.models.generateImage` fires `model.request` with `purpose: "image"`)
- Modify: `.agents/skills/writing-model-providers/SKILL.md` (contract, bytes not URLs, `refusal`, conformance `expect.imageGeneration`, model-fake scripts), `.agents/skills/writing-tools/SKILL.md` (`GenerateImage` in the builtin list), `.agents/skills/writing-extensions/SKILL.md` (`ctx.models.generateImage`)
- Modify: `docs/superpowers/specs/2026-11-17-image-generation-design.md` (an `## As built` section: file names, any deviation)
- Test: `pnpm check:agent-docs`, `pnpm check` (whole custom check suite)

- [ ] **Step 1:** Edit the files above; `pnpm gen:agent-docs` if the skills index is generated.
- [ ] **Step 2: Run** `pnpm check` and `pnpm verify`; expect `ok: true`.
- [ ] **Step 3: Commit:** `docs: image generation rules, skills and as-built notes`.

---

## After the core PR

Plugins (`capybara-hq/plugins`, after the core release; outside this plan's tasks, each its own PR): `ark` (Seedream), `bailian` (Wanxiang / Qwen-Image, task API polled inside the call), `openai` (`gpt-image-*`), each with `expect.imageGeneration` in its conformance test and one live API case. Bumping the SDK there needs the pnpm override (one plugin-sdk instance).
