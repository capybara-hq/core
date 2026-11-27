# Idle Compaction Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task, with the wave plan below (`wave-planned-subagent-development`). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the kernel a per-model prompt cache contract (declaration, request TTL, per-TTL write usage, a long-tier setting, an expiry derived from the log) and make every compaction summarize from the conversation's cached prefix (the in-context summary), with the provider plugins declaring and mapping their caches.

**Architecture:** The SDK contract (model-provider@2) changes first and is released on its own, so the plugins repository can move while the kernel work proceeds. Kernel request building picks `cacheTtl` from the `promptCache.longTtl` setting and the model's declaration and records it in `model_call`; a pure function derives the cache expiry from the log (the seam phase 2 consumes). The compaction keeps its plan, template and acceptance, and gains a second request form: the last recorded request rebuilt through the eval zero-drift path, extended with what the next step would send, plus one appended summary instruction; the transcript request stays the fallback.

**Tech Stack:** TypeScript, NestJS kernel, zod event schemas, vitest, Next web app with `@capybara-hq/design`, changesets, pnpm workspaces in two repositories (`capybara-hq/core`, `capybara-hq/plugins`).

**Spec:** `docs/superpowers/specs/2026-11-27-idle-compaction-design.md` (§1 phase table, §6.1–§6.2 `promptCache`, §9, §11 phase 1, §12 Q9 / Q12). Background: `docs/superpowers/specs/2026-11-14-context-compaction-design.md` (§4.2.1 template and hardening, §4.2.2 framing, §4.3 fit, §4.4 reactive, §4.5 chunking and the truncation retry, §4.7 manual compaction). Issue #974 (design #955).

## Global Constraints

