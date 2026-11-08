# Devices Rename Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. In this repository, run it through the `wave-planned-subagent-development` skill.

**Goal:** The word "environment" disappears from Capybara: what people pick is a device (cloud or local), in the UI, the API, the data, the code and the docs, with no behaviour change.

**Architecture:** One kernel migration renames tables, columns, values and the log event. The kernel's `environments/` module becomes `devices/`, and today's `devices/` (local-device plumbing) becomes `local-devices/`. Routes, error codes, Platform ops, config keys, IM command and model-visible text follow. The web moves `/environments` to `/devices`, and copy says 设备 / device. A check keeps 环境 out of zh UI copy.

**Tech Stack:** TypeScript, NestJS kernel, Kysely/PostgreSQL, Next web app, vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-07-environments-design.md` §15 (the vocabulary table and the names in code and data are binding).

## Global Constraints

- **No behaviour change.** Every renamed path keeps its tests. A test changes only in names and strings, never in what it asserts.
- **Vocabulary per spec §15.1:**
  - device 设备; cloud device 云端设备; local device 本地设备; 个人设备 / "Personal".
  - zh UI says 设备 for this concept. 环境 stays allowed for unrelated meanings (e.g. 环境变量); no automated check (maintainer's call).
- **Names per spec §15.2, verbatim:**
  - Tables: `devices`, `device_instances`, `device_defaults`, `device_machines`.
  - Columns: `device_id`.
  - `source` values: `cloud` | `local`.
  - Provider: `@local`.
  - Log event: `device_paths`.
  - Error codes: `device.*` for the former `environment.*`, and `device_sign_in.*` for the sign-in flow's former `device.*` (`authorization_pending`, `slow_down`, `expired`, `denied`, `code_invalid`, `unavailable`). `device.credential_invalid` stays.
  - Config: `devices.maxPersonal` and `devices.local.*`.
  - Platform ops: `devices.*`.
  - HTTP: `orgs/:orgId/devices…`.
  - Web: `/devices`, `/devices/[id]`; the sign-in confirmation `/device` → `/devices/link` (also the kernel's `verificationUri`).
  - IM (every channel): `/device`.
  - Sandbox resource names: `cap-env-<id>` → `cap-device-<id>` (old cloud files orphaned by decision).
- **Kept, never renamed:**
  - `sandbox@2` and the SDK device protocol;
  - the routes `api/v1/device/*` and `GET /device/connect`;
  - the package and binary name `capybara-device`;
  - applied migrations 0088/0093/0094 (immutable), CHANGELOG files, and spec §1-§14 (history);
  - "environment variable" (环境变量) wherever it means that.
- **Migration** `0095_devices_rename.sql` uses `ALTER TABLE … RENAME` and `ALTER INDEX … RENAME`, with `IF EXISTS` where Postgres supports it, plus `UPDATE`s for `source`, `provider` and the event type. Destructive statements carry the exemption comment the writing-migrations skill requires.
- **Replay:** run the zero-drift tests (`reconstruct.test.ts`, `rename-compat.test.ts`) before and after Task 3. The event rename is a log data change, not a new model input, so no `DriftReason`.
- **Repository rules:**
  - Multi-replica and kernel conventions hold (`pnpm check:kernel-conventions`).
  - Every route keeps its Platform operation or exclusion (`pnpm check:platform-ops`).
  - i18n zh/en parity holds (`pnpm check:i18n`), and so do the web rules (`pnpm check:web-ui`).
- **Changesets:** kernel, web/capybara, plugin-sdk (comments only → patch), device.
- **Commits:** Conventional Commits, body lines ≤ 100 characters, trailer exactly `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **A deployment upgraded across 0095** must keep every device, instance, default, machine, conversation binding and background task. Cloud files under the old `cap-env-` names are orphaned by decision; new instances use `cap-device-`. → Task 1 test "0095 keeps every row and its links".
2. **Old conversation logs that hold `environment_paths`** must render identically after the rename. → Task 1 (migration updates rows) and Task 3 (the zero-drift tests plus a test that a migrated `device_paths` row renders the same line).
3. **A local device already signed in before the upgrade** keeps connecting: its credential hash row moves tables, and `@device` rows become `@local`. → Task 1 test, plus Task 2's gateway tests on migrated data.
4. **`capybara-device` 0.1.0-rc.1 talking to the renamed kernel:** the program parses the sign-in error codes. Program and kernel must agree after the rename. An old rc.1 program is out of support before 0.1.0, but the new program must handle the new codes. → Task 4 tests against the renamed codes.
5. **Leftover vocabulary:** "environment" in model-visible text, or 环境 in zh copy for this concept. → Task 3 asserts tool errors say "device"; Task 5 reports a final grep of the remaining 环境 / environment hits in apps/web with a reason for each.

---

### Task 1: Migration, schema types, config, error codes (risk: high, migration)

**Files:**
- Create: `packages/kernel/src/migrations/0095_devices_rename.sql`
- Modify: `packages/kernel/src/db/kernel-schema.ts`, `packages/kernel/src/config/schema.ts`, `packages/kernel/src/config/docs.ts`, `packages/kernel/src/infra/config/kernel-config.service.ts` (hot appliers), `packages/kernel/src/errors.ts`, `docs/config.md` (regenerated), `apps/web/messages/{zh,en}.json` (the `errors.*` keys only)
- Test: `packages/kernel/test/migrations/0095.test.ts`; config tests renamed

**Interfaces:**
- Produces: the names of spec §15.2 for tables, columns, values, the event type, config keys and error codes. Kysely types `devices`, `device_instances`, `device_defaults`, `device_machines`.

- [ ] Step 1: Write the test `0095 keeps every row and its links`.
  - Seed at 0094: one personal cloud environment with an instance, a default, a conversation, a background task, a local environment with a machine (provider `@device`), and an `environment_paths` event.
  - Migrate, then assert the same counts and ids under the new names, `source` `local`, provider `@local`, and event type `device_paths`.
  - Assert that a rerun of 0095 is a no-op.
- [ ] Step 2: Run it. It fails.
- [ ] Step 3: Write 0095, rename the Kysely types, the config keys (with descriptions) and the error codes, and add the web `errors.*` copy for the renamed codes.
- [ ] Step 4: Run the 0095 test, the config tests, `pnpm gen:config-docs`, `pnpm check:migrations` and `pnpm check:i18n`. All pass.
- [ ] Step 5: Commit `refactor(kernel)!: devices rename — migration, schema, config, error codes`. The kernel does not compile until Task 2; commit with `--no-verify` only if a hook blocks, and say so in the report.

### Task 2: Kernel modules, routes, Platform ops, IM (risk: high)

**Files:** `git mv packages/kernel/src/devices packages/kernel/src/local-devices`, then `git mv packages/kernel/src/environments packages/kernel/src/devices`. Every importer is updated, along with the controllers, DTOs, schemas, `platform/ops/environments.ops.ts` → `devices.ops.ts`, `platform/exclusions.ts`, `channels/inbound.ts` and `phrases.ts` (`/device`), `sandbox/*` (the file-system name `cap-device-<id>` in `sandbox.service.ts` and the prefix parsed by the local device provider, R1), `background/*`, `kernel.module.ts`, `roles/*`, the sign-in `verificationUri` → `<web>/devices/link`, and the tests under `packages/kernel/test/environments` → `test/devices` and `test/devices` → `test/local-devices`.

**Interfaces:**
- Consumes: Task 1 names.
- Produces: `DevicesService`, `DeviceView`, `DeviceList`, `DeviceAccess`, `ConversationDevices`, `LocalDeviceRelay`, `LocalDeviceGateway`, `LocalDeviceProvider`, `LOCAL_PROVIDER = "@local"`, routes under `api/v1/orgs/:orgId/devices`, and Platform ops `devices.*`.

- [ ] Step 1: Do the renames with `git mv`, so history follows the files.
- [ ] Step 2: Rename the identifiers, routes, ops, IM command and phrases (zh 设备 / en device).
- [ ] Step 3: Run the kernel test folders (devices, local-devices, sandbox, background, tools, channels, platform, identity, lifecycle), `pnpm typecheck`, `check:kernel-conventions` and `check:platform-ops`. All pass with tests changed only in names.
- [ ] Step 4: Commit `refactor(kernel)!: devices and local-devices modules, routes and ops`.

### Task 3: Model-visible text and replay (risk: normal, replay-sensitive)

**Files:**
- Modify: `packages/kernel/src/tools/builtins/sandbox/*` (tool error texts, the paths line), `packages/kernel/src/runtime/context/build.ts` (event type), `packages/kernel/src/evals/*` (event kind), `packages/kernel/src/conversations/event-log.ts`
- Test: `environment-paths.test.ts` → `device-paths.test.ts`

- [ ] Step 1: Run the zero-drift tests before the change. They pass.
- [ ] Step 2: Write `a migrated device_paths row renders the same system line` and `tool errors name the device, never an environment`. The second asserts that the texts for offline, files lost, outdated program and revoked contain "device" and not "environment".
- [ ] Step 3: Implement the change: the event type `device_paths`, and the texts per spec §15.2.
- [ ] Step 4: Run the zero-drift tests, the tools, runtime and evals folders, and `check:tool-design`. All pass.
- [ ] Step 5: Commit `refactor(kernel): model-visible text says device`.

### Task 4: SDK comments and the device program (risk: normal)

**Files:** `packages/plugin-sdk/src/*` (comments that say environment), `packages/plugin-sdk/api/*` (regenerated if doc comments are included), `packages/device/src/**` (sign-in error codes → `device_sign_in.*`, messages "environment" → "device"), `packages/device/test/**`, `packages/device/README.md`

- [ ] Step 1: Update the tests to the new codes and messages. They fail.
- [ ] Step 2: Implement.
- [ ] Step 3: Run `pnpm exec vitest run packages/device packages/plugin-sdk`, `pnpm gen:sdk-api` and `check:sdk-api`. All pass.
- [ ] Step 4: Commit `refactor(device): device_sign_in codes; device vocabulary`.

### Task 5: Web (risk: normal)

**Files:**
- `git mv apps/web/src/app/(app)/environments apps/web/src/app/(app)/devices`
- `apps/web/src/lib/environments.ts` → `devices.ts`, and `lib/query/environments.ts` → `query/devices.ts`
- components: `EnvironmentCreateDialog` → `DeviceCreateDialog`, and the picker in `components/conversation/*`
- the route table, navigation, `apps/web/messages/{zh,en}.json`, tests, e2e specs
- the sign-in confirmation page `app/(auth)/device` → `/devices/link` (keep its sign-in redirect behaviour); the kernel's `verificationUri` (Task 2) points there

- [ ] Step 1: Do the renames and the copy (设备 / device; 新建设备 offers 云端 / 本地).
- [ ] Step 2: Run the web tests, `check:web-ui`, `check:i18n` and `typecheck`. All pass. Tests: `/environments` and `/device` give the app's 404; `/devices/link?code=…` confirms.
- [ ] Step 3: Report a final grep of 环境 / environment in apps/web with the reason for each remaining hit.
- [ ] Step 4: Commit `refactor(web)!: devices pages and copy`.

### Task 6: Docs and skills (risk: normal)

**Files:** `docs/**` (except spec §1-14, CHANGELOGs and applied migrations), `.agents/skills/**` (writing-sandbox-providers and others that say environment), `AGENTS.md`, `docs/architecture.md`, `docs/deploy/README.md`, `docs/development.md`, the two live checklists, `packages/device/README.md` if Task 4 left anything, and the agent docs (`pnpm gen:agent-docs`).

- [ ] Step 1: Edit.
- [ ] Step 2: Run `pnpm check` (agent docs, terms). It passes.
- [ ] Step 3: Commit `docs: devices vocabulary`.

### Task 7: Plugins repository docs (separate PR, after the core PR merges)

- In `capybara-hq/plugins`: the sandbox-docker and sandbox-e2b READMEs and its `writing-sandbox-providers` skill say device. Docs only, so no changeset.

---

## Execution notes

- Waves:
  - W1: Task 1, alone.
  - W2: Task 2, alone (it touches nearly every kernel file).
  - W3: Task 3 and Task 4 in parallel, disjoint files.
  - W4: Task 5 and Task 6 in parallel.
  - Task 7 runs after the merge.
  - Tasks 1 and 2 are reviewed alone on the most capable model.
- The branch does not build between Task 1 and Task 2. Review them as one package if that is simpler.
- After merge: release an rc, so that `capybara-device` and the kernel agree on `device_sign_in.*` on npm.
