# Push notifications — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. In this repository it runs under the `wave-planned-subagent-development` skill.

**Goal:** A deployment delivers push notifications for the four decided categories to the
self-built mobile apps whose credentials its super admin configured, through one kernel
extension point (`push-provider@1`) and one plugin per channel (APNs, FCM, a mainland-China
aggregator), with the mobile shell's `push@1` capability registering the phone.

**Architecture:**
- **Core (`capybara-hq/core`).**
  - SDK: the `push-provider@1` contract (`PushProvider`, `PushError`, `PushMessage`) and the
    `push@1` Shell capability types.
  - Kernel `packages/kernel/src/push/`: registrations (token sealed with the master keyring, hash
    for uniqueness) and preferences, their `/api/v1/me/*` routes, a provider host over the extension
    registry, `features.push` in meta, owed work from the trigger events (one `push-fanout` outbox
    job per event, written in the event's transaction), a fanout handler that resolves recipients,
    preferences and registrations and owes one `push-deliver` job per registration on
    `cap-push-deliver`, the delivery worker, the 60-day stale `@LockedCron`, `push.previews`.
  - Setup checks gain a platform place (`extension-deployment`) so a push plugin's credential
    check runs from the super admin's extension page; an `auth` failure writes a platform notice
    pointing there.
  - Web: the `push@1` accessors, 通知 / Notifications personal settings, the in-context prompt,
    `?org=` on app routes so a tapped push opens the right org.
- **Plugins (`capybara-hq/plugins`).** `push-apns`, `push-fcm`, `push-<agg>` (the aggregator chosen
  by Task P1), each a `push-provider@1` extension with deployment config secrets and a setup check,
  tested by the conformance suite from `@capybara-hq/testing`.
- **Clients (`capybara-hq/clients`).** The `push@1` capability module of `apps/mobile` (pure logic
  in `packages/shell`, native APNs on iOS, FCM or the aggregator SDK on Android), `brand.ts` push
  fields, the fork guide's push section.

**Tech Stack:** TypeScript, NestJS + Fastify, Kysely / PostgreSQL, BullMQ, zod, vitest, Next +
TanStack Query; Capacitor shell with Swift / Kotlin native modules; node `http2` for APNs.

**Spec:** `docs/superpowers/specs/2026-11-20-mobile-app-design.md` §5.1, §5.2 (`push@1`), §9, §10
(push parts), §11, §12, "AGENTS.md rules touched". Categories: layout spec
`docs/superpowers/specs/2026-11-19-mobile-layout-design.md` §10.3.

## Global Constraints

**Run and test rules:**
- Core tests from the repo root: `pnpm exec vitest run <path>`. A new kernel unit test joins
  `packages/kernel/test/unit-tests.json`; a dual-replica test joins
  `packages/kernel/test/container-tests.json`; integration is the default. One app per file.
- No fixed sleeps, no per-test timeouts (wait on conditions: a probe, a row, a queue count).
- Clients: `pnpm test` from the root; native modules have a TypeScript-facing contract tested with
  injected fakes; XCTest / JUnit only where noted. Plugins: tests import only the SDK,
  `@capybara-hq/testing`, `plugin-model-fake` and the plugin itself.

**Code rules (core):**
- English comments and identifiers; `pnpm check:english-comments --base origin/main`.
- Kernel: explicit `@Inject`, `KernelConfigService`, `createZodDto` DTOs with `@ZBody` / `@ZParam`,
  writes in `@Transactional()`, new codes in `packages/kernel/src/errors.ts`, every new route in a
  Platform operation or `packages/kernel/src/platform/exclusions.ts` (`pnpm check:platform-ops`,
  `platform-parity.test.ts`).
- Multi-replica: nothing in process memory; owed work only through `OutboxService.add` /
  `addMany` (no direct `queue.add`: `kc-enqueue-via-outbox`); queue names and job ids without
  `:`; consumers and `@LockedCron` providers only under `WorkerModule` (`kc-worker-only`).
- A push token is never logged, audited, put in job data, an error message or an API answer.
- Web: design components only, `defineQuery` reads, `useAppMutation` writes, zh and en in
  `apps/web/messages/{zh,en}.json` (`pnpm check:i18n`); zh says 平台 / 超级管理员 / 智能体; no
  read of `window.capybaraShell` outside `apps/web/src/lib/shell.ts` (`web-shell-access`).
- Changesets: `@capybara-hq/plugin-sdk` (minor; `pnpm gen:sdk-api`, `check:sdk-api-changeset`),
  `@capybara-hq/testing` (minor), `@capybara-hq/kernel` and `@capybara-hq/capybara` (minor).

**Values (copy exactly):**

| Item | Value |
|---|---|
| Extension point | `push-provider@1`, constant `PUSH_PROVIDER_EXTENSION_POINT`; registry entry `"push-provider": info([1], "Delivers push notifications to people's mobile apps through one channel (APNs, FCM, an aggregator).", "multi", true)` (brokered, not org-scoped); sensitive (`SENSITIVE_EXTENSION_POINTS`); tracked (`TRACKED_EXTENSION_POINTS["push-provider"] = {}`) |
| Results | `delivered`, `unregistered`, `failed` with `PushError` kind `auth` / `rate_limited` / `transient` |
| Shell capability | `push@1`: `status()`, `register()`, `registered(id)`, `unregister()` |
| Queue | `cap-push-deliver` (job names `push-fanout`, `push-deliver`) |
| Job ids | fanout `push-fanout-<eventId>`; delivery `push-<eventId>-<registrationId>`; `eventId` = `conv-<conversationId>-<seq>` or `sched-<taskRunId>` |
| Tables | `capybara.push_registrations`, `capybara.push_preferences` (migration `0170_push.sql`, or the next free number at implementation) |
| Config | `push.previews`: `"off" \| "titles"`, default `"off"`, hot, platform only, env `CAPYBARA_PUSH__PREVIEWS` |
| Meta | `features.push: { appId: string; providers: string[] }[]`, `[]` without `http.publicUrl` |
| Routes | `POST /api/v1/me/push-registrations`, `DELETE /api/v1/me/push-registrations/:id`, `GET /api/v1/me/push-registrations`, `GET /api/v1/me/push-preferences`, `PUT /api/v1/me/push-preferences` |
| Categories | `waiting`, `replies`, `tasks`, `schedules` (absent preference row = enabled) |
| Stale | registrations with `last_seen_at` older than 60 days deleted by `@LockedCron("40 3 * * *", { name: "push-stale-registrations" })` |
| Limits | `PUSH_LIMITS = { titleChars: 100, bodyChars: 240, pathChars: 512, tokenChars: 4096, appIdChars: 255, deviceNameChars: 64, sendTimeoutMs: 15_000, registrationsPerAccount: 20 }` |
| Delivery retries | `push-deliver`: `attempts: 5`, `backoff: { type: "exponential", delay: 10_000 }`, `removeOnComplete: { age: 86_400 }`, `removeOnFail: { age: 86_400 }`; `push-fanout`: `attempts: 5`, `backoff: { type: "exponential", delay: 5_000 }`, same removal |
| Errors | `push.provider_unavailable` 422, `push.registration_not_found` 404 |
| Audit | `push.registered` (detail `{ registrationId, platform, appId, provider, deviceName }`), `push.unregistered` (detail `{ registrationId, reason: "person" \| "session_revoked" \| "provider" \| "stale" }`, written only for `person`) |
| Platform notice | kind `push_auth_failed`, detail `{ plugin: string }`, at most one open per plugin |
| Setup place | `extension-deployment` (new `SetupGuidePlace`), target `{ kind: "extension-deployment"; plugin: string; config: unknown }` |

**Triggers (spec §9.4, with this plan's rulings):**

| Category | Event (log of) | Recipient | Skipped when |
|---|---|---|---|
| `waiting` | `approval_requested` (chat or sub-agent conversation) | `requested_for`, else every active member with role ≥ `approver_role` except the run's trigger account (`canHandle`) | approval no longer `pending` at fanout |
| `waiting` | `question_asked`, `connection_required` | the run's `trigger_account_id` | question no longer pending |
| `replies` | `run_finished`, `run_failed` (chat conversation) | `conversations.account_id` | the run has `scheduled_task_run_id` (pushed as `schedules`) |
| `tasks` | `background_task_finished` (any non-eval log) | the root conversation's owner | `stoppedBy` set (a person or a deletion stopped it) |
| `tasks` | `subagent_finished` (written only for background children) | the root conversation's owner | — |
| `schedules` | `ScheduledTaskRunTracker.settle` (completed or failed; trial runs too) | `scheduled_tasks.account_id` | — |

Every recipient must still be an active account and a member of the event's org (org not deleted)
when the fanout runs; eval conversations never push.

**Exact push copy (`packages/kernel/src/push/texts.ts`):**

| Key | en | zh |
|---|---|---|
| `approval` | needs your approval | 需要你的审批 |
| `question` | has a question for you | 有问题需要你回答 |
| `connect` | needs you to connect an account | 需要你连接账号 |
| `runFinished` | finished | 已完成 |
| `runFailed` | failed | 运行失败 |
| `backgroundFinished` | a background task ended | 后台任务已结束 |
| `subagentFinished` | a sub-agent finished | 子智能体已完成 |
| `scheduleRan` | your scheduled task ran | 你的定时任务已运行 |
| `scheduleFailed` | your scheduled task failed | 你的定时任务运行失败 |

`title` = the agent's display name (the task's name for `schedules`), cut to `titleChars`. With
`push.previews: "titles"` and a conversation title: `body` = `<conversation title>: <sentence>`
(en) / `<conversation title>：<sentence>` (zh), cut to `bodyChars`. Message text is never sent.

**Exact UI copy (web):** nav item 「通知」 / "Notifications"; switches 「等你处理」 / "Waiting for
you", 「智能体回复」 / "Agent replies", 「任务状态」 / "Task status", 「定时任务」 / "Scheduled tasks";
prompt 「开启通知，有事项等你处理时提醒你」 / "Turn on notifications to hear when something is
waiting for you", buttons 「开启」 / "Turn on", 「以后再说」 / "Not now"; device list empty state
「还没有设备接收通知」 / "No device receives notifications yet"; button 「在此设备开启通知」 /
"Turn on for this device"; row action 「移除」 / "Remove".

## Decisions this plan adds to the spec

Small and inside the spec's intent; each becomes a one-line spec follow-up when the plan is
accepted. Items 1–3 are gaps the review should confirm.

1. **Setup checks need a platform place.** Setup checks exist only for `channel-connection` and
   `connector-template` (org routes); push credentials are platform deployment config. Task C8
   adds the place `extension-deployment` with super admin routes; an `auth` result also writes
   the platform notice `push_auth_failed` that links to the extension page.
2. **The shell learns the registration id:** `push@1.registered(id)` after the web's POST, and
   `status()` returns `{ permission, registrationId, tokenChanged }`, so profile removal (native)
   can call `DELETE` and the web re-posts a rotated token.
3. **Registrations follow their session.** A registration records the session that posted it.
   Revoking a session (sign-out, single revoke, `revokeAllForAccount`) deletes that session's
   registrations, so a password change removes the other devices' and keeps the current one; a
   disabled account loses all (its sessions are all revoked). The spec's "a password change deletes
   the user's registrations" would otherwise unregister the phone the person is holding.
4. **`register()` needs a user activation only when the OS prompt would show** (`permission:
   "prompt"`); with `granted` it returns the current token, so the web re-posts on each app start
   (upsert refreshes `last_seen_at`, which is what the 60-day rule measures).
5. **Upsert moves a token between accounts:** a POST whose `(provider, app_id, token_hash)` exists
   reassigns the row to the caller and its session, so the previous account stops reaching the
   phone. At most 20 registrations per account; the least recently seen beyond that is deleted.
6. **`unregister()` forgets only the profile's registration** (one OS push token serves every
   profile of the install); it never calls the OS unregister while another profile holds one.