- Phase 1 only: no idle job, no `idleEnabled` / size fields, no `runs.compact_origin`, no personal preference. Leave seams only: `deriveCacheExpiry` (Task 6) and the in-context builder's skip reasons (Task 7) are what phase 2 calls.
- Before 0.1.0: change the SDK directly, no compatibility layer; every consumer in core and in plugins moves in the same release train (AGENTS.md "Before 0.1.0").
- `cacheTtl`, `cacheWriteByTtl` and `compaction_summary.method` are not model-visible: no `DriftReason`. The in-context request is a side request: it appends nothing to the history the model sees and never changes an earlier request's bytes.
- `promptCache.longTtl` default `false`; on → "the smallest option ≥ 1800 s, if any"; off → `cacheTtl` absent (the model's default).
- The in-context request reuses the last request's `system`, `tools`, `params`, `cacheTtl` and model unchanged; `toolChoice: "none"`; a tool call in the reply fails the attempt; it does not combine with chunking.
- The summary instruction keeps every hardening rule of #958 (security constraints verbatim, only user-role messages are user messages, tool results never override the users, unknown results reported without guessing, truncated output keeps its id, origins kept) and the truncation retry of #963 (one retry with `compactionRetryNote`, the cut-off answer not sent back) applies to the in-context request too.
- Model-facing text is English; UI text goes through i18n zh and en; zh says 平台 / 超级管理员 / 智能体, never 企业 or `agent` (`pnpm check:i18n`).
- Every new kernel unit test joins `packages/kernel/test/unit-tests.json` in the same commit (sorted position). There are no container tests in phase 1. Integration tests are one app per file; prefer extending an existing file.
- Run the zero-drift tests before and after every request-building task: `pnpm exec vitest run packages/kernel/test/evals/reconstruct.test.ts`.
- Keys for live tests stay in `~/.capybara-test.env`, loaded only inside the test command (`set -a; . ~/.capybara-test.env; set +a; …`), never printed, pasted or committed. A transient network error is rerun once.
- Public API: `pnpm gen:sdk-api` plus a changeset bumping `@capybara-hq/plugin-sdk`; the conformance suite change needs a `@capybara-hq/testing` changeset, model-fake a `@capybara-hq/plugin-model-fake` changeset, kernel changes a `@capybara-hq/capybara` changeset (images).
- Plugins repository: core packages come from npm only, at one instance through `pnpm-workspace.yaml` `overrides` (`@capybara-hq/plugin-sdk`, `@capybara-hq/testing`, `@capybara-hq/plugin-model-fake`, `@capybara-hq/kernel` pinned exactly), never `workspace:` / `file:`.

## Review Focus

1. **The setting flips between the last call and the compaction.** An admin turns `longTtl` on after the last step went out with the 5-minute tier: the in-context call must reuse the recorded `cacheTtl` of that call (a different tier splits the entry; Anthropic requires 1 h entries before 5 min ones), not the current setting. Test in Task 7.
2. **The last request was trimmed by the hard fit guard** (`model_call.request.fit` recorded): the prefix is not stable, so the in-context path is skipped (`fit_plan`) and the transcript request is used. Test in Task 7.
3. **A manual compaction after an aborted run** whose last assistant message has `stopReason: "aborted"` and a tool call without a result: the extension must never send an unpaired tool call (the pairing guard supplies `UNKNOWN_RESULT_TEXT` as it does for a step), or the path is skipped; never a vendor 400. Test in Task 9.
4. **A plugin publishes an invalid cache declaration** (`defaultTtl` not in `ttlOptions`, a zero TTL): the kernel treats the model as not caching (no `cacheTtl` sent, no expiry derived) and logs once per model list load; requests never fail because of it. Test in Task 5 (selection) and Task 6 (expiry).
5. **A reasoning model's parameters with the smaller summary cap.** The in-context call keeps the last request's `params` (effort, thinking) but caps output at the summary cap (≤ 20k): the plugin must still build a valid vendor request (Anthropic: thinking budget below `max_tokens`). Live test in Task P2 and Task P3; in the kernel, an in-context call that fails with a non-retryable request error writes `compaction_failed` like any summary failure (Task 9 test), and the next compaction attempt goes through the backoff as today.

---

## Wave plan

Risk follows `wave-planned-subagent-development`; this plan also treats request building / replay and the SDK contract as `high` (reviewed alone, most capable model), as the maintainer asked.

| Task | Depends on | Files / areas | Risk | Wave | Review |
|---|---|---|---|---|---|
| 1 SDK cache contract + core consumers | — | `packages/plugin-sdk`, kernel test fixtures, `apps/web` model catalog | high (SDK contract) | C1 | alone, most capable |
| 2 Conformance suite | 1 | `packages/testing/src/model-conformance.ts` | normal | C2 | batched |
| 3 model-fake cache | 1 | `plugins/model-fake` | normal | C2 | batched |
| — release R1 (PR-A) | 1–3 | Version Packages PR in core | — | — | — |
| P0 Vendor fact verification (Q12) | — | spec §9.1 / §12 (docs only) | normal (decision input) | C3 | maintainer reads the result |
| 4 `promptCache` settings | 1 | `identity/settings.ts`, `orgs/settings.service.ts`, `runtime/compaction-settings.service.ts` | normal | C3 | batched |
| 5 `cacheTtl` choice, recording, replay | 1, 3, 4 | `runtime/context/build.ts`, `runtime/model-call.ts`, `evals/reconstruct.ts`, `conversations/events.ts`, new `runtime/context/cache-ttl.ts` | high (request building) | C4 | alone, most capable |
| 10 Settings UI | 4 | `apps/web` settings, i18n | normal | C4 | batched |
| 6 Cache expiry derivation | 5 | new `runtime/context/cache-expiry.ts` | normal | C5 | batched |
| 7 In-context request builder | 5 | new `runtime/context/in-context-compaction.ts`, `runtime/context/compaction.ts`, `evals/snapshot.ts` | high (request building) | C5 | alone, most capable |
| 8 Q9 boundary eval (gate G1) | 7 | new live test + fixture generator, spec §9.4 / §12 | normal (decision) | C6 | maintainer reads the result |
| 9 Wire the in-context summary | 7, 8 | `runtime/model-call.ts`, `runtime/compaction.service.ts`, `runtime/run-steps.ts`, `runtime/context/build.ts`, `conversations/events.ts` | high (request building, replay) | C7 | alone, most capable |
| — PR-B, release R2 | 4–10 | core | — | — | — |
| P1 Plugins SDK bump | R1 | plugins root, every plugin's ModelInfo literals | normal | P1 | batched |
| P2 anthropic | P0, P1 | `plugins/anthropic` | normal | P2 | batched |
| P3 openai | P0, P1 | `plugins/openai` | normal | P2 | batched |
| P4 openai-compatible | P0, P1 | `plugins/openai-compatible` | normal | P2 | batched |
| P5 deepseek | P0, P1 | `plugins/deepseek` | normal | P2 | batched |
| P6 bailian | P0, P1 | `plugins/bailian` | normal | P2 | batched |
| P7 ark | P0, P1 | `plugins/ark` | normal | P2 | batched |
| — plugins release R3 | P1–P7 | plugins Version Packages PR | — | — | — |
| 11 Core bootstrap pins | R1, R3 | `packages/kernel/bootstrap.json` | normal | C8 | batched |

Shared-file rules: `packages/kernel/test/unit-tests.json` is touched by Tasks 4, 5, 6, 7 and 9; each adds only its own lines at their sorted position, and when two tasks of one wave touch it (Tasks 6 and 7 in C5) the orchestrator resolves the one-line conflict while cherry-picking. `apps/web/messages/{en,zh}.json` belong to Task 10 only (Task 1 reuses the existing `models.capability.caching` key). In wave P2 each task owns exactly its plugin directory plus its own `.changeset/pre/*.md` entry; the plugins skill text (`.agents/skills/writing-model-providers/SKILL.md`) belongs to P1.

## Release sequencing (cross-repo)

1. **Core PR-A** (Tasks 1–3, one branch, opened after wave C2, marked ready, merged by the maintainer). The Version Packages PR then publishes **R1**: `@capybara-hq/plugin-sdk`, `@capybara-hq/testing`, `@capybara-hq/plugin-model-fake` and the kernel. Old plugins keep working against it: the kernel never read `capabilities.caching`, and a model without `cache` is "not caching" (no `cacheTtl` sent).
2. **Core PR-B** (Tasks 4–10, a branch from main after PR-A merged; P0's spec revision travels in it). Released as **R2** through the next Version Packages PR. It does not wait for the plugins: the in-context summary needs no declaration, and `cacheTtl` is only sent once a plugin declares options.
3. **Plugins PR-1** (P1) after R1: bump the exact versions in `pnpm-workspace.yaml` `overrides` and the root `devDependencies` (plugin-sdk, testing, plugin-model-fake, kernel) to R1's versions, the six model plugins' `dependencies` ranges to `^<R1 sdk version>`, and remove `capabilities.caching`. One plugin-sdk instance is required (connector e2e checks `instanceof ToolError` across packages).
4. **Plugins PR-2** (P2–P7, after PR-1 merged and P0 recorded). Its Version Packages PR publishes **R3**.
5. **Core PR-C** (Task 11) after R3: bootstrap pins and marketplace commit, released with the next core release.

PR-A and PR-B are reviewed by the maintainer; the final whole-branch review runs per PR.

---

### Task 1: SDK cache contract and core consumers

**Files:**
- Modify: `packages/plugin-sdk/src/model.ts` (`ModelInfo` at 58–100, `ModelRequest` at 307–340, `ModelUsage` at 350–363)
- Modify: `packages/plugin-sdk/src/index.ts` (exports, if not re-exported by `export *`)
- Create: `packages/plugin-sdk/test/model-cache.test.ts`
- Modify: `packages/plugin-sdk/agent-docs/extension-points/model-provider.md` (one paragraph: the declaration, `cacheTtl`, `cacheWriteByTtl`)
- Modify: `packages/plugin-sdk/api/plugin-sdk.api.md` (generated by `pnpm gen:sdk-api`)
- Modify (mechanical, drop `caching:` from `capabilities`, add `cache` only where a test needs one): `plugins/model-fake/src/script.ts:494`, `packages/testing/fixtures/extensions/*` that build `ModelInfo`, `packages/kernel/test/fixtures/plugins/*/index.ts`, `packages/kernel/test/helpers/runtime.ts`, `packages/kernel/test/runtime/context/fixtures.ts`, and the kernel / web tests the grep `capabilities[^}]*caching` lists
- Modify: `apps/web/src/lib/models.ts:16-23` (`ModelCapabilities` loses `caching`; `AdminModelInfo` gains `cache?: { mechanism: "explicit" | "implicit" | "none" }`), `apps/web/src/components/ModelCatalog.tsx:45-70` (the "caching" item comes from `m.cache?.mechanism` being `explicit` or `implicit`; same i18n key), and the web tests that build model info
- Modify: `.agents/skills/writing-model-providers/SKILL.md:28,154` (the declaration replaces `caching`)
- Create: `.changeset/model-cache-contract.md` (`@capybara-hq/plugin-sdk`, `@capybara-hq/plugin-model-fake`, `@capybara-hq/testing`: minor-in-rc wording as the repo's other changesets)

**Interfaces:**
- Produces (SDK, exact names):

```ts
export type ModelCacheMechanism = "explicit" | "implicit" | "none";
export interface ModelCacheInfo {
  mechanism: ModelCacheMechanism;
  ttlOptions: number[];          // seconds, ascending, unique; [] when the service decides alone
  defaultTtl?: number;           // seconds; in ttlOptions when ttlOptions is non-empty
  ttlIsMinimum: boolean;
  refreshOnHit: boolean;
  ttlClock: "request_start" | "unknown";
  minTokens?: number;
  guaranteed: boolean;
}
// ModelInfo: `cache?: ModelCacheInfo` (absent = mechanism "none"); `capabilities.caching` removed
// ModelRequest: `cacheTtl?: number`
export interface CacheWriteByTtl { ttl: number; tokens: number }
// ModelUsage: `cacheWriteByTtl?: CacheWriteByTtl[]`
export function validateModelCache(cache: ModelCacheInfo | undefined): string | null;
export function validateCacheWriteByTtl(usage: ModelUsage): string | null;
```

- [ ] **Step 1: Write the failing tests** in `packages/plugin-sdk/test/model-cache.test.ts`:
  - `validateModelCache` accepts `undefined`, `{ mechanism: "none", ttlOptions: [], ttlIsMinimum: false, refreshOnHit: false, ttlClock: "unknown", guaranteed: false }`, Anthropic's `{ explicit, [300, 3600], defaultTtl 300, ttlIsMinimum false, refreshOnHit true, request_start, guaranteed true }`, OpenAI 5.6+'s `{ implicit, [1800, 43200], defaultTtl 1800, ttlIsMinimum true, refreshOnHit true, unknown, guaranteed true }` and DeepSeek's `{ implicit, [], ttlIsMinimum false, refreshOnHit false, unknown, guaranteed false }` (each returns `null`);
  - it rejects, each with a message naming the field: a TTL of `0`, `-300` or `1.5`; `ttlOptions` `[3600, 300]` (not ascending) and `[300, 300]`; `defaultTtl: 600` with options `[300, 3600]`; `mechanism: "none"` with options or `guaranteed: true`; `guaranteed: true` with neither options nor `defaultTtl`; `minTokens: 0`;
  - `validateCacheWriteByTtl` returns `null` with the field absent and for `[{ttl: 300, tokens: 40}, {ttl: 3600, tokens: 60}]` with `cacheWriteTokens: 100`; rejects a sum of 99, a duplicate `ttl`, a negative or fractional `tokens`.
- [ ] **Step 2: Run** `pnpm exec vitest run packages/plugin-sdk/test/model-cache.test.ts` — FAIL (functions not exported).
- [ ] **Step 3: Implement** the types and both validators in `model.ts`; remove `caching` from `capabilities`; document each field with the spec §9.2 comment text; `cacheTtl` doc: "seconds, one of the model's `ttlOptions`; a plugin of a model without options ignores it; the plugin maps it to the vendor's field"; `cacheWriteByTtl` doc: "optional; sums to `cacheWriteTokens`; from the vendor's per-tier write counts".
- [ ] **Step 4: Run** the test — PASS. Then `pnpm typecheck` and fix every consumer the compiler lists (mechanical edits above). model-fake keeps compiling with no `cache` (Task 3 adds it).
- [ ] **Step 5: Regenerate** `pnpm gen:sdk-api`; `pnpm check:sdk-api` and `pnpm check:api-changeset --base origin/main` pass; `pnpm check:web-api-parity` passes (the admin models route returns the SDK `ModelInfo`, so the web type must match: `cache` optional, no `caching`).
- [ ] **Step 6: Run** `pnpm exec vitest run packages/plugin-sdk apps/web/test/model-catalog.test.tsx apps/web/test/models.test.tsx plugins/model-fake` — PASS. Add one assertion to `apps/web/test/model-catalog.test.tsx`: a chat model with `cache: { mechanism: "explicit", … }` shows "Caching" in its capabilities cell, one without `cache` does not.
- [ ] **Step 7: Commit** `feat(plugin-sdk)!: declare prompt caches per model` (body: replaces `capabilities.caching`; adds `cacheTtl` and `cacheWriteByTtl`; Refs #974).

### Task 2: Conformance suite checks the cache contract

**Files:**
- Modify: `packages/testing/src/model-conformance.ts` (the `caching` case at 283–296, the `usage` case at 298–304, a new case)
- Modify: `packages/testing/test/model-conformance.test.ts`

**Interfaces:**
- Consumes: `validateModelCache`, `validateCacheWriteByTtl`, `ModelCacheInfo` (Task 1).
- Produces: suite cases `"declares a valid cache"`, `"cache ttl options"`; `expect.caching` keeps its meaning (run the cache-hit case).

- [ ] **Step 1: Write the failing tests** in `packages/testing/test/model-conformance.test.ts` against an in-file fake provider: a provider whose model declares `defaultTtl: 600` with options `[300, 3600]` fails `"declares a valid cache"` with the validator's message; a provider reporting `cacheWriteByTtl` that sums to `cacheWriteTokens − 1` fails `"usage"`; a provider declaring options `[300, 3600]` receives two requests in `"cache ttl options"`, one with `cacheTtl: 300` and one with `cacheTtl: 3600`, both completing with `end_turn`; a model without `cache` skips `"cache ttl options"`.
- [ ] **Step 2: Run** `pnpm exec vitest run packages/testing/test/model-conformance.test.ts` — FAIL.
- [ ] **Step 3: Implement** the three checks: `"declares a valid cache"` runs `validateModelCache(info.cache)` for the target model from `listModels()`; `"usage"` adds `expect(validateCacheWriteByTtl(u)).toBeNull()`; `"cache ttl options"` sends the `caching` case's request once per option (skips when `ttlOptions` is empty). The cache-hit case (`caching`) is unchanged.
- [ ] **Step 4: Run** the test — PASS; also `pnpm exec vitest run plugins/model-fake/test/conformance.test.ts`.
- [ ] **Step 5: Commit** `feat(testing): check cache declarations in the model conformance suite` with a `.changeset` entry for `@capybara-hq/testing` (or extend Task 1's changeset file if it already names the package).

### Task 3: model-fake declares and honors its cache

**Files:**
- Modify: `plugins/model-fake/src/script.ts` (model options and `infosOf` near 494; `cacheUsage` near 512)
- Modify: `plugins/model-fake/test/model-fake.test.ts`
- Modify: the script syntax doc comment in `plugins/model-fake/src/script.ts` where the model options are documented

**Interfaces:**
- Produces: per-model script option `cache?: ModelCacheInfo | "none"`; default declaration `FAKE_CACHE = { mechanism: "explicit", ttlOptions: [300, 3600], defaultTtl: 300, ttlIsMinimum: false, refreshOnHit: true, ttlClock: "request_start", minTokens: 1, guaranteed: true }`; usage reports `cacheWriteByTtl: [{ ttl, tokens }]` on a cache write, where `ttl = req.cacheTtl ?? defaultTtl`.

- [ ] **Step 1: Write the failing tests** in `model-fake.test.ts`: `listModels()` returns `cache` equal to `FAKE_CACHE` by default and no `cache` for a model scripted with `cache: "none"`; a first request with a cached system block and `cacheTtl: 3600` reports `cacheWriteTokens > 0` and `cacheWriteByTtl` `[{ ttl: 3600, tokens: cacheWriteTokens }]`; the same request again reports `cacheReadTokens > 0`; a model with `cache: "none"` reports zero cache tokens.
- [ ] **Step 2: Run** `pnpm exec vitest run plugins/model-fake` — FAIL.
- [ ] **Step 3: Implement**: the kv entry TTL is `req.cacheTtl ?? 300` seconds (was a fixed 300); a model with `"none"` never counts cache tokens.
- [ ] **Step 4: Run** `pnpm exec vitest run plugins/model-fake` — PASS.
- [ ] **Step 5: Commit** `feat(model-fake): declare a prompt cache and honor cacheTtl` (changeset `@capybara-hq/plugin-model-fake`).

**After wave C2:** open core PR-A (Tasks 1–3), body `Refs #974`, ending with the attribution line; after merge, the Version Packages PR is R1.

### Task P0: Verify the unverified vendor facts (Q12)

Runs in wave C3, in parallel with Task 4; no code. It must finish before P2–P7 start.

**Files:**
- Modify: `docs/superpowers/specs/2026-11-27-idle-compaction-design.md` §9.1 (table and "Sources and details": each "Unverified" replaced by the verified fact with its source, or kept as "unverified" with what was tried) and §12 Q12 (closed, with a one-line answer per item); travels in PR-B.

**Checks, each answered with an official documentation URL and, where a key exists in `~/.capybara-test.env`, a live probe** (a throwaway script in the session scratchpad sending raw HTTP with the env loaded inside the command; the record keeps the request shape and the usage fields observed, never a key or a response body with account data):

- [ ] OpenAI: `prompt_cache_options` (`ttl`, `mode`) on the Responses API for a GPT-5.6+ model (our plugin uses Responses: `instructions` in `plugins/openai/src/map-request.ts:243`); whether Chat Completions accepts it (record, not needed by our plugin); the `24h` `prompt_cache_retention` tier's refresh behavior and price; the `cache_write_tokens_details.ttl_30m_tokens` / `ttl_12h_tokens` field names in the Responses usage object; which model ids are "5.6 and later" (the id pattern P3 matches).
- [ ] Bailian: whether Qwen4's `prompt_cache_options: { ttl: "1h" }` is accepted on the DashScope native `generation` endpoint our plugin uses (`plugins/bailian/src/map-request.ts`), and the usage field names of its TTL split; whether the explicit `cache_control` 5-minute cache on general models restarts on a hit (as documented).
- [ ] openai-compatible `qwen` dialect: since plugins#304 it places DashScope explicit markers (`cacheFields: "dashscope"`), so it is an explicit 5-minute cache, not implicit (spec §9.5 item 5 predates #304): confirm on the compatible-mode endpoint with a live probe (second request reports cached tokens).
- [ ] DeepSeek: minimum cacheable length and unit size; any configurable lifetime.
- [ ] Ark: hit price and storage price of the implicit cache; the Context API's TTL range (read the page body, not a search summary).
- [ ] Anthropic: the per-model minimum cacheable length (512–4096) for each model id the anthropic plugin lists, for `minTokens`.
- [ ] **Commit** `docs(idle-compaction): record the verified vendor cache facts` and post the table in the PR-B description. If a fact changes a declaration in P2–P7, the task text below follows the spec revision (the spec wins).

### Task 4: `promptCache` settings (platform and org)

**Files:**
- Modify: `packages/kernel/src/identity/settings.ts` (beside `COMPACTION_FIELDS` 205–259; `DEPLOYMENT_SETTINGS` 262+; `DEPLOYMENT_SETTINGS_PATCH` 387+; the patch merge at 1060–1100)
- Modify: `packages/kernel/src/orgs/settings.service.ts` (org override at 255–258, patch at 332–336, the "follow platform" platform values at 409–410, merge at 953–992)
- Modify: `packages/kernel/src/runtime/compaction-settings.service.ts` (a resolver for the new group)
- Create: `packages/kernel/test/runtime/prompt-cache-settings.test.ts` (unit; add to `unit-tests.json`)
- Modify: `packages/kernel/test/identity/settings.test.ts`, `packages/kernel/test/orgs/settings.test.ts` (HTTP round trips)
- Create: `.changeset/prompt-cache-setting.md` (`@capybara-hq/capybara`)

**Interfaces:**
- Produces:

```ts
export const PROMPT_CACHE_SETTINGS = z.object({ longTtl: z.boolean().default(false) });
export type PromptCacheSettings = z.infer<typeof PROMPT_CACHE_SETTINGS>;
export const PROMPT_CACHE_SETTINGS_PARTIAL = z.object({ longTtl: z.boolean() }).partial();
export const PROMPT_CACHE_SETTINGS_PATCH = PROMPT_CACHE_SETTINGS_PARTIAL.strict();
export function effectivePromptCacheSettings(
  platform: PromptCacheSettings,
  org: z.infer<typeof PROMPT_CACHE_SETTINGS_PARTIAL> | undefined,
): PromptCacheSettings;
// DeploymentSettings.promptCache (prefault {}); DEPLOYMENT_SETTINGS_PATCH.promptCache optional;
// org settings: promptCache override (partial, .catch(undefined)), patch nullable (null = follow)
export async function resolvePromptCacheSettings(settings, db, orgId): Promise<PromptCacheSettings>;
// CompactionSettingsService.resolvePromptCache(orgId): Promise<PromptCacheSettings>
```

- [ ] **Step 1: Write the failing unit test** `prompt-cache-settings.test.ts`: `PROMPT_CACHE_SETTINGS.parse({})` is `{ longTtl: false }`; `effectivePromptCacheSettings({ longTtl: false }, { longTtl: true })` is `{ longTtl: true }`, with `undefined` org it follows the platform; `PROMPT_CACHE_SETTINGS_PATCH.safeParse({ longTTL: true }).success` is false (strict).
- [ ] **Step 2: Run** `pnpm exec vitest run packages/kernel/test/runtime/prompt-cache-settings.test.ts` — FAIL.
- [ ] **Step 3: Implement** the schemas, the merge (mirrors `effectiveCompactionSettings`), the deployment patch merge (`next.promptCache = { longTtl: patch.longTtl ?? current.promptCache.longTtl }`), the org override and patch (an empty override = none, as compaction at 988–992), `platformPromptCache` beside the platform compaction read (535–538) for the org page's "follow the platform" values, and the resolver (reads the platform settings and the org row once, like `resolveCompactionSettings`).
- [ ] **Step 4: Run** the unit test — PASS. Extend `identity/settings.test.ts` (`PATCH /admin/settings { promptCache: { longTtl: true } }` then `GET` returns it; `{ promptCache: { longTTL: true } }` is 400) and `orgs/settings.test.ts` (org patch `{ promptCache: { longTtl: true } }` then `null` follows the platform again); run both — PASS.
- [ ] **Step 5: Run** `pnpm exec vitest run tools/checks/test/platform-parity.test.ts` and `pnpm check:platform-ops`, `pnpm check:web-api-parity` — PASS (no new route; the fields join the shared schemas the existing operations are built from).
- [ ] **Step 6: Commit** `feat(settings): add the promptCache.longTtl platform and org setting`.

### Task 5: Choose, record and replay `cacheTtl`

High risk: request building. Most capable model; reviewed alone.

**Files:**
- Create: `packages/kernel/src/runtime/context/cache-ttl.ts`
- Create: `packages/kernel/test/runtime/context/cache-ttl.test.ts` (unit; `unit-tests.json`)
- Modify: `packages/kernel/src/runtime/context/build.ts` (`BuildModelRequestInput`, `ModelCallMeta`, `buildModelRequest`: set `request.cacheTtl` and `meta.cacheTtl` when given)
- Modify: `packages/kernel/src/runtime/model-call.ts` (`buildRequest` 1091–1124 takes `cacheTtl`; `runModelStep` resolves `promptCache` once per step via `deps.compactionSettings.resolvePromptCache` next to the compaction settings at 762, and per rung computes `selectCacheTtl(info.cache, longTtl)`, wrap-up included; the `ModelStepDeps.compactionSettings` pick gains `resolvePromptCache`)
- Modify: `packages/kernel/src/conversations/events.ts` (`model_call.request.cacheTtl: count.optional()` with a doc comment "transport option, not model-visible: no DriftReason"; `ModelUsageShape.cacheWriteByTtl: z.array(z.object({ ttl: count, tokens: count })).exactOptional()`)
- Modify: `packages/kernel/src/evals/reconstruct.ts` (`reconstructInputs` near 395–430)
- Modify: `packages/kernel/test/runtime/model-call.test.ts`, `packages/kernel/test/evals/reconstruct.test.ts`
- Modify: `.agents/skills/replay-evals/SKILL.md` (one bullet: `cacheTtl` is a recorded transport option, no `DriftReason`; baseline sends the recorded value, a candidate recomputes it)

**Interfaces:**
- Consumes: `ModelCacheInfo`, `validateModelCache` (Task 1); `resolvePromptCache` (Task 4); model-fake's declaration (Task 3).
- Produces:

```ts
export const LONG_CACHE_MIN_TTL = 1800;
/** off → undefined; invalid or "none" declaration → undefined; else the smallest option ≥ 1800 s, or undefined. */
export function selectCacheTtl(cache: ModelCacheInfo | undefined, longTtl: boolean): number | undefined;
/** The declaration the kernel trusts: undefined when absent or invalid (validateModelCache). */
export function trustedCache(cache: ModelCacheInfo | undefined): ModelCacheInfo | undefined;
// BuildModelRequestInput.cacheTtl?: number; ModelCallMeta.cacheTtl?: number
```

- [ ] **Step 1: Run the zero-drift baseline** `pnpm exec vitest run packages/kernel/test/evals/reconstruct.test.ts` — PASS on the branch base (record it in the task report).
- [ ] **Step 2: Write the failing unit test** `cache-ttl.test.ts`: `selectCacheTtl(anthropic, false)` is `undefined`; `selectCacheTtl(anthropic /*[300,3600]*/, true)` is `3600`; OpenAI 5.6+ `[1800, 43200]` with `true` is `1800`; Bailian `[300]` with `true` is `undefined`; `undefined` and `mechanism: "none"` are `undefined`; an invalid declaration (`defaultTtl: 600`, options `[300, 3600]`) with `true` is `undefined` and `trustedCache` of it is `undefined`.
- [ ] **Step 3: Run** it — FAIL. **Step 4: Implement** `cache-ttl.ts`; run — PASS.
- [ ] **Step 5: Write the failing integration tests** in `model-call.test.ts` (model-fake with its default declaration): with the org's `promptCache.longTtl` on, the step's `model_call.request.cacheTtl` is `3600` and the request model-fake received carries `cacheTtl: 3600`; with it off the field is absent from both; the step's `usage` event carries `cacheWriteByTtl` as model-fake reported it; a fallback rung on a model scripted `cache: "none"` records no `cacheTtl`.
- [ ] **Step 6: Write the failing zero-drift case** in `reconstruct.test.ts` "baseline zero drift": a run with `longTtl` on reconstructs with empty `drift` and a request equal to the sent one including `cacheTtl: 3600`; a candidate model whose declaration has no option ≥ 1800 reconstructs without `cacheTtl` and with no drift reason added.
- [ ] **Step 7: Run** both files — FAIL. **Step 8: Implement**: build.ts copies `cacheTtl` into the request and meta; model-call.ts passes it; reconstruct.ts: a baseline uses `rec.cacheTtl` when it is still one of `trustedCache(opts.model.cache)?.ttlOptions`, else omits it; a candidate uses `selectCacheTtl(opts.model.cache, rec.cacheTtl !== undefined)`. No `DriftReason` either way. Hook payloads stay unchanged (`hookRequestOf` does not forward `cacheTtl`; spec §8.1).
- [ ] **Step 9: Run** `model-call.test.ts`, `reconstruct.test.ts` and `cache-ttl.test.ts` — PASS; then the zero-drift file once more in full — PASS.
- [ ] **Step 10: Commit** `feat(runtime): choose the prompt cache tier per request and record it` (changeset `@capybara-hq/capybara`).

### Task 10: Prompt cache settings UI

Wave C4, parallel with Task 5 (disjoint: `apps/web` only).

**Files:**
- Create: `apps/web/src/components/settings/PromptCacheSection.tsx` (design components only: `FormSection` + switch field + hint, modeled on `CompactionSection.tsx`, including the org "follow the platform" state)
- Modify: `apps/web/src/app/(app)/admin/settings/view.tsx` (after `CompactionSection` at 490), `apps/web/src/app/(app)/settings/organization/view.tsx` (after 372)
- Modify: `apps/web/src/lib/admin.ts` (deployment settings type gains `promptCache?: { longTtl: boolean }` and the patch type), `apps/web/src/lib/org-settings.ts` (override, patch with `null`, platform values)
- Modify: `apps/web/messages/en.json`, `apps/web/messages/zh.json` (new `promptCache` namespace)
- Create: `apps/web/test/prompt-cache-settings.test.tsx`

**Interfaces:**
- Consumes: the HTTP shape of Task 4 (`promptCache.longTtl` in `GET/PATCH /admin/settings` and the org settings routes).
- Copy (spec §6.4 without its last sentence, decision D7): title "Prompt cache" / "提示缓存"; field `promptCache.longTtl`: "Long prompt cache" / "长提示缓存"; hint en "Requests use the model's cache tier of at least 30 minutes (such as 1 hour); cache writes are billed at the long tier's price (Anthropic about 2× the input price instead of 1.25×)." zh "请求改用模型至少 30 分钟的缓存档（如 1 小时），缓存写入按长档计价（Anthropic 约为输入价的 2 倍，而 5 分钟档约 1.25 倍）。" The spec's last sentence ("Idle compaction runs on these models only with this on." / "开启后空闲压缩才会在这些模型上运行。") is left out: UI copy does not describe a feature that has not shipped. Phase 2 restores it (see "Notes for phase 2"). The test asserts that the hint does not mention idle compaction.

- [ ] **Step 1: Write the failing test** `prompt-cache-settings.test.tsx` (`renderRouteWithCache`): the platform settings page shows the "Long prompt cache" switch off by default, with the hint text above in en and zh and no mention of idle compaction (`/idle|空闲/` does not match); toggling it sends `PATCH /admin/settings` with `{ promptCache: { longTtl: true } }`; the org page shows "Follow the platform settings" with the platform's value, and saving an override sends `{ promptCache: { longTtl: true } }`, resetting sends `{ promptCache: null }`; a member without the settings role sees the read-only state (roles everywhere).
- [ ] **Step 2: Run** `pnpm exec vitest run apps/web/test/prompt-cache-settings.test.tsx` — FAIL.
- [ ] **Step 3: Implement** the section and wire it; reads via the existing `defineQuery` of each page, writes via the existing `useAppMutation`.
- [ ] **Step 4: Run** the test, `apps/web/test/admin-settings.test.tsx`, `apps/web/test/org-settings.test.tsx` — PASS; `pnpm check:web-ui`, `pnpm check:i18n`, `pnpm check:web-api-parity` — PASS.
- [ ] **Step 5: Commit** `feat(web): prompt cache settings on the platform and organization pages`.

### Task 6: Derive the cache expiry from the log

Wave C5. The phase 2 seam; phase 1 has no runtime caller besides tests.

**Files:**
- Create: `packages/kernel/src/runtime/context/cache-expiry.ts`
- Create: `packages/kernel/test/runtime/context/cache-expiry.test.ts` (unit; `unit-tests.json`)

**Interfaces:**
- Consumes: `trustedCache` (Task 5), `model_call.request.cacheTtl` and `usage.cacheWriteByTtl` (Task 5).
- Produces:

```ts
export const CACHE_FIRE_RATIO = 0.9;
export const CACHE_EXPIRY_MARGIN_MS = 30_000;
export interface CacheExpiry {
  callSeq: number;      // the model_call the expiry was derived from
  t0: number;           // epoch ms
  ttl: number;          // seconds (L)
  expiresAt: number;    // epoch ms; a lower bound when isMinimum
  fireAt: number;       // min(t0 + 0.9 L, expiresAt − 30 s)
  isMinimum: boolean;
}
export function deriveCacheExpiry(
  events: readonly ConversationEvent[],
  cacheOf: (provider: string, model: string) => ModelCacheInfo | undefined,
): CacheExpiry | null;
```

Rules (spec §9.3, decided here where the spec leaves a choice): a step call is a `model_call` paired with the next `usage` event of the same `runId` and `step` whose `purpose` is absent; only calls whose `trustedCache(...)` is `guaranteed` count; the chosen call is the latest with `cacheReadTokens + cacheWriteTokens > 0`; `L = request.cacheTtl ?? cache.defaultTtl` (none → `null`); `t0` is the `model_call` event's `createdAt` with `ttlClock: "request_start"` (the event is appended in the transaction just before the request is sent, so it is never later than the start: no `startedAt` field is added) and the paired `usage` event's `createdAt` with `"unknown"`; with `refreshOnHit: false` the chosen call is the latest with `cacheWriteTokens > 0` instead; compaction, title and other side-call usage events are ignored (they may refresh the entry later, so ignoring them gives an earlier, safe expiry).

- [ ] **Step 1: Write the failing tests**: recorded `cacheTtl` 3600 wins over `defaultTtl` 300; no recorded value uses `defaultTtl`; a later call with zero cache tokens does not move the expiry; `refreshOnHit: false` takes the last write, not the last read; `ttlClock: "unknown"` takes the usage time; `fireAt` for `L = 1800` is `t0 + 1620 s`, for `L = 60` it is `expiresAt − 30 s`; `isMinimum` follows `ttlIsMinimum`; a non-guaranteed model (DeepSeek), an invalid declaration, or a log without step usage returns `null`; a compaction `usage` event with cache reads after the last call is ignored.
- [ ] **Step 2: Run** `pnpm exec vitest run packages/kernel/test/runtime/context/cache-expiry.test.ts` — FAIL. **Step 3: Implement.** **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(runtime): derive the prompt cache expiry from the event log`.

### Task 7: The in-context summary request (pure builder)

Wave C5, parallel with Task 6. High risk: request building. Most capable model; reviewed alone.

**Files:**
- Create: `packages/kernel/src/runtime/context/in-context-compaction.ts`
- Modify: `packages/kernel/src/runtime/context/compaction.ts` (split `COMPACTION_INSTRUCTION` at 32–65 into shared parts; `buildCompactionRequest` unchanged in output)
- Modify: `packages/kernel/src/evals/snapshot.ts` (factor the definitions / tool specs loading out of `takeSnapshot`; add `liveSnapshot`)
- Create: `packages/kernel/test/runtime/context/in-context-compaction.test.ts` (unit; `unit-tests.json`)
- Modify: `packages/kernel/test/runtime/context/compaction.test.ts` (the transcript instruction is byte-identical to before the split)

**Interfaces:**
- Consumes: `reconstructInputs`, `reconstructFromInputs` (`evals/reconstruct.ts`), `assembleModelRequest` (`runtime/model-call.ts`), `CaseSnapshot` / `toEvents`, `compactionRetryNote`, `estimateTokens`; `cacheTtl` in requests (Task 5).
- Produces:

```ts
export type InContextBoundary =
  | { mode: "marked"; firstKeptSeq: number }   // summarize before the first kept user message
  | { mode: "all" };                            // summarize everything; empty tail
export type InContextSkip =
  | "no_model_call" | "model_mismatch" | "fit_plan" | "drift" | "prefix_mismatch"
  | "too_large" | "boundary_ambiguous";
export function inContextInstruction(anchor: string | null): string;  // anchor null = "all"
export function buildInContextCompactionRequest(input: {
  snapshot: CaseSnapshot;            // liveSnapshot of the last step call's run
  events: readonly ConversationEvent[];  // every event the compaction holds
  absorbedUpToSeq: number;           // the compacting step's (a compact run: consumed_seq)
  model: ModelInfo;                  // the model the compaction would use
  mediaInfo?: ReadonlyMap<string, MediaInfo>;
  media?: ReadonlyMap<string, MediaBytes | null>;
  reserveTokens: number;
  summaryCap: number;
  boundary: InContextBoundary;
  retry: boolean;
}): { request: ModelRequest; lastCallSeq: number; estimate: number } | { skip: InContextSkip };
// evals/snapshot.ts
export async function liveSnapshot(db: KernelSchemaDb, input: {
  orgId: string; conversationId: string; runId: string; agentId: string;
  events: readonly ConversationEvent[];
}): Promise<CaseSnapshot>;  // no terminal event required, no byte cap (nothing is stored)
```

Builder algorithm (the decisions the spec leaves open; S1 and D2 in the PR description):

1. The reference is the conversation's latest step `model_call` (any run; a compact run's own calls are not `model_call`s). None → `no_model_call`; `model.id !== call.payload.model` → `model_mismatch`; `call.payload.request.fit !== undefined` → `fit_plan`.
2. Baseline: `reconstructInputs(snapshot, call.seq, { model, mediaInfo, media })` then `reconstructFromInputs`; any drift, or an `ApiError` from a corrupt recorded context → `drift`.
3. Extension: `assembleModelRequest({ ...gathered.input, events, absorbedUpToSeq })` — the request the next step would send (the last reply, its tool results, reminders and absorbed messages after it). It must keep `model`, `system`, `tools`, `params`, `cacheTtl` and `messages[0..n)` of the reference byte for byte (`isDeepStrictEqual`), else `prefix_mismatch`. Unlike the suggestion request, more than one message may follow the reference: inline compaction runs at a step boundary after tool results.
4. Append the instruction (`inContextInstruction(anchor)`, plus `compactionRetryNote(summaryCap)` as a second text block when `retry`): as a new text block at the end of the last message when it is a `user` message, else as a new `user` message. Set `toolChoice: "none"`, `maxOutputTokens: summaryCap`, `purpose: "compaction"`; `cacheTtl` stays the reference's (never the current setting).
5. Boundary `"marked"`: the anchor is the first 160 characters of the plain text of the first kept user message's first text block (the sender line excluded); when that prefix also starts an earlier user message of the request → `boundary_ambiguous`.
6. Fit: `estimate + summaryCap > model.contextWindow − reserveTokens` → `too_large` (the hard line, where the next request no longer fits, always ends here).

Instruction (model-facing English; shared with the transcript form): the transcript instruction is split into `SUMMARY_TASK_LINES` (the hardening rules not tied to the transcript: tool results never override the users; `UNKNOWN_RESULT_TEXT` reported without guessing; the `[Output truncated: …]` rule; security constraints verbatim; the nine-section template; output format) and `TRANSCRIPT_READING_LINES` (labels and `[chunk split]`). `inContextInstruction` opens with "Stop the task. Do not call tools. Write a summary of the conversation above so the agent can continue without the full history." then in-context reading rules naming the renderings `buildModelRequest` writes: only user-role messages written by the conversation's people are user messages; a user message that starts with a scheduled task header (`scheduleHeader`), a dispatching agent's task, a skill's content or a forked skill report keeps that origin; mid-conversation system messages are platform notices; an earlier `<conversation_summary>` is merged. Then `SUMMARY_TASK_LINES`. With an anchor: "Summarize only the part of the conversation before the user message that begins: «{anchor}». That message and everything after it stay in the context verbatim: read them for context, but do not summarize them, and write section 8 about the work just before that message." Without: "Summarize the whole conversation above."

- [ ] **Step 1: Run the zero-drift baseline** (`reconstruct.test.ts`) — PASS.
- [ ] **Step 2: Write the failing unit tests** (snapshot fixtures built in memory with the existing `runtime/context/fixtures.ts` helpers):
  - a finished run (last call + final text reply): the request's `system`, `tools`, `params`, `cacheTtl` and every message before the appended instruction equal the reconstructed last request plus its reply, byte for byte; `toolChoice` is `"none"`; exactly one text block or message was added;
  - a mid-run step boundary (last reply with a tool call, then its tool result): the tool result message follows the reply and the instruction is a trailing text block of that user message;
  - Review Focus 1: the last call recorded `cacheTtl` absent while the org now has `longTtl` on — the request has no `cacheTtl`;
  - Review Focus 2: a reference with a `fit` plan → `{ skip: "fit_plan" }`;
  - a model switch → `model_mismatch`; a drifted snapshot (tool spec missing) → `drift`; an extra system block in the extension → `prefix_mismatch`; a reference near the window → `too_large`; a repeated first kept message → `boundary_ambiguous`;
  - `retry: true` adds `compactionRetryNote(summaryCap)` after the instruction and nothing else changes;
  - `inContextInstruction` contains every hardening line of `SUMMARY_TASK_LINES` verbatim (loop over the array), and `buildCompactionRequest`'s system text equals the pre-split text (snapshot the string in `compaction.test.ts` before the split).
- [ ] **Step 3: Run** `pnpm exec vitest run packages/kernel/test/runtime/context/in-context-compaction.test.ts packages/kernel/test/runtime/context/compaction.test.ts` — FAIL.
- [ ] **Step 4: Implement** the split, the builder and `liveSnapshot` (`takeSnapshot` keeps its behavior: terminal event, byte cap, through the shared loader).
- [ ] **Step 5: Run** both files and `packages/kernel/test/conversations/prompt-suggestion-request.test.ts`, `packages/kernel/test/evals/reconstruct.test.ts` — PASS.
- [ ] **Step 6: Commit** `feat(runtime): build an in-context compaction summary request`.

### Task 8: Q9 eval — can the in-context summary keep the tail? (gate G1)

Wave C6. Decides `IN_CONTEXT_BOUNDARY_MODE` for Task 9. Nothing depending on the mode starts before its result is recorded.

**Files:**
- Create: `packages/kernel/test/runtime/context/in-context-boundary.live.test.ts` (no database; joins `unit-tests.json`; skipped unless `CAPYBARA_TEST_COMPACTION_EVAL=1`), following `packages/kernel/test/sandbox/review-live.test.ts` (endpoint setup, env names, the "rerun once" note)
- Create: `packages/kernel/test/runtime/context/in-context-eval-fixtures.ts` (a seeded generator of long conversations)
- Modify: spec §9.4 last paragraph and §12 Q9 (the decision, the numbers and the date); travels in PR-B

**Method:**
- Fixtures: 20 conversations (fixed seeds), each 60–150k estimated tokens of realistic tool-using work (file reads, edits, command output, user corrections), built as event logs so `buildInContextCompactionRequest` builds the real request (marked mode, the plan's own `compactionPlan` boundary with `keepRecentTurns: 4`). Each plants 8 head facts before the boundary and 4 tail facts after it, every fact carrying a unique codeword (`ZQ-<seed>-H3`), one head fact being a security constraint ("never touch `secrets/`").
- Models: every vendor with a key in `~/.capybara-test.env`: Anthropic (`CAPYBARA_TEST_ANTHROPIC_MODEL`, default `claude-haiku-5-5`), OpenAI (`CAPYBARA_TEST_OPENAI_MODEL`), DeepSeek and Qwen through `CAPYBARA_TEST_OAICOMPAT_*`. The test sends the request through a minimal raw client per protocol (as review-live does), never the plugins.
- Metrics per model: tail leakage = share of conversations whose `<summary>` contains any tail codeword; head recall = share of head codewords present; constraint kept verbatim = share keeping the security constraint text. The same fixtures through the transcript request (`buildCompactionRequest` with the plan's transcript) give the baseline recall.
- **Decision rule:** `"marked"` if, for every model tested, tail leakage ≤ 1/20, head recall ≥ transcript recall − 0.05 and the constraint is kept in ≥ 19/20; otherwise `"all"` (the in-context summary covers everything up to the compaction point and keeps no verbatim tail; spec §9.4 fallback). At least two vendors must have been tested; with fewer, the rule cannot decide: the gate stops and the coordinator decides (D4).

- [ ] **Step 1: Write** the generator with a unit assertion (always runs): every fixture's planted codewords sit on the intended side of `compactionPlan(...).coversUpToSeq`, and the in-context builder returns a request (no skip) for each.
- [ ] **Step 2: Run** `pnpm exec vitest run packages/kernel/test/runtime/context/in-context-boundary.live.test.ts` without the env — the fixture assertion PASSES, the live block is skipped.
- [ ] **Step 3: Run live**: `set -a; . ~/.capybara-test.env; set +a; CAPYBARA_TEST_COMPACTION_EVAL=1 pnpm exec vitest run packages/kernel/test/runtime/context/in-context-boundary.live.test.ts` — the test prints only the metric table (no keys, no summaries).
- [ ] **Step 4: Record** the table, the decision and the date in spec §9.4 / §12 Q9 and in the ledger; set nothing in code yet (Task 9 reads the decision).
- [ ] **Step 5: Commit** `test(runtime): evaluate the in-context summary boundary` and `docs(idle-compaction): decide Q9`.

### Task 9: Every compaction tries the in-context summary first

Wave C7. High risk: request building and replay. Most capable model; reviewed alone.

**Files:**
- Modify: `packages/kernel/src/runtime/model-call.ts` (`runCompaction` 1286–1704; `CompactOptions` 1243–1257; the reactive call sites at 1868 and 1947; `ModelStepDeps`)
- Modify: `packages/kernel/src/runtime/run-steps.ts` (wire `liveSnapshot` into the deps from `KernelDb`)
- Modify: `packages/kernel/src/runtime/context/in-context-compaction.ts` (`IN_CONTEXT_BOUNDARY_MODE`, set to Task 8's decision)
- Modify: `packages/kernel/src/conversations/events.ts` (`compaction_summary.method: z.enum(["transcript", "in_context"]).optional()`, doc: not model-visible except through the framing below, which is derived from the log)
- Modify: `packages/kernel/src/runtime/context/build.ts` (`summaryText` framing by method, 822–875)
- Modify: `packages/kernel/test/runtime/model-call.test.ts`, `packages/kernel/test/conversations/compact.http.test.ts`, `packages/kernel/test/evals/reconstruct.test.ts`, `packages/kernel/test/runtime/context/build.test.ts`
- Modify: `docs/superpowers/specs/2026-11-14-context-compaction-design.md` (§4.2.2 framing sentence for in-context summaries; §4.5 note that the in-context request is never chunked)
- Modify: `.agents/skills/replay-evals/SKILL.md` (`compaction_summary.method`, the in-context side request)

**Interfaces:**
- Consumes: `buildInContextCompactionRequest`, `inContextInstruction`, `liveSnapshot` (Task 7); the Q9 decision (Task 8).
- Produces: `export const IN_CONTEXT_BOUNDARY_MODE: "marked" | "all"` (in `in-context-compaction.ts`, the value Task 8 decided); `CompactOptions.transcriptOnly?: boolean`; `ModelStepDeps.liveSnapshot(orgId, conversationId, runId, events): Promise<CaseSnapshot>`; phase 2 will add `CompactOptions.requireInContext` (not now).

Behavior:
- After the plan exists (`compactionPlan` and `openingSeqs` as today), unless `opts.transcriptOnly` (the reactive path sets it: its last request is the one that overflowed) or `opts.ref` names a model other than the last call's, the compaction builds the in-context request. With `"all"` the plan's `coversUpToSeq` becomes the last event the extension includes (the tail is empty) and `openingSeqs` is recomputed for it; with `"marked"` the boundary is the plan's first kept user message.
- A skip, a `liveSnapshot` error, or `MediaUnavailableError` → the transcript path exactly as today (chunked when large). The skip reason is a `debug` log line with `context=Compaction`.
- The in-context call runs in the same loop as the transcript call: `model.request` fires with purpose `compaction` (deny → `compaction_failed`), progress `summarizing` shows `chars` (no chunk counts), a `max_tokens` stop retries once with `retry: true` (#963; usage idem key `:retry`), a second cut-off fails; a tool call in the reply fails the attempt ("summary reply called a tool"); acceptance, `extractSummary` and `savedTokens` use `plan.transcript` as today.
- `compaction_summary.method` is `"in_context"` or `"transcript"`.
- Framing (`summaryText`): for `method: "in_context"` with a kept tail, the tail sentence reads "The messages after {anchor} are the most recent ones in the conversation, kept verbatim. The summary covers what came before them; something it says is still pending may already have happened in them." (the transcript form keeps "The summary was written without seeing them, …"). Derived from the logged summary: zero drift, no `DriftReason`.

- [ ] **Step 1: Run the zero-drift baseline** — PASS.
- [ ] **Step 2: Write the failing integration tests** in `model-call.test.ts` (model-fake reports cache reads on a repeated prefix):
  - an inline compaction after a cached step writes `compaction_summary.method: "in_context"`, the summary call's `usage` has `cacheReadTokens > 0` and `purpose: "compaction"`, and the request model-fake received has the last request's system and tools, `toolChoice: "none"` and the instruction last;
  - a `model_switched` between the last call and the compaction → `method: "transcript"`;
  - the reactive overflow path → `method: "transcript"`;
  - a hard-line compaction (next request over the window) → `"transcript"`;
  - model-fake scripted to stop at `max_tokens` once on the in-context call → a retry carrying the retry note, then `method: "in_context"`; twice → `compaction_failed` with the existing reason text;
  - model-fake scripted to answer the in-context call with a tool call → `compaction_failed`;
  - Review Focus 5: model-fake scripted to fail the in-context call with a non-retryable request error → `compaction_failed`, and the next eligible step's attempt follows the backoff;
  - a policy hook denying the in-context call → `compaction_failed` with the hook reason, as for the transcript call.
- [ ] **Step 3: Write the failing tests** in `compact.http.test.ts`: a manual compaction of a finished conversation writes `method: "in_context"`; Review Focus 3: a manual compaction right after an aborted run (assistant message `stopReason: "aborted"` with a tool call and no result) writes a summary (either method) and the request model-fake received has every tool call paired.
- [ ] **Step 4: Write the failing zero-drift cases** in `reconstruct.test.ts` "baseline zero drift": a run whose step compacted in context, followed by a message run, reconstructs both runs' calls with empty drift (the framing sentence for `in_context` asserted in the rebuilt request); the same for a transcript compaction (framing unchanged). And in `build.test.ts`: `summaryText` with `method: "in_context"` and a kept tail renders the new sentence.
- [ ] **Step 5: Run** the four files — FAIL. **Step 6: Implement.**
- [ ] **Step 7: Run** the four files, `packages/kernel/test/runtime/context/current-turn-compaction.test.ts`, `packages/kernel/test/runtime/permission-context-boundary.test.ts` and the full zero-drift file — PASS.
- [ ] **Step 8: Commit** `feat(runtime): summarize from the cached prefix for every compaction` (changeset `@capybara-hq/capybara`: compaction summaries reuse the prompt cache; `compaction_summary.method`).

**After wave C7:** `pnpm verify --fast` plus the changed tests; open core PR-B (Tasks 4–10, P0's and Task 8's spec revisions), body `Refs #974`, with the P0 fact table, the Q9 metric table and decision, and the decisions D1–D7 below.

### Task P1: Plugins move to the new SDK

Repository `capybara-hq/plugins`, a worktree from `origin/main` (`pnpm wt:new <branch> --from origin/main` there; the local main checkout is far behind). After R1.

**Files:**
- Modify: `pnpm-workspace.yaml` `overrides` (plugin-sdk, testing, plugin-model-fake, kernel to R1's exact versions), root `package.json` devDependencies (same versions), `plugins/{anthropic,openai,openai-compatible,deepseek,bailian,ark}/package.json` (`@capybara-hq/plugin-sdk` `^<R1 sdk>`; `@capybara-hq/testing` `^<R1 testing>`), `pnpm-lock.yaml`
- Modify (remove `caching` from every `ModelInfo` literal; no `cache` yet): `plugins/anthropic/src/index.ts:153`, `plugins/openai/src/index.ts:138`, `plugins/openai/src/image.ts:77`, `plugins/openai-compatible/src/index.ts:246`, `plugins/deepseek/src/list.ts:97`, `plugins/bailian/src/list.ts:157`, `plugins/ark/src/list.ts:130,191`, and the test literals (anthropic conformance 866; openai conformance 757, 787; openai-compatible conformance 38–40, 112, 328; ark list.test 81, 98, 126; bailian list.test 60, 83, conformance 39; deepseek list.test 47); the live gates that read `capabilities.caching` (`plugins/bailian/test/live/bailian.live.test.ts:154,191`, `plugins/ark/test/conformance.test.ts:637`) read `cache?.mechanism` instead
- Modify: `.agents/skills/writing-model-providers/SKILL.md` (capabilities list :28, history caching rules :111: the declaration, `cacheTtl` mapping, `cacheWriteByTtl`); READMEs of ark, bailian, deepseek where they say "caching"
- Create: `.changeset/pre/sdk-cache-contract.md` (the six plugins, patch)

- [ ] **Step 1:** bump and `pnpm install`; `pnpm typecheck` lists every `caching` site; fix them.
- [ ] **Step 2:** `pnpm test` (fixture mode) and `pnpm check:marketplace` — PASS; `pnpm ls @capybara-hq/plugin-sdk -r --depth 0` shows one version.
- [ ] **Step 3: Commit** `chore: move to plugin-sdk <R1> (cache declarations replace capabilities.caching)`; open PR-1; merge when green (maintainer).

### Tasks P2–P7: Declarations, TTL mapping, per-TTL usage (wave P2, parallel)

Each task: one plugin directory and one changeset entry; TDD on the plugin's `test/map.test.ts` (request mapping), its usage tests and its `conformance.test.ts` (fixture mode runs `"declares a valid cache"` and `"cache ttl options"` from Task 2); then its live test with the keys loaded inside the command. Declarations follow spec §9.1 as revised by P0; where P0 changed a fact, P0's text wins.

**P2 anthropic** (`plugins/anthropic/src/index.ts` `mapModelInfo` 138, `src/map-request.ts` 187–200, `src/map-stream.ts` 97–98, 138–140, 208–209):
- [ ] Test first: `mapModelInfo` declares `{ explicit, [300, 3600], defaultTtl 300, ttlIsMinimum false, refreshOnHit true, request_start, minTokens <P0 per model>, guaranteed true }`; `cacheTtl: 3600` puts `ttl: "1h"` on every `cache_control` (the system breakpoint and the top-level automatic one); `cacheTtl` absent or `300` sends no `ttl`; usage with `cache_creation: { ephemeral_5m_input_tokens: 10, ephemeral_1h_input_tokens: 90 }` maps to `cacheWriteByTtl: [{ttl: 300, tokens: 10}, {ttl: 3600, tokens: 90}]` (zero entries left out; field absent when the split is absent).
- [ ] Implement; fixture tests pass; live (`CAPYBARA_TEST_ANTHROPIC_API_KEY`): two requests with a ≥ 4k cached prefix and `cacheTtl: 3600` — the second reports `cacheReadTokens > 0`, the first `cacheWriteByTtl` with `ttl: 3600`; Review Focus 5: one request with the plugin's effort parameter at its highest value, `toolChoice: "none"` and `maxOutputTokens: 20000` succeeds.

**P3 openai** (`plugins/openai/src/index.ts` `modelInfo` 127 and its static table, `src/map-request.ts` 243–245, `src/map-stream.ts` 135–148):
- [ ] Test first: GPT-5.6+ ids (the pattern P0 recorded) declare `{ implicit, [1800, 43200], defaultTtl 1800, ttlIsMinimum true, refreshOnHit true, unknown, minTokens 1024, guaranteed true }` (refreshOnHit describes the 30m tier; the kernel never picks 43200: decision point D3); earlier models `{ implicit, [], ttlIsMinimum false, refreshOnHit false, unknown, minTokens 1024, guaranteed false }`; image models no `cache`; `cacheTtl: 1800` → `prompt_cache_options: { ttl: "30m" }`, `43200` → `"12h"`, absent → no field, and never on a pre-5.6 model; usage `cache_write_tokens_details: { ttl_30m_tokens, ttl_12h_tokens }` → `cacheWriteByTtl`.
- [ ] Implement; fixture tests pass; live (`CAPYBARA_TEST_OPENAI_API_KEY`, `CAPYBARA_TEST_OPENAI_MODEL` set to a 5.6+ model): a repeated cached request with `cacheTtl: 1800` reads the cache; Review Focus 5 with the reasoning effort parameter.

**P4 openai-compatible** (`plugins/openai-compatible/src/dialects.ts` 47–60, 200, 238, 320–321, 369–370; `src/index.ts` 37, 232–246):
- [ ] Test first: the `Dialect` interface's `caching: boolean` becomes `cache: ModelCacheInfo | undefined` per dialect: `generic` none; `deepseek` `{ implicit, [], …, guaranteed false }`; `qwen` (explicit DashScope markers since #304, P0-confirmed) `{ explicit, [300], defaultTtl 300, ttlIsMinimum false, refreshOnHit true, unknown, minTokens 1024, guaranteed true }`; `ark` `{ implicit, [], …, guaranteed false }`; the per-model config field `caching` (the plugin's own admin config, label "Prompt caching") keeps its name: `false` → no `cache`, `true` on `generic` → the implicit non-guaranteed declaration, absent → the dialect's; no dialect maps `cacheTtl` (no options above 300); `qwen` usage keeps its write mapping with `cacheWriteByTtl: [{ ttl: 300, tokens }]` when it writes.
- [ ] Implement; fixture tests pass; live with `CAPYBARA_TEST_OAICOMPAT_*` per dialect available (qwen: the second request reports cached tokens).

**P5 deepseek** (`plugins/deepseek/src/list.ts` 91–97):
- [ ] Test first: every chat model declares `{ implicit, [], ttlIsMinimum false, refreshOnHit false, unknown, minTokens <P0 or absent>, guaranteed false }`; no request mapping; usage unchanged (no writes). Implement; fixture and live (`CAPYBARA_TEST_DEEPSEEK_API_KEY`) pass.

**P6 bailian** (`plugins/bailian/src/list.ts` 152–157, `src/tables.ts`, `src/map-request.ts` 168–248, `src/map-stream.ts` 108–115):
- [ ] Test first: chat models with the `cache` feature declare `{ explicit, [300], defaultTtl 300, ttlIsMinimum false, refreshOnHit true, unknown, minTokens 1024, guaranteed true }`; Qwen4 models declare `[300, 3600]` **only if** P0 confirmed the option on the native endpoint, and then `cacheTtl: 3600` maps to `parameters.prompt_cache_options: { ttl: "1h" }` and the Qwen4 TTL split maps to `cacheWriteByTtl`; models without the feature no `cache`. Implement; fixture and live (`CAPYBARA_TEST_BAILIAN_*`) pass, including a Qwen4 `1h` request when declared.

**P7 ark** (`plugins/ark/src/list.ts` 130, 136–191, `src/tables.ts` 50–65):
- [ ] Test first: `cachesAutomatically(...)` true → `{ implicit, [], ttlIsMinimum false, refreshOnHit false, unknown, minTokens <P0 or 1024>, guaranteed false }`, false → no `cache`; image models no `cache`; usage unchanged. Implement; fixture and live (`CAPYBARA_TEST_ARK_*`) pass.

Each task commits `feat(<plugin>): declare the prompt cache per model` with its `.changeset/pre/<plugin>-cache-declaration.md`. After the wave's batched review: open PR-2, merge (maintainer), Version Packages PR → R3.

### Task 11: Core bootstrap pins

Wave C8, after R3 (and R1).

**Files:**
- Modify: `packages/kernel/bootstrap.json` (versions and `integrity` of anthropic, openai, openai-compatible, deepseek, bailian, ark from R3; `marketplace.commit` to the plugins commit of R3)
- Create: `.changeset/bootstrap-cache-plugins.md` (`@capybara-hq/capybara`)

- [ ] **Step 1:** update the versions and take each `integrity` from the published tarball (`npm view <pkg>@<version> dist.integrity`); `pnpm check:bootstrap` — PASS.
- [ ] **Step 2:** `pnpm exec vitest run packages/kernel/test/extensions/bootstrap.test.ts` — PASS.
- [ ] **Step 3: Commit** `chore(kernel): pin the plugins with cache declarations`; open PR-C (`Refs #974`); after merge #974 can close.

---

## Decisions (PR #976 review, 2026-11-28; delegated by the maintainer to the coordinator)

Repeated in the PR-B description.

- **D1 Per-tier write pricing: deferred to #977.** Spec §9.2 says cost reports price writes by tier, but the price table (`model_prices`) has a single `cacheWritePerMTok`. Phase 1 records `cacheWriteByTtl` in `usage` events, so the log keeps the breakdown, and leaves `costOf` unchanged. #977 covers the price data model, the migration and the billing views (spec §8.2).
- **D2 What the in-context request extends: accepted as planned.** The reference is extended with exactly what the next step's request would add, prefix-checked byte for byte. The instruction is appended to the trailing user message. Spec §9.4's literal "last request + its reply + the instruction" would miss the tool results after the reply in a mid-run compaction.
- **D3 `refreshOnHit` for OpenAI: accepted as planned.** GPT-5.6+ declares `true`. That describes the 30m tier, and the kernel only ever selects 1800 s. A per-option field would be a contract change.
- **D4 Q9 decision rule: accepted as planned** (Task 8). `"marked"` requires all three, on at least two vendors:
  - tail leakage ≤ 1/20;
  - head recall within 5 points of the transcript path;
  - the security constraint kept in ≥ 19/20.

  With fewer than two vendors testable, the gate stops and the coordinator decides.
- **D5 Two core PRs: accepted.** PR-A (the SDK) is released first, and PR-B (the kernel) follows.
- **D6 `cacheTtl` in replays: accepted as planned.**
  - A candidate recomputes it from its declaration with the recorded intent.
  - A baseline replays the recorded value, or omits an option the plugin no longer offers.
  - Neither case is drift.
- **D7 Settings copy in phase 1: the idle compaction sentence is dropped** from the `longTtl` hint (Task 10). Phase 2 restores it.
- **S1–S10** (spec ambiguities found while planning, listed in the PR): accepted as resolved in this plan.

## Notes for phase 2

- Restore the last sentence of the `promptCache.longTtl` hint from spec §6.4 when idle compaction ships: en "Idle compaction runs on these models only with this on.", zh "开启后空闲压缩才会在这些模型上运行。" (D7). Update `apps/web/test/prompt-cache-settings.test.tsx`, which asserts its absence in phase 1.
- Phase 2 consumes `deriveCacheExpiry` (Task 6) and adds `CompactOptions.requireInContext` (Task 9).

## AGENTS.md rules touched

`check:agent-docs` requires this section only for specs dated 2026-11-17 or later; the plan lists the rules it executes so reviewers can check them per task.

- **Model providers:** model-provider@2 replaces `capabilities.caching` with `ModelInfo.cache`, adds `ModelRequest.cacheTtl` and `ModelUsage.cacheWriteByTtl`; no retries added inside plugins; conformance suite extended (Tasks 1–3, P1–P7).
- **Public API reports:** `pnpm gen:sdk-api` plus a `@capybara-hq/plugin-sdk` changeset (Task 1); `check:api-changeset`.
- **Runtime and replay:** `cacheTtl`, `cacheWriteByTtl` and `compaction_summary.method` are not model-visible (no `DriftReason`); the in-context request is a side request that never changes the history's bytes; the framing change is derived from the log; zero-drift tests before and after Tasks 5, 7 and 9.
- **Multi-replica discipline:** the cache expiry is derived from the log, never held in memory; no timer, no new queue in phase 1.
- **Config / settings:** `promptCache.longTtl` is a platform setting with org override in `DeploymentSettings` / org settings (not `KernelConfigSchema`, so `adding-config` does not apply).
- **Platform tool:** no new route; the fields join the shared schemas (`platform-parity.test.ts`, `check:platform-ops`).
- **Web UI / language:** a design-component settings section on the platform and org pages, i18n zh / en, zh 平台 / 智能体 (`check:web-ui`, `check:i18n`).
- **Tests:** new unit tests join `packages/kernel/test/unit-tests.json`; no container tests; live tests gated by `CAPYBARA_TEST_*` with keys loaded only inside the command.
- **Plugins:** one plugin-sdk instance through `pnpm-workspace.yaml` overrides; core packages from npm only; bootstrap pins updated after the plugins release (Task 11, `check:bootstrap`).
