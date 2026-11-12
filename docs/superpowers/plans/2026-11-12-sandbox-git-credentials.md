# Git credentials for sandboxes: implementation plan

- Spec: `docs/superpowers/specs/2026-11-12-sandbox-git-credentials-design.md` (approved
  2026-11-12, every §13 recommendation accepted). Issue: capybara-hq/core#194.
- Phases: **1** core (plugin-sdk, kernel, device, testing, web); **2** capybara-hq/plugins
  (`github` templates declare git hosts, sandbox-docker proxy exception, sandbox-e2b allowOut) after
  a core release; **3** later (LFS, `connector-git`, signing; not planned here).
- Execution: `wave-planned-subagent-development` on top of `subagent-driven-development`. Branch
  `feat/git-gateway-p1` in core, `feat/git-gateway-p2` in plugins. Every PR says `Refs #194`.
  Nothing is merged by the implementer.

## Sequencing with the sandbox dev tiers (#190)

Dev tiers phase 1 (`feat/sandbox-tiers-p1`) changes `SandboxLimits`, the device protocol,
`sandbox/sandbox.service.ts`, `local-devices/local-device-provider.ts`, `device-paths.ts` and the
device's `exec/*`, and takes migration 0117. This plan touches the same files in waves 3–4, so:

- Waves 1–2 (SDK git source type, migration, config, tickets, sources, gateway route, policy,
  approvals) are disjoint from dev tiers and start now on `origin/main`.
- Waves 3–4 (exec env, `SandboxLimits.gateway`, device, `device_paths`) start only after dev tiers
  phase 1 is merged into `main`; the branch is then rebased (merge `origin/main`, never force-push).
- Migration number: the next free number when wave 1 starts (0118 if dev tiers holds 0117);
  checked again before the PR.

## Conventions every task follows

- AGENTS.md rules: English comments for new code, explicit `@Inject`, one Nest module per domain
  (`GitModule`), `@Transactional()` + `afterCommit` for writes, every Redis key with a TTL, no
  in-process shared state, model-facing text in English, UI text through i18n (zh: 平台 /
  超级管理员 / 智能体).
- The token never leaves `Credentials` except into the upstream request of one gateway call; it is
  never logged, stored outside `capybara.secrets`, put in an event, a Redis value or an error.
- SDK public API changes: `pnpm gen:sdk-api` + changeset (`@capybara-hq/plugin-sdk`); device:
  changeset (`@capybara-hq/device`); kernel behaviour: changeset (`@capybara-hq/kernel`,
  `@capybara-hq/capybara`).
- New HTTP route: Platform operation or exclusion with a reason (`pnpm check:platform-ops`): the
  gateway is excluded ("git smart-HTTP for sandboxes, authenticated by run tickets, not an API").
- Tests from the repo root: `pnpm exec vitest run <path>`. Before each commit `pnpm lint`,
  `pnpm typecheck`, the touched tests; `pnpm check` and `pnpm verify` before the PR.
- Implementers stage only their own paths.

## Wave plan