7. **No badge** (`badge` omitted): registrations span orgs and the inbox count is per org, so it
   is not cheap.
8. **Paths carry the org:** `path` = `/chat/<rootConversationId>?org=<orgId>` (with
   `&subagent=<child>` for a sub-agent's ask, as approvals' `conversationPath`); a schedule run
   without a conversation uses `/inbox?org=<orgId>`. The web switches the current org from `?org=`
   when the person is a member. `threadId` = the root conversation id, or `schedule-<taskId>`.
9. **`apps()` is synchronous and derived from deployment config** (no network), so the public meta
   calls it on every request without caching.
10. **Fanout gate:** the event's transaction owes `push-fanout` only while the registry holds a
    `push-provider` (as `UsageSubscribers.any()`), so deployments without push write nothing.
11. **Aggregator** chosen in Task P1; its plugin is `push-<agg>` below.

## Review Focus

1. **A person removed from an org, or disabled, still gets that org's pushes:** the fanout checks
   membership and account status when it runs, not when the event was written. Task C7 pins
   removal between event and fanout, a disabled account, and a deleted org.
2. **Approvals escalated by role reach the wrong people:** the run's initiator and a member below
   `approver_role` get nothing; an admin of another org gets nothing. Task C7 pins all three.
3. **A phone changes hands on the same deployment:** account A registers token T, then B signs in
   on that phone and registers T; A's events no longer reach T. Task C4 pins the reassignment.
4. **Two replicas, one event:** each registration gets exactly one `send` even when the outbox
   fast path and the relay both deliver and a delivery job is retried after a crash. Task C7's
   dual-replica test pins it.
5. **A provider switched off or reconfigured mid-flight:** a job whose provider is gone or no
   longer covers the app id completes without a send and without deleting the registration.
   Task C6 pins both.

---

## Cross-plan dependencies

| This plan needs | From | Used by |
|---|---|---|
| `apps/mobile` scaffold; the runtime's `CapabilityRegistry.register(key, impl: CapabilityImpl, { available(profile) })` (`apps/mobile/src/runtime/registry.ts`, `confirming` functions get the activation and dialog gate); `ProfileStore.onRemoved(listener)`; `DeepLinkRouter` (routes an origin + path to a profile); `HostPort`; `brand.ts` + `scripts/apply-brand.ts` + `check:brand`; the release workflow (its Task 21); the fork guide `docs/fork-guide.md` (its Task 22) | Mobile app shell plan `2026-11-20-mobile-app.md` ("Seams left for the push plan") | Tasks K1–K4 |
| `chrome@1` / `nav@1` types next to `push@1` in `shell-capabilities.ts`, and their mirror in `apps/web/src/lib/shell.ts` | Mobile app shell plan | Tasks C1, C9 (same files: whichever lands second rebases) |
| `GET /api/v1/meta`, `auth.appRedirectUris`, `signIn@1` | Desktop plan (merged) | Tasks C5, K1 |

Where a seam's name differs in the shell plan as merged, the task uses the merged name.

## Manual steps (maintainer)

- **M1:** a test APNs key (`.p8`, key id, team id) and a Firebase project with a service account,
  in the local env file for live tests (`CAPYBARA_TEST_APNS_*`, `CAPYBARA_TEST_FCM_*`); an
  account at the aggregator Task P1 picks (`CAPYBARA_TEST_<AGG>_*`).
- **M2:** release `@capybara-hq/plugin-sdk` (C1) and `@capybara-hq/testing` (C2) before the
  plugin tasks and K1 (an agent with a standing release grant may merge the Version Packages PR).
- **M3:** a self-built test app (a fork build per K4) on one iPhone and one Android phone with and
  without Google Play services, for the acceptance run.

---

## Wave plan (copy to the ledger)

| Task | Repo | Depends on | Files / areas | Risk | Wave | Review |
|---|---|---|---|---|---|---|
| C1 SDK contract + `push@1` types | core | — | plugin-sdk push.ts, extension-point.ts, shell-capabilities.ts, index.ts, sdk api | normal | 1 | batch |
| P1 Aggregator ruling | plugins | — | ledger + spec follow-up line | normal | 1 | batch |
| C3 Migration + sealed token store | core | — | migrations/0170_push.sql, db/kernel-schema.ts, ctx/secrets.ts, push/token-store.ts | high | 1 | alone, most capable |
| C2 Fake provider + conformance suite | core | C1 | testing fixtures/extensions/fake-push, src/push-conformance.ts, fixtures.ts, index.ts | normal | 2 | batch |
| C5 Provider host + `features.push` | core | C1 | push/provider-host.ts, http/meta.controller.ts, extensions/registry.ts, permission-view.ts | normal | 2 | batch |
| C4 Registrations, preferences, routes | core | C3, C5 | push/registrations.*, push/preferences.*, push.controller.ts, sessions.ts, errors.ts, exclusions.ts, platform/ops/platform.ops.ts | high | 3 | alone, most capable |
| C6 Delivery worker, stale job, notice | core | C4, C5 | push/jobs.ts, push/push-processor.ts, push/delivery.ts, push/stale.job.ts, outbox registry, queue-names, health.service.ts, inbox/platform-notices.ts, roles/worker.module.ts | high | 4 | alone, most capable |
| C8 Setup place `extension-deployment` | core | C1 | plugin-sdk setup-guide.ts / setup-check.ts, kernel setup/*, admin extension page | high | 4 | alone, most capable |
| C7 Triggers + fanout | core | C6 | push/triggers.ts, push/push-owed.ts, push/fanout.ts, push/texts.ts, push/recipients.ts, push-processor.ts (fanout branch), event-log.ts, run-tracker.ts, config/schema.ts, outbox registry, dual test | high | 5 | alone, most capable |
| C9 Web: settings, prompt, `?org=` | core | C4, C1 | web lib/shell.ts, lib/push.ts, lib/query/push.ts, account/notifications, settings-nav, AppFrame, admin-inbox, messages | normal | 5 | batch |
| C10 Docs, AGENTS.md, skills | core | C7, C8, C9 | AGENTS.md, docs/architecture.md, skills, docs/config.md | normal | 6 | batch |
| P2 `push-apns` | plugins | C1, C2, C8 (M2) | plugins/push-apns | high | 6 | alone, most capable |
| P3 `push-fcm` | plugins | C1, C2, C8 (M2) | plugins/push-fcm | high | 6 | own repo batch |
| P4 `push-<agg>` | plugins | P1, C2, C8 (M2) | plugins/push-<agg> | high | 6 | own repo batch |
| K1 `push@1` logic + capability module | clients | C1 (M2) | packages/shell/src/push.ts, apps/mobile/src/push/* | normal | 6 | own repo batch |
| K2 iOS APNs module | clients | K1 | apps/mobile/ios/App/App/Push/* | normal | 7 | own repo batch |
| K3 Android FCM + aggregator module | clients | K1, P1 | apps/mobile/android/app/src/main/java/com/capybarahq/mobile/push/* | normal | 7 | own repo batch |
| K4 Brand push fields + fork guide | clients | K2, K3 | apps/mobile/brand.ts, scripts/apply-brand.ts, docs/fork-guide.md, release workflow secrets | normal | 8 | own repo batch |
| A Acceptance | all | all (M3) | live checklist | — | 9 | maintainer |

**Notes:** C3 and C4 share `push/` but not files. C6 and C8 touch disjoint kernel areas; C6 and C7 share `push-processor.ts` and the outbox registry, hence serial. C8 (the admin extension page) and C9 touch disjoint web files; only C9 adds message keys. Plugins and clients start after M2.

---

## Core tasks (`capybara-hq/core`)

### Task C1: `push-provider@1` contract and `push@1` Shell types

**Files:**
- Create: `packages/plugin-sdk/src/push.ts`
- Modify: `packages/plugin-sdk/src/extension-point.ts` (`EXTENSION_POINTS["push-provider"]`)
- Modify: `packages/plugin-sdk/src/shell-capabilities.ts` (`push` key and types)
- Modify: `packages/plugin-sdk/src/index.ts`; the SDK API report (`pnpm gen:sdk-api`)
- Create: `.changeset/<name>.md` (`@capybara-hq/plugin-sdk`: minor)
- Test: `packages/plugin-sdk/test/push.test.ts`

**Interfaces:**
- Produces:

```ts
export const PUSH_PROVIDER_EXTENSION_POINT = "push-provider@1";
export const PUSH_LIMITS = { /* Global Constraints values */ } as const;
export type PushPlatform = "ios" | "android";
export interface PushMessage {
  title: string; body: string; path: string; threadId: string; badge?: number;
  /** The deployment origin (scheme://host[:port]); the shell matches it to a profile. */
  origin: string;
}
export interface PushTarget { id: string; platform: PushPlatform; appId: string; token: string }
export type PushErrorKind = "auth" | "rate_limited" | "transient";
export class PushError extends Error {
  readonly kind: PushErrorKind; readonly retryAfterMs?: number;
  constructor(message: string, opts: { kind: PushErrorKind; retryAfterMs?: number });
}
export type PushResult =
  | { registrationId: string; status: "delivered" }
  | { registrationId: string; status: "unregistered" }
  | { registrationId: string; status: "failed"; kind: PushErrorKind; message: string; retryAfterMs?: number };
