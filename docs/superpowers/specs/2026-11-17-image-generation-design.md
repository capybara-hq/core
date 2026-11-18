# Image generation: the `image` purpose, `GenerateImage` and `generateImage` on `model-provider@2`

- Date: 2026-11-17.
- Status: approved by the maintainer, 2026-11-18. Every call marked **(designer's call)** is
  accepted as written, including the four open questions of the first draft (§14).
- Decisions taken with the maintainer, 2026-11-17:
  - The kernel owns the contract, the governance and the tool shell; model provider plugins own the
    implementations (the `WebSearch` / `WebFetch` pattern: kernel builtin tool, plugin provider,
    hidden while nothing provides it).
  - Image models come from the model providers that already list them (`bailian`, `ark`,
    `openai`), so the implementation is an optional method on `model-provider@2`, not a new
    extension point.
  - Which model generates is chosen by a kernel **purpose** (`image`, kind `image_generation`):
    deployment default plus org override, like every purpose. Several providers listing image
    models is the normal case; the mapping picks one.
  - **Unmapped = the tool is hidden.** The kernel never picks an image model by itself: models are
    enabled by default and one provider alone lists several image models, so any automatic choice
    would be arbitrary in cost and quality.
  - The model never chooses the image model: the tool has no `model` argument.
  - A per-agent image model is a later addition, not part of this design.
- Relates to: the model platform design `2026-11-06-model-platform-providers-design.md` §5.1 (model
  kinds; this design makes `image_generation` callable) and §5.3–§5.4 (purposes, `ctx.models`);
  the web tools design `2026-11-04-web-tools-design.md` (the builtin-tool-over-provider pattern,
  §3.4 availability, §5 the kernel-side model call made by a tool, §8 replay); the attachments
  design `2026-11-17-attachments-on-demand-design.md` (references, the in-page image viewer);
  skills [writing-model-providers](../../../.agents/skills/writing-model-providers/SKILL.md),
  [writing-tools](../../../.agents/skills/writing-tools/SKILL.md),
  [replay-evals](../../../.agents/skills/replay-evals/SKILL.md).

## 1. Why

The model platform already lists image models: `bailian` maps its `IG` capability and `ark` its
Seedream models to `kind: "image_generation"`, and the models page shows them under "图片生成".
Nothing can call them: §5.1 of the model platform design made every kind other than `chat` and
`embedding` list-only, and `model-provider@2` has no method to call.

A deployment that wants images today has one route: an extension that calls a vendor API itself, or
a skill that has the agent call one from the device. Both bypass what the kernel enforces for every
model call: the platform and org model switches, `model.request` policy hooks (fail closed),
`usage.report`, and the org's effective config with its secrets. Each such extension also keeps its
own copy of a vendor key that the model provider plugin already holds.

## 2. Goals

1. An agent can generate images in a conversation with a builtin tool, `GenerateImage`, and the
   user sees and downloads them in the conversation.
2. The images come from the model the org's `image` purpose maps to, called through the provider
   plugin that lists it, under the same governance as a chat call: model switches, policy hooks,
   usage, effective config.
3. An extension can generate images through `ctx.models.generateImage`, by purpose, exactly as it
   embeds through `ctx.models.embed`.
4. The tool is absent wherever no image model is mapped: no tool the model cannot use.
5. A pattern the next kinds (video, speech) can follow: one optional provider method, one
   `ctx.models` entry, one builtin tool, one kernel purpose per kind. Only images are built here.

## 3. Non-goals, anti-goals

- **Not** video, speech-to-text, text-to-speech or rerank. They stay list-only (§11 sketches how
  they would follow).
- **Not** a per-agent image model, a per-call model choice or a model argument on the tool.
- **Not** returning the generated image bytes to the model. The tool result is text (§5.3), as
  every tool result is today (`renderResult` turns image content into a placeholder). Letting a
  vision model look at its own output is a later, separate change.
- **Not** masks, inpainting, outpainting, upscaling or variations as separate operations. Reference
  images (image-to-image) are in scope because the providers we target take them on the same
  call (§5.2).
- **Not** a budget or quota system. Cost control is the purpose mapping (opt-in), the tool policy,
  policy hooks and `usage.report` consumers, all of which exist.
- **Anti-goal:** the kernel choosing an image model when the purpose is unmapped.
- **Anti-goal:** an extension or skill holding its own vendor key to reach an image model a model
  provider plugin already serves.

## 4. Terms

- **Image model**: a model a provider lists with `kind: "image_generation"`.
- **Callable image model**: an image model whose provider implements `generateImage` and which
  carries `ModelInfo.imageGeneration` (§5.1). An image model without both stays list-only.
- **The `image` purpose**: the kernel purpose `GenerateImage` resolves (§5.4).
- **Generated image**: one image a call returned; it becomes an artifact of the conversation.

## 5. Design

### 5.1 Provider contract (SDK, additive to `model-provider@2`)

`ModelInfo` gains, for `kind: "image_generation"`:

```ts
/** Image generation facts of a model whose `kind` is `image_generation`. */
export interface ModelImageGenerationInfo {
  /** The exact output sizes the model accepts, in pixels. At least one. */
  sizes: { width: number; height: number }[];
  /** One of `sizes`. */
  defaultSize: { width: number; height: number };
  /** Most images one call may return (1 when the model returns one per call). */
  maxImages: number;
  /** Most reference images one call may carry; 0 = text-to-image only. */
  maxReferenceImages: number;
  /** What the model returns; a subset of IMAGE_MEDIA_TYPES. */
  outputMediaTypes: ImageMediaType[];
}

export interface ModelInfo {
  // ...
  /** Set when `kind` is `image_generation`. */
  imageGeneration?: ModelImageGenerationInfo;
}
```

`ModelProvider` gains one optional method:

```ts
export interface ImageGenerateRequest {
  model: string;
  prompt: string;
  /** One of the model's `imageGeneration.sizes`. */
  size: { width: number; height: number };
  /** 1 ≤ n ≤ maxImages. */
  n: number;
  /** At most maxReferenceImages; bytes, never a ref (the kernel resolves refs first). */
  referenceImages?: { mediaType: ImageMediaType; data: string }[];
  /** Validated against the model's `parameters` (sanitizeParams), as for a chat request. */
  params: Record<string, ParamValue>;
}

export interface ImageGenerateResult {
  /** Exactly `n` images, base64, each of a type in `outputMediaTypes`. */
  images: { mediaType: ImageMediaType; data: string }[];
  /** The prompt the vendor actually used, when it rewrites prompts (display and model text). */
  revisedPrompt?: string;
  usage: ModelUsage;
}

export interface ModelProvider {
  // ...
  /** Present only on a provider that lists callable `image_generation` models. */
  generateImage?(
    req: ImageGenerateRequest,
    opts: { signal: AbortSignal } & ModelCallOptions,
  ): Promise<ImageGenerateResult>;
}
```

- **Bytes, not URLs.** Vendors that answer with a temporary URL (Bailian, Ark by default) are
  downloaded by the plugin before it returns. A URL in the result would make the kernel fetch a
  vendor-chosen address, and the bytes would vanish when the URL expires. **(designer's call)**
- **Asynchronous vendor APIs** (Bailian's task API: submit, then poll) are handled inside the one
  `generateImage` call; the plugin polls until done or until `signal` aborts. The kernel sees one
  call with one timeout (§6).
- **No retries in the extension**, as for `stream` and `embed`; `ModelError` kinds as today. A
  vendor content-moderation refusal is `ModelError("refusal")` with the vendor's reason in the
  message: `refusal` is a **new** `ModelErrorKind`, not retryable (`isRetryableKind` false), so the
  degradation ladder does not try another attempt with the same prompt **(designer's call**: the
  alternative is `invalid_request`, which would hide from the model and the user that the prompt,
  not the call, was the problem).
- `ModelUsage` gains `outputImages?: number`, the images billed. Token fields stay required and are
  0 when a vendor bills per image only. **(designer's call)**
- `validateImageGenerateResult(req, info, res)` (SDK, pure, like `validateEmbedResult`): count is
  `n`, every media type is in `outputMediaTypes`, data is valid base64. A failure is
  `ModelError("server")` in the kernel.
- The provider registry treats an `image_generation` model as callable only when the provider has
  `generateImage` **and** the model carries a valid `imageGeneration`; otherwise it stays list-only
  as today. `ProviderRegistry.resolve(..., { kind: "image_generation" })` returns it.

### 5.2 Request building (kernel)

Shared by the tool and `ctx.models.generateImage`:

- **Size**: callers pass either an exact `size` (only `ctx.models`) or an `aspectRatio`
  (`"1:1" | "4:3" | "3:4" | "3:2" | "2:3" | "16:9" | "9:16"`). From an aspect ratio the kernel picks
  the declared size whose ratio is closest; ties go to the size whose area is closest to
  `defaultSize`. Neither given → `defaultSize`. An exact size the model does not declare is a
  validation error naming the declared sizes. The rule is a pure function, so a replayed call log
  shows the same size.
- **Count**: `n` defaults to 1 and is capped by both `imageGeneration.maxImages` and the kernel's
  `models.imageMaxPerCall` (default 4). Over the cap is a validation error, not a silent clip.
- **Reference images**: given as conversation attachment ids or artifact ids (§5.3), read from the
  object store by the kernel, checked against `IMAGE_MEDIA_TYPES` and `MEDIA_LIMITS.imageBytes`,
  and passed as bytes. More than `maxReferenceImages` (or any when it is 0) is a validation error
  saying the model takes none or how many.
- **Params**: the purpose mapping's params (purposes already store params validated against the
  target model's declarations), sanitized with `sanitizeParams`. Quality, style, seed, watermark
  and the like are therefore admin settings on the mapping, not tool arguments.
- **Prompt**: non-empty, at most `models.imagePromptMaxChars` (default 4 000) characters.

### 5.3 The tool: `GenerateImage`

A kernel builtin in `tools/builtins/image/`, beside the web tools.

```
name: GenerateImage
description (English, final wording in the plan):
  Generate images from a text prompt with this organization's image model, and deliver them to the
  user in the conversation. Write a specific prompt: subject, composition, style, lighting, any
  text that must appear. Optionally pass reference images (attachment or earlier generated image
  ids) to guide the result. Each call costs money: generate only what the user asked for.
input:
  prompt          string, required
  aspect_ratio    enum of §5.2, optional
  n               integer 1..4, optional, default 1
  reference_images  array of attachment or artifact ids, optional
  name            string, optional: base file name shown to the user ("poster" → poster-1.png)
  file_path       string, optional: also write the images into the device at this path
```

- **Availability** (`unavailable`): the tool is listed only when the org's `image` purpose resolves
  to a callable image model the org can use (mapped, enabled on the platform and in the org, its
  provider loaded with a valid effective config for the org). Otherwise it is hidden, with the
  reason recorded as for the web tools: "No image model is configured for this organization."
  Availability is read per listing, from PG, like every `unavailable`.
- **Policy**: `defaultPolicy: "allow"` **(designer's call)**. The call goes to a model the admins
  mapped on purpose, which is the opt-in; `ask` would make every image a click. Orgs and agents
  that want a click set the tool to `ask` as for any builtin, and an agent can switch it off like
  other builtins (`builtinDisabled`).
- **Output**: each generated image is stored in the object store under the kernel prefix
  (`artifacts/<conversationId>/<artifactId>`) and recorded with `artifact_created`, exactly as
  `Deliver` stores a file. The user sees the images inline under the tool row (thumbnails, the
  in-page viewer of the attachments design) and in the conversation's outputs. No object store →
  the tool is unavailable ("File storage is not configured…", as `Deliver` says).
- **`file_path`**: when given and the conversation has a device, the images are also written there
  through the same path checks as `Write` (inside the workspace without review; elsewhere through
  the command review, as every write). Several images get `-1`, `-2`… suffixes. No device → the
  images are still delivered and the result says the copy was skipped. **(designer's call:** this
  lets an agent put a generated image into a document it is building without a second tool; the
  alternative is extending `FetchAttachment` to artifacts.)
- **What the model sees** (the tool result, text only):

  ```
  Generated 2 images with ark/doubao-seedream-4-0 at 2048x2048 and delivered them to the user:
  - poster-1.png (artifact a3f…, image/png, 3.1 MB)
  - poster-2.png (artifact 7c2…, image/png, 2.9 MB)
  Revised prompt: …
  Written to the device: /workspace/out/poster-1.png, /workspace/out/poster-2.png
  ```

  The artifact ids are what `reference_images` accepts on a later call, so "make the second one
  bluer" works without the user re-uploading.
- **Errors** (English, actionable): validation errors name the bad argument and the allowed values;
  a policy denial is "An org policy blocked this image request; continue without it or ask the
  user."; a refusal is "The image model refused this prompt: <vendor reason>. Rephrase it or ask
  the user."; a timeout or provider failure is "Image generation failed: <reason>. Retry once, or
  continue without the image." Failures follow the kernel's model degradation ladder; no
  automatic retry.
- **Abort**: aborting the run aborts the provider call through its signal. Images a late answer
  carries are dropped; nothing is stored after abort.
- **Sub-agents**: the tool is available to sub-agents on the same terms; their usage carries
  `parent` as for their other calls.

### 5.4 The `image` purpose

- `KERNEL_PURPOSES` gains `{ purpose: "image", kind: "image_generation", label: { zh: "图片生成",
  en: "Image generation" } }`. The purpose kind union in `models/purposes.ts`, the purpose UI and
  `permissions.models` accept `image_generation`.
- Deployment default (super admin) and org override (org admin), effective target org first, as for
  every purpose; a target must be a callable image model enabled where it applies.
- **Unmapped has no fallback**: the tool is hidden (§5.3), `ctx.models.generateImage` rejects with
  `model.unconfigured`. This differs from `title` and `web_fetch`, whose fallback is the
  conversation's chat model; a chat model cannot generate images.
- The models admin page shows, for an org with callable image models but no `image` mapping, a hint
  linking to the purpose ("有可用的图片生成模型，但尚未指定用途"); the hint goes through i18n.

### 5.5 `ctx.models.generateImage` (extensions)

```ts
export interface ExtensionImageGenerateRequest {
  orgId: string;
  /** A purpose this extension declared in permissions.models with kind "image_generation". */
  purpose: string;
  prompt: string;
  size?: { width: number; height: number };
  aspectRatio?: AspectRatio;
  n?: number;
  /** Bytes the extension already holds. */
  referenceImages?: { mediaType: ImageMediaType; data: string }[];
  signal?: AbortSignal;
}

export interface ExtensionImageGenerateResult {
  images: { mediaType: ImageMediaType; data: string }[];
  revisedPrompt?: string;
  model: { provider: string; id: string };
  size: { width: number; height: number };
}
```

- Same admission as `embed`: a declared purpose of the right kind (`model.purpose_unknown`), the
  extension enabled in the org (`extension.not_enabled`), the effective target resolvable
  (`model.unconfigured`).
- The extension gets bytes and stores them itself (its own object-store prefix through
  `ctx.storage`); the kernel stores nothing for an extension call.
- One `model_usage` row per call, its `usage.report` owed in the same transaction (outbox), as for
  embeddings. The row records `output_images` (§9).
- `ctx.models.describe` reports an image purpose's target with its `imageGeneration` facts.

### 5.6 Hooks

- `ModelCallPurpose` and `UsagePurpose` gain `"image"`.
- `model.request` fires once per call before anything is sent, with a new payload variant
  `ImageRequestHookPayload`: `purpose: "image"`, `orgId`, `provider`, `model`, `prompt`, `size`,
  `n`, the reference images as `HookMediaPlaceholder`s (no bytes, no ids), and either the
  conversation fields (a tool call: `accountId`, `agentId`, `conversationId`, `runId`, `callId`,
  `parent`) or `extension` and `imagePurpose` (a `ctx.models` call), as embeddings do.
- Policy hooks fail closed, as for every model call: a denial writes `hook.denied` and becomes the
  tool error of §5.3 or `ApiError("model.hook_denied")` for an extension. Nothing is sent and no
  usage is recorded.
- `model.response` (observe) fires after a successful call with the image count, media types, byte
  sizes, `revisedPrompt` and usage; never bytes. **(designer's call:** embeddings fire no
  `model.response`; images do because a DLP or audit plugin wants to know what came back, and the
  revised prompt is new text.)

## 6. Limits and configuration

| Key | Default | Hot | Meaning |
|---|---|---|---|
| `models.imageTimeoutMs` | 300 000 | yes | One `generateImage` call, polling included; at the limit the signal aborts and the call fails with `ModelError("timeout")` |
| `models.imageMaxPerCall` | 4 | yes | Cap on `n`, below each model's own `maxImages` |
| `models.imagePromptMaxChars` | 4 000 | yes | Cap on the prompt |

- A generated image larger than `sandbox.deliverMaxBytes` (the artifact cap) fails the call with a
  `ModelError("server")` naming the size; no partial delivery. **(designer's call**: per-image
  partial delivery would bill images the user never sees as failures.)
- `MEDIA_LIMITS.imageBytes` (5 MB) applies to reference images, which go to a model, not to
  generated images.
- Documented in `docs/config.md` through the `adding-config` flow.

## 7. Event log and replay

- `GenerateImage` is an ordinary tool call: `tool_call` / `tool_result`, plus one `artifact_created`
  per image. The model sees only the recorded result text. Full-run replay uses the recorded result
  (`RecordedToolPipeline`) and never calls an image model; step replay does not either.
- The image call itself is not model-visible to the main model. Its `usage` event (purpose `image`,
  the `callId`) is written like `web_fetch`'s and is not model-visible either. No new model-visible
  input, so **no `DriftReason`**; the zero-drift fixtures are run once before and after anyway,
  because the builtin tool list a request carries grows by one spec wherever the tool is available.
- The tool spec is fixed text stored in `tool_specs` by `specHash`, like every builtin.
- Hooks fire live only; replays fire none (existing rule).

## 8. Multi-replica

- No process state: availability, the purpose target and the model's facts are read from PG and the
  provider registry per call; the call is one request on one replica, bounded by
  `models.imageTimeoutMs`.
- The object-store writes and the `artifact_created` events are written in the tool call as
  `Deliver` writes them; a replica that dies mid-call leaves at most unreferenced objects under the
  conversation's prefix, which the existing conversation and org purge removes.
- The `model_usage` row of an extension call and its `usage.report` delivery are one transaction
  (outbox), as for embeddings.
- No timers, no queues added. A vendor's asynchronous task is polled inside the call (§5.1), not
  resumed across processes: a call lost with its replica is a failed tool call, which the model sees
  as an error on the next step. **(designer's call:** durable task resumption would need an intent
  row and a queue for a call that normally takes 5–60 s.)

## 9. Data and migration

- One expand-only kernel migration adding two columns to `model_usage`: `kind text NOT NULL DEFAULT
  'embedding'` (so a row's `usage.report` purpose is `image` or `embedding`; the existing `purpose`
  column holds the extension's own purpose name) and `output_images integer NOT NULL DEFAULT 0`.
- Conversation usage events carry `outputImages` in their usage object; no schema change (the event
  payload is JSON and validated by its zod schema, which gains the optional field).
- No change to existing rows; nothing to backfill.

## 10. Plugins (`capybara-hq/plugins`)

Each in its own PR after the core release that carries the SDK change:

- **`ark`**: Seedream models gain `imageGeneration` (sizes from Ark's documented list, reference
  images up to Ark's limit) and `generateImage` (`response_format: b64_json` where offered,
  otherwise download).
- **`bailian`**: `IG` models (Wanxiang, Qwen-Image) gain `imageGeneration` and `generateImage`
  (synchronous multimodal endpoint where the model has one, task API with polling otherwise).
- **`openai`**: `gpt-image-*` models listed as `image_generation` with `generateImage` (base64
  responses).
- Each plugin's live API tests (`CAPYBARA_TEST_*`) gain one generation case; the conformance suite
  in `@capybara-hq/testing` gains image cases a provider must pass when it lists callable image
  models.
- In core, **`model-fake`** gains a scripted image model that returns a fixed small PNG (and can
  script a refusal, a timeout and a wrong count), so kernel tests need no vendor.

## 11. Later kinds (not built here)

Video and speech follow the same shape: `ModelInfo.<kind>` facts, an optional provider method
(`generateVideo`, `transcribe`, `synthesizeSpeech`), a `ctx.models` entry, a kernel purpose with no
fallback, and a builtin tool hidden while the purpose is unmapped. Video generation runs for
minutes, so it will need the durable task resumption §8 declines for images.

## 12. Tests

- **SDK unit**: `validateImageGenerateResult`; the size picker (ratio, tie by area, default,
  undeclared exact size); `permissions.models` accepts `image_generation`.
- **Kernel integration** (model-fake): the tool is hidden with the purpose unmapped, mapped to a
  disabled model, or with no object store, and listed once mapped; a call stores N artifacts,
  writes `artifact_created` and a `usage` event with `outputImages`, and returns the text of §5.3;
  reference images by attachment and by artifact id; over-cap `n` and too many references are
  validation errors; a policy hook denial sends nothing and records nothing; a refusal and a
  timeout become the tool errors; abort stores nothing; `file_path` with and without a device.
- **Kernel integration, `ctx.models.generateImage`**: admission errors, one `model_usage` row with
  `output_images`, the `usage.report` delivery owed.
- **Replay**: a recorded `GenerateImage` call replays from its result without a provider call; the
  zero-drift fixtures pass.
- **Web**: the tool row shows the thumbnails; the models page shows the unmapped hint; i18n keys in
  zh and en.

## 13. Delivery

1. Core PR: SDK (types, `validateImageGenerateResult`, hook payload, unions, API report and
   changeset), kernel (registry, purpose, request building, tool, `ctx.models` entry, hooks, usage,
   migration, config), `model-fake`, web (thumbnails, purpose UI, hint), docs.
2. Core release.
3. Plugins PRs (`ark` first: the deployment's chat models already run there), then their releases
   and the marketplace update.

## 14. Decisions on the first draft's open questions (maintainer, 2026-11-18)

1. `GenerateImage` defaults to `allow` (§5.3).
2. The tool takes `file_path`; `FetchAttachment` is not extended to artifacts (§5.3).
3. Image calls fire `model.response` with metadata only (§5.6).
4. A vendor moderation refusal is the new `ModelErrorKind` `refusal`, not retryable (§5.1).

Still later, outside this design: showing a vision model the images it generated (§3).

## AGENTS.md rules touched

- **Model providers:** `generateImage` is an optional `model-provider@2` method with no retries
  inside the extension; media limits on reference images stay the kernel's; `image_generation`
  becomes the third callable kind, and the kernel still refuses a disabled model; calls made for an
  org carry `{ orgId, config }`. The AGENTS.md line "only `chat` (`stream`) and `embedding`
  (`embed`) are callable" is updated in the same change.
- **Extensions:** every image call fires `model.request` (purpose `image`) and policy hooks fail
  closed; `ctx.models.generateImage` needs `permissions.models` with kind `image_generation` and an
  org where the extension is enabled, recorded in `model_usage`, delivered by `usage.report`.
- **Tools, sub-agents, web tools, skills:** `GenerateImage` has an English description and
  actionable English errors; its key has no dots.
- **Runtime and replay:** no new model-visible input beyond an ordinary tool result; the image
  call's usage event is not model-visible; no `DriftReason`; zero-drift fixtures run before and
  after.
- **Multi-replica discipline:** no in-process state or timers; usage rows and their delivery in one
  transaction via the outbox; vendor polling stays inside one bounded call (§8).
- **Migrations:** one expand-only `ADD COLUMN IF NOT EXISTS` in the kernel schema.
- **Config:** three hot `models.*` keys with `CAPYBARA_` env names, documented in
  `docs/config.md`.
- **Object storage:** generated images use the kernel prefix the kernel adds, as `Deliver` does.
- **Sandboxes:** `file_path` writes through the same path checks and command review as `Write`.
- **Web UI:** thumbnails and the hint are design components; copy through i18n (zh and en, zh says
  智能体 / 平台).
- **SDK public API:** new types, the optional method, union members and the validator regenerate the
  API report (`pnpm gen:sdk-api`) with a `@capybara-hq/plugin-sdk` changeset.
