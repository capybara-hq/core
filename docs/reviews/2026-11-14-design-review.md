# Design review 2026-11-14

- core HEAD: 6e9ddb4d2; plugins HEAD: 4fec4d1
- previous review: `docs/reviews/2026-11-12-2-design-review.md` (core 7cb12115f, plugins 050de14)
- lanes: runtime, extensions-catalog, tools-environments, tenancy-infra, web-ux, process, cross-module
- window: 308 core commits (fix 100, feat 52, docs 34; +65.7k / −9.5k lines, 849 files) and 53
  plugins commits (+13.4k / −1.4k, 186 files); the transactional-outbox line, intent-first device
  policy ops, the catalog heal job's removal, the memory plugin, sandbox dev tiers, git gateway

## Themes

1. **Policies still have no ceiling.** The org cannot deny a tool for attended runs, its egress
   list replaces the deployment's, device reads are a denylist, and extension HTTP routes have no
   caller identity at all. Explains `tool-policy-not-a-ceiling`, `org-egress-replaces-deployment`,
   `device-read-denylist`, `egress-narrowing-not-live-on-cloud-devices`,
   `git-push-policy-unreachable`, `extension-routes-bypass-auth`. One change: every layer is a
   ceiling for the layer below (deployment ⊇ org ⊇ agent / device ⊇ run) computed by one shared
   function, and extension routes declare `public | member | org-admin` enforced by the kernel.
2. **The outbox is right; its edges are unowned.** The transactional outbox removed the sweeps,
   `kickRun` and the heal job (good), but a dead row is not an error anyone acts on, org deletion
   leaves runs going, and one current feature still uses the queue the design declared dead.
   Explains `dead-outbox-row-leaves-run-stuck`, `org-deletion-does-not-stop-runs`,
   `outbox-dead-list-unpageable`, `outbox-dead-no-super-admin-lock`,
   `scheduled-task-uses-retired-queue`, `usage-report-no-backfill`,
   `scope-sync-backstop-ladder`, `scope-sync-item-job-fans-out-all-orgs`. One change: every owed
   work item has an owner and an observable terminal state (and a dead row fails its subject).
3. **One fact, several stores.** Network reach in 8 stores, the host-matching rule in 5 copies, org
   enablement as intent vs materialized install, two org-config mechanisms, two scope services, and
   the sandbox tier ceiling decided again in the browser. Explains
   `network-reach-decided-in-many-places`, `allow-host-rules-copied`, `org-enablement-three-layers`,
   `scope-machines-duplicated`, `config-two-org-layers`, `sandbox-tier-ceiling-decided-twice`,
   `requests-spread-over-tables`. One change: one computed fact per question, served by the server.
4. **Compatibility layers grow with every removal.** Four frozen `pre-*` replay fixtures, legacy
   keys/data/schedulers, a device legacy policy key, "older kernel" branches in the web, and plugin
   docs that still teach a removed manifest field. Explains `legacy-compat-layers`,
   `replay-forces-compat`, `web-older-kernel-fallbacks`, `stale-read-path-comment`,
   `stale-outbox-docs`, `plugins-docs-still-pin`. One change: one destructive cleanup plus a PR
   series that deletes every reader for data no user has.
5. **Enterprise operations still missing** (unchanged): tenancy by convention, no retention or
   purge, no budgets — and the window removed the last default run limits — no metrics, no key
   rotation, no groups.
6. **Governance load keeps growing against a smaller product.** 29 `check:*`, 10.5k lines of
   checks, 1,924 `§` references in kernel source, 31 new Chinese comment lines in a window whose
   rule says English, and a check registry that already disagrees with its own README. Explains
   `governance-load`, `check-registry-drift`, `spec-review-misses-agents-rules`, `test-timeout-ladder`,
   `docs-claims-drift`, `english-rule-unenforced`.

## Findings

### extension-routes-bypass-auth: every extension endpoint is anonymous and unthrottled

- status: new
- severity: high
- lens: security
- evidence: `http/plugin-dispatch.ts` (mounted outside the guard at `http/app.ts:254`; strips only
  `cap_at`/`cap_rt`); `.agents/skills/writing-extensions/SKILL.md:210` — "Extension routes bypass
  kernel authentication … no caller identity available … the manifest's `public` is currently only
  a declaration, Ruling A2"; `infra/throttler/throttler.guard.ts:36` — extension routes stay
  unlimited
- impact: an extension author who assumes kernel auth leaks org data to the internet, and approval
  cannot tell a webhook from a member route
- fix: declare `access: public | member | org-admin` per route, enforce it in the dispatch scope
  with org resolution and caller identity in the handler; refuse routes with no declaration at
  approval
- size: needs a spec

### tool-policy-not-a-ceiling: the org cannot deny a tool for attended runs

