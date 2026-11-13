# Sandbox development tiers: implementation plan

- Spec: `docs/superpowers/specs/2026-11-12-sandbox-dev-tiers-design.md` (approved 2026-11-12, all
  eight §14 questions decided as recommended). Issue: capybara-hq/core#190.
- Phases: **1** core (plugin-sdk, kernel, device, web) in this repository; **2** capybara-hq/plugins
  (sandbox image, egress proxy, sandbox-docker, sandbox-e2b) plus the core bootstrap bump; **3** later
  (below, not planned in detail).
- Execution: `wave-planned-subagent-development` on top of `subagent-driven-development`. Branches:
  phase 1 on `feat/sandbox-tiers-p1`, stacked on `docs/sandbox-dev-tiers` (PR into it, retargeted
  to `main` when the docs PR merges); phase 2 on `feat/sandbox-tiers-p2` in capybara-hq/plugins.
- Every PR body says `Refs #190`. Nothing is merged by the implementer.

## Conventions every task follows

- AGENTS.md rules: English comments for new code, explicit `@Inject`, `@Transactional()` +
  `afterCommit`, every `ctx.kv` / Redis key with a TTL, no in-process shared state, tool and
  model-facing text in English, UI text through i18n (zh: 平台 / 超级管理员 / 智能体).
- Migration number: **0117** (`origin/main` has 0116). File `0117_sandbox_tiers.sql`.
- SDK public API changes: `pnpm gen:sdk-api` and a changeset bumping `@capybara-hq/plugin-sdk`;
  device changes: a changeset bumping `@capybara-hq/device`.
- Tests run from the repo root: `pnpm exec vitest run <path>`. Before each commit: `pnpm lint`,
  `pnpm typecheck` for the touched packages, the touched tests; `pnpm check` before the PR.
- Implementers stage only their own paths (`git add <paths>`), never `-A` / `-a`; retry a commit
  that hits `index.lock`.

## Phase 1 wave plan

| Task | Depends on | Files / areas | Risk | Wave | Review |
|---|---|---|---|---|---|
| A1 SDK + device types | — | `packages/plugin-sdk/src/sandbox.ts`, `device-protocol.ts`, `index.ts`, `dev-hosts.ts` (new), sdk api snapshot, changeset; `packages/device/src/state.ts` (Policy type + read/write), sandbox-fake fixture limits | normal | 1 | batch |
| B1 Kernel tiers + config + org settings | A1 | `packages/kernel/src/config/schema.ts`, `docs/config.md`, `packages/kernel/src/sandbox/tiers.ts` (new), `orgs/settings.service.ts`, `platform/ops/org-settings.ops.ts`, `platform/ops/platform.ops.ts`, their tests | **high** (tier caps) | 2 | alone |
| B2 Device dev tier (OS mode) | A1 | `packages/device/src/policy.ts`, `network.ts`, `exec/os.ts`, `exec/shared.ts`, `exec/docker.ts`, `commands/policy.ts`, `proxy-guard.ts` (new), README, device tests for these | normal | 2 | batch |
| B3 Device unsandboxed + remote policy refusal | A1 | `packages/device/src/exec/host.ts` (new), `exec/index` wiring in `commands/start.ts` / `client.ts`, `server-ops.ts` (policy op), their tests | **high** | 2 | alone |
| B4 srt Chrome sysctl patch | — | root `package.json` `pnpm.patchedDependencies`, `patches/@anthropic-ai__sandbox-runtime@0.0.81.patch`, `pnpm-lock.yaml`, one device test | normal | 2 | batch |
| C1 Kernel cloud tiers + local exec args + gates | B1 | migration 0117, `db/kernel-schema.ts`, `sandbox/sandbox.service.ts`, `sandbox/providers.ts`, `local-devices/local-device-provider.ts`, `local-devices/network-grants.ts`, `schedules/grant-rules.ts` + unattended cap, sandbox-fake `update`, tests | **high** (tier caps, unsandboxed gate) | 3 | alone |
| C2 Kernel device surfaces | B1 | `devices/devices.controller.ts`, `devices.service.ts`, `devices.schemas.ts`, `dto.ts`, `local-devices/device-policy.service.ts`, `policy-summary.ts`, `machines.ts`, `runtime/context/device-paths.ts` (+ `build.ts` call sites), Platform exclusion, audit, tests | normal | 3 | batch |
| D1 Web | C1, C2 | `apps/web/src/app/(app)/devices/[id]/view.tsx`, `devices/view.tsx`, `settings/sandbox/view.tsx`, device picker, `lib/devices.ts`, `lib/org-settings.ts`, `messages/{zh,en}.json`, web tests | normal | 4 | batch |
| E Final | all | whole-branch review, `pnpm verify`, PR, visual-update + reference-update workflows, empty `ci:` commit | — | 5 | most capable |

