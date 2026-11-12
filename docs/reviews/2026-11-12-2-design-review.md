# Design review 2026-11-12 (second)

- core HEAD: 7cb12115f; plugins HEAD: 050de14 (unchanged)
- previous review: `docs/reviews/2026-11-12-design-review.md` (core 41799f041)
- lanes: runtime, extensions-catalog, tools-environments, tenancy-infra, web-ux, process, cross-module
- window: 149 core commits (network asks, skills on by default with pinning removed, skills catalog
  budget, scheduled-task network grants); +47.5k / -4.3k lines

## Themes

1. **No outbox, and new features add their own repair loops.** Scheduled tasks added a repair scan;
   network decisions send a device op before anything is recorded. Explains
   `post-commit-followups-no-outbox`, `device-op-before-record`, `catalog-import-heal-job`,
   `client-heuristics-for-server-order`. One change: a transactional outbox plus an intent-first
   pattern for calls to devices.
2. **Policies have no ceiling.** The org cannot cap tools for attended runs; the org egress list
   replaces the deployment's; device reads are a denylist while network can now be widened from the
   cloud. Explains `tool-policy-not-a-ceiling`, `org-egress-replaces-deployment`,
   `device-read-denylist`, `network-reach-decided-in-many-places`. One change: every layer is a
   ceiling for the layer below (deployment ⊇ org ⊇ agent / device ⊇ run), computed by one shared
   function.
3. **One fact, several stores.** Org enablement in ~7 predicates; network reach in 7 stores; org
   config in two mechanisms; platform skills copied into orgs. Explains
   `org-enablement-three-layers`, `scope-machines-duplicated`, `config-two-org-layers`,
   `network-reach-decided-in-many-places`, `langgraph-checkpoint-duplicates-log`.
4. **Compatibility layers grow with every removal.** The skills default-on spec says "no
   compatibility layer" and then requires one; a 19-minute spec approval did not catch it. Explains
   `legacy-compat-layers`, `replay-forces-compat`, `web-older-kernel-fallbacks`,
   `spec-review-misses-agents-rules`. One change: zero drift only for logs written from 0.1.0; one
   destructive cleanup; specs state which AGENTS.md rules they depart from.
5. **Enterprise operations still missing** (unchanged): tenancy by convention, no retention, no key
   rotation, no budgets, no metrics, no groups.

## Findings

### post-commit-followups-no-outbox: follow-ups after commit are repaired by sweeps

- status: recurring (2nd time, first seen in 2026-11-12-design-review.md); worse
- severity: high
- lens: design-flaw
- evidence: `kernel/src/runtime/run-queue.ts:55,191-216`; `conversations/conversations.service.ts:378`
  (`kickRun`, called from read paths :1058, :1075, :1482 and `runtime/stream.controller.ts:146`);
  `runtime/waits.ts:201-223` (nine passes; one-day lookbacks :813, :833, :1045, :1594); new:
  `schedules/scan.job.ts:58,202-280` ("a failure is repaired by a later scan"); also
  `runtime/usage-report.ts:767`, `orgs/offboarding.ts:527`, `catalog/owned-items.ts:870`; 46 files
  mention sweep or repair
- impact: each feature re-solves "an enqueue was lost after commit"; reads mutate run state
- fix: transactional outbox table written in the business transaction, one locked relay to BullMQ and
  the bus; delete the per-feature recovery sweeps and `kickRun`
- size: needs a spec

### device-op-before-record: a network decision widens the device before the kernel records it

- status: new
- severity: high
- lens: security
- evidence: `kernel/src/tools/approvals.service.ts:614-735` (`decideNetwork` sends the policy op,
  then decides in a separate transaction; `auditLateAllow` patches one case);
  `local-devices/device-policy.service.ts:92-106` (op first, summary and audit after)
- impact: a crash between the op and the commit widens a device with no kernel audit and leaves the
  approval pending
- fix: write the intent (approval `deciding`, unconfirmed audit row) first, send the op, then
  finalize; a relay resolves intents left open
- size: needs a spec

### tool-policy-not-a-ceiling: the org cannot cap tools for every run and tool kind

