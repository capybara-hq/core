# Model platform providers: DeepSeek, Alibaba Bailian, Volcengine Ark

Status: draft, 2026-11-06, on hold: waits for the platform / org layering design (`2026-11-06-platform-org-layering-notes.md`), which waits for the plugin-component-management branch. Sections 5.3 and 5.5 change under that design (org-level keys and config copies).

Covers a contract change in core (model kinds, embeddings, org model
enablement, `ctx.models`) and three new plugins in `capybara-hq/plugins`. The contract part lands
in core first (AGENTS.md: a contract change needs a PR in core first).

## 1. Intent

Enterprises in China buy model access from a few platforms rather than from each model vendor:
Alibaba Cloud Bailian (Model Studio, DashScope) and Volcengine Ark host hundreds of models from many
vendors (Qwen, DeepSeek, Kimi, GLM, Doubao, ...) and of many kinds (chat, vision, embeddings,
speech, image and video generation). Once a platform account is opened, every model on it can be
called with one key. DeepSeek is a single vendor but is used directly by many deployments.

Today the only way to reach them is `openai-compatible` with its `deepseek` / `qwen` / `ark`
dialects, where the admin types every model id, context window and output limit by hand. That does
not scale to a platform with hundreds of models, and it only reaches chat models.

What the user wants:

1. Three native provider plugins: **DeepSeek**, **Alibaba Bailian**, **Volcengine Ark**. "Native"
   means each plugin speaks its platform's own API and handles its specifics (reasoning output,
   cache accounting, model listing); it is not a configuration of `openai-compatible`.
2. The super admin installs and enables a plugin and enters credentials (an API key; see §5.5
   for OAuth). No model is typed by hand: **the plugin lists the platform's models** through the
   platform's API.
3. The model list is **grouped by kind**: chat (LLM), embedding, speech, image / video.
4. Because a platform lists so many models, **an org admin chooses which models the org enables**.
   Agents, purposes and extensions of the org can only use enabled models.
5. Embedding models must be **callable**, not only listed: a coming memory plugin (its own design,
   later) will use a platform's embedding models through the kernel. This is why a model provider
   offers more than one kind of model.

Prices are not part of this work. The kernel already keeps a price table entered by the super
admin (`packages/kernel/src/models/prices.ts`); a plugin declares no price. Bailian's list API
returns prices, but nothing here reads them (a later change may prefill the price table from it).

## 2. Goals, non-goals, anti-goals

Goals

- `model-provider@2` models carry a **kind**; the kernel, the API and the web group and filter by
  it. The kind set is open for later kinds.
- `model-provider@2` gains an optional **`embed()`**; the kernel calls it for embedding models.
- **Org model enablement**: a kernel feature for every provider (also `anthropic`, `openai`,
  `openai-compatible`, `model-fake`), not only the platform plugins.
- **`ctx.models`** (reserved today, not callable) opens for embeddings: an extension embeds text
  through a purpose it declares in `permissions.models`.
- Three plugins in `capybara-hq/plugins`: `deepseek`, `bailian`, `ark` (names: §6), each listing its
  models from the platform.

Non-goals

- Calling speech, image or video models. They are listed, grouped and can be enabled, but no
  contract method calls them yet; each gets its own design when a consumer needs it.
- Prices, balances, quotas from the platforms.
- Vector storage. The memory plugin decides where vectors live in its own design.
- OAuth: a plugin's own concern, nothing in the kernel (§5.5).
- Changing `openai-compatible`. Its dialects stay for self-hosted or other compatible services.

Anti-goals (would make this a failure even if it works)

- An org admin facing a flat list of hundreds of models with no grouping or search.
- A provider plugin that knows about purposes or about the memory plugin. Providers only offer
  models; consumers declare what they need.
- An extension reaching a platform key, or calling a model the org did not enable.
- Breaking existing deployments: an org that never opens the new settings keeps today's behavior.

## 3. Current state (what the builder starts from)

- SDK `packages/plugin-sdk/src/model.ts`: `ModelProvider { listModels(); stream() }`, `ModelInfo
  { id, displayName, contextWindow, maxOutputTokens, capabilities, streamIdleTimeoutMs?,
  parameters }`. Every model is a chat model.