- status: recurring (3rd time, first seen in 2026-11-12-design-review.md)
- severity: high
- lens: design-flaw
- evidence: `tools/policy.ts:198-201` (`forbiddenTools` only for unattended runs); `:216` (a
  connector default `allow` beats org `ask`); `orgs/settings.service.ts:191,219` (sandbox tools
  allow|ask only); `tools/org-tool-switches.ts:52-58` ("Builtin and connector tools are out of
  scope"); the forbid list is exposed only on the schedules page
  (`apps/web/src/app/(app)/settings/schedules/view.tsx:261`)
- impact: an admin can forbid Bash in a scheduled run but not while a person is in the loop
- fix: one `org_tool_policies` table, allow|ask|deny per tool key for every kind, applied first in
  `createDecidePolicy` as a ceiling; `forbiddenTools` becomes its deny column with an `unattended`
  scope
- size: needs a spec

### device-read-denylist: device reads are open except a denylist

- status: recurring (3rd time, first seen in 2026-11-12-design-review.md); worse (dev tier opens
  caches, sockets and `.git/config`)
- severity: high
- lens: security
- evidence: `packages/device/src/policy.ts:19-48` (`DENIED_SECRET_PATHS` only; every other `~/…`
  is readable); `:310-320` (`srtConfig` sets `denyRead`, never `allowRead`); the auto-mode design
  (`docs/superpowers/specs/2026-11-13-auto-mode-design.md`) proposes unsandboxed-by-default with a
  classifier
- impact: prompt injection reads an unlisted credential store, then one allowlisted upload
  exfiltrates it
- fix: reads confined to the workspace roots by default, extra roots opt-in in the local policy;
  `open` / unsandboxed refused unless reads are workspace-only
- size: needs a spec

### org-egress-replaces-deployment: the org's allowlist is not capped by the deployment's

- status: recurring (2nd time, first seen in 2026-11-12-2-design-review.md)
- severity: high
- lens: security
- evidence: `orgs/settings.service.ts:60` — `allowHosts` "**replaces** the deployment's list … the
  org can add other hosts"; `:267,504` take the org list as is; the window added the tier ceiling
  (`sandbox/tiers.ts:109`) but no host ceiling; `catalog/requests.service.ts:867` copies the
  deployment list into the org on the first approved request
- impact: the super admin's allowlist is a default, not a limit; one approval silently detaches
  the org from future platform changes
- fix: store org hosts as a delta; effective = deployment ∩ (deployment ∪ org additions), or an
  explicit deployment `orgMayExtend`; never copy the list
- size: direct fix

### oauth-discovery-bypasses-net: OAuth, npm and provenance fetches skip src/net

- status: recurring (3rd time, first seen in 2026-11-12-design-review.md)
- severity: high
- lens: security
- evidence: `tools/oauth/discovery.ts:91` (raw `fetch`; `checkOAuthUrl` at `:53-73` checks https and
  userinfo only); `packages/npm.ts:106`; `packages/provenance.ts:88`; contrast `net/safe-fetch.ts`
  used by `git/gateway.ts`, `catalog/marketplace-fetch.ts`, `setup/oauth-token-probe.ts`
- impact: SSRF to metadata/internal hosts and no egress-proxy support for admin-supplied URLs
- fix: route all three through `safeFetch` with an explicit private-host policy; add a check that
  only `net/` calls global `fetch`
- size: direct fix

### sdk-has-no-safe-fetch: plugins cannot reach the kernel's safe fetch

- status: recurring (3rd time, first seen in 2026-11-12-design-review.md)
- severity: high
- lens: security
- evidence: no `net` item in `packages/plugin-sdk/src/ctx.ts`; plugins
  `connector-mcp/src/session.ts:309`, `connector-openapi/src/http.ts:105,385` fetch directly;
  `tools/endpoint.ts` checks credentials only
- impact: every connector bypasses SSRF checks and the proxy
- fix: `ctx.net.fetch` backed by `safeFetch`/`proxyAgent` with an explicit
  `connectors.allowPrivateHosts`, gated by `permissions.network`
- size: needs a spec

### tenancy-by-convention: org scoping is a per-query convention

- status: recurring (3rd time, first seen in 2026-11-12-design-review.md)
- severity: high
- lens: security
- evidence: no RLS (`ROW LEVEL SECURITY` absent); `conversation_events` has no `org_id`
  (`migrations/0006_conversations.sql:15-24`); 644 `where("id", …)` sites; the new `outbox.org_id`
  is nullable and FK-less (`0119_outbox.sql:12`)
- impact: one forgotten predicate leaks another tenant's rows; nothing fails closed
- fix: a `TenantDb` wrapper or a check requiring `org_id` on tenant tables, plus an RLS backstop
- size: needs a spec

### no-retention-or-purge: nothing is ever deleted

- status: recurring (3rd time, first seen in 2026-11-12-design-review.md); wider (dead outbox rows
  keep tenant payloads forever)
- severity: high
- lens: gap
- evidence: org deletion is a soft delete (`orgs/orgs.service.ts:246-314`); no account-deletion
  route; no purge of `conversation_events`, `runs`, `audit_events`; usage is derived from
  `conversation_events` (`admin/usage.service.ts:283-299`); dead outbox rows keep `data`
  (`admin/outbox-dead.service.ts`, only a super admin can discard)
- impact: an enterprise deployment cannot meet an erasure request, and keeping everything is the
  only policy
- fix: usage ledger first (see `cost-recomputed-from-current-prices`), then org / account purge,
  per-org retention and audit retention
- size: needs a spec

### cost-recomputed-from-current-prices: no price snapshot, no budgets, and the last limits went

- status: recurring (3rd time, first seen in 2026-11-12-design-review.md); severity raised (was
  medium: 86c258c7d removes the default step and duration limits, f1331fe48 the sub-agent token
  cap, so a runaway run has no limit and no budget)
- severity: high
- lens: design-flaw
- evidence: `config/schema.ts:838` (`maxSteps: 0`), `:1290` (`maxTokensPerRun`, now 0);
  `admin/usage.service.ts:238,330,356` computes cost from the live price table; no per-org or
  per-member spend cap
- impact: a super admin price edit retroactively changes last week's reported cost, and one loop
  can spend without bound
- fix: one `model_usage` ledger storing the price at call time; per-org / member token and spend
  limits checked before each step
- size: needs a spec

### legacy-compat-layers: a permanent reader for every removed feature

- status: recurring (3rd time, first seen in 2026-11-12-design-review.md); worse
- severity: high
- lens: drift
- evidence: `tools/legacy-keys.ts` (140), `legacy-data.ts` (105, 19 importers),
  `devices/legacy-cleanup.job.ts`, `runtime/context/legacy-text.ts`, `runtime/retired-schedulers.ts`
  (14 ids), `runtime/providers.ts:239` (`model-provider@1`, no plugin implements it),
  `agents/definition.ts:615-640` (strips `orgSkills`/`pinned` on every read),
  `extensions/package.ts:336` (`withoutRemovedManifestFields`), `extensions/admin-view.ts:95`
  (`legacy_format`), new `device/src/commands/start.ts:23` (`LEGACY_NETWORK_NOTICE` for a
  pre-0.1.0 `policy.json` key nobody has); 103 non-test files mention legacy/compat/deprecated
- impact: AGENTS.md's "no compatibility layers for pre-release state" is contradicted by code
  that must be tested and can never be deleted by 0.1.0
- fix: one destructive cleanup migration and a PR series deleting every item above; reject
  `pinned` on import
- size: direct fix (several PRs)

### replay-forces-compat: zero-drift replay of rc logs freezes production text

- status: recurring (3rd time, first seen in 2026-11-12-design-review.md)
- severity: high
- lens: drift
- evidence: `runtime/context/legacy-text.ts:1-9` ("FROZEN … never edit them"); four `pre-*`
  fixtures under `test/evals/fixtures/`; `runtime/context/skills.ts:15-57,139-178`;
  `evals/reconstruct.ts:35-44,270-278`
- impact: a feature that existed for days dictates system text forever
- fix: amend AGENTS.md — zero drift only for logs written from 0.1.0; delete the `pre-*` fixtures
  and the frozen render paths
- size: needs a spec (short)

### compaction-needs-user-turns: long single-turn runs can never compact

- status: recurring (3rd time, first seen in 2026-11-12-design-review.md); severity raised (was
  medium: auto mode targets long single-turn dev runs, which this cannot compact)
- severity: high
- lens: gap
- evidence: `runtime/context/compaction.ts:42-70` — `userIdx.length < keepRecentTurns` sets
  `boundary = 0`, the transcript is empty, the function returns `null`; `config/schema.ts:844`
  (`keepRecentTurns: 4`); the only compaction test uses 8 turns
  (`test/runtime/model-call.test.ts:760-781`)
- impact: every long one-turn agent run dies at the context window instead of compacting
- fix: when there are fewer user turns than `keepRecentTurns`, keep the last user turn and compact
  everything before it; compact once at a step boundary before failing
- size: direct fix

### setup-model-goes-to-extensions: "configure a model" lands on an extension list

- status: recurring (3rd time, first seen in 2026-11-12-design-review.md)
- severity: high
- lens: gap (ux)
- evidence: `apps/web/src/components/shell/setup.tsx:76,79` (model step → `/admin/extensions`);
  `lib/run-row.ts:25` and `components/conversation/Thread.tsx:562` (same link);
  `app/(app)/admin/models/view.tsx:275-276` (empty state → `/admin/plugins`)
- impact: the super admin's first task does not have a surface of its own
- fix: one model-service setup entry (install provider + configure) reachable from `/admin/models`;
  point all four links there
- size: direct fix

### plugins-and-extensions-both-in-nav: two names for one unit in every audience's nav

- status: recurring (3rd time, first seen in 2026-11-12-design-review.md)
- severity: high
- lens: gap (ux)
- evidence: `apps/web/src/components/shell/nav.tsx:87,97`; `components/admin-nav.ts:9-23` (13 flat
  admin items, both `plugins` and `extensions`); 12 plugin/extension routes
- impact: members, org admins and the super admin all have to learn the split
- fix: one Plugins surface with the extension as a tab; ~4 admin nav groups
- size: needs a spec

### org-deletion-does-not-stop-runs: a deleted org's runs keep spending

- status: new
- severity: medium
- lens: design-flaw
- evidence: `orgs/orgs.service.ts:262-314` (`softDeleteIn` cancels eval runs and pending requests,
  revokes tokens, deletes outbox rows — but owes no `run-stop` for chat / sub-agent runs);
  `runtime/run-queue.ts:154-168` (`ensureRunIn` rejects a deleted conversation, not a deleted org);
  `runtime/run-orphan-check.job.ts:72-82` deliberately leaves a deleted org's running run as it is
  ("its deletion purged its owed jobs on purpose")
- impact: after deletion, running runs keep calling models and tools with the org's connectors, and
  a background-task finish can start a new run; nobody can see or stop it
- fix: owe `run-stop` for the org's active runs in the delete transaction and make `ensureRun`
  reject a conversation whose org is soft-deleted
- size: direct fix

### dead-outbox-row-leaves-run-stuck: a dead ensure-run row parks a run forever

- status: new
- severity: medium
- lens: gap
- evidence: `runtime/run-orphan-check.job.ts:121-138` and `:171` — `jobInOutbox` counts a *dead*
  row as "not a lost job", so the queued run is never re-owed; only the super admin sees
  `outbox_dead` (`admin/overview.service.ts:262-266`); the org has no view
- impact: after 20 failed deliveries a queued run waits forever with no reply and no org-visible
  error
- fix: a dead row for a run job fails that run `run.orphaned` (or re-owes it) in the orphan check;
  surface it in the org's inbox
- size: direct fix

### scheduled-task-uses-retired-queue: a current feature depends on the queue the design removed

- status: new
- severity: medium
- lens: drift
- evidence: `schedules/fire.ts:384` calls `ConversationQueue.add`, which inserts
  `conversation_queue` (`conversations/queue.service.ts:212`), for every conversation / chat /
  group task; `.agents/skills/replay-evals/SKILL.md:78-86` says the table "only holds leftover rows
  queued by older versions"; the run-input spec
  (`docs/superpowers/specs/2026-11-07-run-input-and-live-drafts-design.md:31,44-48`) says "there is
  no queue"
- impact: a message the model has not seen lives outside the log until drained, and the contract
  step can never drop the table
- fix: append the task's `user_message` (with the schedule marker) in the fire transaction, as
  mode `new` already does; drain and drop the queue
- size: needs a spec (short)

### usage-report-no-backfill: spend before a subscriber existed is lost

- status: new
- severity: medium
- lens: gap
- evidence: `runtime/usage-report-jobs.ts:88` and `extensions/usage-subscribers.ts:60-70` — a usage
  event written while no plugin subscribes is never reported, "later subscribers included" (spec
  §8.1)
- impact: enabling a billing or audit plugin loses all earlier spend although the log holds it
- fix: on first enable (and on demand), backfill from the log per plugin watermark
- size: needs a spec

### scope-sync-backstop-ladder: one "not loaded yet" condition has four mechanisms

- status: new
- severity: medium
- lens: special-case-patch
- evidence: `catalog/scope-sync.ts:91` (`reconcileWithin` 10 s race), `:81,208-227`
  (`SCOPE_LOAD_RETRIES = 6` deferred retries), `catalog/scope-jobs.ts:21,73-76` (a 5-minute
  `scope-item-backstop` that throws until the extension is deployed, so BullMQ backs off), and the
  `plugin_scope_sync_failures` inbox (`inbox/platform-inbox.service.ts:249`)
- impact: the enable / install transaction does not owe convergence; four compensations cover a
  crash between commit and deploy
- fix: owe the item sync from the deploy transaction and use one BullMQ retry policy; delete
  `SCOPE_BACKSTOP_JOB` and the retry counter
- size: direct fix

### scope-sync-item-job-fans-out-all-orgs: one job loops every org

- status: new
- severity: medium
- lens: gap
- evidence: `catalog/scope-sync.ts:180-227` (one `scope-item` job iterates every non-deleted org
  sequentially under a per-org Redis lock, concurrency 2 at `:122`)
- impact: with thousands of orgs one scope change runs for hours; a retry redoes every pair
- fix: fan out one deterministic job per (item, org) chunk, bounded by queue concurrency
- size: direct fix

### git-push-policy-unreachable: the org's push default has no writer and the member grant no list

- status: new
- severity: medium
- lens: gap
- evidence: `tools/git-push-policy.ts:22-26,128,147` reads `connectors.git_push_policy`; the only
  occurrences are reads and the schema field (`db/kernel-schema.ts:522`) — no writer exists;
  `connector-account-policies.ts:44-50` documents that the 权限 sheet does not list
  `git_push:<host>/<repo>`; `approvals.service.ts:1700-1722` writes such rows
- impact: the org default is fixed at `ask`, and a member's standing "always allow this repo" can
  never be listed or revoked
- fix: expose the org default on the connector admin route, and list/clear `git_push:*` in the
  member permissions; or store git grants in a table of their own
- size: direct fix

### sandbox-tier-ceiling-decided-twice: the browser re-implements the kernel's ceiling rule

- status: new
- severity: medium
- lens: design-flaw
- evidence: `apps/web/src/lib/devices.ts:104-110` already returns `ceiling` / `cappedBy`, yet
  `components/DeviceSandboxSection.tsx:59-62` re-implements `tierWidens` as `localTierWidens`
  (kernel: `devices/devices.service.ts:1502-1510`) and `:116-125` recomputes "who caps this tier"
  from raw `platformMax` instead of `cappedBy`
- impact: a security-adjacent decision has two implementations that must stay in step
- fix: the server returns the per-option cap reason and the widening verdict; delete
  `localTierWidens` and the org-settings read
- size: direct fix

### check-registry-drift: the check list lives in five places and already disagrees

- status: new
- severity: medium
- lens: design-flaw
- evidence: `package.json` (29 `check:*`), `tools/checks/src/cli/all.ts` (20 named entries plus
  plugin checks), 43 files under `tools/checks/src/cli/`, `tools/checks/README.md:3` ("runs every
  custom check"), `tools/ci/src/affected.ts`; four real checks are undocumented —
  `check:tool-design`, `check:config-docs`, `check:plugin-pack`, `check:package-schemas` (all in
  `pnpm check`, zero mentions in the README)
- impact: the page that claims to be the authority is already wrong, and CI mode (full / diff) is
  prose only
- fix: one registry array `{ name, cli, ciMode, reason }` that `all.ts`, a generated
  `package.json` script block and the README table read; a test that every `check:*` appears
- size: direct fix

### english-rule-unenforced: English-only is declared, not held

- status: new
- severity: medium
- lens: drift
- evidence: 474 CJK lines in 22 files of `packages/plugin-sdk/src` (e.g. `ctx.ts`, `context.ts`) —
  the contract third-party authors implement; 31 Chinese comment lines *added* in the window
  (`tools/approvals.service.ts` ×8, `conversations/event-log.ts`, `runtime/run-queue.ts:73`,
  `orgs/offboarding.ts`, `channels/jobs.ts:216`, `sandbox/tiers.ts`,
  `tools/oauth/discovery.ts:5-16`); AGENTS.md requires English for docs and new comments; no check
  covers comments (`tools/checks/src/i18n.ts:285` scans `zh:` values only)
- impact: a plugin author cannot read the SDK contract, and the on-touch rule is slipping in
  exactly the files that are changing
- fix: translate the SDK's comments in one PR; add a CJK-in-comments check for
  `packages/plugin-sdk/src` and for new lines elsewhere
- size: direct fix (one translation PR)

### unverified-provenance-shown: a forgeable attestation is shown as provenance

- status: recurring (2nd time, first seen in 2026-11-12-2-design-review.md)
- severity: medium
- lens: security
- evidence: `packages/provenance.ts:3-7` ("display only: the sigstore signatures are not
  verified"); shown in the import review (`catalog/catalog.service.ts`, `PluginReviewBody.tsx`)
- impact: the super admin approves full-trust code on a claim nobody checked
- fix: verify with `sigstore`, or label it "attestation, unverified" in the review
- size: direct fix

### extensions-share-env-and-db-role: every extension shares process env and one PG role

- status: recurring (3rd time, first seen in 2026-11-12-design-review.md)
- severity: medium
- lens: security
- evidence: no `process.env` scrubbing for extensions (`ctx/create-ctx.ts`); one connection pool
  with `withSchema(plugin_<name>)`, only `destroy` blocked (`:245,595`)
- impact: one malicious or buggy extension reads every secret and every schema
- fix: scrub secrets from `process.env` after config loads; a Postgres role per extension schema;
  state "full trust" in the approval UI
- size: needs a spec

### org-enablement-three-layers: intent and materialized install answer "on" separately

- status: recurring (3rd time, first seen in 2026-11-12-design-review.md); severity lowered (was
  high: the predicates are now shared in `extensions/enabled.ts` and `catalog/scope.ts`)
- severity: medium
- lens: design-flaw
- evidence: intent in `catalog_item_org_switches` / `catalog_item_scope_orgs` (`wantedOn`,
  `catalog/scope-state.ts`), materialization in `plugin_installs` and
  `extension_org_configs.enabled` (`extensions/enabled.ts:15-50`), converged by the scope job; a
  failed sync makes the org page answer a different "on" than the platform's scope
- impact: the org sees two truths while a sync is failing
- fix: expose derived intent and install state as separate fields (`on`, `install_failed`); never
  let the install row stand in for the fact
- size: needs a spec

### scope-machines-duplicated: two scope services

- status: recurring (3rd time, first seen in 2026-11-12-design-review.md); severity lowered (was
  high: platform rows are served directly now, no org copies)
- severity: medium
- lens: over-engineering
- evidence: `catalog/catalog-scope.service.ts` (1,487 lines) vs
  `catalog/component-scope.service.ts` (1,538), each with preview / confirm / writers
- impact: every scope change is implemented twice
- fix: one scoped-item service behind the shared predicates
- size: needs a spec

### config-two-org-layers: org config has two mechanisms

- status: recurring (2nd time, first seen in 2026-11-12-2-design-review.md)
- severity: medium
- lens: design-flaw
- evidence: `config.org` (jina, lark, slack; `extensions/org-config.ts`) vs `orgAccess` (ark,
  deepseek; `extensions/org-overrides.ts`, `effective-config.ts:31-45`), two secret namespaces
  (`plugin-config:` / `plugin-override:`)
- impact: two stores, two secret namespaces, two upgrade paths
- fix: drop `config.org`; `orgAccess(…, "override" | "org-only")` on one schema, one store
- size: needs a spec

### network-reach-decided-in-many-places: "may this command reach host H" has 8 stores and 4 evaluators

- status: recurring (2nd time, first seen in 2026-11-12-2-design-review.md)
- severity: medium
- lens: design-flaw
- evidence: deployment `sandbox.limits`, org `sandboxEgress`, `catalog_requests` (0115),
  `approvals` kind network (0114), `scheduled_task_grants` (`local-devices/network-grants.ts:209`),
  `device_machines.local_policy`, new `device_machines.pending_policy_ops` / outbox (0118), git
  reach in `git-push-policy.ts`; evaluated in the kernel (`network-grants.ts:277-319`) and again
  in the device (`device/src/policy.ts:199-225`, `network.ts:94-110`); cloud providers report no
  `network.blocked`
- impact: answers differ by device kind and freshness; cloud asks never happen
- fix: one pure rule in plugin-sdk plus a `network_grants` table; cloud providers populate
  `ExecResult.network`
- size: needs a spec

### egress-narrowing-not-live-on-cloud-devices: narrowing does not stop running instances

- status: recurring (2nd time, first seen in 2026-11-12-2-design-review.md); partially fixed
  (tier and egress mode now update live)
- severity: medium
- lens: security
- evidence: `sandbox/tiers.ts:145-158` (`AppliedLimits` is tier + egress mode only);
  `config/schema.ts:1636` documents that `allowHosts` reaches only instances created afterwards
- impact: removing a host from the allowlist leaves running cloud instances reaching it, while
  the device page shows the new list
- fix: include a digest of the effective `allowHosts` in `AppliedLimits` and update / recreate on
  change
- size: needs a spec (provider-specific)

### allow-host-rules-copied: the host-matching rule and public-suffix list exist in several copies

- status: recurring (2nd time, first seen in 2026-11-12-2-design-review.md)
- severity: medium
- lens: design-flaw
- evidence: `*.x` matching in `local-devices/network-grants.ts:273`, `device/src/policy.ts:67`,
  plugins `sandbox-docker/egress-proxy/proxy.mjs:124`; `devices/public-suffix.ts` is byte-identical
  to `device/src/public-suffix.ts`; `plugin-sdk/src/sandbox.ts:439` `validateAllowHost` never
  refuses a public suffix, so an org-wide list accepts `*.co.uk`
- impact: the org-wide list, which matters more, is the weaker one
- fix: `allowHostCovers` and the public-suffix check in plugin-sdk with shared vectors for
  `proxy.mjs` and the web copy
- size: direct fix

### run-lock-no-fencing: a replica that lost its lease can still append

- status: recurring (3rd time, first seen in 2026-11-12-design-review.md)
- severity: medium
- lens: design-flaw
- evidence: `runtime/run-worker.ts:526-528` (lease loss only aborts at the next step boundary);
  `conversations/event-log.ts:400-410` (append locks the conversation row; no run generation or
  job-ownership check)
- impact: two replicas can write one step's events
- fix: a run generation written by the claim, checked on append and tool dispatch
- size: needs a spec

### langgraph-checkpoint-duplicates-log: a second state store beside the event log

- status: recurring (3rd time, first seen in 2026-11-12-design-review.md)
- severity: medium
- lens: over-engineering
- evidence: `runtime/langgraph-loop.ts:32-58,110-141`; `runtime/checkpointer.ts`; three
  `@langchain/*` dependencies used only here (`packages/kernel/package.json:50-52`)
- impact: two state machines to keep in step
- fix: a plain step loop resuming from the log
- size: needs a spec

### retry-after-kills-runs: a long 429 fails the run instead of waiting

- status: recurring (3rd time, first seen in 2026-11-12-design-review.md)
- severity: medium
- lens: gap
- evidence: `runtime/model-call.ts:105-108` (waits at most 10 s); `:1122-1135` (a longer
  retry-after skips the retry and fails when there is no fallback)
- impact: a provider asking for 30 s ends the run
- fix: honour retry-after within the run deadline, or park and resume
- size: direct fix

### compaction-marker-in-prompt: compaction is identified by a prompt marker

- status: recurring (3rd time, first seen in 2026-11-12-design-review.md)
- severity: medium
- lens: special-case-patch
- evidence: `runtime/context/compaction.ts:9-10` (`CAPYBARA_COMPACTION`, sent to real providers)
- impact: a fake-model marker in production prompts
- fix: identify compaction by request purpose
- size: direct fix

### media-budget-rewrites-history: the media budget rewrites earlier request positions

- status: recurring (3rd time, first seen in 2026-11-12-design-review.md)
- severity: medium
- lens: drift
- evidence: `runtime/context/build.ts:262-276` — "已知取舍（接受）"; when newer media evicts older
  ones, earlier positions change and the prompt cache after them is lost
- impact: not an append-only history at the model boundary; a documented accepted trade-off
- fix: decide each attachment once and replay the decision, or record the dropped set on the call
- size: needs a spec

### request-order-inferred-not-recorded: placement is inferred, not recorded

- status: recurring (3rd time, first seen in 2026-11-12-design-review.md)
- severity: medium
- lens: design-flaw
- evidence: `runtime/context/build.ts:600-640` (`absorbedUpToSeq` and a placement scan)
- impact: a log without the field is interpreted by a heuristic that must match past builds
- fix: each `model_call` records the seqs it appended
- size: needs a spec

### model-visible-render-scattered: a `default:` swallows unknown event types

- status: recurring (3rd time, first seen in 2026-11-12-design-review.md)
- severity: medium
- lens: design-flaw
- evidence: `runtime/context/build.ts:799,887`, `context/compaction.ts:154` still `default:`
- impact: a new event type silently disappears from requests
- fix: one exhaustive `Record<EventType, Renderer>`
- size: direct fix

### client-heuristics-for-server-order: the web waits out a kernel ordering gap

- status: recurring (3rd time, first seen in 2026-11-12-design-review.md)
- severity: medium
- lens: special-case-patch
- evidence: `apps/web/src/lib/live-drafts.ts:5-12` (`DRAFT_RETRY_MS` ladder because a delta may be
  published before the draft is written); `lib/subagents.ts:349,406,413` re-reads the tree on a
  timer
- impact: correctness depends on retry timing in the browser
- fix: write the draft before publishing deltas; stream the title and sub-agent tree as events
- size: needs a spec

### web-older-kernel-fallbacks: the web keeps branches for older kernels

- status: recurring (2nd time, first seen in 2026-11-12-2-design-review.md)
- severity: medium
- lens: stale-dependency
- evidence: 39 "older kernel" branches in `apps/web/src`, e.g.
  `app/(app)/extensions/view.tsx:300-306` re-derives `needsConfig` with `savedConfigComplete`;
  web and kernel ship together
- impact: dead branches keep a second source of truth for server decisions
- fix: make the fields required, delete the branches, ban "older kernel" in `apps/web`
- size: direct fix

### network-allow-concept-spread: five surfaces for one question

- status: recurring (2nd time, first seen in 2026-11-12-2-design-review.md)
- severity: medium
- lens: gap (ux)
- evidence: `/settings/sandbox`, the device page network section, schedule task grants, the
  conversation approval card, the admin request in `/inbox`; copy mixes host / domain
  (`apps/web/messages/en.json:2013,2419-2433`)
- impact: a person meets the same decision in four vocabularies
- fix: one term ("domain"); an org "Network" page showing the effective decision and the one action
  for that layer; resume the run on approval
- size: needs a spec

### client-extensions-l2-l3-premature: full client-extension machinery for two consumers

- status: recurring (3rd time, first seen in 2026-11-12-design-review.md); severity lowered (was
  high: a second real consumer exists — `plugins/memory/src/client.tsx`)
- severity: medium
- lens: over-engineering
- evidence: two consumers (`memory` org page, `theme-cyberpunk` 5 slots); 7 of 12
  `packages/plugin-sdk/src/ui-slots.ts` slots unused; 22 of 29 `UI_PARTS` consumed by one theme's
  CSS; `kernel/src/client` 1,241 lines, `apps/web/src/components/client-ext` 1,532,
  `packages/plugin-client` 697, plus import map / nonce / safe mode / crash budget
- impact: a large surface validated by two first-party plugins
- fix: keep the used slots and parts; put the rest behind an experimental flag
- size: needs a spec

### one-plugin-kernel-contracts: four kernel contracts have one consumer each

- status: new
- severity: medium
- lens: over-engineering
- evidence: `context@1` (`plugin-sdk/src/context.ts`) — only `plugins/memory`; `ToolSpec.sources`
  — only `plugins/memory`; lifecycle hooks (`extensions/lifecycle-hooks.ts`) — only memory; the
  kernel's pgvector migration (0123) serves memory alone, and a DBA-installed `vector` in another
  schema is "left where it is", so the plugin's `search_path` never sees it and memory silently
  falls back to `real[]` with no setup check reporting it
- impact: each contract is generic but unvalidated by a second consumer, and a deployment decision
  (pgvector) is owned by the kernel for one plugin, where its absence is silent
- fix: keep the contracts, but let the memory plugin own its pgvector expectation (`ctx.setup.check`
  reporting `to_regtype('vector')` on its own `search_path`), not a kernel migration; revisit the
  contracts if no second consumer appears before 0.1.0
- size: direct fix

### catalog-size: catalog is the largest module again

- status: recurring (3rd time, first seen in 2026-11-12-design-review.md)
- severity: medium
- lens: over-engineering
- evidence: 30,937 non-test lines; 8 of 18 catalog commits in the window are fixes;
  `catalog/claude` 2,410
- impact: the module that should be thinnest carries the most code
- fix: follows from the scope findings; move the Claude translator to plugin-tools
- size: needs a spec

### governance-load: the enforcement layer is a second product

- status: recurring (3rd time, first seen in 2026-11-12-design-review.md); worse
- severity: medium
- lens: over-engineering
- evidence: `tools/checks/src` 9,456 → 10,515 lines (+763 in 25 commits); 29 `check:*`, 8 `gen:*`;
  1,924 `§` references in non-test kernel source; 1,027 ruling / P-id hits; 52 specs + 80 plans;
  29% of the window's commits are docs / tests / chore
- impact: check upkeep competes with the open enterprise gaps
- fix: cap the check count, move stable rules into biome / tsc, comment invariants rather than
  ruling ids
- size: direct fix

### spec-review-misses-agents-rules: no spec must state the AGENTS.md rules it departs from

- status: recurring (2nd time, first seen in 2026-11-12-2-design-review.md)
- severity: medium
- lens: drift
- evidence: 0 of 52 specs under `docs/superpowers/specs/` has the section; the outbox spec did it
  ad hoc; `sandbox-dev-tiers`, `memory-plugin` and `auto-mode` (2026-11-13) do not; the auto-mode
  spec moves safety from the OS sandbox to command review without naming the AGENTS.md sandbox
  statements it changes
- impact: reversals still pass the gate on paper
- fix: require the section in new specs, enforced by `check:agent-docs`
- size: direct fix

### migrations-no-concurrent-index: no way to build an index concurrently

- status: recurring (3rd time, first seen in 2026-11-12-design-review.md)
- severity: medium
- lens: design-flaw
- evidence: the migrator runs every file in a transaction; `writing-migrations/SKILL.md:39`
  forbids `CONCURRENTLY`
- impact: a large table blocks writes during an upgrade
- fix: a non-transactional migration kind; baseline squash at 0.1.0
- size: needs a spec

### kernel-schema-handwritten: the Kysely schema is hand-maintained

- status: recurring (3rd time, first seen in 2026-11-12-design-review.md)
- severity: medium
- lens: drift
- evidence: `db/kernel-schema.ts` 2,108 lines (was 2,064), no test diffing it with
  `information_schema`
- impact: types drift from the database without anything failing
- fix: a test diffing `information_schema` with the Kysely types
- size: direct fix

### plugins-docs-still-pin: the plugins skill teaches a removed manifest field

- status: recurring (2nd time, first seen in 2026-11-12-2-design-review.md)
- severity: medium
- lens: drift
- evidence: plugins `.agents/skills/writing-plugins/SKILL.md:63,73-74` teaches `"pinned": true`;
  `plugin-sdk/src/plugin-manifest.ts` rejects the field
- impact: a plugin author following the docs produces a plugin this kernel refuses
- fix: update the plugins skill; a check parsing its JSON examples with the current SDK
- size: direct fix

### npm-latest-points-at-rc0: `latest` still installs an old rc

- status: recurring (2nd time, first seen in 2026-11-12-2-design-review.md)
- severity: medium
- lens: stale-dependency
- evidence: `npm view` 2026-11-14: `latest` = 0.1.0-rc.0; `next` = rc.20 (`plugin-sdk`) / rc.27
  (`kernel`); `plugin-tools/src/release/publish-plan.ts:38-43` correctly sends prereleases to
  `next` — this is registry state
- impact: `npm i @capybara-hq/plugin-sdk` installs a format current kernels reject
- fix: move `latest` with each rc until 0.1.0, or deprecate the old rc.0s
- size: direct fix

### key-rotation-unusable: an old master key can never be retired

- status: recurring (3rd time, first seen in 2026-11-12-design-review.md)
- severity: medium
- lens: gap
- evidence: `ctx/secrets.ts:193` `rewrapDataKeys`; only re-exported (`index.ts:68`); no CLI,
  runbook or test calls it, though `masterKeyPrevious` is loaded into the keyring
- impact: a leaked key stays valid forever
- fix: `capybara secrets rewrap` + runbook + test
- size: direct fix

### roles-without-groups: roles are flat

- status: recurring (3rd time, first seen in 2026-11-12-design-review.md)
- severity: medium
- lens: gap
- evidence: `orgs/roles.ts:2` (`ORG_ROLES = ["guest", "member", "admin", "owner"]`)
- impact: an enterprise cannot model teams or bind permissions to them
- fix: groups plus role bindings
- size: needs a spec

### no-metrics-no-rate-limits: tracing only, throttling on few routes

- status: recurring (3rd time, first seen in 2026-11-12-design-review.md)
- severity: medium
- lens: gap
- evidence: `apps/capybara/src/tracing.ts` (no Meter); throttles only on credential, device-code,
  client-report and setup-check routes (`infra/throttler/named-throttlers.ts:47-67`, per-route
  opt-in by design)
- impact: no queue / run / error / dead-outbox metrics, and no default per-principal limit
- fix: OTel metrics with the OTel upgrade; a default per-principal `/api` throttle
- size: needs a spec

### network-grant-in-tool-key: scope is encoded in a text key

- status: recurring (2nd time, first seen in 2026-11-12-2-design-review.md); wider
- severity: low
- lens: special-case-patch
- evidence: `schedules/unattended.ts:123` (`network:<host>`), `grant-rules.ts:173-205`
  (`git:push:<owner>/<repo>`), `connector-account-policies.ts:49` (`git_push:<host>/<repo>`)
- impact: tables accept impossible values and the permissions sheet cannot parse the key
- fix: `kind` / `resource` columns, or the `network_grants` table
- size: direct fix

### outbox-dead-admin-gaps: the dead-letter surface is incomplete

- status: new
- severity: low
- lens: gap
- evidence: `admin/outbox-dead.service.ts:12` (`OUTBOX_DEAD_LIST_MAX = 200`), `:72-104` (no
  `next`), while retry / discard are by id — a dead row past the first page can never be
  delivered; retry / discard run in `@Transactional()` but never call
  `adminLock.lockAndAuthorize`, which the skill requires of every new super-admin write
  (`.agents/skills/writing-kernel-api/SKILL.md:122`)
- impact: a dead row beyond page one is unreachable, and the super-admin role can be revoked
  concurrently with the write
- fix: keyset pagination by `(dead_at, id)` with `next`; inject `SuperAdminLock` and call it
  inside the transaction
- size: direct fix

### stale-comments-and-docs: three comments describe a past state

- status: new
- severity: low
- lens: drift
- evidence: `runtime/run-worker.ts:65-68` — "opening SSE / reading events will ensureRun again"
  (`ensureRun` is no longer called from any read path; `kickRun` is gone);
  `orgs/orgs.module.ts:22` still names "offboarding (with its sweep cron)"; the outbox spec still
  says "draft for maintainer review"; `apps/web/src/components/shell/nav.tsx:26` lists 设备 under
  `primary` while `:78-83` puts it in `more`
- impact: the next reader or edit follows the stale statement
- fix: four one-line edits, and delete the redundant in-process retry ladder
- size: direct fix

### usage-report-hook-no-consumer: the usage-report hook has no subscriber

- status: new
- severity: low
- lens: over-engineering
- evidence: `extensions/usage-subscribers.ts` (105 lines, per-process cache and generation);
  `grep usage.report` finds no plugin in `capybara-hq/plugins`; core consumers are fake extensions
- impact: a delivery path with no real consumer, kept correct by tests only
- fix: drop the hook and its outbox kind until a subscriber exists, or state in the spec that it
  is for third parties
- size: direct fix

### device-means-two-things: "device" names a cloud sandbox and a local machine

- status: new
- severity: low
- lens: drift
- evidence: `GET /api/v1/orgs/:orgId/devices` (cloud sandbox,
  `devices/devices.controller.ts:53`) vs `/api/v1/device/*` (local login and gateway,
  `local-devices/device-auth.controller.ts:55`); AGENTS.md Terms defines neither
- impact: every doc and conversation about "devices" needs a qualifier
- fix: define both in Terms, or name the cloud API `sandboxes` before 0.1.0
- size: direct fix

### sandbox-runtime-pinned: a security boundary is two patches behind

- status: new
- severity: low
- lens: stale-dependency
- evidence: `packages/device/package.json:48` pins `@anthropic-ai/sandbox-runtime` 0.0.81; latest
  0.0.83; `device/src/network.ts` parses that version's output
- impact: the local sandbox misses two patch releases
- fix: upgrade with the output-format tests
- size: direct fix

### bash-network-hint-provider-blind: the model is told about a proxy that may not exist

- status: recurring (2nd time, first seen in 2026-11-12-2-design-review.md)
- severity: low
- lens: drift
- evidence: `tools/builtins/sandbox/bash.ts:76-80` promises `HTTP_PROXY` and a blocked-domain
  report; sandbox-e2b has no proxy and no `ExecResult.network`
- impact: the model passes a proxy that does not exist and waits for a report that never comes
- fix: the hint only in the device trailer, or chosen by a provider capability
- size: direct fix

### special-cased-names: one vendor's token errors are kernel code

- status: recurring (3rd time, first seen in 2026-11-12-design-review.md)
- severity: low
- lens: special-case-patch
- evidence: `tools/oauth/tokens.ts:57-85` (Slack codes); `runtime/context/claude-tools.ts:19`
  (`plugin__todo__write`); `platform/ops/models.ops.ts:94,162` (`model-anthropic`)
- impact: each new vendor edits the kernel
- fix: extensions classify their own token errors and declare tool mappings; fix the examples
- size: direct fix

### template-skills-by-instruction: template skills cost extra model steps

- status: recurring (2nd time, first seen in 2026-11-12-2-design-review.md)
- severity: low
- lens: design-flaw
- evidence: `runtime/subagents/definition.ts:178-184,383-392` tells the child to load its skills
  in the preamble
- impact: a load may not happen, and costs a step when it does
- fix: the kernel writes skill-invocation events at child start
- size: direct fix

### reminder-text-as-flag: an omitted tool set is inferred from reminder text

- status: recurring (3rd time, first seen in 2026-11-12-design-review.md)
- severity: low
- lens: design-flaw
- evidence: `runtime/context/tool-changes.ts:25-37` matches `TOOLS_UNSUPPORTED_REMINDER`
- impact: changing the reminder text changes the logic
- fix: record `toolsOmitted` on `model_call`
- size: direct fix

### requests-spread-over-tables: one inbox question lives in three tables

- status: recurring (2nd time, first seen in 2026-11-12-2-design-review.md)
- severity: low
- lens: design-flaw
- evidence: network allowlist requests in `catalog_requests` (0115), network asks in `approvals`
  (0114), git asks in `approvals` (0126), skill share requests in their own table
- impact: three lifecycles for "someone must decide"
- fix: one org request inbox keyed by kind
- size: needs a spec

### process-guard-keeps-broken-process: a swallowed fatal event leaves the process serving

- status: recurring (2nd time, first seen in 2026-11-12-2-design-review.md)
- severity: low
- lens: special-case-patch
- evidence: `infra/lifecycle/process-guards.ts:19-21` ("Known trade-off")
- impact: an orchestrator never replaces a half-broken replica
- fix: mark readiness not ready on a swallowed fatal event
- size: direct fix

### test-timeout-ladder: per-test timeouts instead of a project split

- status: recurring (2nd time, first seen in 2026-11-12-2-design-review.md); worse (269 → 352)
- severity: low
- lens: special-case-patch
- evidence: `vitest.config.ts:17` (5 s local / 30 s CI); 352 `timeout:` overrides
- impact: a green local run says little about CI
- fix: separate unit and integration vitest projects with matching timeouts; remove the overrides
- size: direct fix

### docs-claims-drift: AGENTS.md contradicts itself and the manifest

- status: recurring (2nd time, first seen in 2026-11-12-2-design-review.md); partially fixed
- severity: low
- lens: drift
- evidence: AGENTS.md:59-60 says "Only the plugin/SDK boundary is checked automatically" while
  :50-51 names the device edge enforced by `check:deps`; AGENTS.md:113-114 says "required ones are
  `builtin`" while `plugin-sdk/src/bootstrap.ts:19-23` says they are two different promises and
  `bootstrap.json` has required non-builtin entries; `docs/architecture.md:51` omits `skills-core`
- impact: a reader cannot tell which promise applies
- fix: four one-line edits, plus generated bootstrap / dependency lists
- size: direct fix

### stale-npm-dependencies: tracked majors

- status: recurring (2nd time, first seen in 2026-11-12-2-design-review.md)
- severity: low
- lens: stale-dependency
- evidence: plugins `anthropic` on `@anthropic-ai/sdk` ^0.135.0 (latest 1.8.0);
  `apps/capybara/package.json:32-34` `@opentelemetry/sdk-trace-base` 2.12.0 (deprecated) and
  `@opentelemetry/resources` 2 (latest 3); core also jsdom 30→31, protobufjs 7→8
- impact: an SDK upgrade deferred is an SDK upgrade that gets harder
- fix: upgrade the Anthropic SDK with the plugin's live tests; OTel with the metrics work
- size: direct fix

## Fixed since the previous review

- `post-commit-followups-no-outbox`: a transactional outbox (`migrations/0119_outbox.sql`,
  `infra/outbox/{service,dispatcher,relay,registry}.ts`, `add` mandatory, fast path plus a
  `@LockedInterval` relay, dead letters surfaced). Every sweep the spec named is gone (`Waits.sweep*`,
  `UsageReportSweep`, `OffboardSweepJob`, `enqueueAll`, `PlatformMigration`), `kickRun` and the
  read-path mutations are gone, and the rules are checked (`check:outbox-registry`,
  `kc-enqueue-via-outbox` with reasons). The remaining edges are separate findings above.
- `device-op-before-record`: intent first, then the device call, then settle
  (`local-devices/device-policy.service.ts:100-230`, `pending_policy_ops` 0118, a resolver job,
  hello backfill).
- `catalog-import-heal-job`: `catalog/platform-migration.ts` deleted (0121 drops its table);
  platform rows are written inside the import transaction.
- `special-cased-names`, the `catalog/claude/mcp.ts` part: still judged reasonable.

## Reasonable

- The outbox as the sweeps' replacement: one row in the business transaction, one relay,
  deterministic ids, per-job idempotency sentences, 14 exceptions each with a reason.
- Intent-first device policy ops: one intent, one resolver, no resend.
- `ensure-run` backstop with `runAt` plus the direct post-commit call: latency and durability
  separated.
- `run-orphan-check` as a single `@LockedInterval`, re-checked under the run lock: a repair for
  replica death, not a per-feature sweep.
- Terminal state in one transaction (`RunFinish.finishIn`), idempotent terminal event.
- Org run and eval quotas as renewed Redis leases; quota loss never fatal.
- `sandboxTiers` deployment settings: read-only when set by env/file, token widening refused.
- Intent-first external calls in the sandbox and device paths; no socket proxy on a host address.
- `enabled.ts` and `wantedOn`/`componentOn` as the shared enablement predicates.
- `conversations.source` stored at creation and required on insert (0124): never guessed.
- The git gateway: ticket auth, per-org concurrency, `safeFetch`, no secrets in logs.
- `marketplace-integrity` check plus the hand-refreshed plugins marketplace: drift is caught.
- Bootstrapping: required vs builtin are documented as two promises and checked by
  `check:bootstrap`.
- Kernel lifecycle hooks carry no `org_id`: deletion's own cleanup.
- `device` importing only `plugin-sdk` is now enforced by `check:deps`.
- OrgGuard 404s non-members and reads the role live; the HUMAN_ONLY / service-token split holds.
- Contract with actions: 283 `ERROR_CODES` all have en+zh copy.
- `sandbox-docker` hardening and the dev-tier union disclosed in org settings.
- The same-day `revert(web)` of the short plugin route left no residue: the acceptance loop
  working, not thrash.

## Baseline numbers

| Number | Previous (7cb12115f) | Current (6e9ddb4d2) |
|---|---|---|
| kernel src non-test lines | 174,954 (41799f041); 7cb12115f not totalled | 195,983 |
| commits in the window | 149 (fix 43, feat 40) | 308 (fix 100, feat 52, docs 34) |
| files mentioning legacy / compat / deprecated (non-test) | 101 | 103 |
| plan / ruling ids in source comments | 1,006; 1,475 `§` in kernel | 1,027; 1,924 `§` in kernel src |
| migrations | 116 | 128 |
| checks | 28 `check:*`, 8 `gen:*`; 9,456 lines | 29 `check:*`, 8 `gen:*`; 10,515 lines |
| specs / plans | not collected | 52 / 80 |
| `pnpm outdated` majors | core: @fastify/static 9→10, @opentelemetry/resources 2→3 (sdk-trace-base deprecated), es-module-lexer 2→3, jsdom 30→31, protobufjs 7→8; plugins: @anthropic-ai/sdk 0.135→1.8 | core unchanged; OTel instrumentations 0.223→0.301, oxc-parser 0.154→0.158; plugins: @anthropic-ai/sandbox-runtime 0.0.81→0.0.83 |
| npm `latest` dist-tag | 0.1.0-rc.0 for every package | still 0.1.0-rc.0 (`next`: sdk rc.20, kernel rc.27) |