| Task | Depends on | Files / areas | Risk | Wave | Review |
|---|---|---|---|---|---|
| A1 SDK git source | — | `plugin-sdk/src/plugin-package.ts` (template `git`), `connector-auth.ts`/connector create schema, `git.ts` (new: `GitSourceHost`, `GIT_HOST_USERNAMES`, `parseGitHosts`), `index.ts`, api snapshot, changeset | normal | 1 | batch |
| A2 Migration + schema | — | `migrations/01NN_git_gateway.sql`, `db/kernel-schema.ts` | normal | 1 | batch |
| A3 Config | — | `config/schema.ts` (`tools.git`), `docs/config.md` | normal | 1 | batch |
| A4 Fake git host | — | `packages/testing/src/fake-git-server.ts` (new), export, its test | normal | 1 | batch |
| B1 Tickets | A2, A3 | `kernel/src/git/tickets.ts`, `git.module.ts`, tests | **high** | 2 | alone |
| B2 Git sources + identity | A1, A2 | `kernel/src/git/sources.ts`, `connectors.service.ts` (store `git_hosts`, `use_for_git`), `credentials.ts` (`gitAuthorization`), tests | **high** (cross-tenant, whose credential) | 2 | alone |
| B3 Gateway route | B1, B2, A4 | `kernel/src/git/gateway.controller.ts`, `gateway.service.ts`, `pkt-line.ts`, `http/app.ts` (raw body parser for `application/x-git-*`), platform exclusion, tests | **high** (trust boundary, SSRF, streaming) | 2 | alone |
| B4 Push policy + approvals | B1 | `tools/approvals.service.ts` (kind `git`), `tools/git-asks.ts` (new, modeled on `network-asks.ts`), `tools/policy.ts` (`git_push` virtual policy), `connector-account-policies.ts`, `schedules/grant-rules.ts` + `unattended.ts` (`git:push`, `git:push:<owner>/<repo>`), conversation event `approval_requested.git`, tests | **high** | 2 | alone |
| C1 Exec env + redaction | B1–B4, dev tiers merged | `tools/builtins/sandbox/bash.ts`, `common.ts`, `background/session.ts`, `tools/pipeline.ts` (git report → ask), `git/exec-env.ts` (new), tests | **high** | 3 | alone |
| C2 SandboxLimits.gateway + device | dev tiers merged | `plugin-sdk/src/sandbox.ts`, `device-protocol.ts`, `sandbox/sandbox.service.ts`, `local-devices/local-device-provider.ts`, `packages/device/src/exec/docker.ts` (`--env-file`), `exec/os.ts` + `policy.ts` (allow the gateway origin; `gitGateway` local key; drop git env when unsandboxed and off), sandbox-fake fixture, tests, changesets | **high** | 3 | alone |
| C3 Model-visible line | C1 | `runtime/context/device-paths.ts`, zero-drift fixtures (`replay-evals` skill) | normal | 3 | batch |
| C4 Revocation + audit | B1, B3 | run-end hook (afterCommit) deleting tickets, member deactivation / connector delete / credential clear hooks, `audit` types `git.push` / `git.fetch`, run-end fetch summary, tests | normal | 3 | batch |
| D1 Web | B2, B4, C4 | connector page ("use for git", `git_push` policy row), org settings (gateway switch, host source pick), task page grants, device page line, `messages/{zh,en}.json`, web tests | normal | 4 | batch |
| D2 End-to-end | all | kernel e2e with sandbox-fake + fake git host (clone / fetch / push, ask → approve → re-run, unattended grant), dual-replica, leak tests, live test (env-gated) | normal | 4 | batch |
| E Final | all | whole-branch review, `pnpm verify`, PR | — | 5 | most capable |

## Tasks

### A1. SDK git source

- Template file and custom connector create body accept `git?: { hosts: { host: string; username:
  string }[] }` (≤ 8 hosts; `host` passes `validateAllowHost` and has no port or path; `username`
  `^[A-Za-z0-9._-]{1,64}$`; strict objects). `validateConnectorTemplate` checks it; the JSON Schema
  `connector-template.v1.schema.json` gains it.
- `GIT_HOST_USERNAMES` documents the known ones (`github.com` / `*.ghe.com`: `x-access-token`).
- Tests: valid, credential-like values refused, duplicates refused.

### A2. Migration

- `connectors.git_hosts jsonb NULL` (the declared hosts, from the template or the create body),
  `connectors.use_for_git boolean NOT NULL DEFAULT false` (org-ownership connectors only; personal
  ones are always sources).
- Approvals: the `kind` CHECK gains `'git'`.
- No table for tickets (Redis). Org setting `gitGateway: { enabled?: boolean; hostSources?:
  Record<host, connectorId> }` lives in the existing org settings JSON (no migration).
- `IF NOT EXISTS` style; schema `capybara`.

### A3. Config

