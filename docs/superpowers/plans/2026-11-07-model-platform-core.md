# Model platform providers, core part — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended)
> or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`)
> syntax for tracking.

**Goal:** models carry a kind, providers may embed, model provider calls are org-bound (org keys
through design A), the platform and each org can disable models, and extensions embed text through
`ctx.models` with usage recorded and reported — so the `deepseek` / `bailian` / `ark` plugins can be
written against a released SDK.

**Architecture:** additive `model-provider@2` changes in the SDK (`ModelInfo.kind` and display
fields, optional `embed`, `{ orgId, config }` call options); `ProviderRegistry` takes the org,
passes the org's effective config (design A `EffectiveConfigs`) and caches lists per effective-config
hash; one enablement helper filters every model read and resolve by two disabled lists; `ctx.models`
is a kernel broker gated by `permissions.models`, writing a new usage table and feeding the existing
`usage.report` queue.

**Tech Stack:** NestJS + Fastify kernel, Kysely on PG, Redis (`@Cacheable`), BullMQ, zod 4, Next web
app with TanStack Query and `@capybara-hq/design`, vitest.

**Spec:** `docs/superpowers/specs/2026-11-06-model-platform-providers-design.md` (cited "B §n"),
core part §5.1-§5.7 and §7 steps 1-3. It builds on design A
`docs/superpowers/specs/2026-11-07-platform-org-layering-design.md` ("A §n"), implemented on the base
branch `feat/platform-org-layering` (PR #89). Research map with file:line facts:
`.superpowers/sdd/b-core-research.md` (cited "R§n"; lines at `1df96954`).

## Global Constraints

- Branch `feat/model-platform-core` is stacked on `feat/platform-org-layering`; it merges after #89.
- Next migration number `0087`; one migration: `packages/kernel/src/migrations/0087_model_kinds_usage.sql`.
  Expand-only; `IF NOT EXISTS`.
- `ModelKind = "chat" | "embedding" | "rerank" | "image_generation" | "video_generation" |
  "speech_to_text" | "text_to_speech"`; absent `kind` = `"chat"`. An unknown kind string from a newer
  plugin is listed as `"other"` by the kernel and never resolved. Callable kinds: `chat` (`stream`),
  `embedding` (`embed`); every other kind is list-only.
- SDK changes are additive except the `usage.report` payload, whose conversation fields become
  optional (decided). One changeset bumping `@capybara-hq/plugin-sdk` minor; API snapshot via
  `pnpm gen:sdk-api`; `model-fake` gets its own changeset.
- No retries inside providers (`writing-model-providers`); embed errors are `ModelError` with the
  existing kinds.
- Model enablement: every listed model is enabled unless disabled by the platform list or the org
  list; no allowlist and no mode switch (B §5.3). Disabling is never a config edit (no org copy, A §5.4).
- An org never reaches a platform overridable secret (A §5.4): provider calls get the org's
  effective config from `EffectiveConfigs.get(orgId, plugin)`, never `ctx.config` mixed in by the
  kernel.
- Replay invariant: conversation reconstruction never calls a provider; nothing model-visible
  changes for existing conversations. Run `packages/kernel/test/evals/reconstruct.test.ts` and
  `rename-compat.test.ts` after Tasks 3 and 4.
- Kernel conventions and web rules as in AGENTS.md (`@Inject` everywhere, `@Transactional`,
  `afterCommit`, `createZodDto` + `@ZBody` / `@ZParam` / `@ZQuery`, error codes in `errors.ts` with
  web copy, design components only, query keys, zh / en messages: 智能体, 平台, 超级管理员, 组织管理员,
  never 企业 or Latin "agent").
- Audit actions: `model.disabled_set` (platform list), `org.model_disabled_set` (org list).
- Changesets: `@capybara-hq/plugin-sdk` minor, `@capybara-hq/testing` minor (conformance),
  `@capybara-hq/plugin-model-fake` minor, `@capybara-hq/kernel` minor, `@capybara-hq/web` minor.
- Local only: no push, PR or publish. Single test: `pnpm exec vitest run <path>` from the worktree root.

## Review Focus

1. **A provider list with one odd entry.** A Bailian-sized list where one model has an invalid
   parameter declaration, an `embedding` model without `embedding` info, or an unknown kind: only
   that entry is dropped or listed as `other` (warn logged); the rest of the provider stays usable.
   Tests in Task 3.
2. **Org key with a different model list.** Org A follows the platform, org B has its own key whose
   list differs: each sees its own list (cache per effective-config hash), A and B share no cached
   list, and a model disabled by id in B's org list stays harmless in A. Tests in Task 3 and 4.
3. **A model disabled after an agent saved it.** The run fails the step with
   `agent.model_unavailable` through the ladder (fallback used when enabled), a purpose override
   pointing at it makes the purpose unconfigured for that org, the switch-model plan refuses it, an
   eval candidate is refused. Tests in Task 4.
4. **Embedding batch and shape.** `ctx.models.embed` with more inputs than `maxBatch` is split and
   the vectors come back in input order; a provider returning a wrong count, a wrong dimension or a
   non-finite number fails with `ModelError("server")`-equivalent; the extension did not declare the
   purpose → refused. Tests in Task 6.
5. **Usage without a conversation.** Every embed writes one usage row and one `usage.report`
   delivery with purpose `embedding` and no conversation fields; a handler failing is retried at
   least once and deduped by `eventId`; existing conversation usage reports are unchanged. Tests in
   Task 6.

---

### Task 1: SDK — kinds, embed, org-bound options, usage payload, conformance

**Files:**
- Modify: `packages/plugin-sdk/src/model.ts:8-35` (ModelInfo), `:304-316` (ModelProvider, V1),
  `packages/plugin-sdk/src/hooks.ts:52-55,144-160` (UsagePurpose, UsageReportPayload),
  `packages/plugin-sdk/api/plugin-sdk.api.md`
- Modify: `packages/testing/src/model-conformance.ts` (embedding block), `packages/testing/src/index.ts`
- Test: `packages/plugin-sdk/test/model.test.ts` (or the existing model test file), `packages/testing/test/model-conformance.test.ts` if present
- Changesets: `.changeset/model-kinds-sdk.md` (plugin-sdk minor), `.changeset/model-conformance-embed.md` (testing minor)

**Interfaces — produces:**
- `export type ModelKind = "chat" | "embedding" | "rerank" | "image_generation" | "video_generation" | "speech_to_text" | "text_to_speech";`
- `ModelInfo` gains optional `kind?: ModelKind; publisher?: string; description?: LocalizedName | string; retiresAt?: string; embedding?: ModelEmbeddingInfo;`
  with `export interface ModelEmbeddingInfo { dimensions: number[]; defaultDimensions: number; maxInputTokens: number; maxBatch: number }`.
  Chat-only fields stay required (B §5.1).
- `export interface ModelCallOptions { orgId?: string; config?: unknown }` (TSDoc copied from
  `tool.ts:183-191`: the org's effective config; optional so older providers compile; the kernel
  always passes both).
- `ModelProvider`: `listModels(opts?: ModelCallOptions): Promise<ModelInfo[]>;`
  `stream(req: ModelRequest, opts: { signal: AbortSignal } & ModelCallOptions): AsyncIterable<ModelStreamEvent>;`
  `embed?(req: EmbedRequest, opts: { signal: AbortSignal } & ModelCallOptions): Promise<EmbedResult>;`
- `export interface EmbedRequest { model: string; input: string[]; dimensions?: number; inputType?: "query" | "document" }`;
  `export interface EmbedResult { vectors: number[][]; usage: { inputTokens: number } }`.
- `export function validateEmbedResult(req: EmbedRequest, info: ModelEmbeddingInfo, res: EmbedResult): string | null`
  (null when valid; else a reason: count mismatch, dimension mismatch, non-finite number) — used by
  the kernel and the conformance suite.
- `UsagePurpose = ModelCallPurpose | "embedding"`; `UsageReportPayload`: `accountId?`, `agentId?`,
  `conversationId?`, `conversationKind?`, `runId?` optional (TSDoc: absent for `embedding`), new
  optional `extension?: string` (the calling extension for `embedding`).
- `ModelProviderV1` unchanged (no embed, no options).
- Conformance: `TargetCommon.expect.embedding?: { model: string; dimensions: number }`; when set,
  cases "embeds a batch in order" and "embed result passes validateEmbedResult".

- [ ] **Step 1: Write the failing tests**: `validateEmbedResult` returns null for a valid result and
  a reason for 2 vectors on 3 inputs, a vector of dimension 7 for requested 8, a `NaN`; a type-level
  test (compile in the test file) that a provider without `embed` and with `listModels()` taking no
  argument still satisfies `ModelProvider`; `UsageReportPayload` accepts `{ purpose: "embedding" }`
  without conversation fields.
- [ ] **Step 2: Run** `pnpm exec vitest run packages/plugin-sdk/test`; expected FAIL.
- [ ] **Step 3: Implement** the types, `validateEmbedResult`, the conformance block.
- [ ] **Step 4: Run** the tests, `pnpm gen:sdk-api`, `pnpm check:sdk-api`, `pnpm typecheck`
  (kernel usage-report code compiles with the optional fields; fix narrowing where the kernel reads
  them for conversation purposes); expected PASS.
- [ ] **Step 5: Commit** `feat(sdk): model kinds, embeddings and org-bound model calls`.

### Task 2: model-fake — kinds, an embedding model, per-call config

**Files:**
- Modify: `plugins/model-fake/src/index.ts:16,48-60`, `plugins/model-fake/src/script.ts:23,260-300`
- Test: `plugins/model-fake/test/model-fake.test.ts`, `plugins/model-fake/test/conformance.test.ts`
- Changeset: `.changeset/model-fake-embed.md` (`@capybara-hq/plugin-model-fake` minor)

**Interfaces — produces:**
- Config model entries gain `kind?: ModelKind`, `publisher?: string`, `dimensions?: number[]`,
  `maxBatch?: number`. The deployment `models` field is `orgAccess(..., "override")` so kernel tests
  can give an org its own list.
- `listModels(opts)` uses `opts?.config` (parsed with the same schema) when present, else the setup
  config; same for `stream` / `embed` model lookup.
- An entry with `kind: "embedding"` lists `embedding: { dimensions: dimensions ?? [8, 16],
  defaultDimensions: dimensions?.[0] ?? 8, maxInputTokens: 512, maxBatch: maxBatch ?? 4 }`.
- `embed(req)`: deterministic vectors (seeded by sha256 of the text; values in [-1, 1]; requested or
  default dimension), `usage.inputTokens = Σ ceil(text.length / 4)`; script prefix `fail:<kind>` in
  the first input makes it throw `ModelError(kind)`.

- [ ] **Step 1: Write the failing tests**: an embedding entry lists with `kind: "embedding"` and the
  embedding info; `embed` returns one vector per input, in order, of the requested dimension, equal
  for equal text; `listModels({ config: { models: [{ id: "org-1" }] } })` lists only `org-1`; the
  conformance suite runs with `expect.embedding`.
- [ ] **Step 2: Run** `pnpm exec vitest run plugins/model-fake/test`; expected FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same and `pnpm check` (plugin checks); expected PASS.
- [ ] **Step 5: Commit** `feat(model-fake): kinds, an embedding model and per-call config`.

### Task 3: ProviderRegistry — org-bound calls, per-model validation, list timeout

**Files:**
- Modify: `packages/kernel/src/runtime/providers.ts` (whole class; `adaptModelProviderV1`),
  `packages/kernel/src/runtime/model-call.ts:833,1080,1385-1418` (`consumeModelStream` forwards
  options), every caller in R§3 (run-worker `fallBackIfUnavailable`, run-steps, subagents definition /
  dispatch / service, agents.service `checkModels`, from-template, conversations `planSwitch`,
  purposes, evals runs / step-replay / run-replay / worker / judge, models controller, admin
  controller, readiness), `packages/kernel/src/config/schema.ts` (+ `docs/config.md` regenerated)
- Test: `packages/kernel/test/agents/providers.test.ts`, new `packages/kernel/test/agents/providers-org.test.ts`,
  kernel fixture `packages/kernel/test/fixtures/plugins/model-odd/` (lists a valid chat model, one
  with an invalid parameter declaration, an `embedding` model without `embedding` info, one with
  kind `"hologram"`)

**Interfaces — produces:**
- `resolve(orgId: string, ref: ModelRef): Promise<{ provider: BoundProvider; info: ModelInfo }>` where
  `BoundProvider = { stream(req, opts: { signal }): AsyncIterable<ModelStreamEvent>; embed?(req, opts:
  { signal }): Promise<EmbedResult> }` already bound to `{ orgId, config }` from
  `EffectiveConfigs.get(orgId, plugin)`; not ok → `agent.model_unavailable` (needs config). Only
  kinds `chat` and `embedding` resolve; others → `agent.model_unavailable`.
- `list(orgId: string): Promise<{ provider: string; models: KernelModelInfo[] }[]>` and
  `listWithStatus(orgId?: string)` (no org = the platform view with the platform config, for
  `/admin/models`; a provider whose platform config leaves a required overridable field empty shows
  `status: "org_configured"` and no models) where `KernelModelInfo = ModelInfo & { kind: ModelKind |
  "other" }` (kind normalised).
- Cache key `capk:models:<plugin>:v<major>:<version>:<effectiveConfigHash>`, the hash =
  `deploymentConfigHash(schema, effective.config)` (`extensions/host.ts:122`); failure marker keyed
  the same way. Following orgs share the platform's key.
- Per-model validation (B §5.1, Review Focus 1): a chat model failing `assertValidDeclarations`, an
  `embedding` model without `embedding` info or whose provider lacks `embed`, is dropped with one warn
  log per (plugin, model, configHash); an unknown kind becomes `"other"`. `assertValidDeclarations`
  runs only on chat models.
- Config `models.listTimeoutMs` (default 10000, hot; `adding-config`) replaces the constant; the DI
  override `LIST_MODELS_TIMEOUT` stays for tests.
- `consumeModelStream(provider: BoundProvider, …)`.

- [ ] **Step 1: Write the failing tests**: `providers-org.test.ts` with model-fake (models field
  overridable) and an org copy giving org B `models: [{ id: "b-only" }]`: `list(orgA)` has
  `fake-1`, `fake-2`; `list(orgB)` has only `b-only`; the stream call for org B receives
  `opts.config.models[0].id === "b-only"` and `opts.orgId === orgB` (capture via
  `test/helpers/provider-capture.ts`); org A and org B cache keys differ, two following orgs share
  one; a provider needing config in an org resolves to `agent.model_unavailable` there.
  `model-odd`: `list` returns the valid chat model and the `"other"` one; the two invalid ones are
  absent; resolving the `"other"` model fails. Admin view without org shows `org_configured` for a
  provider whose platform key is empty. Existing `providers.test.ts` cases updated to the new
  signatures stay green.
- [ ] **Step 2: Run** `pnpm exec vitest run packages/kernel/test/agents/providers.test.ts packages/kernel/test/agents/providers-org.test.ts`; expected FAIL.
- [ ] **Step 3: Implement** and update every caller to pass the org it already has in scope
  (R§3 lists the source per caller; `fallBackIfUnavailable` and `planSwitch` gain an `orgId`
  parameter; eval step / full-run replays use the case snapshot's `orgId`).
- [ ] **Step 4: Run** the two files, then `pnpm exec vitest run packages/kernel/test/runtime packages/kernel/test/evals packages/kernel/test/models packages/kernel/test/agents packages/kernel/test/conversations`
  and the zero-drift fixtures; `pnpm typecheck`; expected PASS.
- [ ] **Step 5: Commit** `feat(kernel): org-bound model providers and per-model list validation`.

### Task 4: Model disabling on two layers (kernel)

**Files:**
- Create: `packages/kernel/src/migrations/0087_model_kinds_usage.sql`,
  `packages/kernel/src/models/enablement.ts`, `packages/kernel/src/models/enablement.controller.ts`
- Modify: `packages/kernel/src/db/kernel-schema.ts`, `packages/kernel/src/runtime/providers.ts`
  (filter), `packages/kernel/src/models/purposes.ts:225-334` (kind + enabled checks),
  `packages/kernel/src/agents/agents.service.ts:383` (chat + enabled), `packages/kernel/src/agents/models.controller.ts`
  (`?kind=`, catalog route), `packages/kernel/src/admin/admin.controller.ts` (platform route),
  `packages/kernel/src/models/models.module.ts`, `packages/kernel/src/http/api.module.ts`,
  `packages/kernel/src/errors.ts`
- Test: `packages/kernel/test/models/enablement.http.test.ts` (new), `packages/kernel/test/models/purposes.test.ts`,
  `packages/kernel/test/agents/agents.http.test.ts`, `packages/kernel/test/models/admin-models.test.ts`

**Interfaces — produces (migration 0087, both tables; Task 6 uses the second):**
- `model_disabled (org_id text NULL REFERENCES orgs(id) ON DELETE CASCADE, provider text NOT NULL,
  model text NOT NULL, disabled_by text REFERENCES accounts(id) ON DELETE SET NULL, disabled_at
  timestamptz NOT NULL DEFAULT now())`, unique `((coalesce(org_id, '')), provider, model)`;
  `org_id` null = the platform list.
- `model_usage (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id text NOT NULL REFERENCES
  orgs(id) ON DELETE CASCADE, extension text NOT NULL, purpose text NOT NULL, provider text NOT
  NULL, model text NOT NULL, input_tokens integer NOT NULL, occurred_at timestamptz NOT NULL DEFAULT
  now(), reported_at timestamptz NULL)`, index `(org_id, occurred_at DESC)`, partial index
  `(occurred_at) WHERE reported_at IS NULL`.

**Interfaces — produces (services and routes):**
- `ModelEnablement.disabled(orgId: string | null): Promise<Set<string>>` (keys `provider\u0000model`);
  `isEnabled(orgId: string, provider: string, model: string): Promise<boolean>` (neither list);
  `setPlatform(provider, models: string[], actor)` / `setOrg(orgId, provider, models: string[],
  actor)` replace that provider's disabled ids, `@Transactional`, audited, cache evicted after commit,
  returning `{ affected: { agents: {id, name, orgId}[]; purposes: {purpose, orgId | null}[] } }`
  (agents whose current version uses a newly disabled model as main or fallback; purpose
  defaults / overrides targeting one).
- `ProviderRegistry.list(orgId)` and `resolve(orgId, …)` exclude disabled models (resolve →
  `agent.model_unavailable`); `listWithStatus()` (platform) marks `disabled: true` from the platform
  list only.
- Routes: `GET api/v1/orgs/:orgId/models?kind=` (enabled only, `agents.use`);
  `GET api/v1/orgs/:orgId/models/catalog` (`org.models.manage`: every model the platform left on,
  with `disabled` for the org); `PUT api/v1/orgs/:orgId/models/:provider/disabled` `{ models:
  string[] }` (`org.models.manage`); `PUT api/v1/admin/models/:provider/disabled` `{ models }`
  (super admin). `@ZParam` / `@ZBody` / `@ZQuery` DTOs.
- Agent save: main and fallback must be enabled `chat` models in the org → 400
  `agent.model_unavailable` otherwise.
- Purposes (`check`, `resolve`): a target's kind must equal the purpose's kind (400
  `validation_failed` naming the kind); an org override must be enabled in that org on save; at
  resolve, an effective target disabled in the org → `model.unconfigured` (409).

- [ ] **Step 1: Write the failing tests** (`enablement.http.test.ts`, startKernel with model-fake
  listing `fake-1`, `fake-2`, `fake-embed` (embedding)): an org admin disables `fake-2` → `GET
  …/models` lacks it, `…/models/catalog` lists it `disabled: true`, the response lists an agent using
  it; a member's PUT is 403; the super admin disables `fake-1` on the platform → no org sees it,
  not even in the catalog; `?kind=embedding` lists only `fake-embed`; saving an agent with
  `fake-embed` as model → 400; a run of an agent saved on `fake-2` before the disable fails the step
  with `agent.model_unavailable` and uses an enabled fallback; `purposes.test.ts`: an embedding
  purpose rejects a chat target (400), an org override on a disabled model is refused, a default
  disabled in the org makes `resolve` 409 `model.unconfigured` for that org only; the switch-model
  plan (`planSwitch`) refuses a disabled model; an eval candidate on a disabled model is refused.
  Migration test: 0086 → 0087 creates both tables; rerun no-op.
- [ ] **Step 2: Run** `pnpm exec vitest run packages/kernel/test/models packages/kernel/test/agents/agents.http.test.ts`; expected FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same, the zero-drift fixtures, `pnpm typecheck`; expected PASS.
- [ ] **Step 5: Commit** `feat(kernel): models disabled by the platform and by orgs`.

### Task 5: Web — models by kind, disabling, kind-aware pickers

**Files:**
- Modify: `apps/web/src/app/(app)/settings/models/view.tsx`, `apps/web/src/app/(app)/admin/models/view.tsx`,
  `apps/web/src/components/agent/ModelSection.tsx`, `apps/web/src/components/PurposeEditor.tsx`,
  `apps/web/src/lib/agents.ts`, `apps/web/src/lib/models.ts`, `apps/web/src/lib/query/keys.ts`,
  `lib/query/conversation.ts`, `lib/query/settings.ts`, `lib/query/admin.ts`, `lib/query/routes.ts`,
  `apps/web/messages/{zh,en}.json`
- Create: `apps/web/src/components/ModelCatalog.tsx` (one provider block: kind groups with counts,
  search, publisher filter when several, a switch per model, bulk off / on per kind and publisher,
  retiring marker; used by both pages)
- Test: `apps/web/test/model-catalog.test.tsx` (new), `apps/web/test/settings-models.test.tsx`,
  `apps/web/test/admin-models.test.tsx` (existing files or new), agent model picker test

**Interfaces — consumes:** Task 4 routes; the models list carries `kind`, `publisher`,
`description`, `retiresAt`, `embedding`. New keys `keys.org(o).modelsCatalog()`.

Copy (zh / en): 模型 / Models; 对话模型 / Chat; 向量模型 / Embedding; 重排模型 / Rerank; 图像生成 / Image
generation; 视频生成 / Video generation; 语音识别 / Speech to text; 语音合成 / Text to speech; 其他 /
Other; 搜索模型 / Search models; 发布方 / Publisher; 全部关闭 / Turn all off; 全部开启 / Turn all on;
即将下线 / Retiring; 跟随平台 / Following the platform; 本组织配置 / This org's configuration;
组织各自配置 / Orgs configure their own; disable warning 以下智能体或用途正在使用这些模型： / These agents
or purposes use these models:.

- [ ] **Step 1: Write the failing tests**: the catalog groups 300 generated models by kind with
  counts and filters by search and publisher; bulk "turn all off" for a kind sends one PUT with all
  that kind's ids plus those already disabled; the settings page shows 跟随平台 / 本组织配置 from the
  extension's `overrideState` (design A) with a link to its config; the admin page sends the
  platform PUT; the agent model picker lists only chat models grouped by provider and publisher;
  the purpose editor lists only models of the purpose's kind; the disable response's affected list
  is shown before the change is kept (warn after save, then allow undo by re-enabling).
- [ ] **Step 2: Run** the new and touched web tests; expected FAIL.
- [ ] **Step 3: Implement** with design components only; a list of hundreds uses the design's table
  with filtering (follow the design change flow first if nothing fits).
- [ ] **Step 4: Run** the tests, `pnpm check:web-ui && pnpm check:i18n`, web `tsc`; expected PASS.
- [ ] **Step 5: Commit** `feat(web): models grouped by kind, disabling, kind-aware pickers`.

### Task 6: `ctx.models` embed / describe, usage rows, usage.report

**Files:**
- Modify: `packages/plugin-sdk/src/ctx.ts:60-170` (`models` member), `packages/plugin-sdk/src/permissions.ts:23`
  (drop "reserved" note), API snapshot; `packages/kernel/src/ctx/create-ctx.ts` (+ `KernelDeps`
  broker), create `packages/kernel/src/models/embeddings.ts` (`ModelEmbeddings` broker),
  `packages/kernel/src/runtime/usage-report.ts` (jobs and sweep for `model_usage`),
  `packages/kernel/src/models/models.module.ts`
- Test: `packages/kernel/test/models/embeddings.test.ts` (new; kernel fixture
  `packages/kernel/test/fixtures/plugins/embed-consumer/` declaring `permissions.models: [{ purpose:
  "embed-consumer.memory", kind: "embedding", label }]`, registering a tool that calls
  `ctx.models.embed` and `describe`), `packages/kernel/test/runtime/usage-report.test.ts`
- Changeset: append to `.changeset/model-kinds-sdk.md`

**Interfaces — produces:**
- SDK `ExtensionContext.models: { embed(req: { orgId: string; purpose: string; input: string[];
  dimensions?: number; inputType?: "query" | "document" }): Promise<{ vectors: number[][]; model: {
  provider: string; id: string }; dimensions: number }>; describe(req: { orgId: string; purpose:
  string }): Promise<{ provider: string; id: string; kind: ModelKind; embedding?: ModelEmbeddingInfo
  } | null> }`. Calling with a purpose the extension did not declare with `kind: "embedding"` throws
  (`model.purpose_unknown`); calling without `permissions.models` throws.
- `ModelEmbeddings.embed(plugin: string, req)`: purpose → `ModelPurposesService.resolve(orgId,
  purpose)` (409 `model.unconfigured` passes through), `ProviderRegistry.resolve(orgId, target.model)`
  (enabled, kind `embedding`), purpose params; splits `input` into chunks of `maxBatch`, calls
  `embed` per chunk with `{ signal }` (the extension's `ctx.signal`), checks each result with
  `validateEmbedResult` (mismatch → `ModelError("server")`), concatenates in order; writes one
  `model_usage` row per call (sum of chunk `inputTokens`) and enqueues its report after commit.
- `usage.report`: a job per `model_usage` row (job id `usage-model-<rowId>`), payload `{ eventId:
  rowId, purpose: "embedding", orgId, extension, provider, model, usage: { inputTokens, outputTokens:
  0, cacheReadTokens: 0, cacheWriteTokens: 0 }, occurredAt }` with no conversation fields; the sweep
  also re-enqueues rows with `reported_at IS NULL` older than the existing sweep threshold; a
  delivered row sets `reported_at`.

- [ ] **Step 1: Write the failing tests**: with model-fake's `fake-embed` (maxBatch 4) mapped to the
  purpose for the org: embedding 10 texts makes 3 provider calls and returns 10 vectors in order of
  the default dimension; `describe` returns the target with its embedding info, `null` when
  unmapped; an undeclared purpose throws; a purpose mapped to a model disabled in the org →
  `model.unconfigured`; a fake returning a wrong dimension → `ModelError` kind `server`; one
  `model_usage` row per call with the summed tokens; a `usage.report` handler receives one payload
  per row with purpose `embedding` and no `conversationId`; a failing handler is retried and the
  payload `eventId` is stable; conversation usage reports still carry their conversation fields.
- [ ] **Step 2: Run** `pnpm exec vitest run packages/kernel/test/models/embeddings.test.ts packages/kernel/test/runtime/usage-report.test.ts`; expected FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same, `pnpm gen:sdk-api`, `pnpm check:sdk-api`, `pnpm check`
  (`check:extension-permissions`: using `ctx.models` requires `permissions.models`; add the rule
  `perm-models` with a red fixture if the check has none), `pnpm typecheck`; expected PASS.
- [ ] **Step 5: Commit** `feat: extensions embed text through ctx.models`.

### Task 7: Docs, changesets, verify

**Files:** `AGENTS.md` ("Model provider extensions" bullet: kinds, embed, org-bound calls, model
disabling; "Extension hooks": `usage.report` embedding payload), `.agents/skills/writing-model-providers/SKILL.md`
(kinds, embed, `ModelCallOptions`, per-model validation, conformance `expect.embedding`),
`.agents/skills/writing-extensions/SKILL.md` (`ctx.models`), the B spec status line (core part
implemented, migration 0087, plan path), changesets listed in Global Constraints (add only the
missing ones).

- [ ] **Step 1:** Update the docs; keep `check:skills-frontmatter` and `check:terms` green.
- [ ] **Step 2:** Run `pnpm -s verify --json`; expected every check passes.
- [ ] **Step 3: Commit** `docs: model kinds, embeddings and model disabling`.
