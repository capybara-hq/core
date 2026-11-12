# Design review 2026-11-12

- core HEAD: 41799f041; plugins HEAD: 050de14
- previous review: none (first review; written before the `reviewing-design` skill existed, so the
  cross-module lane did not run and `pnpm outdated` was not collected)
- lanes: runtime, extensions-catalog, tools-environments, tenancy-infra, web-ux, process

## Themes

1. **Post-commit follow-ups have no outbox.** Work that must follow a commit (enqueue, sync, publish)
   runs after it with nothing durable behind it, so each gap got its own repair: orphan grace and
   read-path kicks, nine `Waits.sweep` passes, the platform-migration "heal" job, the client draft
   retry ladder. Explains `post-commit-followups-no-outbox`, `catalog-import-heal-job`,
   `client-heuristics-for-server-order`. One change: a transactional outbox relayed to BullMQ.
2. **One fact, several stores.** Org enablement in three layers, two parallel scope machines, run
   progress in three places, platform vs org copies of skills and templates. Explains
   `org-enablement-three-layers`, `scope-machines-duplicated`, `langgraph-checkpoint-duplicates-log`,
   `skills-copies-and-pinned-overload`. One change: derive, don't sync.
3. **Compatibility layers before 0.1.0.** Zero-drift replay of rc data forced every rename to keep a
   translation. Explains `legacy-compat-layers`, `replay-forces-compat`. One change: zero-drift only
   for logs written after 0.1.0, squash migrations to a baseline, delete the layers.
4. **Enterprise operations missing.** Tenancy by convention, no retention, no key rotation, no
   budgets, no metrics, thin roles. Explains the tenancy-infra gaps below.
5. **Scope spent on extensibility surfaces without consumers.** Explains
   `client-extensions-l2-l3-premature`, `catalog-size`, `governance-load`.

## Findings

### post-commit-followups-no-outbox: follow-ups after commit are repaired by sweeps

- status: new
- severity: high
- lens: design-flaw
- evidence: `kernel/src/runtime/run-queue.ts:163-233` (row committed, then enqueue; 30 s orphan
  grace :53); `conversations/conversations.service.ts:341-350` (`kickRun` from read paths);
  `runtime/waits.ts:194-215` (nine repair passes; one looks back only a day, :791);
  `infra/database/after-commit.ts` (failing hook is logged); commits 6b132f9f6, b81f40e52
- impact: every new follow-up needs its own sweep; reads can mutate state; gaps older than a sweep
  window are never repaired
- fix: transactional outbox table written in the business transaction, one relay to BullMQ / bus;
  remove the per-feature sweeps
- size: needs a spec

### catalog-import-heal-job: platform components written outside the import transaction