/** No retries inside; a thrown PushError applies to every registration of the call, any other throw is transient. */
export interface PushProvider {
  /** App ids (bundle / application ids) the configured credentials cover; synchronous, from config. */
  apps(): readonly string[];
  send(args: { registrations: readonly PushTarget[]; message: PushMessage; signal: AbortSignal }): Promise<PushResult[]>;
}
/** null when `results` answers every registration exactly once, else the problem (no token in it). */
export function checkPushResults(registrations: readonly PushTarget[], results: unknown): string | null;
export function validatePushMessage(m: PushMessage): string | null;
// shell-capabilities.ts
SHELL_CAPABILITY_KEYS.push = "push@1";
export type PushPermission = "granted" | "denied" | "prompt";
export interface PushStatus { permission: PushPermission; registrationId: string | null; tokenChanged: boolean }
export interface PushRegistration { platform: PushPlatform; appId: string; provider: string; token: string }
export interface PushCapabilityV1 {
  status(): Promise<PushStatus>;
  /** User activation only when permission is "prompt"; rejects { code: "cancelled" } when denied. */
  register(): Promise<PushRegistration>;
  registered(id: string): Promise<void>;
  unregister(): Promise<void>;
}
```

- [ ] **Step 1:** Tests: `checkPushResults` returns null for one result per target; a problem for
  a missing id, a duplicate, an unknown id, a non-array, a `failed` without a known kind, and the
  problem text never contains a target's token. `validatePushMessage` refuses a 101-character
  title, a 241-character body, a `path` not starting with `/`, an `origin` with a path. `new
  PushError("x", { kind: "rate_limited", retryAfterMs: 5000 })` keeps both fields and
  `instanceof Error`. `EXTENSION_POINTS["push-provider"]` is `{ majors: [1], cardinality: "multi",
  brokered: true, orgScoped: false }`. `SHELL_CAPABILITY_KEYS.push === "push@1"`;
  `expectTypeOf<PushCapabilityV1["register"]>().returns.resolves.toEqualTypeOf<PushRegistration>()`.
- [ ] **Step 2:** Run `pnpm exec vitest run packages/plugin-sdk/test/push.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement the file, the registry entry and the shell types; export from
  `index.ts`; run `pnpm gen:sdk-api`.
- [ ] **Step 4:** Run the test, `pnpm check:sdk-api`, `pnpm check:sdk-api-changeset`,
  `pnpm typecheck`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(plugin-sdk): add push-provider@1 and the push@1 shell capability types`.

### Task C2: `fake-push` fixture and the push provider conformance suite

**Files:**
- Create: `packages/testing/fixtures/extensions/fake-push/{package.json,.capybara-plugin/plugin.json,src/index.ts,src/push.ts,migrations/0001_sends.sql}`
- Create: `packages/testing/src/push-conformance.ts`
- Modify: `packages/testing/src/fixtures.ts` (`FAKE_PLUGINS`, the doc table), `packages/testing/src/index.ts`
- Test: `packages/testing/test/push-conformance.test.ts` (the suite against `fake-push`)
- Changeset: `@capybara-hq/testing` minor.

**Interfaces:**
- Consumes: C1 types.
- Produces:
  - `fake-push`: provides `push-provider@1`; deployment config `{ apps: string[] (default ["com.example.app"]), key?: secret(string) }`. Scripted by the token prefix: `dead:` → `unregistered`; `auth:` → `failed` `auth`; `rate:` → `failed` `rate_limited` (`retryAfterMs: 1000`); `flaky:<n>:` → `transient` for the first `n` calls of that token, then `delivered`; `throw:` → plain `Error`; `hang:` → waits for the signal; anything else `delivered`. Each call inserts `(registration_id, job_marker, message jsonb)` into `plugin_fake_push.sends` (so dual-replica tests count across processes) and pushes onto `fakePushProbe().sends` in process.
  - `export function fakePushProbe(): { sends: { registrationId: string; token: string; message: PushMessage }[] }`.
  - `export interface PushConformanceTarget { plugin: string; make(): Promise<{ provider: PushProvider; arrange(token: string, outcome: PushOutcome): void; requests(): { token: string; title: string; body: string; path: string; origin: string; threadId: string }[]; close(): Promise<void> }> }`, `type PushOutcome = "delivered" | "unregistered" | "auth" | "rate_limited" | "transient" | "network_error" | "hang"`.
  - `export function describePushProviderConformance(target: PushConformanceTarget): void`.

- [ ] **Step 1:** Write `push-conformance.test.ts`: it calls `describePushProviderConformance`
  with a target built on `fake-push`'s `makeFakePush()` (outcomes mapped to token prefixes).
  The suite's cases (each an `it`):
  - `delivered` answers `{ registrationId, status: "delivered" }` and the vendor request carries
    exactly the message's `title`, `body`, `path`, `origin`, `threadId`;
  - `unregistered` answers `unregistered`; `auth`, `rate_limited`, `transient` answer `failed`
    with that kind (a thrown `PushError` of the kind also passes);
  - `network_error` yields `transient` (result or thrown `PushError`);
  - each outcome is requested exactly once (no retries inside);
  - two registrations in one call get two results (`checkPushResults` is null);
  - `hang` plus an aborted signal settles (rejects or answers `transient`) without a timer;
  - no thrown message and no result message contains the token;
  - `apps()` returns the same array twice and does not touch the vendor (`requests()` empty).
- [ ] **Step 2:** Run `pnpm exec vitest run packages/testing/test/push-conformance.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement the fixture and the suite. The suite never sleeps: `hang` resolves on
  the signal's `abort` event.
- [ ] **Step 4:** Run the test and `pnpm exec vitest run packages/testing/test/fixtures.test.ts`.
  Expected: PASS.
- [ ] **Step 5:** Commit `feat(testing): add the fake-push fixture and the push provider conformance suite`.

### Task C3: Migration and the sealed token store (high risk: sealed secrets, migration)

**Files:**
- Create: `packages/kernel/src/migrations/0170_push.sql`
- Modify: `packages/kernel/src/db/kernel-schema.ts` (`PushRegistrationsTable`, `PushPreferencesTable`)
- Modify: `packages/kernel/src/ctx/secrets.ts` (`pushTokenAad`, `MASTER_KEYED` entry, `RewrapResult.pushTokens`)
- Create: `packages/kernel/src/push/token-store.ts`
- Test: `packages/kernel/test/push/token-store.test.ts` (integration),
  `packages/kernel/test/infra/master-key-rewrap.test.ts` (extend the existing file)

**Interfaces:**
- Produces:
  - SQL (expand-only, `IF NOT EXISTS`):

```sql
CREATE TABLE IF NOT EXISTS capybara.push_registrations (
  id text PRIMARY KEY,
  account_id text NOT NULL REFERENCES capybara.accounts(id) ON DELETE CASCADE,
  session_id text REFERENCES capybara.sessions(id) ON DELETE SET NULL,
  platform text NOT NULL CHECK (platform IN ('ios', 'android')),
  app_id text NOT NULL,
  provider text NOT NULL,
  token_hash text NOT NULL,          -- sha256 hex of the token
  master_key_id text NOT NULL,
  token_ciphertext bytea NOT NULL,   -- AES-256-GCM, AAD pushTokenAad(id)
  locale text NOT NULL CHECK (locale IN ('zh', 'en')),
  device_name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, app_id, token_hash)
);
-- indexes: (account_id), (session_id) WHERE session_id IS NOT NULL, (last_seen_at)
CREATE TABLE IF NOT EXISTS capybara.push_preferences (
  account_id text NOT NULL REFERENCES capybara.accounts(id) ON DELETE CASCADE,
  category text NOT NULL CHECK (category IN ('waiting', 'replies', 'tasks', 'schedules')),
  enabled boolean NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, category)
);
```

  - `export const pushTokenAad = (registrationId: string) => \`capybara:push-token:${registrationId}\``.
  - `PushTokenStore` (`@Injectable`, `@Inject(KEYRING)`): `seal(registrationId: string, token: string): { masterKeyId: string; ciphertext: Buffer; tokenHash: string }`, `open(row: { id: string; master_key_id: string; token_ciphertext: Uint8Array }): string`, `static hash(token: string): string`.
  - `MASTER_KEYED` gains `{ table: "push_registrations", idColumn: "id", dataColumn: "token_ciphertext", aad: pushTokenAad, hasExpiresAt: false }` (widen the union types).