- Kernel `packages/kernel/src/runtime/providers.ts` `ProviderRegistry`: model providers are
  deployment-wide (the extension point is not `orgScoped`); each provider's list is cached in Redis
  600 s, `listModels()` has a 10 s limit, failures mark the provider `error` for 15 s in list views.
- `GET /api/v1/orgs/:orgId/models` (`agents/models.controller.ts`) returns every provider's every
  model; there is no per-org filter. `GET /api/v1/admin/models` is the deployment view with prices.
- Purposes (`packages/kernel/src/models/purposes.ts`): kernel purposes plus purposes extensions
  declare in `permissions.models` (`{ purpose: "<plugin>.<name>", kind: "chat" | "embedding",
  label }`, validated in `plugin-sdk/src/permissions.ts`), a deployment default and an org
  override, edited at `/admin/...` and `/settings/models`. The file states "no model allowlist" and
  "`ctx.models` stays reserved, extensions cannot call it yet". The `embedding` kind exists in the
  declaration but nothing can resolve or call it.
- `openai-compatible` (`capybara-hq/plugins/plugins/openai-compatible`) has `deepseek`, `qwen`,
  `ark` dialects with hand-typed models.

## 4. Platform facts (checked 2026-11-06; the builder re-checks before coding)

| | Model list | What it returns | Chat API | Embeddings |
|---|---|---|---|---|
| DeepSeek | `GET https://api.deepseek.com/models`, Bearer API key | `id`, `owned_by`, optional `name`, `context_window`, `max_output_tokens`, `input_modalities` / `output_modalities`, `effort` (`supported_levels`, `default_level`), `api_capabilities` | `POST /chat/completions` (DeepSeek's own API is Chat Completions shaped; reasoning in `reasoning_content`, cache counts `prompt_cache_hit_tokens` / `..._miss_tokens`) | none |
| Bailian | `GET https://{WorkspaceId}.<region>.maas.aliyuncs.com/api/v1/models` (Beijing, Singapore, Hong Kong, Tokyo, Frankfurt; US Virginia `https://dashscope-us.aliyuncs.com/api/v1/models` without workspace), Bearer API key, paged (`page_no`, `page_size`, `output.total`) | `model`, `name`, `description`, `provider` (the model's vendor), `capabilities` (`TG` text generation, `VU` vision understanding, `IG` image gen, `VG` video gen, `ASR`, `TTS`, `TR` text embedding, `Reasoning`), `features` (`function-calling`, `structured-outputs`, `cache`, ...), `inference_metadata.request_modality` / `response_modality`, `model_info.context_window` / `max_input_tokens` / `max_output_tokens` / `max_reasoning_tokens`, `prices[]`, `inference_offline_info.offline_time` | DashScope native `/api/v1/services/aigc/text-generation/generation` and `.../multimodal-generation/generation` (SSE) | DashScope native `/api/v1/services/embeddings/text-embedding/text-embedding` |
| Ark | Management OpenAPI `ListFoundationModels` (service `ark`, version `2024-01-01`), which by Volcengine OpenAPI convention is signed with **AK/SK (V4 HMAC)**, not the inference API key (not yet confirmed on an official page). No documented list endpoint on the inference plane (`/api/v3`) was found | foundation model names, versions, tags (exact fields to read from the API Explorer) | `POST https://ark.<region>.volces.com/api/v3/chat/completions` (Ark's own Chat Completions shaped API; `model` is a model id or an endpoint id `ep-...`) | `/api/v3/embeddings`, `/api/v3/embeddings/multimodal` |

Sources: [DeepSeek list models](https://api-docs.deepseek.com/api/list-models),
[Bailian list models](https://help.aliyun.com/zh/model-studio/list-models),
[Ark ListFoundationModels](https://api.volcengine.com/api-docs/view?action=ListFoundationModels&serviceCode=ark&version=2024-01-01),
[Ark model list](https://ark.volcengine.com/region:cn-beijing/docs/model-list).

## 5. Core changes

### 5.1 Model kinds in `ModelInfo` (SDK, additive to `@2`)

- `ModelInfo.kind?: ModelKind`, absent means `"chat"` (every existing plugin keeps working, no
  `@3`). `ModelKind` = `"chat" | "embedding" | "rerank" | "image_generation" | "video_generation" |
  "speech_to_text" | "text_to_speech"`. A kernel that meets a kind it does not know (a newer
  plugin) lists the model under "other" and never calls it.
- Callable kinds in this work: `chat` (through `stream`) and `embedding` (through `embed`). Every
  other kind is list-only: it shows, groups and can be enabled, but nothing resolves it (an agent or
  purpose naming one is refused with `agent.model_unavailable` / a validation error).
- `ModelInfo.publisher?: string`: the model's own vendor when the platform hosts other vendors'
  models (Bailian `provider`, e.g. `qwen`, `deepseek`, `zhipu-ai`). Display and filtering only.
- `ModelInfo.description?: LocalizedName | string` and `ModelInfo.retiresAt?: string` (ISO date,
  Bailian `offline_time`): display only.
- `ModelInfo.embedding?: { dimensions: number[]; defaultDimensions: number; maxInputTokens: number;
  maxBatch: number }`, required when `kind` is `embedding`.
- The chat-only fields (`contextWindow`, `maxOutputTokens`, `capabilities`, `parameters`) stay
  required in the type so the change is additive; for a non-chat model the kernel ignores them
  (the plugin fills what the platform gives, zero / false / `[]` otherwise). The builder may instead
  make `ModelInfo` a union by kind if the API snapshot and `@1` adapter stay compatible; either way
  `assertValidDeclarations` runs only on chat models.
- The kernel validates a list (inside `validatedModels`): an `embedding` model without `embedding`
  info, or a provider listing an `embedding` model without implementing `embed`, makes that model
  invalid; the builder decides whether one invalid model drops only that model (preferred: a
  platform list of hundreds must not fail as a whole for one odd entry; log a warn).

### 5.2 `embed()` (SDK, optional method on `ModelProvider`)

```ts
interface EmbedRequest {
  model: string;
  input: string[];               // 1..maxBatch texts
  dimensions?: number;           // one of ModelInfo.embedding.dimensions
  inputType?: "query" | "document"; // mapped where the platform distinguishes (DashScope text_type)
}
interface EmbedResult {
  vectors: number[][];           // one per input, in order, each of the requested dimension
  usage: { inputTokens: number };
}
embed?(req: EmbedRequest, opts: { signal: AbortSignal }): Promise<EmbedResult>;
```

Errors are `ModelError` with the existing kinds; no retries inside the extension (same rule as
`stream`). The kernel checks the result shape (count, dimension, finite numbers) and throws
`ModelError("server")`-equivalent on a mismatch. Text only; multimodal embeddings (Ark
`/embeddings/multimodal`) are a later addition.

### 5.3 Org model enablement (kernel)

- New table (`capybara` schema, the builder names it) holding, per org and provider, the provider's
  mode and the enabled model ids: mode `all` (every listed model is enabled, today's behavior) or
  `selected` (only the listed ids). No row = `all`. So nothing changes for an org until its admin
  acts; see §9 for the platform default.
- Enforcement, one helper used everywhere (the builder places it next to `ProviderRegistry`):
  - `GET /api/v1/orgs/:orgId/models` returns only enabled models, with `kind` and the new display
    fields, optional `?kind=` filter. A new `GET .../models/catalog` (org admins,
    `org.models.manage`) returns every model with its enabled flag for the settings page.
  - Agent save and the agent model picker: only enabled `chat` models.
  - Run time (`resolve` in the org's context): a model that was enabled when the agent was saved and
    is disabled now fails the run step with `agent.model_unavailable`, through the existing
    degradation ladder. Replays are not affected (they never call a provider).
  - Purpose targets (deployment default and org override): the target's kind must equal the
    purpose's kind, and an org's effective target must be enabled in that org; a deployment default
    that the org disabled counts as unconfigured for that org (`model.unconfigured`).
  - `ctx.models` (§5.4): enabled and of the right kind.
- Writes: `PUT /api/v1/orgs/:orgId/models/:provider` with `{ mode, models? }`, `org.models.manage`,
  audited, `@Transactional`, evicting the org's cached view after commit. Disabling a model that an
  agent or a purpose override uses is allowed; the response lists the affected agents and purposes
  so the page can warn before saving (the builder decides warn-before vs warn-after).
- Deployment level is unchanged: the super admin's `/admin/models` shows every provider with
  every model, grouped by kind.

### 5.4 `ctx.models` for embeddings (SDK + kernel)

- `ctx.models.embed({ orgId, purpose, input, dimensions?, inputType? })`: `purpose` must be one the
  calling extension declared in `permissions.models` with `kind: "embedding"` (so it is part of the
  approved permission manifest); the kernel resolves the org's effective target for it, checks it
  is enabled, calls the provider's `embed` with the purpose's params, enforces `maxBatch` (splits or
  refuses: builder's call, splitting preferred), and records usage.
- `ctx.models.describe({ orgId, purpose })` returns the effective target's id, kind and
  `embedding` info (dimensions) or `null` when unconfigured, so a consumer can size its vector
  store and notice a model change (a changed model invalidates stored vectors; that is the memory
  plugin's problem, but it needs this signal).
- Which model a purpose uses is chosen in the existing purpose UI (`/settings/models`, and the
  deployment default in the admin console). **Decision (Claude's call)**: the memory plugin's own
  settings page shows and changes this mapping rather than storing a model id of its own; how it
  reaches the mapping from an extension page (a link to `/settings/models#<purpose>`, or a
  `ctx.models` setter) is decided in the memory design. Provider plugins never declare purposes.
- Usage: each `embed` call writes a usage record (provider, model, purpose, org, input tokens)
  where kernel purpose calls record usage today, and fires the `usage.report` hook; no conversation
  event (it is not part of a conversation). Cost uses the price table's input price.
- Not in scope: `ctx.models` for chat (no consumer yet).

### 5.5 Credentials and OAuth

Each plugin's deployment config holds an `apiKey: secret()`. The kernel defines nothing for
OAuth: how a provider authenticates is the plugin's own code (the kernel at most stores its secrets
and tokens), and none of the three platforms offers OAuth for model calls anyway (the OAuth login
some tools offer for Qwen is Qwen Portal, a different product). Ark adds optional AK/SK for listing
(§6.3).

### 5.6 Web

- `/settings/models` (org admins) gains a models section before the purposes: one block per
  provider (display name, mode switch "all models / selected models"), inside it the models grouped
  by kind with counts, a search box, a publisher filter when the provider hosts several, and a
  toggle per model; retiring models are marked. Built from design components and templates only
  (`writing-web-ui`); a list of hundreds needs the design's table with filtering, and if no
  component fits, the design system change flow comes first.
- Agent model picker: chat models only, grouped by provider and publisher.
- Purpose editor: targets filtered by the purpose's kind (embedding purposes list embedding models).
- `/admin/models`: grouped by kind.
- New query keys, freshness classes and route-table entries as the query-cache rules require; i18n
  zh and en.

### 5.7 Large lists

A platform list can be hundreds of entries over several pages. The plugin pages through it itself
inside one `listModels()` call; the kernel's 10 s limit may be too short, so the builder adds a
per-model-list allowance (e.g. a config `models.listTimeoutMs`, or a value the provider declares)
and keeps the Redis cache. The org catalog view must not call the provider more than the cached
list does.

## 6. The three plugins (`capybara-hq/plugins`)

Common to all three: `model-provider@2` with `listModels`, `stream` and (where the platform has
embeddings) `embed`; deployment config with `apiKey` (§5.5) and the platform's region / base URL;
`displayName` zh / en; config labels zh / en (`plugin-config-labels`); declared `permissions.network`
hosts; tests in `plugins/<name>/test` against a fake server (`@capybara-hq/testing`) plus live tests
gated by `CAPYBARA_TEST_*` env vars; the model-provider conformance suite. Mapping rules follow
`writing-model-providers` in the plugins repository (append-only history, opaque replay, usage
semantics with cache tokens subtracted, `ModelError` kinds, no retries).

Plugin names (Claude's call, the user may rename): `deepseek`, `bailian`, `ark`; npm
`@capybara-hq/plugin-<name>`.

### 6.1 DeepSeek

- Config: `apiKey`, `baseUrl` (default `https://api.deepseek.com`).
- `listModels`: `GET /models`; `context_window` / `max_output_tokens` from it, `effort` levels into
  an `effort` parameter declaration, `input_modalities` into `vision` / `documents`,
  `api_capabilities.anthropic_messages.system_prompt_update` into `midConversationSystem`. A field
  the API omits falls back to a per-model table bundled in the plugin; a model with neither is
  listed with conservative defaults (the builder documents them).
- `stream`: DeepSeek's Chat Completions API with its own fields (`reasoning_content`, thinking
  replay rules, cache hit / miss token accounting, `effort`). The builder may reuse ideas from the
  `openai-compatible` `deepseek` dialect but the plugin does not depend on it.
- No `embed`.

### 6.2 Alibaba Bailian

- Config: `apiKey`, `region` (the six of §4), `workspaceId` (required in the regions whose list URL
  carries it).
- `listModels`: the list API, all pages; `capabilities` → kind (`TG`/`VU` chat, `TR` embedding,
  `IG` image_generation, `VG` video_generation, `ASR` speech_to_text, `TTS` text_to_speech; a model
  with both `TG` and `VU` is one chat model with vision), `features` → `tools` / `caching`,
  `Reasoning` → reasoning, `model_info` → limits, `provider` → `publisher`, `offline_time` →
  `retiresAt`. Only `inference` models (`supports=inference`, the default).
- `stream`: DashScope native text-generation / multimodal-generation with SSE incremental output.
  Whether every hosted vendor's chat model (DeepSeek, Kimi, GLM on Bailian) works on the native
  endpoint is a check the builder makes first; a model that only works on the compatible endpoint
  is either sent there by the plugin or left out of the list (builder's call, documented).
- `embed`: DashScope native text embedding; `inputType` → `text_type`; dimensions and batch limits
  per model from a bundled table when the list does not give them.

### 6.3 Volcengine Ark

- Config: `apiKey` (inference API key), `region` (default `cn-beijing`), optional
  `management: { accessKeyId, secretAccessKey: secret() }` for listing.
- `listModels`: with AK/SK, `ListFoundationModels` (V4 signing) for the foundation models and the
  account's custom inference endpoints (`ep-...`) if a list API for them exists; without AK/SK, a
  model table bundled in the plugin (updated with plugin releases). **First task of this plugin**:
  confirm the list API's auth and fields, and whether the inference plane lists models with the API
  key; if it does, AK/SK is dropped.
- `stream`: Ark's `/api/v3/chat/completions` (reasoning content, cache tokens, `thinking` switch as
  a parameter). Responses API is out of scope.
- `embed`: `/api/v3/embeddings`.

## 7. Order of work

1. Core: SDK kinds and `embed` (API snapshot, changeset bumping `@capybara-hq/plugin-sdk`),
   `model-fake` gains an embedding model and kinds so kernel tests have a provider.
2. Core: org model enablement (table, enforcement, routes, web settings section).
3. Core: `ctx.models.embed` / `describe`, usage, kind-filtered purposes.
4. Release a core rc carrying the SDK.
5. Plugins repository: `deepseek`, `bailian`, `ark` (independent of each other; Ark starts with the
   list-auth check).

Steps 1-3 are one core PR or three; the plan decides.

## 8. Left to the builder

Table and column names; the exact TypeScript shape of `ModelInfo` for non-chat kinds (§5.1);
splitting vs refusing over-long embedding batches; warn-before vs warn-after when disabling a used
model; the list timeout mechanism; bundled per-model tables and their defaults; how the plugins
share no code (each is self-contained; no shared package is introduced).

## 9. Decided with the user / open

Decided with the user: three native plugins; API key credentials, OAuth is a plugin's own concern;
model list from the platform, grouped by kind; org admins choose enabled models, as a kernel
feature for every provider; embeddings callable for the memory plugin; prices out of scope;
provider plugins declare no purposes.

Claude's calls (§5.4, §6): the memory plugin chooses its embedding model through a purpose it
declares; plugin names; speech / image / video list-only.

Open: the default for a platform provider in an org that never chose (§5.3 `all`).