## Phase 1 tasks

### A1. SDK and device types

- `SandboxTier = "strict" | "dev" | "open"`, `SANDBOX_TIERS`, `tierAtMost(a, b)` / `minTier(...)`
  helpers; `DEV_HOSTS` (spec §5.2.2), each entry tested with `validateAllowHost`.
- `SandboxLimits`: `tier: SandboxTier`, `devHosts: string[]`, `defaultTier?: SandboxTier`.
- `SandboxProvider`: optional `update?(h, limits, signal): Promise<"updated" | "recreate">`,
  optional `readonly limitsApplyAt?: "instance" | "fileSystem"`.
- Device protocol: `DeviceLocalPolicySummary` replaces `network` with `tier` (optional: absent =
  follows the org), `effectiveTier`, `isolation: "sandbox" | "none"`, `localhost: "on" |
  "off-proxy-detected" | "off"`, `unixSockets: "roots" | "all-masked" | "off"`; hello feature
  `"tiers"`; `DevicePolicyArgs.network` → `tier?: SandboxTier | null` (null = follow the org) and
  `isolation?: "sandbox"` (the parser refuses `"none"`); `parseLimits` accepts the new fields.
- Device `state.ts`: `Policy` drops `network`, adds `tier?: SandboxTier`, `isolation`,
  `localhost: "auto" | "allow"`; `readPolicy` ignores legacy keys (`network`, `allowLocalBinding`,
  `allowUnixSockets`) and reports whether `network: "open"` was present (for the start notice);
  `writePolicy` drops them.
- Fix every compile error the type changes cause with the smallest edit (kernel limits builders
  default `tier: "strict"`, `devHosts: []` for now); real behaviour comes in B/C.
- `pnpm gen:sdk-api`, changesets (plugin-sdk minor-pre, device).

### B1. Kernel tiers, config and org settings (high)

- Config (`adding-config` skill): `sandbox.tiers.max` (default `dev`), `sandbox.tiers.default`
  (default `dev`, refined ≤ max), `sandbox.tiers.allowUnsandboxed` (default `true`),
  `sandbox.limits.devHosts` (default `DEV_HOSTS`, validated); `sandbox.limits.egress` loses `open`
  with a message pointing to `sandbox.tiers.max`. Regenerate `docs/config.md`.
- `sandbox/tiers.ts`: `effectiveSandboxPolicy(deployment, orgSettings, deviceTier)` per spec §4.2
  (tier, ceiling, cappedBy, egress, allowHosts, devHosts, allowUnsandboxed, defaultTier); table
  tests for every row. Replace `effectiveSandboxEgress` callers (catalog requests, network grants).
- Org settings: `sandboxTier: { max?, default?, allowUnsandboxed? }` in the settings, patch and
  GET (`deployment.sandboxTiers`); invalid stored value reads as `{ max: "strict" }`; patch above
  the platform → `org.sandbox_tier_not_allowed` (registered error code); `default ≤ max`.
- Platform op `org-settings`: `sandboxTier` accepted only when it narrows (compare effective
  before / after), else an English actionable error; parity test stays green.
- Startup warning moves to `sandbox.tiers.max = "open"` with the provider plugin's
  `openEgress` set to `"off"` (absent means `"proxy"`; read `extensionConfig.<plugin>.openEgress`).

### B2. Device dev tier, OS mode

- `effectiveEgress(policy, limits)` per spec §4.2: `t = min(policy.tier ?? limits.defaultTier ??
  "strict", limits.tier)`; strict / dev / open lists; grants unchanged.
- `srtConfig` per tier and platform (spec §5.2.3): dev / open: macOS `allowLocalBinding` unless the
  proxy guard says off (or `localhost: "allow"`), `allowUnixSockets: [tmp, workspace, socketDir]`;
  Linux: keep sockets blocked (the spike result is recorded in the PR; enabling masked sockets is
  phase 3 unless the spike passes cleanly in CI on Linux).