- [ ] **Step 1:** Tests:
  - seal then open round-trips; `tokenHash` equals `PushTokenStore.hash(token)` (64 hex chars);
    the ciphertext does not contain the token bytes;
  - a ciphertext copied to another registration id fails to open (AAD);
  - after rotating the master key (`masterKeyPrevious`), `rewrapToCurrentMasterKey` reports
    `pushTokens: 1` and the row opens with the new key only config;
  - migration applies twice cleanly (`capybara migrate` idempotence via the migration test
    helper) and a second row with the same `(provider, app_id, token_hash)` violates the unique key.
- [ ] **Step 2:** Run `pnpm exec vitest run packages/kernel/test/push/token-store.test.ts packages/kernel/test/infra/master-key-rewrap.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement per the writing-migrations skill (header comment with the spec
  section; no destructive statement).
- [ ] **Step 4:** Run the tests and `pnpm check` (migration checks). Expected: PASS.
- [ ] **Step 5:** Commit `feat(kernel): add push registration tables and the sealed token store`.

### Task C5: Provider host and `features.push` in meta

**Files:**
- Create: `packages/kernel/src/push/provider-host.ts` (`PushProviderHost`, in `PushHostModule`)
- Modify: `packages/kernel/src/extensions/registry.ts` (`TRACKED_EXTENSION_POINTS["push-provider"]`)
- Modify: `packages/kernel/src/extensions/permission-view.ts` (`SENSITIVE_EXTENSION_POINTS` + doc line)
- Modify: `packages/kernel/src/http/meta.controller.ts` (`features.push`)
- Test: `packages/kernel/test/push/provider-host.test.ts`, `packages/kernel/test/http/meta.test.ts` (extend)

**Interfaces:**
- Consumes: `ExtensionRegistry.list("push-provider")`, C1 types.
- Produces:
  - `PushProviderHost.provider(plugin: string): PushProvider | null` (the `@1` entry of that
    plugin, else null).
  - `PushProviderHost.covers(plugin: string, appId: string): boolean` (`apps()` throwing counts as
    false and is logged once per call with the plugin, never config).
  - `PushProviderHost.coverage(): { appId: string; providers: string[] }[]` (sorted by appId, then
    provider name).
  - `PushProviderHost.any(): boolean`.
  - `MetaResponseSchema.features.push`: `z.array(z.object({ appId: z.string(), providers: z.array(z.string()) }))`.

- [ ] **Step 1:** Tests (app with `fake-push` loaded through the fixtures helper, deployment config
  `{ apps: ["com.example.a", "com.example.b"] }`):
  - `coverage()` equals `[{ appId: "com.example.a", providers: ["fake-push"] }, { appId: "com.example.b", providers: ["fake-push"] }]`;
  - `covers("fake-push", "com.other")` is false; `provider("nope")` is null;
  - meta with `http.publicUrl` set includes that `features.push`; without it, `features.push` is `[]`;
    without `fake-push` loaded it is `[]` (existing meta assertions updated);
  - after disabling the extension, `any()` is false and meta lists `[]`.
- [ ] **Step 2:** Run `pnpm exec vitest run packages/kernel/test/push/provider-host.test.ts packages/kernel/test/http/meta.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement; no caching (decision 9).
- [ ] **Step 4:** Run the tests. Expected: PASS.
- [ ] **Step 5:** Commit `feat(kernel): host push-provider@1 and list push coverage in meta`.

### Task C4: Registrations, preferences and their routes (high risk: tokens, cross-account)

**Files:**
- Create: `packages/kernel/src/push/push.schemas.ts`, `packages/kernel/src/push/registrations.service.ts`,
  `packages/kernel/src/push/preferences.service.ts`, `packages/kernel/src/push/push.controller.ts`,
  `packages/kernel/src/push/registration-cleanup.ts`, `packages/kernel/src/push/push.module.ts`
- Modify: `packages/kernel/src/http/api.module.ts` (controller), `packages/kernel/src/errors.ts`
- Modify: `packages/kernel/src/identity/sessions.ts` (`revoke`, `revokeAllForAccount` delete the
  sessions' registrations in the same statement's transaction)
- Modify: `packages/kernel/src/platform/exclusions.ts`, `packages/kernel/src/platform/ops/platform.ops.ts`
- Test: `packages/kernel/test/push/registrations.http.test.ts`, `packages/kernel/test/push/preferences.http.test.ts`

**Interfaces:**
- Consumes: `PushTokenStore` (C3), `PushProviderHost.covers` (C5), `audit()` (`identity/audit.ts`),
  `@SessionOnly()` (`identity/principal.ts`).
