# Design review 2026-11-16

- core HEAD: e65ccefb1; plugins HEAD: 85aaf65
- previous review: `docs/reviews/2026-11-14-design-review.md` (core 6e9ddb4d2, plugins 4fec4d1);
  the narrower `2026-11-15-conversation-review.md` was remediated inside this window
- lanes: runtime, extensions-catalog, tools-environments, tenancy-infra, web-ux, process, cross-module
- window: 315 core commits (fix 99, feat 65, docs 48; +76.1k / −21.5k lines, 1,141 files) and 29
  plugins commits (+4.2k / −1.5k, 105 files); feature lines: auto mode and device modes replacing
  the sandbox tiers, command review hardening, connectors follow their plugin, test portfolio and
  `verify --fast`, agent attribution, context compaction, device page and service control,
  tool-catalog header, `safeFetch`, extension route access, project root, org egress ceiling,
  conversation execution fencing and recovery

## Themes

1. **Defaults are open, and "off" is the only thing that is enforced.** A model provider is usable
   in every org that never switched it off, a new local device runs unsandboxed in auto mode, the
   egress ceiling skips auto mode, org security settings fall back to their permissive value when
   unreadable, and the org still cannot deny a builtin tool for attended runs. Explains
   `model-provider-on-by-absence`, `auto-mode-unsandboxed-by-default`, `egress-ceiling-skips-auto-mode`,
   `org-settings-heal-on-read`, `tool-policy-not-a-ceiling`, `sandbox-docker-runc-default`,
   `sdk-has-no-safe-fetch`. One change: every "is this allowed" answer is opt-in and computed by one
   function per question (enabled, tool policy, network reach), each layer a ceiling for the one
   below, failing narrow.
2. **A kernel rule is re-derived outside its owner.** The browser computes the org cloud-network
   delta and the auto-mode ceiling, the eval Platform op re-runs the set service's admission rules
   in SQL, and the platform-setting layering (env > file > PG > default) is hand-written twice
   beside the generic one. Explains `cloud-network-delta-computed-by-client`,
   `eval-case-rules-duplicated-in-precheck`, `platform-setting-layering-hand-rolled`,
   `execution-liveness-decided-in-many-places`, `live-install-set-copied-with-dead-status`,
   `allow-host-rules-copied`, `network-reach-decided-in-many-places`. One change: the server takes
   intent (the edited list, the case to add) and owns the derivation; shared predicates are
   exported once.
3. **Compatibility layers keep growing, now for days-old formats.** The sandbox tiers lived two
   days and left a data migration, a removed-key reader, upgrade prose and readers in the kernel,
   the device program and scheduled-task grants; `upgrading` install rows, `legacy_format`,
   config-declared extensions, `place`/`aliasOf` and the frozen replay texts remain. Explains
   `legacy-compat-layers`, `sandbox-tiers-thrash`, `replay-forces-compat`, `web-older-kernel-fallbacks`,
   `ui-place-alias-compat`, `legacy-format-status`, `config-declared-extension-source`,
   `config-unknown-keys-dropped`. One change: one destructive cleanup series, a strict config schema,
   and a spec-gate line "a feature replaced before 0.1.0 gets no migration and no reader".
4. **The fencing fix is right; its lock is too wide.** Run ownership is now fenced (good), but the
   fence takes the org row `FOR NO KEY UPDATE` in every run transaction, so every run in an org
   and every org admin write queue on one row. Explains `run-fence-serializes-org`,
   `fence-is-ambient`, `org-stop-scans-every-conversation`. One change: shared admission locks,
   exclusive only for deletion, and an explicit claim assertion.
5. **Enterprise operations still missing** (unchanged, and zero commits this window): tenancy by
   convention, no retention or purge, an org audit trail nobody can read, no budgets, no metrics,
   no key-rotation command, no groups. Explains `tenancy-by-convention`, `no-retention-or-purge`,
   `org-audit-unreadable`, `cost-recomputed-from-current-prices`, `no-metrics-no-rate-limits`,
   `key-rotation-unusable`, `roles-without-groups`, `per-org-limits-in-platform-json`.
6. **Governance outgrows product.** 47% of the window's commits are test/docs/chore, 30 checks and
   11.3k lines of check code, 2,257 `§` references in kernel src, while the gaps of theme 5 got no
   commit. Explains `governance-load`, `check-registry-drift`, `english-rule-unenforced`,
   `spec-review-misses-agents-rules`, `docs-claims-drift`, `stale-comments-and-docs`.

## Findings

### model-provider-on-by-absence: a provider never switched on in an org is usable there