`tools.git`: `enabled` (default true, hot), `gatewayUrl` (default `http.publicUrl`; sandbox-facing
origin), `maxBytesPerRun` (5 GiB), `idleTimeoutMs` (60 s), `maxConcurrentPerOrg` (8),
`ticketTtlSeconds` (900; renewed while the run lives). adding-config skill, `docs/config.md`.

### A4. Fake git host (`@capybara-hq/testing`)

`startFakeGitServer({ repos, requireBasic?: { username, password } })`: serves smart-HTTP by
spawning `git http-backend` per request on a temp bare repo (git is in CI images); records requests
(headers without values of `Authorization`), can answer 401 / 403 / redirects on demand.

### B1. Tickets

- `issue({ orgId, accountId, runId, execId, hosts, repos? })` → 32 random bytes base64url; Redis
  `git-ticket:<sha256>` → JSON binding, TTL `ticketTtlSeconds`; a run set `git-run-tickets:<runId>`
  (TTL) for revocation.
- `resolve(ticket)` → binding or null; checks expiry, run still active (PG `runs.status`), account
  active member, org gateway enabled. `revokeRun(runId)`.
- Tests: hash-only storage (the raw ticket in no Redis key or value), expiry, revocation,
  cross-org misuse refused, dual-replica (issued on A, resolved on B).

### B2. Git sources and identity

- `sourcesFor(orgId, accountId)` → `{ host, connectorId, username, bot: boolean }[]`: personal
  connectors with `git_hosts` where the account has a credential; org connectors only with
  `use_for_git`; one per host (org `hostSources` pick, else the OAuth (`oauth_code`) one, else the
  oldest).
- `Credentials.gitAuthorization(orgId, connectorId, auth, accountId)` → `Basic
  base64(username:token)` built inside `Credentials` (the raw token never returned), with refresh
  and `forceRefresh` as `injection` does.
- Identity: `gitIdentity(orgId, connectorId, accountId)` reads GitHub `GET /user` once through the
  credential (host from the connector's API base: `api.github.com` or `api.<sub>.ghe.com`), caches
  `{ name, login, id }` in Redis 24 h, returns `name` and `<id>+<login>@users.noreply.<host>`.
- Tests: personal vs org, anonymous guest gets nothing, another account's credential never used,
  host pick rules.

### B3. Gateway route

- `GitModule` in `ApiModule`; route `/git/v1/:host/*` (`@Public()`, ticket guard reading
  `Authorization: Bearer`), methods GET (`info/refs`) and POST (`git-upload-pack`,
  `git-receive-pack`); everything else 404.
- Raw streaming body: a Fastify content-type parser for `application/x-git-upload-pack-request` /
  `-receive-pack-request` that passes the stream through (no buffering, route body limit off,
  byte counter enforcing `maxBytesPerRun` via a Redis counter per run).
- Upstream: `https://<host>/<owner>/<repo>.git/...` through `packages/kernel/src/net` (no
  redirects, deployment egress rules), headers filtered as spec §5.3, `Authorization` from B2;
  upstream 401 → `forceRefresh` once and retry only for GET `info/refs` (a POST body is not
  replayable: 401 there answers the git error).
- Push (`service=git-receive-pack` on `info/refs` and the POST): B4's decision first; refused →
  `ERR` pkt-line with the spec's message and a pending ask record.
- Repo checks: `owner/repo` shape, the ticket's repo allowlist.
- Per-org concurrency (Redis counter with TTL), idle timeout, audit hooks (C4).
- Tests (fake git host): clone, fetch, push with a valid ticket; wrong host / path / method 404;
  expired ticket 401 with git message; upstream redirect refused; headers filtered (no ticket
  upstream, no `Set-Cookie` downstream); 401 refresh path; byte cap; the token in no log line.

### B4. Push policy and approvals

- Virtual per-connector tool `git_push` in connector policies (org default `ask`, member override
  `always` per repo stored as `git_push:<owner>/<repo>`), resolved by `decideGitPush({ binding,
  repo })` → `allow | ask | deny`.
- `ask`: Redis record `git-ask:<execId>` `{ host, repo, refs }` (TTL 1 h) that C1 reads after the
  exec; approval kind `git` with `detail: { host, repo, refs, command }`, scopes `once` (run grant
  row) / `always` (member override for that repo); notes modeled on `network-asks.ts`
  (`[git] Push to acme/app needs approval…`, allowed / denied / expired).
- Unattended: `git:push` / `git:push:<owner>/<repo>` task grants through `grantRefusalOf`;
  without one the push is refused with the unattended note and `missing_grants` records it.
- Tests: each policy path, grants, the approval card fields, replay of `approval_requested.git`
  (display-only field, no DriftReason).

### C1. Exec env and redaction (after dev tiers)

- `gitExecEnv(binding, ticket, sources, identity)` builds spec §5.4's env (one `insteadOf` triple
  per host: `https://<host>/`, `git@<host>:`, `ssh://git@<host>/`); empty when the org gateway is
  off, the actor has no source, or the device is unsandboxed without `gitGateway: on`.