- Fold `45c326a95`'s executor parts: `applyConfig` / `markInstalled` (`SandboxManager.updateConfig`
  at the next command), `MAC_CHROMIUM_TMPDIR`, now pointing at the short socket dir
  `/private/tmp/cap-<dirKey8>` (0700, created at start) together with `TMPDIR` for dev / open.
- Cache env for dev / open (spec §5.2.1) under `<dir>/cache/…` (created on demand); `args.env`
  wins.
- `proxy-guard.ts`: `scutil --proxy` parse, loopback proxy env vars, a TCP probe of the listed
  ports (short timeout), run at start and on policy reload; result feeds `localhost` in the summary.
- `commands/policy.ts`: keys `tier` (`strict|dev|open|default`), `isolation` (`sandbox|none`, the
  `none` path is wired by B3 through an exported confirm helper here), `localhost` (`auto|allow`);
  risk texts; `policy show` prints effective behaviour; start notice for a legacy `network: open`.
- Docker mode: `--shm-size` per tier (`min(1 GiB, memoryMb/4)` or 1 GiB when no ceiling);
  network: the bridge only when the explicit local list is non-empty or the tier is `open`
  (`D` does not count, spec §5.2 table).
- README sections rewritten for tiers.

### B3. Unsandboxed executor and remote policy refusal (high)

- `exec/host.ts` `HostExecutor implements Executor`: spawn `/bin/bash -c` with the person's own
  environment (+ request env, `EXEC_MARKER`), cwd inside the workspace root, own process group,
  the same tracking / `killTagged` / `killAll` / timeout / output cap as `OsExecutor` (extract the
  shared group tracking from `os.ts` into `exec/groups.ts` if needed; coordinate: B3 owns the new
  file, B2 leaves the tracking code in `os.ts` untouched). File operations: direct host file IO
  within the roots (reuse `HostFiles` / `RootGuard`).
- Executor selection: `isolation: "none"` and tier `open` and OS mode → `HostExecutor`; switch at
  the next command after a policy change; refuse `isolation: none` in Docker mode.
- `server-ops.ts` `policy` op: `tier` widening only under `remoteGrants: "owner"`; narrowing always;
  `isolation` accepts only `"sandbox"`; anything else → `policy` error, never applied. Audit line
  in the local command log.
- `policy set isolation none` requires `--yes` / interactive `y`, prints the risk text (spec §5.4).
- Every exec logged with tier and isolation.

### B4. srt Chrome sysctl patch

- `pnpm patch @anthropic-ai/sandbox-runtime@0.0.81`: add `(sysctl-name "hw.product")` and
  `(sysctl-name "kern.hv_vmm_present")` to the macOS profile's allow list only. A device unit test
  asserts the generated profile contains both (pinned to 0.0.81); file the upstream request link in
  the PR.

### C1. Kernel cloud tiers, local exec args and gates (high)

- Migration 0117: `devices.tier text NULL CHECK (tier IN ('strict','dev','open'))`;
  `device_instances.instance_limits jsonb NULL` (or on the table that holds the fenced instance
  row; the implementer picks the table the fenced create writes).
- `SandboxService.deviceLimits(device)` via `effectiveSandboxPolicy`; at create write
  `{ tier, egress }`; on use compare (NULL = `{ tier: "strict" }`), call `update` under the exclusive
  lease, on `"recreate"` / no `update` destroy + create on the same files with the recreated
  notice; a provider with `limitsApplyAt: "fileSystem"` and no `update` keeps the record unchanged
  and the device view says `pendingFilesReset`.
- `sandbox-fake`: `update` + `limitsApplyAt` toggles for tests; records limits.
- Local provider exec args: `limits` for the ceiling, `defaultTier`, `devHosts`; unattended cap
  (`runs.scheduled_task_run_id` without a `tier:open` task grant → `limits.tier` ≤ `dev`).
- Unsandboxed gate: a device whose summary reports `isolation: "none"` while `allowUnsandboxed`
  is false (or the ceiling is below `open`, or an unattended run without the grant) →
  `device.unsandboxed_not_allowed` (registered error code, fixed English text from spec §4.3),
  checked at each exec.