- Produces:
  - `PushRegistrationBody` (strict): `{ platform: "ios"|"android", appId: string 1..255 /^[A-Za-z0-9][A-Za-z0-9._-]*$/, provider: string /^[a-z][a-z0-9-]{0,63}$/, token: string 1..4096, locale: "zh"|"en", deviceName: string 1..64 printable }` → `201 { id: string }`.
  - `PushRegistrationView`: `{ id, platform, appId, provider, deviceName, locale, createdAt, lastSeenAt, current: boolean }` (`current`: posted by the caller's session); `GET` → `{ items: PushRegistrationView[] }`, newest `lastSeenAt` first.
  - `PushPreferencesSchema`: `{ waiting: boolean, replies: boolean, tasks: boolean, schedules: boolean }`; `PUT` takes a partial with at least one key, answers the full object.
  - `PushRegistrationsService.register(accountId: string, sessionId: string, body: PushRegistrationBody): Promise<{ id: string }>` (`@Transactional`; upsert on the unique key: reassign `account_id`, `session_id`, `locale`, `device_name`, `last_seen_at = now()`, keep `id`; evict beyond 20 by oldest `last_seen_at`; audit `push.registered` only for a new row or a reassignment).
  - `PushRegistrationsService.remove(accountId: string, id: string): Promise<void>` (another account's id → `push.registration_not_found`).
  - `PushRegistrationsService.list(accountId: string, sessionId: string): Promise<PushRegistrationView[]>`.
  - `PushRegistrationsService.forAccounts(accountIds: readonly string[]): Promise<PushRegistrationRow[]>` (no token decrypted).
  - `PushPreferencesService.get(accountId): Promise<PushPreferences>`, `set(accountId, patch): Promise<PushPreferences>`, `enabledFor(accountIds: readonly string[], category: PushCategory): Promise<Set<string>>`.
  - `deletePushRegistrationsForSessions(db: KernelSchemaDb, sessionIds: readonly string[]): Promise<number>` (`registration-cleanup.ts`, infra dependencies only, so `sessions.ts` imports it without a module cycle).
  - Controller `@Controller("api/v1/me")`: `POST push-registrations` and `DELETE push-registrations/:id` and `GET push-registrations` are `@SessionOnly()`; `GET`/`PUT push-preferences` accept sessions and personal tokens.
  - Exclusions (`human-only`): POST "Registers the person's own app install for push; a device action of the person's app", DELETE "Removes one of the person's app installs from push (sign-out, profile removal, settings)", GET "Lists the person's own app installs that receive push, for the settings page".
  - Operations `platform.push-preferences` (read, mirrors `GET /api/v1/me/push-preferences`) and `platform.set-push-preferences` (`personal`, mirrors `PUT`, bilingual summary naming each switched category with the UI copy), `authz: { orgAction: "agents.use" }`.

- [ ] **Step 1:** Registration tests (one app with `fake-push` covering `com.example.app`):
  - without a session 401; with a personal token 403 `auth.session_required`;
  - a valid POST answers 201 `{ id }`; the row's `token_ciphertext` opens to the token; no answer,
    log line (captured logger) or audit row contains the token;
  - provider `nope` or app id `com.other` → 422 `push.provider_unavailable`;
  - a 4097-character token, `platform: "web"`, an empty device name → 400 `validation_failed`;
  - the same token posted again by the same session keeps the id and moves `last_seen_at`;
  - account B posting A's token gets A's id reassigned to B: `GET` as A no longer lists it, as B
    lists it with `current: true` (Review Focus 3);
  - the 21st registration of an account deletes the least recently seen;
  - `DELETE` of B's id as A → 404 `push.registration_not_found`; as B → 204, audit `push.unregistered` `{ reason: "person" }`;
  - `POST /auth/logout` deletes the registrations of that session only; a password change
    (`PUT /me/password`) deletes the other sessions' and keeps the current session's; disabling
    the account deletes all; deleting the account cascades.
- [ ] **Step 2:** Preference tests: default `GET` answers all four `true`; `PUT { replies: false }`
  answers `{ waiting: true, replies: false, tasks: true, schedules: true }`; `PUT {}` → 400;
  `enabledFor([a, b], "replies")` omits the account that switched it off; both operations pass
  `platform-parity.test.ts`, and a Platform call of `platform.set-push-preferences` asks once and
  writes.
- [ ] **Step 3:** Run `pnpm exec vitest run packages/kernel/test/push/registrations.http.test.ts packages/kernel/test/push/preferences.http.test.ts packages/kernel/test/platform/platform-parity.test.ts`. Expected: FAIL.
- [ ] **Step 4:** Implement. Register error codes; add the exclusions and operations.
- [ ] **Step 5:** Run the tests, `pnpm check:platform-ops`, `pnpm check:kernel-conventions`. Expected: PASS.
- [ ] **Step 6:** Commit `feat(kernel): add push registrations and preferences under /api/v1/me`.

### Task C6: Delivery worker, stale registrations, auth notice (high risk: multi-replica delivery)

**Files:**
- Create: `packages/kernel/src/push/jobs.ts` (queue, job names, ids, data types),
  `packages/kernel/src/push/push-processor.ts` (`@Processor("cap-push-deliver")`; this task handles
  `push-deliver`, C7 adds the `push-fanout` branch), `packages/kernel/src/push/delivery.ts`
  (`PushDelivery`), `packages/kernel/src/push/stale.job.ts`
- Modify: `packages/kernel/src/push/push.module.ts` (`QueueModule.registerQueue(PUSH_QUEUE)`),
  `packages/kernel/src/roles/worker.module.ts` (processor and stale job)
- Modify: `packages/kernel/src/infra/outbox/registry.ts` (`push-deliver`), `packages/kernel/src/infra/queue/queue-names.ts` and `packages/kernel/src/admin/health.service.ts` `KERNEL_QUEUE_NAMES` (`cap-push-deliver`)
- Modify: `packages/kernel/src/inbox/platform-notices.ts` (`push_auth_failed`; web rendering in C8)
- Test: `packages/kernel/test/push/delivery.test.ts`, `packages/kernel/test/push/stale.test.ts`

**Interfaces:**
- Consumes: C3 `PushTokenStore.open`, C4 registrations, C5 host, `runJob`, `@LockedCron`, `addPlatformNotice`.
- Produces:
  - `jobs.ts`: `PUSH_QUEUE = "cap-push-deliver"`, `PUSH_FANOUT_JOB = "push-fanout"`, `PUSH_DELIVER_JOB = "push-deliver"`, `conversationEventId(conversationId: string, seq: number)`, `scheduleRunEventId(taskRunId: string)`, `pushFanoutJobId(eventId: string)`, `pushDeliverJobId(eventId: string, registrationId: string)`; `type PushFanoutData = { eventId: string; source: { kind: "conversation"; conversationId: string; seq: number } | { kind: "schedule"; taskRunId: string } }`; `type PushDeliverData = { eventId: string; registrationId: string; message: PushMessage }` (never a token).
  - `PushDelivery.deliver(data: PushDeliverData): Promise<"delivered" | "dropped" | "unregistered" | "auth">`; throws a retryable error for `transient` / `rate_limited`, a non-`PushError` throw, a timeout at `PUSH_LIMITS.sendTimeoutMs` (named seam: the `PUSH_SEND_TIMEOUT_MS` provider) and a result failing `checkPushResults`.
  - `PushStaleJob.prune(): Promise<number>` under `@LockedCron("40 3 * * *", { name: "push-stale-registrations" })`, deleting in batches of 500 where `last_seen_at < now() - interval '60 days'`.
  - `addPushAuthNotice(db: KernelSchemaDb, plugin: string): Promise<void>`: inserts `push_auth_failed` only when no undismissed notice of that kind names the plugin.

- [ ] **Step 1:** Delivery tests (one app with `fake-push`; each case owes one `push-deliver`
  row through `OutboxService.add` in a test transaction and waits for the job to finish):
  - a plain token: one send carrying the opened token, outcome `delivered`;
  - `dead:` → the registration row is deleted;
  - `auth:` → the job completes, one `push_auth_failed` notice for `fake-push`; a second `auth:`
    adds none while the first is open;
  - `flaky:2:` → two failed attempts, then delivered: exactly three sends;
  - `rate:` every time → the job fails after 5 attempts, the registration stays;
  - the registration deleted before the job runs → `dropped`, no send;
  - the extension disabled, or its config no longer covering the app id → `dropped`, no send,
    registration kept (Review Focus 5);
  - `hang:` with the timeout seam at 50 ms → aborted and retried;
  - the captured log and the stored job data never contain the token;
  - owing the same delivery id twice produces one send (completed job kept a day).
- [ ] **Step 2:** Stale test: rows last seen 59 and 61 days ago → `prune()` deletes only the
  61-day row; two holders of the tick lock run it once (the existing locked-cron test helper).
- [ ] **Step 3:** Run `pnpm exec vitest run packages/kernel/test/push/delivery.test.ts packages/kernel/test/push/stale.test.ts`. Expected: FAIL.
- [ ] **Step 4:** Implement; every job inside `runJob(PUSH_QUEUE, job, fn)`. Registry entry with
  the Global Constraints options; idempotent sentence: "Completed jobs are kept a day under the
  deterministic id, so a repeated add is swallowed; a missing registration ends the job".
- [ ] **Step 5:** Run the tests, `pnpm exec vitest run packages/kernel/test/infra/queue-names.test.ts`,
  `pnpm check:outbox-registry`, `pnpm check:kernel-conventions`. Expected: PASS.
- [ ] **Step 6:** Commit `feat(kernel): deliver push through cap-push-deliver and prune stale registrations`.

### Task C7: Triggers and fanout (high risk: cross-tenant recipient resolution)

**Files:**
- Create: `packages/kernel/src/push/triggers.ts` (pure: event → trigger), `packages/kernel/src/push/push-owed.ts`
  (`PushOwed`), `packages/kernel/src/push/fanout.ts` (`PushFanout`), `packages/kernel/src/push/texts.ts`,
  `packages/kernel/src/push/recipients.ts`
- Modify: `packages/kernel/src/push/push-processor.ts` (the `push-fanout` branch),
  `packages/kernel/src/infra/outbox/registry.ts` (`push-fanout`)
- Modify: `packages/kernel/src/conversations/event-log.ts` (`write()` calls `pushOwed.oweIn` after the insert, next to `oweDelivery`; `EventLogModule` imports the push owed module, which depends only on infra and the extension registry)
- Modify: `packages/kernel/src/schedules/run-tracker.ts` (`settle()` calls `pushOwed.oweScheduleRun`)
- Modify: `packages/kernel/src/config/schema.ts` (`push.previews`), `docs/config.md` (`pnpm gen:config-docs`)
- Test: `packages/kernel/test/push/triggers.unit.test.ts` and `packages/kernel/test/push/texts.unit.test.ts`
  (unit, join `unit-tests.json`), `packages/kernel/test/push/fanout.test.ts`,
  `packages/kernel/test/push/push.dual.test.ts` (join `container-tests.json`)

**Interfaces:**
- Consumes: C4 services (`forAccounts`, `enabledFor`), C5 `PushProviderHost.any()`, C6 `jobs.ts`,
  `OutboxService.add` / `addMany`, `KernelConfigService`.
- Produces:
  - `export type PushCategory = "waiting" | "replies" | "tasks" | "schedules"`.
  - `export function pushTriggerOf(e: Pick<ConversationEvent, "type" | "payload">): { category: PushCategory; text: PushTextKey } | null` (the event rows of the Triggers table; `background_task_finished` with `stoppedBy` → null).
  - `PushOwed.oweIn(conversationId: string, orgId: string, kind: string, events: readonly ConversationEvent[]): Promise<void>` (`@Transactional({ propagation: "mandatory" })`; nothing when `kind === "eval"` or `!host.any()`).
  - `PushOwed.oweScheduleRun(taskRunId: string, orgId: string): Promise<void>` (mandatory transaction).
  - `resolveRecipients(db: KernelSchemaDb, source: PushFanoutData["source"]): Promise<{ orgId: string; accountIds: string[]; path: string; threadId: string; title: string; conversationTitle: string | null; text: PushTextKey } | null>` (`recipients.ts`; the membership, account status, org liveness, pending and scheduled-run filters live here).
  - `pushText(key: PushTextKey, locale: "zh" | "en"): string`; `renderPushMessage(r: ResolvedPush, locale: "zh" | "en", previews: "off" | "titles", origin: string): PushMessage`.
  - `PushFanout.run(data: PushFanoutData): Promise<number>` (`@Transactional`; owes one `push-deliver` per registration with `addMany`; no `http.publicUrl` → 0 and a warn log).
  - `cfg.push.previews: "off" | "titles"`.

- [ ] **Step 1:** Unit tests: `pushTriggerOf` for every event row of the Triggers table;
  `run_aborted`, `approval_decided`, `subagent_waiting` → null; `background_task_finished` with
  `stoppedBy: "person"` → null; `pushFanoutJobId` and `pushDeliverJobId` contain no `:` for UUID
  inputs. `texts.unit.test.ts`: every key has en and zh from the copy table; zh contains no 企业
  and no Latin `agent`; with previews `off` the conversation title never appears; with `titles`
  the body is `"Deploy check: finished"` / `"Deploy check：已完成"`; a 300-character agent name is
  cut to 100.
- [ ] **Step 2:** Fanout tests (one app, `fake-push`, `http.publicUrl` `https://cap.example`,
  model-fake drives the runs):
  - a completed chat run writes the outbox row `push-fanout-conv-<id>-<seq>` in the run end's
    transaction; `run()` owes one `push-deliver` per registration of the owner with
    `{ title: <agent name>, body: "finished", path: "/chat/<id>?org=<orgId>", threadId: <id>, origin: "https://cap.example" }`
    in each registration's locale;
  - the owner switched `replies` off → zero jobs;
  - an approval escalated to `admin` reaches the org's admins, not the admin who started the run,
    not a member, not an admin of a second org (Review Focus 2);
  - an approval decided before the fanout runs → zero jobs;
  - the owner removed from the org between event and fanout → zero jobs; a disabled owner → zero;
    a deleted org → zero (Review Focus 1);
  - a sub-agent's approval: path `/chat/<root>?org=<orgId>&subagent=<child>`;
  - a scheduled task run (completed and failed) writes `push-fanout-sched-<taskRunId>`, and its
    kernel run's `run_finished` owes no `replies` push;
  - with no `push-provider` loaded nothing is written; an eval conversation writes nothing;
  - `run()` twice owes no extra job.
- [ ] **Step 3:** Dual-replica test (`push.dual.test.ts`): two kernels on one PG and Redis, three
  registrations, one completed run → after the queue drains, `plugin_fake_push.sends` holds
  exactly three rows, one per registration; a replayed outbox row for the same fanout and a
  manual re-add of one delivery id add none (Review Focus 4).
- [ ] **Step 4:** Run `pnpm exec vitest run packages/kernel/test/push/triggers.unit.test.ts packages/kernel/test/push/texts.unit.test.ts packages/kernel/test/push/fanout.test.ts`
  and `pnpm exec vitest run --project container packages/kernel/test/push/push.dual.test.ts`. Expected: FAIL.
- [ ] **Step 5:** Implement. Registry entry `push-fanout` (idempotent: "Owes delivery jobs under
  deterministic ids; a repeat owes nothing new"). Config field per the adding-config skill.
- [ ] **Step 6:** Run the tests, `pnpm check:outbox-registry`, `pnpm gen:config-docs && pnpm check:config-docs`. Expected: PASS.
- [ ] **Step 7:** Commit `feat(kernel): owe push fanout from the trigger events and resolve recipients`.

### Task C8: Setup place `extension-deployment` (high risk: credentials reach a check)

**Files:**
- Modify: `packages/plugin-sdk/src/setup-guide.ts` (`SETUP_GUIDE_PLACES`, `SETUP_GUIDE_PLACE_INFO["extension-deployment"]`: modes `[]`, audiences `["admin"]`, variables `COMMON_VARIABLES` + `pluginName: "text"`, `drift: false`)
- Modify: `packages/plugin-sdk/src/setup-check.ts` (`SetupCheckTarget` gains `{ kind: "extension-deployment"; plugin: string; config: unknown }`; `SetupCheckArgs.orgId` becomes `string | null`, null for this place); SDK API report; changeset (same release as C1)
- Modify: `packages/kernel/src/setup/setup-check-registry.ts`, `setup-checks.service.ts`, `setup-guides.service.ts`
- Create: `packages/kernel/src/setup/admin-setup-checks.controller.ts`: `GET /api/v1/admin/extensions/:name/guides` (guides of the place), `GET /api/v1/admin/extensions/:name/guides/:guideId/checks`, `POST /api/v1/admin/extensions/:name/guides/:guideId/checks/:checkId/run` (super admin)
- Modify: `packages/kernel/src/platform/ops/extensions-admin.ops.ts` (operations mirroring the two reads and the run, `{ superAdmin: true }`, `confirm: "read"` — a check never writes), `apps/web/src/app/(app)/admin/extensions/[name]/view.tsx` (render `SetupGuideSection` for this place)
- Test: `packages/kernel/test/setup/deployment-checks.http.test.ts`, `packages/plugin-sdk/test/setup-guide.test.ts` (extend)

**Interfaces:**
- Produces: the place and target above; a check of this place receives the extension's platform
  deployment config (secrets included, as the extension's own `ctx.config`), `orgId: null`, and its
  result goes through the existing redaction (secret values of that config replaced).
- Consumes: the existing cache / single-flight / cooldown of `SetupChecksService`, keyed with
  `deployment` in place of the org id; the per-account rate limit stays.

- [ ] **Step 1:** Tests: a fixture guide of place `extension-deployment` in `fake-push`
  (`setupGuides` + `permissions.setupChecks: ["fake-push-key"]`, the check `failing` when `key`
  is `bad`, with a reason that echoes the key) — as super admin `GET guides` lists it and `run`
  answers `failing` with the key replaced by `[REDACTED]`; an org admin gets 403; the
  `connector-template` and `channel-connection` places still parse and run unchanged; a guide of
  the new place declaring a mode is refused by the SDK parser.
- [ ] **Step 2:** Run `pnpm exec vitest run packages/kernel/test/setup/deployment-checks.http.test.ts packages/plugin-sdk/test/setup-guide.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement; `pnpm gen:sdk-api`.
- [ ] **Step 4:** Run the tests, `pnpm check:platform-ops`, `pnpm check:sdk-api`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(setup): add the extension-deployment setup place for platform checks`.

### Task C9: Web — accessors, notification settings, in-context prompt, `?org=`

**Files:**
- Modify: `apps/web/src/lib/shell.ts` (mirror `push@1` types; `usePushCapability()`)
- Create: `apps/web/src/lib/push.ts` (API calls), `apps/web/src/lib/query/push.ts` (`pushRegistrationsQuery`, `pushPreferencesQuery`), `apps/web/src/lib/use-push-registration.ts`
- Create: `apps/web/src/app/(app)/account/notifications/{page.tsx,view.tsx}`
- Modify: `apps/web/src/components/settings-nav.ts` (`useAccountNav` item `notifications`), `apps/web/src/components/shell/path.ts`, `apps/web/src/lib/query/routes.ts` (prefetch), `apps/web/src/lib/query/keys.ts`
- Modify: `apps/web/src/components/shell/AppFrame.tsx` (`?org=` switch; mount the prompt), sign-out handler (where `POST /auth/logout` is called: `DELETE` + `unregister()` first)
- Modify: `apps/web/src/lib/admin-inbox.ts` (render `push_auth_failed`: 「推送凭据无效：<plugin>」 / "Push credentials rejected: <plugin>", link `/admin/extensions/<plugin>`), `apps/web/src/lib/audit-actions.ts` (labels for `push.registered`, `push.unregistered`)
- Modify: `apps/web/messages/{zh,en}.json`
- Test: `apps/web/src/app/(app)/account/notifications/view.test.tsx`, `apps/web/src/lib/use-push-registration.test.ts`, `apps/web/src/components/shell/org-param.test.tsx`

**Interfaces:**
- Consumes: C4 routes, C1 type shapes (mirrored; `check:web-ui` and `web-shell-access` hold).
- Produces:
  - `usePushRegistration(): { state: "unavailable" | "prompt" | "granted" | "denied"; enable(): Promise<void>; disable(): Promise<void> }` — `enable` (in a click handler) calls `register()`, `POST`, `registered(id)`; on mount with `granted` and (`registrationId === null` or `tokenChanged`) it re-registers and posts silently (decision 4).
  - `PushPrompt` (in AppFrame): shown once per profile when `state === "prompt"` and the pending count first becomes > 0; 「以后再说」 hides it (per-viewer `localStorage`, try/catch).

- [ ] **Step 1:** Tests:
  - the settings view (`renderRouteWithCache`) lists registrations with device name and last
    seen, marks `current`, 「移除」 calls `DELETE` and invalidates; the four switches render from
    `GET` and a toggle `PUT`s the one key; empty list shows the empty-state copy; without
    `push@1` no 「在此设备开启通知」 button, with it the button calls `enable()`;
  - `usePushRegistration` with a fake shell: `prompt` → `enable()` registers, posts and calls
    `registered("<id>")`; `granted` + `tokenChanged` re-posts without a click; `denied` exposes
    `denied` and never calls `register`; no shell → `unavailable`;
  - sign-out with a registration id calls `DELETE /api/v1/me/push-registrations/<id>` then
    `unregister()` before logout, and still logs out when `DELETE` fails;
  - `/chat/c1?org=o2` for a member of `o2` calls `PUT /api/v1/me/current-org` with `o2` and
    replaces the URL with `/chat/c1`; for a non-member it only drops the parameter.
- [ ] **Step 2:** Run `pnpm exec vitest run apps/web/src/app/\(app\)/account/notifications apps/web/src/lib/use-push-registration.test.ts apps/web/src/components/shell/org-param.test.tsx`. Expected: FAIL.
- [ ] **Step 3:** Implement on `SettingsPage` with `DataTable` and `Switch` rows (one box, no box
  in a box); copy from Global Constraints.
- [ ] **Step 4:** Run the tests, `pnpm check:web-ui`, `pnpm check:i18n`, `pnpm typecheck`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(web): add notification settings, the push prompt and org switching from links`.

### Task C10: Docs, AGENTS.md and skills

**Files:**
- Modify: `AGENTS.md` (Rules by area: a **Push** line), `docs/architecture.md` (the `push/` domain and the point), `.agents/skills/writing-extensions/SKILL.md` (`push-provider@1`: brokered, sensitive, platform-only config, no retries, token handling), `.agents/skills/writing-kernel-api/SKILL.md` (the `cap-push-deliver` queue in the queue table)
- Modify: the spec (`2026-11-20-mobile-app-design.md`): one-line follow-ups for this plan's decisions 1–11 and P1's ruling
- Test: `pnpm check:agent-docs`, `pnpm check`

The AGENTS.md line (verbatim):

```
- **Push:** channels are `push-provider@1` plugins; delivery is the kernel's (an outbox row in the
  event's transaction, one `cap-push-deliver` job per registration, retries only there); a push
  token is sealed at rest and never logged, audited or returned; payloads carry no conversation
  content unless `push.previews` is `titles`, never message text. [mobile app spec §9]
```

- [ ] **Step 1:** Edit the files.
- [ ] **Step 2:** Run `pnpm check` and `pnpm lint`. Expected: PASS.
- [ ] **Step 3:** Commit `docs: describe push delivery, push-provider@1 and the push rule`.

---

## Plugin tasks (`capybara-hq/plugins`)

Each plugin: `plugins/<name>` with `package.json` (`@capybara-hq/plugin-<name>`),
`.capybara-plugin/plugin.json` (displayName zh / en, `setupGuides` with one guide of place
`extension-deployment`), `icon.svg` (`pnpm icons:generate`), `src/index.ts`, `test/`. Shared rules:
`provides: ["push-provider@1"]`; config `{ deployment: … }` only (no org config: spec §9.2 scope);
secrets through `secret()`; `permissions.network` lists the vendor hosts; no retries; never put a
token in an error, a log or a result message; short-lived vendor auth tokens cached in `ctx.kv`
with a TTL below their lifetime; `apps()` from config. Tests: `describePushProviderConformance`
against a local fake vendor server in `test/fake-<vendor>.ts`; a kernel-level test
(`test/kernel.http.test.ts`) that loads the plugin with `@capybara-hq/testing`, posts a
registration, finishes a model-fake run and sees one request at the fake vendor; a live test under
`test/live` gated on `CAPYBARA_TEST_*`.

### Task P1: Aggregator ruling (Getui vs JPush)

**Files:** the execution ledger; the spec follow-up line (C10).

- [ ] **Step 1:** Compare, from each vendor's current public docs, and record a table:
  vendor channels reached (Huawei, Honor, Xiaomi, OPPO, vivo, plus Meizu / FCM fallback); server
  API that needs no long connection (REST endpoint, auth scheme and token lifetime: JPush v3 HTTP
  Basic `appKey:masterSecret`; Getui RestAPI v2 `sign` token per app); client SDK size and
  whether it bundles vendor SDKs; terms (free tier limits, data processing in mainland China,
  privacy-policy obligations under PIPL and app-store compliance rules, required in-app
  disclosures); a dead-token signal in the send answer; per-request batch limit.
- [ ] **Step 2:** Pick one with the rule: covers all five vendor channels, plain REST with token or
  basic auth, a per-token dead signal; ties go to the simpler auth. Record the ruling (vendor,
  plugin name `push-<agg>`, endpoint hosts, auth) in the ledger and send it to C10.

### Task P2: `push-apns` (high risk: signing key)

**Files:** `plugins/push-apns/{package.json,.capybara-plugin/plugin.json,setup/zh.md,setup/en.md,src/index.ts,src/config.ts,src/jwt.ts,src/send.ts,src/check.ts,test/*}`

**Interfaces:**
- Config `ApnsDeployment`: `{ key: secret(z.string().min(1)) /* .p8 PEM */, keyId: z.string().length(10), teamId: z.string().length(10), bundles: z.array(z.object({ bundleId: z.string(), environment: z.enum(["production", "sandbox"]) })).min(1) }`.
- `apps()` = bundle ids. `createApnsProvider({ config, kv, net })`.
- Request: HTTP/2 `POST /3/device/<token>` to `api.push.apple.com` or `api.sandbox.push.apple.com` per bundle; headers `authorization: bearer <ES256 JWT>`, `apns-topic: <bundleId>`, `apns-push-type: alert`, `apns-priority: 10`, `apns-expiration: <now + 86400>`; body `{ aps: { alert: { title, body }, "thread-id": threadId, sound: "default" }, path, origin }`.
- JWT cached in `ctx.kv` key `apns-jwt-<keyId>`, TTL 40 minutes (Apple refuses a new token more often than every 20 minutes).
- Mapping: 200 → delivered; 410, or 400 `BadDeviceToken` / `Unregistered` → unregistered; 403 `InvalidProviderToken`, 400 `DeviceTokenNotForTopic` / `TopicDisallowed` → auth; 403 `ExpiredProviderToken` → transient (and drop the cached JWT); 429 (incl. `TooManyProviderTokenUpdates`) → rate_limited; 5xx, connection errors → transient.
- Setup check `apns-credentials`: parses the key and signs a JWT; `POST` to an all-zero device token: 400 `BadDeviceToken` → ok, 403 → failing (reason names the APNs reason code), else unknown. Nothing is delivered.

- [ ] **Step 1:** Tests: conformance against `test/fake-apns.ts` (node `http2` server on a
  self-signed cert); `config.test.ts` (bad key length, empty bundles refused); `jwt.test.ts`
  (header `kid`, claims `iss`/`iat`, ES256 verifies with the public key; second call within TTL
  reuses the cached token); the mapping table, one case per row; the check (ok / failing / unknown);
  kernel-level test; live test `test/live/apns.live.test.ts` (`CAPYBARA_TEST_APNS_KEY`, `_KEY_ID`, `_TEAM_ID`, `_BUNDLE`, `_TOKEN`).
- [ ] **Step 2:** Run `pnpm exec vitest run plugins/push-apns`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the tests and `pnpm exec capybara-plugin check plugins/push-apns`. Expected: PASS.
- [ ] **Step 5:** Changeset (new plugin), commit `feat(push-apns): add the APNs push provider`.

### Task P3: `push-fcm`

**Files:** `plugins/push-fcm/{…same layout…, src/oauth.ts}`

**Interfaces:**
- Config `FcmDeployment`: `{ serviceAccount: secret(z.string().min(1)) /* JSON */, applicationIds: z.array(z.string()).min(1) }`; the JSON must carry `project_id`, `client_email`, `private_key` (refine; the message never echoes values).
- OAuth: JWT bearer grant to `https://oauth2.googleapis.com/token`, scope `https://www.googleapis.com/auth/firebase.messaging`; access token in `ctx.kv` `fcm-token-<sha256(client_email)>`, TTL `expires_in − 300` s.
- Request: `POST https://fcm.googleapis.com/v1/projects/<project_id>/messages:send` with `{ message: { token, notification: { title, body }, data: { path, origin, threadId }, android: { priority: "HIGH", ttl: "86400s", notification: { tag: threadId } } } }`.
- Mapping: 200 → delivered; 404 `UNREGISTERED`, 400 `INVALID_ARGUMENT` naming `message.token` → unregistered; 401, 403 `SENDER_ID_MISMATCH` / `THIRD_PARTY_AUTH_ERROR`, token endpoint 400 `invalid_grant` → auth; 429 `QUOTA_EXCEEDED` → rate_limited (`Retry-After` → `retryAfterMs`); other 400 / 5xx / network → transient.
- Setup check `fcm-credentials`: the token exchange only (ok / failing on `invalid_grant` / unknown).

- [ ] **Step 1:** Tests: conformance against `test/fake-fcm.ts` (token endpoint + send endpoint);
  config refusals; the mapping, one case per row; the cached access token reused; the check; kernel-level;
  live `test/live/fcm.live.test.ts` (`CAPYBARA_TEST_FCM_SERVICE_ACCOUNT`, `_APP_ID`, `_TOKEN`).
- [ ] **Step 2:** Run `pnpm exec vitest run plugins/push-fcm`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the tests and `capybara-plugin check`. Expected: PASS.
- [ ] **Step 5:** Changeset, commit `feat(push-fcm): add the FCM push provider`.

### Task P4: `push-<agg>`

**Files:** `plugins/push-<agg>/…` (same layout).

**Interfaces:** from P1's ruling: config `{ appId, appKey, masterSecret: secret(…), applicationIds: string[] }` (field names as the vendor calls them), the REST send endpoint with a single registration id per request, vendor notification channel options set so Huawei / Xiaomi / OPPO / vivo classify it as a service (not marketing) message, `thread-id`-like grouping where the vendor offers it, the vendor's dead-token code → unregistered, auth errors → auth, quota → rate_limited, else transient; setup check `<agg>-credentials` through the vendor's auth call only.

- [ ] **Step 1:** Tests as P2 / P3 (conformance against `test/fake-<agg>.ts`, mapping per vendor
  code, check, kernel-level, live `CAPYBARA_TEST_<AGG>_*`).
- [ ] **Step 2:** Run `pnpm exec vitest run plugins/push-<agg>`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the tests and `capybara-plugin check`. Expected: PASS.
- [ ] **Step 5:** Changeset, commit `feat(push-<agg>): add the <vendor> push provider`.

---

## Client tasks (`capybara-hq/clients`)

### Task K1: `push@1` logic and the capability module

**Files:**
- Create: `packages/shell/src/push.ts` (pure)
- Create: `apps/mobile/src/push/capability.ts` (the `CapabilityImpl` for `push@1`, registered with `available: (profile) => offersPush(profile.meta, build)`), `apps/mobile/src/push/native.ts` (the TypeScript-facing contract of the native module), `apps/mobile/src/push/store.ts` (registration id per profile)
- Modify: the runtime's start-up wiring (one `registry.register("push@1", …)` line; `ProfileStore.onRemoved` and the sign-out path hooked to the unregister flow; native taps handed to `DeepLinkRouter`)
- Test: `packages/shell/test/push.test.ts`, `apps/mobile/test/push/capability.test.ts`

**Interfaces:**
- Consumes: `PushCapabilityV1`, `PushStatus`, `PushRegistration` from `@capybara-hq/plugin-sdk` (exact published version, M2); the shell plan's `CapabilityRegistry`, `ProfileStore`, `DeepLinkRouter`. `register` is not in `confirming` (decision 4: the capability itself requires `ctx.activation` only when permission is `prompt`).
- Produces:

```ts
// packages/shell/src/push.ts
export function offersPush(meta: { features?: { push?: { appId: string; providers: string[] }[] } },
  build: { appId: string; providers: readonly string[] }): boolean;
export function pickAndroidProvider(env: { googlePlayServices: boolean },
  carried: { fcm?: string; aggregator?: string }): string | null; // FCM when present, else aggregator
export function shouldPresentForeground(push: { origin: string; path: string },
  screen: { origin: string; url: string } | null): boolean; // false only when same origin and same pathname
export function profileForPush(origin: string, profiles: readonly { id: string; origin: string }[]): string | null; // exact origin match
export function parsePushPayload(data: Record<string, unknown>): { origin: string; path: string; threadId: string } | null;
// apps/mobile/src/capabilities/push/native.ts
export interface PushNative {
  permission(): Promise<PushPermission>;
  requestPermission(): Promise<PushPermission>;
  token(provider: string): Promise<string>;         // OS / vendor token for this install
  onToken(cb: (provider: string, token: string) => void): () => void;
  onForeground(cb: (data: Record<string, unknown>) => void): () => void;
  onTap(cb: (data: Record<string, unknown>) => void): () => void;
  present(data: { title: string; body: string; data: Record<string, unknown> }): Promise<void>;
  googlePlayServices(): Promise<boolean>;            // android only; ios false
}
export function createPushCapability(deps: { native: PushNative; store: RegistrationStore;
  build: BrandPush }): CapabilityImpl; // functions status / register / registered / unregister, each (ctx: CallContext, ...args)
```

- `RegistrationStore`: `{ get(profileId): { id: string; token: string } | null; set(profileId, v); clear(profileId); any(): boolean }` (native secure storage behind it; the shell plan's profile store if it offers one).
- Tap handling: `onTap` → `parsePushPayload` → `DeepLinkRouter` (profile by exact origin via `profileForPush`, then load `origin + path`); unknown origin → open the app without navigating.
- Sign-out and profile removal hooks: page-context `fetch(DELETE /api/v1/me/push-registrations/<id>)` before the store is cleared, then `store.clear(profileId)` (decision 6).

- [ ] **Step 1:** Tests (`packages/shell`): `offersPush` true only when the build's app id is listed
  with a provider the build carries; `pickAndroidProvider` FCM with Play services, aggregator
  without, null when neither; `shouldPresentForeground` false for the same pathname with another
  query, true for another path or origin or no screen; `profileForPush` matches
  `https://a.example` exactly, not `https://a.example.evil` or `http://a.example`;
  `parsePushPayload` refuses a non-`/` path and an origin with a path.
- [ ] **Step 2:** Tests (`apps/mobile`, fake `PushNative`): `status()` maps permission and reports
  `registrationId` and `tokenChanged` (stored token differs from `token()`); `register()` with
  `prompt` and no user activation rejects `{ code: "no_activation" }`, with activation requests
  permission and resolves `{ platform, appId, provider, token }`; `denied` rejects
  `{ code: "cancelled" }`; `granted` resolves without activation; `registered("r1")` stores it;
  `unregister()` clears only this profile and leaves another profile's registration; the
  foreground handler presents a banner unless `shouldPresentForeground` is false; a tap on a
  second profile's origin activates it and loads the path; profile removal issues the `DELETE`
  before clearing.
- [ ] **Step 3:** Run `pnpm test`. Expected: FAIL.
- [ ] **Step 4:** Implement.
- [ ] **Step 5:** Run `pnpm test`, `pnpm typecheck`, `pnpm lint`. Expected: PASS.
- [ ] **Step 6:** Changeset (`@capybara-hq/mobile`), commit `feat(mobile): add the push@1 capability`.

### Task K2: iOS APNs native module

**Files:** `apps/mobile/ios/App/App/Push/PushModule.swift`, `PushBridge.swift` (the shell's message
handler wiring, not Capacitor's bridge), `AppDelegate.swift` (APNs callbacks), entitlements
`aps-environment`; `apps/mobile/ios/App/AppTests/PushModuleTests.swift`.

**Interfaces:** implements `PushNative` for iOS: `UNUserNotificationCenter` authorization (alert,
sound), `registerForRemoteNotifications`, the device token as lowercase hex under provider
`push-apns`; `userNotificationCenter(_:willPresent:)` forwards to `onForeground` and presents only
when K1 says so; `didReceive` forwards to `onTap`; `googlePlayServices()` false.

- [ ] **Step 1:** XCTest: the token formatter (Data → hex), the payload extraction from a
  `UNNotification` user info (`path`, `origin`, `aps.thread-id`), and that `willPresent` returns
  `[]` when the injected decision says suppress and `[.banner, .sound]` otherwise.
- [ ] **Step 2:** Run `xcodebuild test -scheme App -destination 'platform=iOS Simulator,name=iPhone 17'`. Expected: FAIL.
- [ ] **Step 3:** Implement; the module is reachable only through the shell's handler (§5.3 origin gate).
- [ ] **Step 4:** Run the XCTest and `pnpm test`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(mobile): add the iOS APNs push module`.

### Task K3: Android FCM and aggregator native module

**Files:** `apps/mobile/android/app/src/main/java/com/capybarahq/mobile/push/{PushModule.kt,FcmService.kt,AggregatorReceiver.kt,PlayServices.kt}`,
`AndroidManifest.xml` (services, `POST_NOTIFICATIONS`), Gradle (Firebase messaging, the P1 vendor
SDK), `apps/mobile/android/app/src/test/java/com/capybarahq/mobile/push/PushModuleTest.kt`.

**Interfaces:** implements `PushNative` for Android: `GoogleApiAvailability.isGooglePlayServicesAvailable == SUCCESS`
→ FCM token under `push-fcm`, else the aggregator's registration id under `push-<agg>` (K1's
`pickAndroidProvider` decides); Android 13+ `POST_NOTIFICATIONS` runtime permission (`prompt` until
asked); a notification channel `capybara-default`; foreground messages → `onForeground`; tap
intents → `onTap` with the data map; the aggregator SDK initialised only when FCM is unavailable.

- [ ] **Step 1:** JUnit (Robolectric): the provider choice with a fake availability; the data map
  extraction from an FCM `RemoteMessage` and from the aggregator's payload; permission mapping per
  API level (32 → `granted` by default, 33 → `prompt` before asking).
- [ ] **Step 2:** Run `./gradlew :app:testDebugUnitTest` (in `apps/mobile/android`). Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the JUnit tests and `pnpm test`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(mobile): add the Android FCM and aggregator push module`.

### Task K4: Brand push fields and the fork guide's push section

**Files:** `apps/mobile/brand.ts`, `apps/mobile/scripts/apply-brand.ts`,
`apps/mobile/test/brand.test.ts`, `docs/fork-guide.md` (push section),
`.github/workflows/release.yml` (mobile job: push secrets written to files at build time).

**Interfaces:**
- `brand.ts` gains `push?: { apns?: { environment: "production" | "sandbox" }; fcm?: { googleServicesFile: string /* path to google-services.json, from a secret in CI */ }; aggregator?: { appId: string; appKey: string } }` (official build: `push` absent, so `push@1` is never offered).
- `apply-brand.ts` writes `aps-environment`, adds the Firebase Gradle plugin and file only with
  `fcm`, the aggregator manifest placeholders only with `aggregator`; the drift check fails when
  the native projects disagree.
- `BrandPush` (consumed by K1) = the `push` field plus `appId` and the carried providers derived
  from it.

- [ ] **Step 1:** Tests: the official brand yields no `aps-environment`, no Firebase plugin, no
  aggregator placeholders, and `carriedProviders(brand)` is `[]`; a fork brand with all three
  yields each and `["push-apns", "push-fcm", "push-<agg>"]`; drift detection fails on a changed
  entitlement.
- [ ] **Step 2:** Run `pnpm test`. Expected: FAIL.
- [ ] **Step 3:** Implement. The fork guide's push section, in order: create the APNs key (`.p8`, key id,
  team id) and the Firebase project (Android app with the fork's application id,
  `google-services.json`, a service account with Firebase Cloud Messaging), and the aggregator app;
  set the brand `push` field; store the files as repository secrets (`MOBILE_GOOGLE_SERVICES_JSON`,
  `MOBILE_AGG_APP_KEY`); on the deployment, as super admin, import and enable `push-apns`,
  `push-fcm` and `push-<agg>` for the channels the build carries, fill their deployment config
  (bundle id with `production` for TestFlight / App Store builds, application ids), run each
  plugin's credential check on its extension page, and confirm `GET /api/v1/meta` lists the build's
  app id under `features.push`; set `push.previews` only if conversation titles may leave the
  deployment.
- [ ] **Step 4:** Run `pnpm test`, `pnpm lint`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(mobile): add brand push fields and the fork guide's push section`.

---

## Task A: Acceptance (maintainer, M3)

A live checklist file `docs/superpowers/plans/push-live-acceptance-checklist.md` written at the
end of C10 (one line per item): each category on iPhone, Android with Play services, Android
without (aggregator); foreground suppression on the same conversation; tap opens the right
profile and org; previews off shows no conversation title; sign-out and profile removal stop
pushes; a wrong APNs key raises the platform notice and the check says failing.

---

## Self-review notes

- Spec coverage: §9.1 (official app has no `push` brand field → no `push@1`: K4, K1); §9.2 (C1,
  C5, P1–P4, meta: C5); §9.3 (C3, C4, C9, K1, decisions 2–5); §9.4 (C6, C7; no IM dedup: nothing
  dedups; foreground: K1/K2/K3; no presence record: none written); §9.5 (C7 texts and previews,
  decision 7 badge, threadId); §5.1 / §5.2 (C1, K1); §10 push parts (K4); §11 (Global
  Constraints token rule, C4/C6 log assertions); §12 kernel / sdk / web items (C1–C9); AGENTS.md
  rules touched (C10).
- Type names used across tasks: `PushProvider`, `PushTarget`, `PushMessage`, `PushResult`,
  `PushError`, `PushCapabilityV1`, `PushStatus`, `PushRegistration`, `PushProviderHost`,
  `PushTokenStore`, `PushRegistrationsService`, `PushPreferencesService`, `PushOwed`,
  `PushFanout`, `PushDelivery`, `PushStaleJob`, `PushCategory`, `PushFanoutData`,
  `PushDeliverData`, `PUSH_QUEUE`.