- `Bash` and background tasks pass it through `exec({ env })`; a ticket per exec (`execId` =
  the tool call id).
- The formatter redacts the exact ticket from stdout / stderr before archiving and the result.
- After the exec, `git-ask:<execId>` turns into the B4 ask (pipeline outcome like `network_ask`).
- Tests: env shape, no env for guests, redaction, ask flow end to end with sandbox-fake.

### C2. `SandboxLimits.gateway` and the device (after dev tiers)

- SDK: `SandboxLimits.gateway?: { origin: string }`; device protocol carries it in exec limits.
- Kernel: set from `tools.git.gatewayUrl` when the gateway is enabled for the org.
- Device OS mode: add the gateway origin's host to the command's allowed domains; Docker mode:
  pass env with `--env-file` (0600 temp file, removed after `docker exec` starts) instead of
  `-e K=V`; unsandboxed: drop `GIT_CONFIG_*` git gateway keys unless the local policy has
  `gitGateway: "on"` (`capybara-device policy set git-gateway on|off`).
- Tests: env file permissions and cleanup, no value on the docker command line, OS-mode allow,
  unsandboxed filter.

### C3. Model-visible line

`device_paths` gains the git line of spec §5.6 when the actor has a source. Zero-drift fixture
tests before and after (replay-evals skill).

### C4. Revocation and audit

- Run end / abort (afterCommit): `revokeRun`. Member deactivated or removed, connector deleted,
  credential cleared, `use_for_git` off: tickets resolve to null on the next request because
  `resolve` re-checks; no extra hook needed beyond tests proving it.
- Audit `git.push` (per receive-pack), `git.fetch` summary per run and repo at run end (Redis
  counters → one audit row each).

### D1. Web

Connector page: "Use for git" switch (org connectors; personal ones show "Git: github.com"),
`git_push` row in the policy table; org sandbox settings: gateway switch and the host source
picker; scheduled task page: `git:push` grants; device page: a line on git through the gateway
and the unsandboxed opt-in. zh / en copy. Web tests per writing-web-ui.

### D2. End-to-end

Kernel e2e with model-fake + sandbox-fake (which must run real `git`: use the docker sandbox
fixture if sandbox-fake cannot) + fake git host: clone, commit, push (ask → approve → re-run),
unattended push with and without a grant; dual-replica gateway; leak test over events, logs, tool
outputs, sandbox files. Live test (env-gated `CAPYBARA_TEST_LIVE_GIT=1`,
`CAPYBARA_TEST_GITHUB_MCP_TOKEN`, `CAPYBARA_TEST_GITHUB_REPO`): push a scratch branch and delete it.

## Phase 2 (capybara-hq/plugins)

- `github` / `github-pat` templates: `git: { hosts: [{ host: "github.com", username:
  "x-access-token" }] }` (after the SDK release), version bump, guide line about git.
- sandbox-docker: the egress proxy allows `limits.gateway.origin` (exact origin, private address
  allowed for it only) in every tier; sandbox-e2b: add the gateway host to `allowOut` (public only).
- Tests in both plugins; core bootstrap bump if a bootstrap plugin changes.