- Cloud unattended: effective `open` without the grant → sandbox tools fail with the note.
- Grant rules: `tier:open` grant key (refused `needs_admin` when the ceiling is below open).

### C2. Kernel device surfaces

- `PATCH /api/v1/orgs/:org/devices/:id` `tier` (owner only, cloud devices; null = follow);
  audit `device.tier_changed`; Platform exclusion with reason.
- Device views: `tier`, `effectiveTier`, `ceiling`, `cappedBy`, `pendingFilesReset`, local summary
  fields; `device-policy.service` sends `tier` / `isolation: "sandbox"`, audits.
- `device.isolation_reported` audit on hello when isolation changes.
- `device_paths` gains `tier` and `isolation` (payload + text line, spec §11.5); the change check
  includes them; idem key includes them; zero-drift fixture tests before and after
  (`reconstruct.test.ts`, `rename-compat.test.ts`) plus a new case.

### D1. Web

- Device page 「沙箱级别」 section (spec §11.1): three cards, capped state, effective + reason,
  local summary facts, remoteGrants hint, open confirm (reuse `OpenNetworkDialog`), unsandboxed row
  (local command + copy, 「恢复沙箱」), cloud `pendingFilesReset` / 「下次使用时生效，文件保留」.
- Org settings 「沙箱级别」 section (spec §11.2), dev hosts disclosure under the allowlist.
- Device list / picker badges (开放 warn, 不使用沙箱 danger).
- i18n zh / en, `check:web-ui`, `check:i18n`, jsdom tests; visual baselines and the reference set
  are rendered by the workflows in task E.

### E. Final

- Whole-branch review on the most capable model; `pnpm verify`; push; PR into
  `docs/sandbox-dev-tiers` with `Refs #190`; run `gh workflow run 397190212 --ref main -f
  branch=feat/sandbox-tiers-p1` (reference-update) and `388429628` (visual-update), then an empty
  `ci:` commit; CI green.

## Phase 2 (capybara-hq/plugins, `feat/sandbox-tiers-p2`)

Follow that repository's AGENTS.md, skills (`writing-sandbox-providers`) and worktree flow; bump
its `@capybara-hq/plugin-sdk` to the phase 1 version (prerelease from the stacked branch, or a
workspace link, per that repo's rules).

| Task | Files | Risk |
|---|---|---|
| P2-1 image | `plugins/sandbox-docker/image/Dockerfile`: Node 22 LTS (checksum-pinned), corepack + pnpm / yarn, `openssh-client`, `netcat-openbsd`, `socat`, `build-essential`, `pkg-config`, Chromium runtime libs, `fonts-liberation`, `fonts-noto-cjk`, cache env (spec §8) | normal |
| P2-2 egress proxy | `egress-proxy/proxy.mjs`: `MODE=strict|dev|open`; dev: CONNECT any port for allowed hosts; SOCKS5 listener on 1080 with the same host and resolved-address checks; open: any public host; tests | **high** |
| P2-3 sandbox-docker | `src/provider.ts`, `src/index.ts`: tier → proxy mode, `ShmSize`, env (`ALL_PROXY`, `GRPC_PROXY`, `GIT_SSH_COMMAND`), `openEgress: off|proxy|direct` replacing `allowOpenEgress`, `update` (recreate the proxy for mode / host changes, `"recreate"` for shm), labels, README | **high** |
| P2-4 sandbox-e2b | `src/provider.ts`, `src/index.ts`: allowOut per tier (`allowHosts` is final), `openEgress`, `limitsApplyAt: "fileSystem"`, `update` via `PUT /sandboxes/{id}/network` after resume, README | normal |
| P2-5 core bootstrap bump | core `packages/kernel/bootstrap.json` `marketplace.commit` and versions, `docker/compose*.yaml` git contexts (`check:bootstrap`) after the plugins PR has a commit | normal |

## Phase 3 (later, not planned here)

- srt: Chromium mach services (multi-process headless), a localhost port filter replacing the
  proxy guard's downgrade, a structured violation field; upstream first.
- Linux OS-mode unix sockets with masked host daemon sockets, if the phase 1 spike does not pass.
- Docker device mode behind the plugin's egress proxy image (domain filter; then `D` counts there).
- Per-domain asks for cloud devices (refusal reports from the Docker egress proxy; device layer on
  cloud devices).