- status: new
- severity: high
- lens: special-case-patch
- evidence: `kernel/src/catalog/plugin-import.ts:1667-1715` (`syncPlatform` after commit, retry via
  the migration job); `catalog/platform-migration.ts:1-7` (runs at every worker start and daily "to
  heal"); commits c85d64790, a82a780cc
- impact: a one-off pre-release migration became a permanent repair loop
- fix: write platform rows in the import's `@Transactional` unit; delete the migration job
- size: direct fix

### org-enablement-three-layers: "is it on in this org" stored in three layers

- status: new
- severity: high
- lens: design-flaw
- evidence: `catalog_items.scope/disabled` + `catalog_item_scope_orgs` + `catalog_item_org_switches`
  → `catalog/scope-sync.ts` (async job, `plugin_scope_sync_failures`) → `plugin_installs` →
  `extensions/enabled.ts:5-11` (`extension_org_configs.enabled ∪ required`);
  `catalog/org-extension-switch.ts:16-41`; two builtin flags (`builtin`, `required`)
- impact: sync failures and two code paths per switch
- fix: one pure function of scope plus switch; installs record what was provisioned, not a gate
- size: needs a spec

### scope-machines-duplicated: plugin and component scope are parallel copies

- status: new
- severity: high
- lens: over-engineering
- evidence: `catalog/catalog-scope.service.ts` (1,422 lines) vs `catalog/component-scope.service.ts`
  (1,538) with the same methods; `skills` vs `platform_skills`, `agent_templates` vs
  `platform_agent_templates`
- impact: every scope rule is written twice; 55 ruling ids cited in catalog code
- fix: one scoped-item abstraction (item kind plus scope row)
- size: needs a spec

### legacy-compat-layers: compatibility layers despite the pre-0.1.0 rule

- status: new
- severity: high
- lens: drift
- evidence: `kernel/src/tools/legacy-keys.ts`, `tools/legacy-data.ts` (18 importers),
  `tools/pipeline.ts:691-700`, `tools/policy.ts:205` (`normalizeStoredDefinitionIn` per decision);
  `devices/legacy-cleanup.job.ts`; `runtime/providers.ts:14-20` (model-provider@1);
  `catalog/catalog.service.ts:63,79-80`; `identity/audit.ts:39-57`; ~150 "legacy" hits
- impact: every hot path pays for rc data that no user has
- fix: one sweep: migrate stored data, delete the layers
- size: direct fix (several PRs)

### replay-forces-compat: zero-drift replay applied to rc logs

- status: new
- severity: medium
- lens: drift
- evidence: `runtime/context/legacy-text.ts`; `conversations/events.ts:285-287`; 29,616-line
  pre-rename fixture (1beea7ef5)
- impact: renames cannot be done cleanly
- fix: guarantee zero drift only for logs written after 0.1.0; drop pre-rename fixtures
- size: direct fix

### tenancy-by-convention: org scoping relies on each query

- status: new
- severity: high
- lens: security
- evidence: no RLS in migrations; `orgs/org.guard.ts:56-130` checks only the path; 506
  `where("id", …)` sites; `runtime/runs.service.ts:616` unscoped lookup; `conversation_events` has no
  `org_id` (`migrations/0006`)
- impact: one forgotten predicate is a cross-tenant leak
- fix: a check requiring an `org_id` predicate on tenant tables or a `TenantDb` wrapper; RLS as a
  backstop
- size: needs a spec

### oauth-discovery-bypasses-net: OAuth fetches skip src/net

- status: new
- severity: high
- lens: security
- evidence: `kernel/src/tools/oauth/discovery.ts:84-95` (global `fetch`, https check only)
- impact: SSRF to internal https hosts; no proxy support
- fix: route `oauthFetch` through `safeFetch` / `proxyAgent`
- size: direct fix

### sdk-has-no-safe-fetch: extensions call tenant URLs with raw fetch

- status: new
- severity: high
- lens: security
- evidence: `plugin-sdk/src/ctx.ts` (no `net`); plugins `connector-mcp/src/session.ts:309`,
  `connector-openapi/src/http.ts:105,385`
- impact: org-admin URLs become internal requests whose result the model sees
- fix: `ctx.net.fetch` backed by `safeFetch`; required for connectors and web providers
- size: needs a spec

### tool-policy-not-a-ceiling: agents can lift the org default; orgs cannot deny every kind

- status: new
- severity: medium
- lens: design-flaw
- evidence: `tools/policy.ts:89-100` (agent `allow` beats org `ask` for personal credentials);
  `orgs/settings.service.ts:90` (sandbox tools allow|ask only); controls spread over
  `org_tool_switches`, `connector_tools`, `sandboxToolPolicy`, `platformTool`
- impact: an org admin cannot enforce approval or deny Bash / WebFetch org-wide
- fix: one org tool-policy table (allow|ask|deny for every kind) as a ceiling; agents and members only
  tighten
- size: needs a spec

### extensions-share-env-and-db-role: full-trust extensions see the master key

- status: new
- severity: medium
- lens: security
- evidence: no env scrubbing; `ctx/create-ctx.ts:245-300` (kernel pool and role)
- impact: any marketplace plugin reads every tenant's data and the master key
- fix: scrub secrets from `process.env` before loading extensions; a Postgres role per extension
  schema; state "marketplace = full trust" in the approval UI
- size: needs a spec

### device-read-denylist: local devices readable except a denylist

- status: new
- severity: medium
- lens: security
- evidence: `packages/device/src/policy.ts:12-40,56`
- impact: prompt injection can read project `.env` files and credential stores
- fix: reads default to the workspace, extra roots opt-in
- size: direct fix

### no-retention-or-purge: soft deletes only, no PII erasure

- status: new
- severity: high
- lens: gap
- evidence: `conversations/conversations.service.ts:598`; `storage/purge.ts` (object storage only);
  no account deletion; no `audit_events` retention
- impact: cannot meet data-deletion obligations
- fix: org and account purge jobs, per-org retention, audit retention
- size: needs a spec

### key-rotation-unusable: rewrapDataKeys has no caller

- status: new
- severity: medium
- lens: gap
- evidence: `ctx/secrets.ts:193`, exported at `index.ts:68`, no CLI or job
- impact: `masterKeyPrevious` can never be retired
- fix: `capybara secrets rewrap` plus a rotation runbook
- size: direct fix

### cost-recomputed-from-current-prices: no price snapshot, no budgets

- status: new
- severity: medium
- lens: design-flaw
- evidence: `migrations/0027_model_prices.sql:1-13`; `admin/usage.service.ts:285-315` (two usage
  stores); no token / spend quota (`runtime/quota.ts` is concurrency only)
- impact: a price change rewrites history; runaway spend is unbounded
- fix: one usage ledger with the price at call time; per-org spend and token limits
- size: needs a spec

### no-metrics-no-rate-limits

- status: new
- severity: medium
- lens: gap
- evidence: no metrics library in kernel; throttlers only on auth / setup
  (`infra/throttler/named-throttlers.ts`)
- impact: operators are blind; one principal can flood the API
- fix: metrics endpoint (queues, runs, model errors, lock losses); default per-principal throttle
- size: needs a spec

### roles-without-groups

- status: new
- severity: medium
- lens: gap
- evidence: `orgs/roles.ts:2-88` fixed ladder; `agent_members` per account
- impact: no groups or custom roles for agent ACLs and connector sharing
- fix: groups plus role bindings
- size: needs a spec

### run-lock-no-fencing: lost run lease stops only at the next step

- status: new
- severity: medium
- lens: design-flaw
- evidence: `runtime/run-worker.ts:498-501`; 30 s TTL `conversation-lock.ts:5`
- impact: unverified: duplicate model or tool calls while another replica resumes
- fix: carry a run generation into calls and check it on append
- size: needs a spec

### langgraph-checkpoint-duplicates-log

- status: new
- severity: medium
- lens: over-engineering
- evidence: `runtime/langgraph-loop.ts:61-67,82-109`; `runtime/checkpointer.ts` (351 lines)
- impact: progress kept in three places; dependency unused beyond checkpointing
- fix: plain step loop resuming from the log
- size: needs a spec

### compaction-needs-user-turns

- status: new
- severity: medium
- lens: gap
- evidence: `runtime/context/compaction.ts:57`; overflow fails the run (`model-call.ts:1353`)
- impact: single-message long runs and sub-agents never compact
- fix: compact at step boundaries; compact on overflow before failing
- size: direct fix

### retry-after-kills-runs

- status: new
- severity: medium
- lens: gap
- evidence: `runtime/model-call.ts:108,1106-1131`
- impact: an ordinary 429 with retry-after > 10 s fails the run or switches model
- fix: backoff that honours retry-after within the run's time budget
- size: direct fix

### compaction-marker-in-prompt

- status: new
- severity: medium
- lens: special-case-patch
- evidence: `runtime/context/compaction.ts:10,21`; `plugins/model-fake/src/script.ts:215`
- impact: a test marker is in the real model's prompt
- fix: mark compaction by request purpose / metadata
- size: direct fix

### client-heuristics-for-server-order

- status: new
- severity: medium
- lens: special-case-patch
- evidence: `apps/web/src/lib/live-drafts.ts:5-12`; `components/conversation/useConversation.ts:60-82,183-307`;
  `lib/subagents.ts:347-420`
- impact: each race patched in the client
- fix: write drafts before publishing deltas; stream title and sub-agent tree as events
- size: needs a spec

### setup-model-goes-to-extensions

- status: new
- severity: high
- lens: gap (ux)
- evidence: `apps/web/src/components/shell/setup.tsx:76-79`
- impact: the first setup task needs the internal term "extension"
- fix: configure the provider in place on `/admin/models`
- size: direct fix

### plugins-and-extensions-both-in-nav

- status: new
- severity: high
- lens: gap (ux)
- evidence: `components/shell/nav.tsx:76-95`; `components/admin-nav.ts:15-16`; four connector entry
  points
- impact: two names for one install unit; 13 flat admin items
- fix: one Plugins surface with the extension as a tab; group admin nav into ~4 sections
- size: needs a spec

### client-extensions-l2-l3-premature

- status: new
- severity: high
- lens: over-engineering
- evidence: only consumer `theme-cyberpunk`; 4 of 12 slots serve it
  (`plugin-sdk/src/ui-slots.ts:7-20`); 31 `UI_PARTS`; generated copies and three checks
- impact: DOM structure is a public contract before 0.1.0
- fix: freeze L2/L3 behind an experimental flag; drop cosmetic slots and parts until a real consumer
- size: needs a spec

### catalog-size

- status: new
- severity: medium
- lens: over-engineering
- evidence: `kernel/src/catalog` 30.8k lines (install/upgrade 4.7k, scope 4.5k, marketplaces 3.5k,
  Claude translator 2.4k); 8 named locks with order documented in comments only
- impact: lock-order races (fbad13a7e, 571318f3a); half the catalog commits are fixes
- fix: follows from `org-enablement-three-layers` and `scope-machines-duplicated`; fewer, coarser
  locks with one ordering helper; move the Claude translator to plugin-tools
- size: needs a spec

### special-cased-names

- status: new
- severity: low
- lens: special-case-patch
- evidence: `tools/oauth/tokens.ts:57-79` (Slack codes); `runtime/context/claude-tools.ts:19`
  (`plugin__todo__write`); `platform/ops/models.ops.ts:94,162` and `extensions-admin.ops.ts:27`
  (`model-anthropic`, the plugin is `anthropic`); `catalog/claude/mcp.ts:20`
- impact: generic code knows one vendor or plugin; wrong ids taught to the model
- fix: let extensions classify their errors and declare tool mappings; fix the examples
- size: direct fix

### governance-load

- status: new
- severity: medium
- lens: over-engineering
- evidence: 28 `check:*`, 11 generators, `tools/checks` 9,456 lines; AGENTS.md 147 commits; 817
  plan / ruling ids in source comments
- impact: the apparatus grows faster than the product
- fix: cap AGENTS.md; retire stable checks into lint config; comments state invariants, not rulings
- size: direct fix

### migrations-no-concurrent-index

- status: new
- severity: medium
- lens: design-flaw
- evidence: `migrations/0063_tool_keys_claude_code.sql:211-219`; ~7 indexes on `conversation_events`
- impact: index builds lock the hottest table
- fix: non-transactional migration files; partitioning plan; baseline squash at 0.1.0
- size: needs a spec

### kernel-schema-handwritten

- status: new
- severity: medium
- lens: drift
- evidence: `db/kernel-schema.ts` (1,945 lines, 136 commits), no comparison test
- impact: types can silently diverge from the schema
- fix: a test comparing `information_schema` with the Kysely types
- size: direct fix

### media-budget-rewrites-history: older attachments replaced in place when the budget overflows

- status: new (found by the skill's trial run on `runtime/context`, core 87853c024)
- severity: medium
- lens: drift
- evidence: `runtime/context/build.ts:259-276` (comment at :274 calls it a known trade-off)
- impact: history sent to the model is no longer append-only; prompt cache invalidated
- fix: decide each attachment once at first appearance and replay it from `model_call.request.media`;
  over-budget placeholders only at the new attachment's position
- size: needs a spec

### request-order-inferred-not-recorded: message placement re-derived instead of recorded

- status: new (trial run)
- severity: medium
- lens: design-flaw
- evidence: `runtime/context/build.ts:599-707` (inline / deferred / late / raced rules); commits
  cb9e1614c, 6f769fa4a, 4edb3a516, c93d0bc23
- impact: each ordering race needs another rule
- fix: each `model_call` records the seqs it appended; a request is the previous one plus that delta
- size: needs a spec

### model-visible-render-scattered: what the model sees per event type defined in three places

- status: new (trial run)
- severity: medium
- lens: design-flaw
- evidence: `runtime/context/build.ts:749-777,796-861`, `compaction.ts:116-157` (`default` swallows
  unknown types)
- impact: a new event type silently disappears from the model's view
- fix: one `Record<ConversationEvent["type"], Renderer>` table, checked by the compiler
- size: direct fix

### reminder-text-as-flag: a reminder's wording is matched as a flag

- status: new (trial run)
- severity: low
- lens: design-flaw
- evidence: `runtime/context/tool-changes.ts:27`
- impact: rewording the reminder writes a wrong `tools_changed` into old conversations
- fix: record `toolsOmitted` on `model_call`
- size: direct fix

## Fixed since the previous review

None (first review).

## Reasonable

- Dependency direction: extensions see only `ctx`; kernel has almost no plugin-name branches.
- Event log as single source of truth; tool side effects at most once; one active run per
  conversation (partial unique index).
- Default-deny auth guard, PG-authoritative sessions, per-org envelope encryption, audit in the same
  transaction.
- Sandbox leases with fencing; `src/net` safe fetch; connector circuit breaker.
- Flake policy: no retries or skips; root causes fixed.

## Baseline numbers

| Number | Value |
|---|---|
| kernel src non-test lines | 174,954 (catalog 30.8k, tools 19.7k, runtime 15.9k, extensions 15.8k, platform 13.8k) |
| commits since 2026-10-17 | 2,851 (fix ~1,016, feat ~700) |
| "legacy" hits in kernel src | ~150 |
| plan / ruling ids in source comments | 817 |
| migrations | 112 |
| `pnpm outdated` | not collected |