- status: recurring (2nd time, first seen in 2026-11-12-design-review.md); worse
- severity: high (was medium: a fifth control list was added that only covers unattended runs)
- lens: design-flaw
- evidence: `kernel/src/tools/policy.ts:110-119,272-283` (agent `allow` beats org `ask` on personal
  credentials); `:198-201` (`forbiddenTools` only for unattended runs);
  `orgs/settings.service.ts:143` (sandbox tools allow|ask only); `extensions/org-tool-switches.ts:52-58`
  (builtin and connector tools out of scope); no org domain policy for WebFetch / WebSearch
- impact: an admin can forbid Bash in scheduled runs but not when a person is in the loop
- fix: one org table, allow|ask|deny per tool key for every kind, applied first in
  `createDecidePolicy` as a ceiling; `forbiddenTools` becomes its deny column with an `unattended`
  scope
- size: needs a spec

### org-egress-replaces-deployment: the org's allowlist is not capped by the deployment's

- status: new
- severity: high
- lens: security
- evidence: `kernel/src/orgs/settings.service.ts:44-45` ("replaces the deployment's list ... the org
  can add other hosts") vs `:196-208` (`effectiveSandboxEgress` takes `org.allowHosts` as is);
  `check()` :314-324 refuses only when the deployment is `none`; `catalog/requests.service.ts:864-874`
  copies the deployment list into the org on the first approved network request, after which the org
  no longer follows platform changes
- impact: the super admin's allowlist is a default, not a limit; one approval silently detaches the
  org from future platform changes
- fix: store org additions as a delta and compute effective = (deployment ∪ org additions) ∩
  deployment ceiling, or add an explicit deployment `orgMayExtend`; never copy the list
- size: direct fix

### device-read-denylist: device reads are open except a denylist

- status: recurring (2nd time, first seen in 2026-11-12-design-review.md); worse
- severity: high (was medium: network can now be widened from the cloud by one owner click or
  `network: open`)
- lens: security
- evidence: `packages/device/src/policy.ts:17-49,165` (reads unchanged); widening paths
  `kernel/src/tools/approvals.service.ts:663-700` (always allow), `devices/devices.controller.ts:143`,
  `device/src/policy.ts` `effectiveEgress` (`ANY_HOST`)
- impact: prompt injection reads `~/.aws` or `.env` and needs one approval to send it out
- fix: reads default to the workspace with opt-in roots; `open` network refused unless reads are
  workspace-only
- size: direct fix

### network-reach-decided-in-many-places: "may this command reach host H" has 7 stores and 2 evaluators

- status: new
- severity: medium
- lens: design-flaw
- evidence: deployment egress `config/schema.ts:1515`; org `sandboxEgress`; `catalog_requests`
  kind `network_allowlist` (0115); `device_machines.local_policy` cache (0114, refreshed on hello /
  op only); run grants in `approvals.detail.grantedHosts` (`local-devices/network-grants.ts:148-176`);
  task grants as `network:<host>` in `scheduled_task_grants.tool_key` (:184-216); device policy file.
  Evaluated in the kernel (`network-grants.ts:237-280`, `tools/network-asks.ts:166`) and again in the
  device (`device/src/policy.ts:65-135`, `network.ts:81-103`); cloud sandboxes never ask
- impact: different answers and freshness per device kind; the kernel plans asks from a stale summary
- fix: one pure rule in plugin-sdk used by kernel and device; a `network_grants` table (org, device,
  host, scope, source); the device pushes its summary on every local change
- size: needs a spec

### egress-narrowing-not-live-on-cloud-devices

- status: new
- severity: medium
- lens: security
- evidence: `kernel/src/config/schema.ts:1518` ("existing ones keep theirs until destroyed");
  plugins `sandbox-e2b/src/provider.ts:791-795`
- impact: narrowing org or deployment egress does not stop running cloud devices
- fix: on narrowing, mark the org's cloud devices for rebuild through the existing rebuild / notice
  path; sandbox@2 states egress is applied on start
- size: needs a spec

### allow-host-rules-copied: the host-matching rule and the public-suffix list exist in several copies

- status: new
- severity: medium
- lens: design-flaw
- evidence: `*.x` matching in `kernel/src/local-devices/network-grants.ts:234`,
  `device/src/policy.ts:65`, plugins `sandbox-docker/egress-proxy/proxy.mjs:108`;
  `kernel/src/devices/public-suffix.ts` = `device/src/public-suffix.ts`; public-suffix refusal only on
  device wildcards (`devices/dto.ts:27`), not in `plugin-sdk/src/sandbox.ts:368` `validateAllowHost`,
  so org egress accepts `*.co.uk`; web copy `apps/web/src/lib/network-hosts.ts:11-24`
- impact: the org-wide list, which matters more, is the weaker one; copies drift
- fix: `allowHostCovers` and the public-suffix check in plugin-sdk; shared test vectors for
  `proxy.mjs` and the web copy
- size: direct fix

### oauth-discovery-bypasses-net: OAuth and npm fetches skip src/net

- status: recurring (2nd time, first seen in 2026-11-12-design-review.md); wider
- severity: high
- lens: security
- evidence: `kernel/src/tools/oauth/discovery.ts:84-95`; also `packages/npm.ts:106` (tarball URLs),
  `packages/provenance.ts:88`
- impact: SSRF to internal hosts; no proxy support
- fix: route all through `safeFetch` / `proxyAgent`
- size: direct fix

### sdk-has-no-safe-fetch

- status: recurring (2nd time, first seen in 2026-11-12-design-review.md)
- severity: high
- lens: security
- evidence: no `ctx.net` in `plugin-sdk/src`; plugins `connector-mcp/src/session.ts:309`,
  `connector-openapi/src/http.ts:105,385`; `tools/endpoint.ts` checks credentials only
- fix: `ctx.net.fetch` backed by `safeFetch`, with an explicit `connectors.allowPrivateHosts`
- size: needs a spec

### tenancy-by-convention

- status: recurring (2nd time, first seen in 2026-11-12-design-review.md)
- severity: high
- lens: security
- evidence: no RLS; `orgs/org.guard.ts:56-120`; 568 `where("id", …)` sites; new
  `scheduled_task_grants` without `org_id` (0113:84-91); `schedules/fire.ts:530,597` by id;
  `evals/runs.service.ts:616` (`assertAgentLive`, moved)
- fix: `TenantDb` wrapper or a check requiring `org_id` on tenant tables; `org_id` on
  `conversation_events`; RLS backstop
- size: needs a spec

### no-retention-or-purge

- status: recurring (2nd time, first seen in 2026-11-12-design-review.md)
- severity: high
- lens: gap
- evidence: `orgs/orgs.service.ts:262` soft delete; no account deletion; `storage/purge.ts` object
  storage only; usage read from `conversation_events` (`admin/usage.service.ts:285-296`), so a purge
  would erase billing history
- fix: usage ledger first (see `cost-recomputed-from-current-prices`), then org / account purge, per-org
  retention, audit retention
- size: needs a spec

### legacy-compat-layers: compatibility layers grew again

- status: recurring (2nd time, first seen in 2026-11-12-design-review.md); worse
- severity: high
- lens: drift
- evidence: old: `tools/legacy-keys.ts`, `tools/legacy-data.ts` (19 importers, called at run start
  `runtime/run-worker.ts:609,658`), `devices/legacy-cleanup.job.ts`, `runtime/providers.ts:239-260`
  (model-provider@1, no plugin uses it), `catalog/catalog.service.ts:62-63,79-80` (`policy`),
  `identity/audit.ts:39-60`. New in this window: `agents/definition.ts:615-640` (strips
  `orgSkills` / `pinned` on every read although 0116 migrated them), `agents/templates.ts:138-149`,
  `catalog/plugin-package.ts:203-225` `withoutRemovedManifestFields` (kernel accepts a field the SDK
  rejects), `catalog/claude/report.ts:77`, `kernel-schema.ts:844,1694,1728` (`suggest_pinned`),
  `identity/cookies.ts:20-49` (legacy refresh cookie path), `runtime/retired-schedulers.ts` (14 ids),
  `extensions/admin-view.ts:77,329-349` (`legacy_format`)
- impact: each removed feature leaves permanent reader branches for data no user has
- fix: one destructive cleanup migration and a PR series deleting every item above; reject `pinned`
  on import
- size: direct fix (several PRs)

### replay-forces-compat: zero-drift replay of rc logs freezes production code

- status: recurring (2nd time, first seen in 2026-11-12-design-review.md); worse
- severity: high (was medium: a fourth frozen fixture now dictates production text)
- lens: drift
- evidence: `runtime/context/legacy-text.ts`; pinned rendering kept in `runtime/context/skills.ts:15-57,139-178`;
  `evals/reconstruct.ts:35-44,270-278`; new fixture `test/evals/fixtures/pre-skills-default-on`
  (d5bd5ce94, 4,143 lines, "never regenerated"); spec
  `2026-11-12-skills-default-on-design.md:161` ("no compatibility layer") vs :295-301 (text "must not
  change")
- impact: a feature that existed 17 days lives on indefinitely
- fix: amend AGENTS.md: zero drift only for logs written from 0.1.0; delete the `pre-*` fixtures and
  the render paths; amend the skills default-on spec
- size: needs a spec (short, amending the replay invariant)

### spec-review-misses-agents-rules: specs depart from AGENTS.md without anyone deciding it

- status: new
- severity: medium
- lens: drift
- evidence: skills default-on spec 401c64848 at 01:15, "approved with every recommendation" plus plan
  3217c4f8d at 01:34, implementation from 01:41; the spec contradicts AGENTS.md (above); pinning built
  2026-10-26 (6809a94bc) and removed 2026-11-12
- impact: the design gate passes on paper; reversals leave residue
- fix: a required spec section "AGENTS.md rules this spec departs from", each needing an explicit
  maintainer decision; `check:agent-docs` requires the section in new specs
- size: direct fix

### catalog-import-heal-job

- status: recurring (2nd time, first seen in 2026-11-12-design-review.md)
- severity: high
- lens: special-case-patch
- evidence: `catalog/plugin-import.ts:1665-1715`; `catalog/platform-migration.ts:1-7,154-155`
  (runs on start and daily); `catalog/owned-items.ts:870` ("the daily sweep repairs it")
- fix: platform rows in the import transaction; object-storage copies keyed by content before the
  commit; delete the migration job
- size: direct fix

### org-enablement-three-layers: "is X on for this org" decided in ~7 predicates

- status: recurring (2nd time, first seen in 2026-11-12-design-review.md)
- severity: high
- lens: design-flaw
- evidence: `catalog/scope.ts:31`, `catalog/component-state.ts:62,81`, `skills/usable.ts:179`,
  `agents/templates.ts:268`, `extensions/enabled.ts:14`, org tool switches, org model disables;
  `catalog/scope-sync.ts` job; `catalog/org-extension-switch.ts:16-41`; two builtin flags
- fix: one pure `isOn(kind, item, org)`; installs record provisioning only; one builtin flag
- size: needs a spec

### scope-machines-duplicated

- status: recurring (2nd time, first seen in 2026-11-12-design-review.md)
- severity: high
- lens: over-engineering
- evidence: `catalog/catalog-scope.service.ts` (1,422) vs `component-scope.service.ts` (1,538);
  org copies of platform components (`skills/skills.service.ts:837-842`) now leak into
  `disabledSkills`, which must match both ids (1b75435e0, `agents/definition.ts:110-130`), against
  AGENTS.md "never copied into orgs"
- fix: one scoped-item service; serve platform rows directly, drop org copies
- size: needs a spec

### config-two-org-layers: org config has two mechanisms

- status: new
- severity: medium
- lens: design-flaw
- evidence: `plugin-sdk/src/define-extension.ts:33` (`config.org`) and `orgAccess` (`org-access.ts:23`);
  stores `extensions/org-config.ts` and `extensions/effective-config.ts:31-38`; plugins split: jina,
  lark, slack use `config.org`; bailian, ark, deepseek use `orgAccess`
- fix: drop `config.org`; `orgAccess(…, "override" | "org-only")` on one schema, one store
- size: needs a spec

### unverified-provenance-shown

- status: new
- severity: medium
- lens: security
- evidence: `kernel/src/packages/provenance.ts:3-7` ("sigstore signatures are not verified", display
  only), shown in import review (`catalog/catalog.service.ts:440`)
- impact: the super admin approves full-trust code on a forgeable claim
- fix: verify with `sigstore`, or label it "unverified" in the review
- size: direct fix

### extensions-share-env-and-db-role

- status: recurring (2nd time, first seen in 2026-11-12-design-review.md)
- severity: medium
- lens: security
- evidence: no env scrubbing; `ctx/create-ctx.ts:236-275`
- fix: scrub secrets from `process.env` after config loads; a Postgres role per extension schema;
  "full trust" stated in the approval UI
- size: needs a spec

### cost-recomputed-from-current-prices: no price snapshot, no budgets

- status: recurring (2nd time, first seen in 2026-11-12-design-review.md)
- severity: medium
- lens: design-flaw
- evidence: `migrations/0027_model_prices.sql`; `admin/usage.service.ts:270-315` (two stores); only
  `subagents.maxTokensPerRun` (`config/schema.ts:1193`); no throttler on message creation
- fix: one `model_usage` ledger with the price at call time; per-org / member token and spend limits
  before each step
- size: needs a spec

### no-metrics-no-rate-limits

- status: recurring (2nd time, first seen in 2026-11-12-design-review.md)
- severity: medium
- lens: gap
- evidence: tracing only (`apps/capybara/src/tracing.ts`, with the deprecated
  `@opentelemetry/sdk-trace-base` 2.12.0); throttles only on credential, device-code and
  client-report routes (`infra/throttler/named-throttlers.ts:47-60`)
- fix: OTel metrics SDK (queues, runs, model errors, lock losses, sweeps) with the OTel upgrade; a
  default per-principal `/api` throttle
- size: needs a spec

### key-rotation-unusable

- status: recurring (2nd time, first seen in 2026-11-12-design-review.md)
- severity: medium
- lens: gap
- evidence: `ctx/secrets.ts:193`, only exported (`index.ts:68`)
- fix: `capybara secrets rewrap`, runbook, test
- size: direct fix

### roles-without-groups

- status: recurring (2nd time, first seen in 2026-11-12-design-review.md)
- severity: medium
- lens: gap
- evidence: `orgs/roles.ts:2`
- fix: groups plus role bindings
- size: needs a spec

### run-lock-no-fencing

- status: recurring (2nd time, first seen in 2026-11-12-design-review.md)
- severity: medium
- lens: design-flaw
- evidence: `runtime/run-worker.ts:499-501,783`; no generation check on append
  (`conversations/event-log.ts`)
- fix: abort the step signal on lease loss; run generation checked on append and tool dispatch
- size: needs a spec

### langgraph-checkpoint-duplicates-log

- status: recurring (2nd time, first seen in 2026-11-12-design-review.md)
- severity: medium
- lens: over-engineering
- evidence: `runtime/langgraph-loop.ts:110-141`; `runtime/checkpointer.ts`; three `@langchain/*`
  dependencies used only for this (`packages/kernel/package.json:50-52`)
- fix: a plain step loop resuming from the log
- size: needs a spec

### compaction-needs-user-turns

- status: recurring (2nd time, first seen in 2026-11-12-design-review.md)
- severity: medium
- lens: gap
- evidence: `runtime/context/compaction.ts:51-58`; `model-call.ts:1353`
- fix: compact at step boundaries; compact once on overflow before failing
- size: direct fix

### retry-after-kills-runs

- status: recurring (2nd time, first seen in 2026-11-12-design-review.md)
- severity: medium
- lens: gap
- evidence: `runtime/model-call.ts:108,1123-1136`
- fix: abortable backoff honouring retry-after within the run deadline
- size: direct fix

### compaction-marker-in-prompt

- status: recurring (2nd time, first seen in 2026-11-12-design-review.md)
- severity: medium
- lens: special-case-patch
- evidence: `runtime/context/compaction.ts:10,21`
- fix: identify compaction by request purpose
- size: direct fix

### media-budget-rewrites-history

- status: recurring (2nd time, first seen in 2026-11-12-design-review.md)
- severity: medium
- lens: drift
- evidence: `runtime/context/build.ts:262-276` ("known trade-off, accepted")
- fix: decide each attachment once and replay the decision
- size: needs a spec

### request-order-inferred-not-recorded

- status: recurring (2nd time, first seen in 2026-11-12-design-review.md)
- severity: medium
- lens: design-flaw
- evidence: `runtime/context/build.ts:608-725`
- fix: each `model_call` records the seqs it appended
- size: needs a spec

### model-visible-render-scattered

- status: recurring (2nd time, first seen in 2026-11-12-design-review.md)
- severity: medium
- lens: design-flaw
- evidence: `runtime/context/build.ts:791,873`, `compaction.ts:154` (`default` swallows)
- fix: one exhaustive `Record<EventType, Renderer>`
- size: direct fix

### client-heuristics-for-server-order

- status: recurring (2nd time, first seen in 2026-11-12-design-review.md)
- severity: medium
- lens: special-case-patch
- evidence: `apps/web/src/lib/live-drafts.ts:5-12`; `components/conversation/useConversation.ts:57-82`;
  `lib/subagents.ts:340-360`
- fix: write drafts before publishing deltas; stream title and sub-agent tree as events
- size: needs a spec

### web-older-kernel-fallbacks: the web keeps branches for older kernels

- status: new
- severity: medium
- lens: stale-dependency
- evidence: 38 "older kernel" fallbacks in `apps/web/src`, e.g. `lib/approvals.ts:39`,
  `app/(app)/extensions/view.tsx:300-305` (re-derives `needsConfig` in the client); web and kernel
  ship together (`docker/web.Dockerfile`, `docker/kernel.Dockerfile`, one tag)
- fix: make the fields required, delete the branches, ban "older kernel" in `apps/web`
- size: direct fix

### setup-model-goes-to-extensions

- status: recurring (2nd time, first seen in 2026-11-12-design-review.md); wider
- severity: high
- lens: gap (ux)
- evidence: `apps/web/src/components/shell/setup.tsx:76,79` (to `/admin/extensions`);
  `app/(app)/admin/models/view.tsx:273-276` (to `/admin/plugins`)
- fix: configure the provider on `/admin/models`; point both links there
- size: direct fix

### plugins-and-extensions-both-in-nav

- status: recurring (2nd time, first seen in 2026-11-12-design-review.md)
- severity: high
- lens: gap (ux)
- evidence: `apps/web/src/components/shell/nav.tsx:83-102` (14 items); `components/admin-nav.ts:9-23`
  (13 flat items); four connector routes
- fix: one Plugins surface with the extension as a tab; ~4 admin nav groups
- size: needs a spec

### network-allow-concept-spread: five surfaces for one question

- status: new
- severity: medium
- lens: gap (ux)
- evidence: `/settings/sandbox`, the device page network section, schedule task grants, the
  conversation approval card, the admin request in `/inbox`; copy mixes host / domain and keeps
  "sandbox"; after approval the person runs the command again by hand (`networkAsk.dialogBody`)
- fix: one term ("domain"); an org "Network" page; the blocked card shows the effective decision and
  the one action for that layer; resume the run on approval
- size: needs a spec

### client-extensions-l2-l3-premature

- status: recurring (2nd time, first seen in 2026-11-12-design-review.md)
- severity: high
- lens: over-engineering
- evidence: one consumer, plugins `theme-cyberpunk/src/client.tsx:23-26`;
  `plugin-sdk/src/ui-slots.ts` (12 slots); `ui-parts.ts:60` (29 parts; the previous "31" was counted
  differently)
- fix: L2/L3 behind an experimental flag; drop cosmetic slots and parts until a real consumer
- size: needs a spec

### catalog-size

- status: recurring (2nd time, first seen in 2026-11-12-design-review.md)
- severity: medium
- lens: over-engineering
- evidence: 31,058 lines; 109 of 223 catalog commits are fixes, including lock-order fixes
  fbad13a7e, 571318f3a, e661e5720; `catalog/claude` 2,410 lines
- fix: follows from the scope findings; one lock-ordering helper; move the Claude translator to
  plugin-tools
- size: needs a spec

### governance-load

- status: recurring (2nd time, first seen in 2026-11-12-design-review.md)
- severity: medium
- lens: over-engineering
- evidence: 28 `check:*`, 8 `gen:*`; `tools/checks/src` 9,456 lines; 1,475 `§` references in kernel
  source; AGENTS.md churn stopped (0 commits in the window)
- fix: comments state invariants, not ruling ids; stable checks into lint config
- size: direct fix

### migrations-no-concurrent-index

- status: recurring (2nd time, first seen in 2026-11-12-design-review.md)
- severity: medium
- lens: design-flaw
- evidence: 0025, 0063, 0094; `writing-migrations/SKILL.md:39` forbids `CONCURRENTLY`
- fix: a non-transactional migration kind; baseline squash at 0.1.0
- size: needs a spec

### kernel-schema-handwritten

- status: recurring (2nd time, first seen in 2026-11-12-design-review.md)
- severity: medium
- lens: drift
- evidence: `db/kernel-schema.ts` 2,064 lines (was 1,945)
- fix: a test diffing `information_schema` with the Kysely types
- size: direct fix

### plugins-docs-still-pin

- status: new
- severity: medium
- lens: drift
- evidence: plugins `.agents/skills/writing-plugins/SKILL.md:63,73-74` teaches `"pinned": true`;
  `plugin-sdk/src/plugin-manifest.ts:345` rejects it
- fix: update the plugins skill; a check parsing its JSON examples with the current SDK
- size: direct fix

### npm-latest-points-at-rc0

- status: new
- severity: medium
- lens: stale-dependency
- evidence: `npm view` dist-tags: `latest` 0.1.0-rc.0, `next` rc.15 (plugin-sdk, testing,
  model-fake) / rc.21 (kernel); `plugin-tools/src/release/publish-plan.ts:38-39`
- impact: `npm i @capybara-hq/plugin-sdk` installs a format current kernels reject
- fix: until 0.1.0, move `latest` with each rc, or deprecate the old rcs
- size: direct fix

### special-cased-names

- status: recurring (2nd time, first seen in 2026-11-12-design-review.md)
- severity: low
- lens: special-case-patch
- evidence: `tools/oauth/tokens.ts:57-85` (Slack codes); `runtime/context/claude-tools.ts:19`
  (`plugin__todo__write`); `platform/ops/models.ops.ts:94,162`, `extensions-admin.ops.ts:27`
  (`model-anthropic`)
- fix: extensions classify their own token errors and declare tool mappings; fix the examples
- size: direct fix

### template-skills-by-instruction

- status: new
- severity: low
- lens: design-flaw
- evidence: `runtime/subagents/definition.ts:178-180,383-392` (a6f1d6b0d)
- impact: template skills cost extra model steps and may not load
- fix: the kernel writes skill-invocation events at child start
- size: direct fix

### bash-network-hint-provider-blind

- status: new
- severity: low
- lens: drift
- evidence: `tools/builtins/sandbox/bash.ts:71-74` (89a0a5c6a) tells every model about HTTP_PROXY
  and blocked-domain reports; sandbox-e2b has no proxy and no `ExecResult.network`
- fix: the hint only in the device trailer, or chosen by a provider capability
- size: direct fix

### network-grant-in-tool-key

- status: new
- severity: low
- lens: special-case-patch
- evidence: `migrations/0113_scheduled_tasks.sql:84-91`; `schedules/unattended.ts:123`
- fix: a `kind` column with `host`, or the `network_grants` table above
- size: direct fix

### reminder-text-as-flag

- status: recurring (2nd time, first seen in 2026-11-12-design-review.md)
- severity: low
- lens: design-flaw
- evidence: `runtime/context/tool-changes.ts:27`
- fix: record `toolsOmitted` on `model_call`
- size: direct fix

### process-guard-keeps-broken-process

- status: new
- severity: low
- lens: special-case-patch
- evidence: `infra/lifecycle/process-guards.ts:15-21` ("Known trade-off")
- fix: on a swallowed fatal event, mark readiness not ready so the orchestrator replaces the process
- size: direct fix

### requests-spread-over-tables

- status: new
- severity: low
- lens: design-flaw
- evidence: network allowlist requests in `catalog_requests` (0115), network asks in `approvals`
  (0114), skill share requests in another table (0112)
- fix: one org request inbox keyed by kind
- size: needs a spec

### stale-npm-dependencies

- status: new
- severity: low
- lens: stale-dependency
- evidence: plugins `anthropic` on `@anthropic-ai/sdk` 0.135.0 (latest 1.8.0);
  `@opentelemetry/sdk-trace-base` 2.12.0 deprecated, `@opentelemetry/resources` 2 → 3
- fix: upgrade the Anthropic SDK with the plugin's live tests; upgrade OTel with the metrics work
- size: direct fix

### test-timeout-ladder

- status: new
- severity: low
- lens: special-case-patch
- evidence: `vitest.config.ts:17` (5 s local, 30 s CI); 269 per-test or per-describe timeout
  overrides (00f8fc882, f631365e6)
- fix: separate unit and integration vitest projects with matching timeouts; remove the overrides
- size: direct fix

### docs-claims-drift

- status: new
- severity: low
- lens: drift
- evidence: AGENTS.md says only the plugin/SDK boundary is checked, but `check:deps` also enforces
  `device-imports-internal`; `docs/architecture.md` bootstrap list omits `skills-core`; neither
  mentions `docs/reviews/`
- fix: three one-line edits
- size: direct fix

## Fixed since the previous review

- The "pinned" overload (theme 2 of the previous review, `skills-copies-and-pinned-overload`):
  pinning is gone (0116, 44000d37f, a6f1d6b0d). The copies half remains under
  `scope-machines-duplicated`.
- `special-cased-names`, the `catalog/claude/mcp.ts:20` part: now judged reasonable (see below).

No other previous finding is fixed.

## Reasonable

- Network asks as an approval `kind`: reuses expiry, waits, inbox, IM re-authorization and resume.
- The kernel never trusts the device's claim that the org allows a host (`relayer`, `grantsWithin`),
  and the device intersects again: two trust domains.
- Run grants read from PG on each exec, scoped to the run tree.
- Network notes in `tool_result` and the catalog budget cut as `nameOnly` in the snapshot: in the log,
  no DriftReason needed.
- `disabledSkills` mirroring `disabledTools`: one default-on model.
- `catalog/claude/mcp.ts:20` names `connector-mcp`: the translator must name the one MCP connector.
- Migrations 0114-0116 follow the format; 0116 rewrites data without a shim.
- Abort as a Redis flag with TTL plus broadcast; org run quota as a renewed Redis lease; background
  poll as `@LockedInterval`.
- `OrgGuard` 404s for non-members and reads roles live.
- Test-flake fixes in the window changed only tests.
- sandbox-docker hardening (CapDrop ALL, read-only rootfs, no-new-privileges, pids limit).

## Baseline numbers

| Number | Previous (41799f041) | Current (7cb12115f) |
|---|---|---|
| kernel src non-test lines | 174,954 | catalog 31,058, tools 22,176 (19.7k), runtime 15,980, extensions 15,796, platform 14,344 |
| commits in the window | 2,851 since 2026-10-17 | 149 (fix 43, feat 40) |
| files mentioning legacy / compat / deprecated (non-test) | ~150 "legacy" hits | 101 files |
| plan / ruling ids in source comments | 817 | 1,006 (`ruling …` / `Px-y`); 1,475 `§` in kernel |
| migrations | 112 | 116 |
| `pnpm outdated` majors | not collected | core: @fastify/static 9→10, @opentelemetry/resources 2→3 (sdk-trace-base deprecated), es-module-lexer 2→3, jsdom 30→31, protobufjs 7→8; plugins: @anthropic-ai/sdk 0.135→1.8 |
| npm `latest` dist-tag | not collected | 0.1.0-rc.0 for every package |