- status: new
- severity: high
- lens: security
- evidence: `models/enablement.ts:105-124` (`switchedOff` returns only explicit
  `extension_org_configs.enabled = false` rows; "an extension with no row … keeps working as
  before"); `runtime/providers.ts:336,397` (`target` checks only that set, then
  `EffectiveConfigs.get`); pinned by `test/models/enablement.http.test.ts:580` ("a provider never
  switched in an org stays usable"); every other extension and embedding use opt-in
  `extensions/enabled.ts:15`, `models/embeddings.ts:89`; introduced c3c88b68b
- impact: an `optional` or `named` provider (the optional bootstrap providers anthropic, openai,
  deepseek, bailian, ark) is callable with the platform's keys in orgs that never got it,
  contradicting AGENTS.md "off in every org until switched on"
- fix: `ProviderService.target` and the model lists use `isExtensionEnabled`; delete `switchedOff`;
  flip the test
- size: direct fix

### auto-mode-unsandboxed-by-default: the default device mode has no OS sandbox, only a best-effort rule table

- status: new (grew out of `device-read-denylist`)
- severity: high
- lens: security
- evidence: `packages/device/src/commands/login.ts:159` (`let mode: SandboxMode = "auto"`);
  `config/schema.ts:1721` ("auto mode is the default of a new local device and of a cloud device");
  `sandbox/review/rules.ts:14-15` ("best-effort, not a security boundary … Accepted, documented
  gaps"); 28 bypass-closing review commits in the window (e.g. d766513f2, 9ea80502e, 4a61daf0e)
- impact: by default a prompt-injected agent on a member's laptop can read and send secrets; the
  only guard is a rule table that says it is not a guard
- fix: sandbox mode is the default for a new local device; auto is an explicit owner opt-in on the
  machine (already the only way to turn it on); stop growing the rule table and scope the review to
  visibility
- size: needs a spec

### org-audit-unreadable: org audit events are write-only

- status: new
- severity: high
- lens: gap
- evidence: the only general reader `admin/platform-audit.service.ts:42-58` filters
  `org_id IS NULL`; the web calls only `/api/v1/admin/audit` (`apps/web/src/lib/admin.ts:481`);
  `devices/devices.service.ts` reads only device events; org events such as role changes,
  `org.deleted`, `trajectory.viewed` have no reader
- impact: the trajectory-privacy audit and every org admin action cannot be inspected by anyone
- fix: `GET /orgs/:orgId/audit` (keyset paged, org admin), an org filter on the super admin's audit,
  export; a Platform operation for it
- size: direct fix

### tool-policy-not-a-ceiling: the org cannot deny a tool for attended runs

- status: recurring (4th time, first seen in 2026-11-12-design-review.md)
- severity: high
- lens: design-flaw
- evidence: `tools/policy.ts:199-202` (`forbiddenTools` unattended only); `orgs/settings.service.ts:218`
  (`sandboxToolPolicy` allow|ask); `tools/org-tool-switches.ts:56-58` ("Builtin and connector tools
  are out of scope"); the final decision is split over `createDecidePolicy`, `decideGitPush`
  (`tools/git-push-policy.ts:117`), `tools/network-asks.ts`, the command review and the device's
  local policy
- impact: an org admin cannot forbid Bash, Write, Edit, WebFetch or Agent for members
- fix: one org allow|ask|deny table per tool key for every kind, applied first in
  `createDecidePolicy`; `forbiddenTools` becomes its unattended column
- size: needs a spec

### sdk-has-no-safe-fetch: plugins cannot reach the kernel's safe fetch

- status: recurring (4th time, first seen in 2026-11-12-design-review.md)
- severity: high
- lens: security
- evidence: no `net` item in `plugin-sdk/src/ctx.ts`; plugins `connector-mcp/src/session.ts:309`,
  `connector-openapi/src/http.ts:105,385` call raw `fetch`; no private-address check on connector
  endpoints (`tools/endpoint.ts`)
- impact: an org admin can point a connector at 169.254.169.254 or an internal service: SSRF from
  the shared kernel process
- fix: `ctx.net.fetch` backed by `safeFetch` / the proxy agent, gated by `permissions.network`;
  `connectors.allowPrivateHosts` for the super admin
- size: needs a spec

### tenancy-by-convention: org scoping is a per-query convention

- status: recurring (4th time, first seen in 2026-11-12-design-review.md)
- severity: high
- lens: security
- evidence: no RLS; `conversation_events` has no `org_id` (0006); new tables scope through a parent
  (`device_projects`, `0133_project_root.sql:5`); `where("id", …)` sites 644 → 680; no check
  mentions `org_id`
- impact: one missing predicate leaks another tenant's rows and nothing fails closed
- fix: a tenant-scoped `KernelDb` variant (`infra/database/kernel-db.ts:20-55` already proxies
  every query) requiring an org on tenant tables, a check, and an RLS backstop
- size: needs a spec

### no-retention-or-purge: nothing is ever deleted

- status: recurring (4th time, first seen in 2026-11-12-design-review.md)
- severity: high
- lens: gap
- evidence: org and conversation deletes are soft (`orgs/orgs.service.ts:264-273`,
  `conversations/conversations.controller.ts:327`); accounts can only be disabled
  (`admin/admin.controller.ts:131`); only deleted-org object storage is purged (`storage/purge.ts`),
  leaving PG rows that point at deleted objects
- impact: no GDPR-style erasure, unbounded growth, dangling object references
- fix: org and account purge jobs that mirror the storage purge; per-org conversation and audit
  retention
- size: needs a spec

### cost-recomputed-from-current-prices: no price snapshot, no budgets, no default run limits

- status: recurring (4th time, first seen in 2026-11-12-design-review.md)
- severity: high
- lens: design-flaw
- evidence: `admin/usage.service.ts:238,293,310,356` price from the live table; `model_usage` has
  no price column (`db/kernel-schema.ts:1364`); `maxSteps: 0` and `maxTokensPerRun: 0`
  (`config/schema.ts:822,1272`); the only rate control is concurrency (`runtime/quota.ts:121-128`)
- impact: past cost changes when a price is edited; one loop spends without bound
- fix: store the price per usage row at call time; per-org and per-member token / spend budgets
  checked before each step
- size: needs a spec

### legacy-compat-layers: a permanent reader for every removed feature

- status: recurring (4th time, first seen in 2026-11-12-design-review.md); worse
- severity: high
- lens: drift
- evidence: 109 non-test files mention legacy/compat/deprecated (was 103). New this window:
  `local-devices/policy-summary.ts:36-63` (`legacyIsolationOf`, `legacyPolicyOf`);
  `schedules/grant-rules.ts:219-240` and `scheduled-tasks.service.ts:1038,1433-1441` (`tier:`
  grants still read, never migrated); `packages/device/src/state.ts:160-222` (`LEGACY_POLICY_KEYS`)
  and `commands/policy.ts:174-181` (e08c07510, f3c29f59e, caa4575fe); `runtime/model-call.ts:1077-1088`
  (step-less compaction counted as legacy, 13a3fcda6). Still there: `tools/legacy-keys.ts`,
  `devices/legacy-cleanup.job.ts`, `runtime/context/legacy-text.ts`, `runtime/retired-schedulers.ts`,
  `identity/audit.ts:39`, `identity/cookies.ts:20`, `db/kernel-schema.ts:967`; docs:
  `docs/deploy/upgrade.md` 365 → 439 lines
- impact: every removal leaves a reader, and AGENTS.md says pre-0.1.0 has none
- fix: one destructive cleanup series: refuse a device hello without the `mode` feature, a hard
  error for an old `policy.json`, a migration deleting `tier:%` grants and rewriting legacy keys,
  then delete the readers, the cleanup job and the pre-0.1.0 upgrade notes
- size: direct fix (several PRs)

### replay-forces-compat: zero-drift replay of rc logs freezes production text

- status: recurring (4th time, first seen in 2026-11-12-design-review.md)
- severity: high
- lens: drift
- evidence: `runtime/context/legacy-text.ts` (FROZEN), used at `build.ts:23,792-793,986`; four
  `pre-*` fixtures; `evals/reconstruct.ts:258,432` (`legacy_event`); `run-context.service.ts:145`
- impact: production prompt text cannot change without a frozen copy
- fix: zero drift only for logs written from 0.1.0; delete the frozen texts and fixtures
- size: needs a spec (short)

### setup-model-goes-to-extensions: "set up a model" has six destinations

- status: recurring (4th time, first seen in 2026-11-12-design-review.md); wider
- severity: high
- lens: gap
- evidence: `components/shell/setup.tsx:76,79` and `components/conversation/Thread.tsx:591` →
  `/admin/extensions`; `admin/models/view.tsx:276` → `/admin/plugins`;
  `settings/models/view.tsx:245` → `/plugins`, `:332` → `/extensions?tab=model`
- impact: no audience has one place to set up a model; each link teaches the plugin/extension split
- fix: `/admin/models` and `/settings/models` install and configure providers inline; all links
  point there
- size: direct fix

### plugins-and-extensions-both-in-nav: two names for one unit in every audience's nav

- status: recurring (4th time, first seen in 2026-11-12-design-review.md)
- severity: high
- lens: gap
- evidence: `components/shell/nav.tsx:87-99` (members get 插件 and 扩展); `components/admin-nav.ts:9-23`
  (13 flat items); 13 plugin/extension routes (was 12)
- impact: a member meets two packaging terms before the first conversation
- fix: one Plugins surface with the extension as a tab, none for members; about four admin groups
- size: needs a spec

### governance-load: the enforcement layer is a second product

- status: recurring (4th time, first seen in 2026-11-12-design-review.md); worse
- severity: high (was medium: governance work now outweighs product work and none reached the
  enterprise gaps)
- lens: over-engineering
- evidence: 148 of 315 commits are test/docs/chore/ci (47%, was 29%); 30 `check:*`, 11,253 lines in
  `tools/checks/src`; 64 specs / 91 plans; 2,257 `§` references in kernel src (was 1,924);
  `tools/checks/test-portfolio-baseline.json` grandfathers 126 test files; no commit touched
  retention, budgets, metrics or groups
- impact: upkeep consumes the capacity theme 5 needs
- fix: no new check or spec/plan pair below a cross-package change; next window's feature budget
  goes to retention, budgets and metrics; replace `§`/ruling ids in comments with the invariant
- size: needs a spec (a process decision)

### run-fence-serializes-org: every run transaction locks the org row

- status: new (introduced by the `run-lock-no-fencing` fix, c412cf39a)
- severity: medium
- lens: design-flaw
- evidence: `runtime/run-execution.ts:72-95` (org row, root, conversation `FOR NO KEY UPDATE`);
  `infra/database/transaction-host.ts:143` runs it at the start of every writable transaction in a
  claim; empty fence transactions before every dispatch (`tools/pipeline.ts:2078,2234`);
  `orgs/org-lock.ts:19-21` (holders exclude each other); the spec accepts it in writing
  (`2026-11-15-conversation-reliability-design.md:161-164`)
- impact: every event append and tool dispatch of every concurrent run in an org, and every org
  admin write, queue on one row
- fix: `FOR KEY SHARE` (or a shared advisory lock) on org and root for admission; deletion and
  offboarding take the exclusive form; ownership stays the `execution_id` comparison under the
  conversation lock; a dual-replica deadlock test; amend the spec
- size: needs a spec (lock order)

### egress-ceiling-skips-auto-mode: `orgHosts: within` does not bound auto mode

- status: new
- severity: medium
- lens: security
- evidence: `config/schema.ts:1698` ("Auto mode is not limited by it"); `sandbox/sandbox.service.ts:384-393`
  only warns at startup; `devices.autoMode` defaults to allowed
- impact: a super admin who sets the allowlist as the ceiling still has every default cloud device
  on the open internet
- fix: under `within`, cloud devices in auto mode get the allowlist too (as `sandbox/modes.ts:84`
  does for sandbox mode), or refuse `within` together with an allowed auto mode at every write
- size: direct fix

### sandbox-docker-runc-default: model code from every org shares the host kernel

- status: new
- severity: medium
- lens: security
- evidence: plugins `sandbox-docker/src/index.ts:36-37` (`runtime` defaults to `runc`); the rest of
  the hardening is good (`provider.ts:1150-1155`)
- impact: one kernel exploit crosses tenants
- fix: default `runsc`, or refuse `runc` on a multi-org deployment without an explicit super admin
  opt-in
- size: direct fix

### cloud-network-delta-computed-by-client: the browser and the model compute the kernel's storage delta

- status: new (the device-page half of `sandbox-tier-ceiling-decided-twice` is fixed; the pattern
  moved here)
- severity: medium
- lens: design-flaw
- evidence: `apps/web/src/lib/org-settings.ts:170-199` (`cloudNetworkToSave` derives
  `extraHosts`/`excludedHosts` from the platform list as loaded); `settings/sandbox/view.tsx:187-192`
  re-implements the auto-mode ceiling; `platform/ops/org-settings.ops.ts:37-67` makes the model send
  the stored value whole
- impact: a platform change between load and save writes wrong exclusions; three copies of a
  security rule
- fix: the PATCH takes the edited effective list (or add/remove); the kernel derives the delta in its
  transaction; the GET returns `autoMode` effective/allowed like the device view
- size: direct fix

### config-unknown-keys-dropped: a typo in a security key is ignored

- status: new
- severity: medium
- lens: special-case-patch
- evidence: `config/load.ts:80-107` (`removedConfigProblems`, 204dd7489) refuses three removed keys;
  `KernelConfigSchema` is non-strict; `config/env.ts:39-47` accepts any `CAPYBARA_*` path
- impact: a misspelt egress or limit key silently falls back to the default
- fix: strict objects across the schema (an unknown key is a `ConfigError` with its path); delete
  `removedConfigProblems`
- size: direct fix

### sandbox-tiers-thrash: a two-day-old feature got a migration, a reader and upgrade prose

- status: new
- severity: medium
- lens: special-case-patch
- evidence: tiers spec 45ead4563 and code 6887c225d (11-12), replaced by 36976d370 (11-14);
  `migrations/0130_auto_mode.sql` maps tier data; `docs/deploy/upgrade.md:140-163` (1fefc8062);
  plus the readers listed under `legacy-compat-layers`
- impact: the cost of a replaced design is paid again as compatibility nobody needs
- fix: drop the upgrade section with the cleanup; a spec-gate line: a spec replacing a feature not
  yet in 0.1.0 states "no migration, no reader"
- size: direct fix

### platform-setting-layering-hand-rolled: env > file > PG > default is written three times

- status: new
- severity: medium
- lens: design-flaw
- evidence: `sandbox/platform-auto-mode.ts` (115 lines) and `attribution/platform-attribution.ts`
  (223 lines) each hand-write the chain (`identity/settings.ts:551-625`);
  `extensions/deployment-config.ts:287-583` has a generic one; other settings are PG-only
  `DEPLOYMENT_SETTINGS`
- impact: each new platform setting copies ~100 lines and picks a mechanism
- fix: one layered-setting helper (`key`, `schema`, `configPath`) used by both
- size: direct fix

### per-org-limits-in-platform-json: per-org overrides live as maps in one shared row

- status: new
- severity: medium
- lens: design-flaw
- evidence: `identity/settings.ts:226-235,357-398` (`{orgId: …}` maps for run concurrency, sandbox
  and sub-agent limits); `runtime/quota.ts:126`; other org limits live in org settings
- impact: no FK, never cleared on org deletion, every org's edit rewrites one shared row
- fix: an `org_limits` table (`org_id` FK, cascade) as the only per-org override store
- size: direct fix

### client-heuristics-for-server-order: the web waits out a kernel ordering gap

- status: recurring (4th time, first seen in 2026-11-12-design-review.md)
- severity: medium
- lens: special-case-patch
- evidence: `apps/web/src/lib/live-drafts.ts:10` (`DRAFT_RETRY_MS` ladder); kernel
  `runtime/run-drafts.ts` coalesces writes over 200 ms while deltas publish at once;
  `lib/subagents.ts:290,406,413` re-reads the tree every 1.5 s
- fix: a draft offset in each delta frame (or write before publish); sub-agent tree changes as
  conversation events
- size: needs a spec

### no-member-event-stream: inbox and sidebar state poll every 30 s

- status: new
- severity: medium
- lens: gap
- evidence: SSE exists only per conversation (`runtime/stream.controller.ts:151`) and for extension
  views; `components/shell/nav.tsx:209,230` and `conversations.tsx:218` poll
- impact: an approval that blocks a run reaches the member up to 30 s late
- fix: one per-member SSE topic (inbox count, conversation state) on the existing bus
- size: needs a spec

### web-older-kernel-fallbacks: the web keeps branches for older kernels

- status: recurring (3rd time, first seen in 2026-11-12-2-design-review.md); worse (39 → 44)
- severity: medium
- lens: stale-dependency
- evidence: new ones in `components/agent/AttributionSection.tsx:211`, `lib/org-settings.ts:102-110`;
  `extensions/view.tsx:300-306` re-derives `needsConfig`
- fix: required fields, delete the branches, ban "older kernel" in `check:web-ui`
- size: direct fix

### client-extensions-l2-l3-premature: full client-extension machinery for two consumers

- status: recurring (4th time, first seen in 2026-11-12-design-review.md)
- severity: medium
- lens: over-engineering
- evidence: component consumers are memory and theme-cyberpunk only; 5 of 12 `UI_SLOTS` unused in 22
  plugins; embeds used only by example-board; plugin-client 697 → 874 lines
- fix: unused slots, embeds and arrangement behind an experimental flag until a second consumer
- size: needs a spec

### network-allow-concept-spread / network-reach-decided-in-many-places: one question, many stores and surfaces

- status: recurring (3rd time, first seen in 2026-11-12-2-design-review.md); wider
- severity: medium
- lens: design-flaw
- evidence: stores `sandbox.limits`, org `cloudNetwork` (0134), platform/org/device `autoMode`
  (0130, 0131), `catalog_requests`, approvals, `scheduled_task_grants`, `device_machines.local_policy`
  and `pending_policy_ops`; evaluated in `sandbox/modes.ts` and `device/src/policy.ts:110-130`; no
  cloud provider fills `ExecResult.network.blocked`; UI mixes "host" (40) and "domain" (24)
- fix: one pure rule in plugin-sdk, a `network_grants` table, cloud providers report blocked hosts;
  one term and one org Network page
- size: needs a spec

### egress-narrowing-not-live-on-cloud-devices: narrowing does not reach running instances

- status: recurring (3rd time, first seen in 2026-11-12-2-design-review.md)
- severity: medium
- lens: security
- evidence: `sandbox/modes.ts:189-209` (`sameApplied` compares mode and network kind only)
- fix: a digest of the hosts in the applied state; update or recreate on change
- size: needs a spec

### allow-host-rules-copied: the host rule and public-suffix list exist in several copies

- status: recurring (3rd time, first seen in 2026-11-12-2-design-review.md)
- severity: medium
- lens: design-flaw
- evidence: `sandbox/modes.ts:46`, `device/src/policy.ts:66`, plugins
  `sandbox-docker/egress-proxy/proxy.mjs:153`; `devices/public-suffix.ts` = `device/src/public-suffix.ts`;
  `plugin-sdk/src/sandbox.ts:489` and `orgs/settings.service.ts:73-88` accept `*.co.uk`
- fix: `allowHostCovers` and the public-suffix check in plugin-sdk with shared vectors; validate
  every host list with them
- size: direct fix

### org-enablement-three-layers: "is X on for this org" has seven deciders

- status: recurring (4th time, first seen in 2026-11-12-design-review.md); wider
- severity: medium
- lens: design-flaw
- evidence: `catalog/scope.ts:31` (`wantedOn`), `plugin_installs`, `extensions/enabled.ts`,
  `models/enablement.ts` (above), `catalog/component-state.ts:35-81`, `needs_config`, replica load;
  `catalog/org-extension-switch.ts:16-41` routes the switch two ways
- fix: one `orgUsable(orgId, plugin)` from intent plus install state, with separate `on` and
  `install_failed`
- size: needs a spec

### live-install-set-copied-with-dead-status: one status set in 11 places, one value never written

- status: new
- severity: medium
- lens: design-flaw
- evidence: `["installing","installed","upgrading"]` in `catalog/scope-sync.ts:124`,
  `catalog-scope.service.ts:143`, `component-state.ts:265`, `unshare.ts:19`, `catalog-items.ts:830`,
  `inbox/platform-inbox.service.ts:17`, `agents/templates.ts:79`, `skills/usable.ts:68`, inline in
  `plugin-upgrade.ts:934,1876`, `plugin-install.ts:1765`; nothing writes `upgrading`; a stale-upgrade
  branch remains (`plugin-install.ts:1864-1885`)
- fix: export one `LIVE_INSTALL`; drop `upgrading` (two-step); delete the branch
- size: direct fix

### config-declared-extension-source: a second way to load an extension, outside the catalog

- status: new
- severity: medium
- lens: stale-dependency
- evidence: `config/schema.ts:228` `extensions`; `extensions/sources.ts:12` ("development mode and
  existing deployments"); its own gates `host.ts:2454`, `org-extension-switch.ts:37-41`
- fix: dev and tests use `source: "workspace"` bootstrap entries; drop the key
- size: direct fix (unverified: test dependence)

### extensions-share-env-and-db-role / config-two-org-layers / scope-machines-duplicated / scope-sync-backstop-ladder / scope-sync-item-job-fans-out-all-orgs / one-plugin-kernel-contracts / catalog-size / unverified-provenance-shown / usage-report-no-backfill

- status: recurring, unchanged (4th time for env/db role, scope machines, one-plugin contracts
  2nd, catalog-size 4th; config-two-org-layers and provenance 3rd; scope-sync pair and backfill 2nd)
- severity: medium each
- evidence and fix: as in the previous review; re-confirmed: `ctx/create-ctx.ts:644` one pool;
  `define-extension.ts:33` `config.org` vs `orgAccess`; `catalog-scope.service.ts` 1,488 and
  `component-scope.service.ts` 1,538 lines; `scope-jobs.ts:21-76`; `scope-sync.ts:186-217`;
  `context@1` and `0123_pgvector.sql` serve memory only; catalog 30,994 lines; provenance copy
  `apps/web/messages/en.json:4746` without "unverified"; `usage-subscribers.ts:60`
- size: as before

### langgraph-checkpoint-duplicates-log / retry-after-kills-runs / compaction-marker-in-prompt / media-budget-rewrites-history / request-order-inferred-not-recorded / model-visible-render-scattered

- status: recurring (4th time each, first seen in 2026-11-12-design-review.md)
- severity: medium each
- evidence: `runtime/langgraph-loop.ts`, `checkpointer.ts` (the fence now also guards checkpoint
  writes: the second store doubles every ownership fix); `model-call.ts:145,1640-1647`;
  `context/compaction.ts:12-13,32` (read only by `plugins/model-fake/src/script.ts:46`);
  `build.ts:279` ("已知取舍（接受）"); `build.ts:626-640,845`; `build.ts:854,950`, `compaction.ts:355`
- fix and size: as before

### scheduled-task-uses-retired-queue: a current feature depends on the removed queue

- status: recurring (2nd time, first seen in 2026-11-14-design-review.md)
- severity: medium
- evidence: `schedules/fire.ts:384` → `ConversationQueue.add` (`conversations/queue.service.ts:212`)
- fix: append the `user_message` in the fire transaction; drop the queue
- size: needs a spec (short)

### git-push-policy-unreachable / check-registry-drift / english-rule-unenforced / spec-review-misses-agents-rules / migrations-no-concurrent-index / kernel-schema-handwritten / key-rotation-unusable / roles-without-groups / no-metrics-no-rate-limits / plugins-docs-still-pin / npm-latest-points-at-rc0

- status: recurring, unchanged
- severity: medium each
- evidence (re-confirmed): `connectors.git_push_policy` has no writer (`tools/git-push-policy.ts:128`);
  `check:config-docs`, `check:package-schemas`, `check:plugin-pack` missing from
  `tools/checks/README.md`; 472 CJK lines in `plugin-sdk/src` and ≥13 new Chinese comment lines in
  kernel src; 0 of 11 new specs name the AGENTS.md rules they touch; `0133_project_root.sql:28-30`
  builds an index on `conversation_events` inside the migration transaction ("Not CONCURRENTLY");
  `db/kernel-schema.ts` 2,149 lines; no rewrap command; `orgs/roles.ts:2`; no metrics exporter;
  plugins `writing-plugins/SKILL.md:63,73` teach `pinned`; `latest` = 0.1.0-rc.0 (`next`: sdk rc.24,
  kernel rc.34)
- fix and size: as before

### device-read-denylist: device reads in sandbox mode are open except a denylist

- status: recurring (4th time, first seen in 2026-11-12-design-review.md)
- severity: medium (was high: it now applies only to sandbox mode; the default is
  `auto-mode-unsandboxed-by-default`)
- evidence: `device/src/policy.ts:18-49,191-196`
- fix: an `allowRead` list (workspace, project roots, toolchains) in sandbox mode
- size: direct fix

### Low

- `execution-liveness-decided-in-many-places` (new, design-flaw): "org and conversation live" in
  `run-queue.ts:173-181,249-255`, `run-execution.ts:72-95`, `run-orphan-check.job.ts:99-116`,
  `run-deletion.ts:58-75`. Fix: one `liveConversationIn(t, id)`. Direct fix.
- `org-stop-scans-every-conversation` (new, design-flaw): `run-deletion.ts:35-52` pages every chat
  and sub-agent conversation the org ever had, one transaction each, no cursor; `:104` records
  `reason: "user"`. Fix: select only conversations with an active run or task; an `org_deleted`
  reason. Direct fix.
- `fence-is-ambient` (new, design-flaw): the fence runs only when a root transaction opens
  (AsyncLocalStorage); dispatch authorizes via an empty transaction (`tools/pipeline.ts:2078`). Fix:
  an explicit `execution.assertClaim()`; `KernelDb` refuses non-transactional writes inside a fence.
  Direct fix. Unverified whether any worker write bypasses it today.
- `org-settings-heal-on-read` (new, security): `orgs/settings.service.ts:169-174,218` —
  `forbiddenTools` falls back to `[]` and `sandboxToolPolicy` to `allow` on a parse error, with no
  log, while `autoMode` narrows to `off`. Fix: security fields fall back narrow, or validate once at
  write/migrate time. Direct fix.
- `outbox-conflict-test-only-throw` (new, special-case-patch): `infra/outbox/outbox.service.ts:33-38,127`
  throws on a reused job id in tests, logs and drops in production. Fix: one behaviour, refuse at
  `add`. Direct fix.
- `eval-case-rules-duplicated-in-precheck` (new, drift): `platform/ops/evals.ops.ts:360-418` re-runs
  `evals/sets.service.ts:565-600` in SQL (both got the compact rule, 4f8e43d8a). Fix: one
  `sets.checkAddCase()`. Direct fix.
- `scheduled-task-cannot-bind-project` (new, gap): `schedules/fire.ts:356-369` creates with
  `deviceId` only; no project field. Fix: `project` on the task target, checked by
  `DeviceProjectsService`. Direct fix.
- `unattended-command-ask-unreported` (new, gap; partly unverified): `tools/pipeline.ts:151-158,1197`
  turn a review "ask" into a deny in unattended runs. Fix: record the held command class in
  `missing_grants` and show it on the task run. Direct fix.
- `org-extension-put-two-transactions` (new): `catalog/org-extension-switch.ts:24-27`. Fix: one
  `@Transactional`. Direct fix.
- `legacy-format-status` (new): `extensions/admin-view.ts:77,95,504`, `catalog/plugin-package.ts:408-415`.
  Fix: a plain `catalog.invalid_package`. Direct fix.
- `ui-place-alias-compat` (new): `plugin-sdk/src/ui.ts:65,78-82`, `ui-slots.ts:267-275`; used by
  plugins todo and example-board. Fix: migrate both to `slot`, delete `place`/`aliasOf`. Direct fix.
- Recurring, unchanged: `outbox-dead-admin-gaps`, `process-guard-keeps-broken-process`,
  `requests-spread-over-tables`, `network-grant-in-tool-key` (now also `git:push:` vs `git_push:`
  disagree on the host), `bash-network-hint-provider-blind`, `sandbox-runtime-pinned` (0.0.81 vs
  0.0.83), `special-cased-names`, `template-skills-by-instruction`, `reminder-text-as-flag`,
  `usage-report-hook-no-consumer`, `docs-claims-drift` (AGENTS.md:59-60 says `check:deps` checks
  only the plugin/SDK boundary; it also checks the device edge), `stale-comments-and-docs`
  (`run-worker.ts:65-68`, `orgs.module.ts:22`, outbox spec status, `nav.tsx:27`),
  `stale-npm-dependencies` (see baseline).

## Fixed since the previous review

- `run-lock-no-fencing`: `runs.execution_id` (0135), `RunExecution.claim` / `withClaim`
  (`run-execution.ts:58-68`), the fence at `transaction-host.ts:143`, lease loss aborts in-flight
  work (c412cf39a). Its cost is `run-fence-serializes-org`.
- `compaction-needs-user-turns`: cuts inside an over-budget turn at a tool-pair boundary
  (`compaction.ts:162-185`, 9b22f79af).
- `dead-outbox-row-leaves-run-stuck`: a run with only dead deliveries fails with
  `run.delivery_failed` (`run-orphan-check.job.ts:356-383`).
- `org-deletion-does-not-stop-runs`: `orgs.service.ts:287` owes `stop-deleted-org`; `ensureRun` and
  the claim refuse a deleted org.
- `extension-routes-bypass-auth`: `plugin-sdk/src/http-access.ts` (`public|embed|member|admin`),
  enforced in `http/plugin-dispatch.ts:156-252` before the body, public writes throttled
  (`http/plugin-route-access.ts:84-105`), shown at approval (f99a7225b).
- `oauth-discovery-bypasses-net`: `safeFetch` in `tools/oauth/discovery.ts`, `packages/npm.ts`,
  `packages/provenance.ts`, held by `kc-global-fetch` (d8bddcf90).
- `org-egress-replaces-deployment`: delta storage (0134) and the `orgHosts: within` ceiling
  (a6b14418e); the auto-mode gap is `egress-ceiling-skips-auto-mode`.
- `device-means-two-things`: one device concept with `source: cloud | local`.
- `test-timeout-ladder`: the kernel-unit / integration / container projects
  (`vitest.config.ts:66-100`) and `check:test-portfolio` refusing new per-test timeouts.
- `sandbox-tier-ceiling-decided-twice`: superseded (tiers removed, 36976d370; the device page reads
  the server's `allowedMode`); the pattern recurs as `cloud-network-delta-computed-by-client`.

## Reasonable

- `run-orphan-check` with a PG cursor (0136): BullMQ is not durable, so a PG-side reconciler is the
  only way to settle a run whose job was lost.
- The SSE stream reads a bounded page from PG after each access recheck: a lost bus hint still
  catches up.
- The org-deletion stop obligation carries no `org_id`: it must survive the purge of the org's own
  outbox rows.
- The quota slot keyed by `runId/executionId` with a TTL: a dead slot expires, the replacement never
  waits on a provider that ignores abort.
- A revoked execution writes no terminal state and `RunDeletion` settles the run: a stale worker
  cannot overwrite its successor.
- Command review fails closed when its model or run is unavailable.
- WebFetch refuses private hosts before calling the provider: a cheap first gate.
- Device access is owner-only and answers `not_found`: ids cannot be probed.
- The org cloud network can only be narrowed through the Platform tool: an agent cannot widen its
  own egress.
- Project root: binding (`conversations.project_*`) and snapshot (`project_root` event) are
  different facts; replay reads only the log; `device_projects` in PG with the kernel as the only
  writer; the §12 rework was done in place without a compatibility layer.
- `runs.compact` plus `run_started.trigger: "compact"`: the column steers the worker, the event
  feeds replay snapshots.
- `CompactionProgressService`: the in-memory map only throttles one writer; the state is in Redis
  with a TTL.
- Platform-ops parity holds for this window's routes (compact, four project routes, `platform.me`).
- The local auto-mode gate re-reads the reported mode at every exec.
- Route access is default deny and worth having despite two (example) consumers.
- Org soft delete drops owed outbox rows in the same transaction and keeps usage reports.
- JWT keys chosen by `kid` from the master keyring: rotation covers sessions.
- The `KernelDb` context proxy: one transaction handle without `trx` threading, and the right place
  for a tenant wrapper.
- Webhook 503 while a plugin is missing on a replica; a skipped channel card stays `pending`.
- No-restart revocation ledger (drain, signal, ledger, dispose).
- `bootstrap.json` required vs builtin as two promises, checked.
- Config precedence env > file/Nacos > PG > default, invalid extension config never fails startup.
- `blobs.ts:207` restores content-addressed bytes during an idempotent write: no sweep.
- Setup steps derived by role in `setup.tsx` while readiness comes from the server.
- `/settings/sandbox` refuses to render without server data instead of guessing.
- CSP leaves `style-src` open: extensions are full trust and the design system uses inline styles.
- Themes as a catalog component with the usual scoping.
- Polling bounded to an active run, eval or task.
- `check:test-portfolio` baseline: time-boxed, refuses empty reasons, reports stale entries.
- The closed seam set in `overrides.ts`: tests cannot replace domain classes.
- The revert af6ee061c: one test change backed out, then fixed with a wait (713492b51).
- Docker sandbox hardening (CapDrop ALL, read-only root, no-new-privileges, pids limit), apart from
  the runtime default.

## Baseline numbers

| Number | Previous (6e9ddb4d2) | Current (e65ccefb1) |
|---|---|---|
| kernel src non-test lines | 195,983 | 211,163 (catalog 30,994; tools 25,655; runtime 19,799; extensions 16,303; platform 14,838) |
| commits in the window | 308 (fix 100, feat 52, docs 34) | 315 (fix 99, feat 65, docs 48; test/docs/chore/ci 47%) |
| churn hot spots (kernel) | — | runtime 89, sandbox 64, tools 61, devices 35, conversations 33, platform 25, local-devices 20; packages/device 215, apps/web 177 |
| files mentioning legacy / compat / deprecated (non-test) | 103 | 109 |
| plan / ruling ids in source comments | 1,027; 1,924 `§` in kernel src | 1,516 (regex over packages + apps; the process lane's narrower count is 1,278); 2,257 `§` |
| migrations | 128 | 136 |
| checks | 29 `check:*`, 8 `gen:*`; 10,515 lines | 30 `check:*`, 8 `gen:*`; 11,253 lines |
| specs / plans | 52 / 80 | 64 / 91 |
| per-test timeout matches (rough grep) | 352 | 320 (new ones refused by `check:test-portfolio`) |
| `pnpm outdated` majors | core: @fastify/static 9→10, @opentelemetry/resources 2→3, es-module-lexer 2→3, jsdom 30→31, protobufjs 7→8; plugins: @anthropic-ai/sdk 0.135→1.8 | unchanged; OTel instrumentations 0.223→0.301; @anthropic-ai/sandbox-runtime 0.0.81→0.0.83 |
| npm `latest` dist-tag | 0.1.0-rc.0 (`next`: sdk rc.20, kernel rc.27) | 0.1.0-rc.0 (`next`: sdk rc.24, kernel rc.34) |
