# Device Providers Phase 4: Local Read Model and Per-Connection Project Reach

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task, layered with
> `wave-planned-subagent-development`. Steps use checkbox (`- [ ]`) syntax for tracking. Read the
> index `2026-11-21-device-provider.md` first: its Global Constraints and Shared interfaces apply
> here unchanged.

**Goal:** A local device's sandboxed work reads the whole machine minus a deny list (secret paths,
this program's state directory, every other connection's state and working directory) and writes
only in `writeRoots`, on macOS Seatbelt and Linux Landlock alike. Project reach becomes a
per-connection setting `machine | paths | workspace` with a `projectPaths` list, and refused
project paths come back to the kernel as `ProjectPathRefusedError`.

**Architecture:** The read rule lives in `capybara-device` (`packages/device/src/exec/`): one
pure read model (`read-model.ts`) turns the connection's policy, the scope's `projectRoot` /
`writeRoots` and the other connections into read roots plus a deny list. macOS keeps
`@anthropic-ai/sandbox-runtime`, which already denies inside an allowed region, so machine reach
drops the `/` read deny. Linux Landlock only grants, so machine reach carves the read roots around
every denied path (`linux-read-carve.ts`). `device-local` (plugins) only describes the reach and
maps the device's refusal code to `ProjectPathRefusedError` with fixed en / zh text.

**Tech Stack:** TypeScript (Node 22), vitest, `@anthropic-ai/sandbox-runtime` 0.0.81 (patched),
the SDK's Linux launcher (Landlock + seccomp broker, unchanged), `@capybara-hq/plugin-sdk`
`device-protocol` subpath.

**Spec:** `docs/superpowers/specs/2026-11-21-device-provider-design.md` §7.1, §7.2 (isolation),
§7.3, §6.1 (project paths), §13 (capybara-device tests).


## Reconciliation (index rulings; these win over the tasks below)

- R2: bump the protocol to 6 only if phase 5 has not already bumped it since the last `@capybara-hq/device` release; otherwise change 6 in place.
- R4: the kernel-facing code is `device.project_refused`.
- R10: Tasks 6 and 11 own denying other connections and the risk text (phase 5 Task 5 is dropped).
- R17: `device-local` paths in Task 13 follow what phase 2 created.

## Waves

Phase 5 owns `state.ts`, `cli.ts`, `args.ts`, `commands/`, `service/`, `control/`, `pid.ts` and
changes a shared file first (index). Tasks touching those start only after phase 5's change to
that file is on the branch this phase rebases onto.

| Wave | Tasks | Notes |
|---|---|---|
| 0 | 1 | only when `packages/device/src/connections.ts` does not exist yet (phase 5 not merged) |
| 1 | 2, 3, 4 | disjoint: SDK protocol / read model / Linux carve |
| 2 | 5 | `state.ts` policy format (after phase 5's `state.ts`) |
| 3 | 6 | the owner ceiling and intersection; review alone |
| 4 | 7, 8, 9 | macOS worker / Linux worker / browse refusal; 7 and 8 reviewed alone |
| 5 | 10, 11, 12 | owner report + wire narrowing / `ceiling` CLI / `policy` CLI |
| 6 | 13, 14 | `device-local` (after the SDK release carrying Task 2) / docs and changesets |

## Global Constraints

All of the index's Global Constraints, plus:

- Project reach values `machine` (default for a new connection) | `paths` | `workspace`; list key
  `projectPaths`; rank `workspace < paths < machine` (a higher rank is a widening).
- Writes only in `writeRoots`; the protected write chains (`macProtectedWriteDenies`,
  `protectedWriteTargets`), the mandatory write denies and the reserved staging prefix are
  unchanged.
- The deny list is computed fresh at every strict owner-ceiling read (every operation and every
  reconcile tick), never cached across operations.
- The SDK's Linux launcher bytes (`sandbox-linux-runtime-source.ts`) and the native helper bytes
  stay unchanged: changing them repins the `device-docker` image (`check:bootstrap`). Linux
  residual instead: a file directly inside a directory on the path to a denied one is unreadable,
  and such a directory cannot be listed.
- Docker mode is unchanged: the container sees only its mounts, so its ceiling is `workspace`
  with no `projectPaths` (`containerCeiling`).
- An escalated call (outside the sandbox) gets no deny list: it runs as the OS user.
- The device is untrusted to `device-local`: a refusal crosses the wire as a code, never as text
  the web shows.
- Device tests use a temporary `XDG_CONFIG_HOME` and `HOME`; never the real
  `~/.config/capybara-device`.
- Tests that start a real sandbox join `packages/device/test/os-tests.json`
  (`check:test-portfolio`, rule `test-portfolio-os-unlisted`).

## Review Focus

- A sandboxed command of connection A reading connection B's working directory or state on the
  same machine must fail, also with project reach `machine` and with a project directory that is
  a symlink into B (index line, owned here: Tasks 6, 7, 8, 9).
- A connection added while A runs a long background operation: A's next reconcile tick sees a
  longer deny list and revokes the operation (`grantStillHolds` compares the denied roots
  exactly) (Task 6).
- Another connection whose `credential.json` cannot be read: A's restricted work fails closed
  with an actionable message, never runs without B's working directory denied (Task 6).
- Linux, machine reach: a symlink or an unreadable entry in `~` must not fail the command (the
  carve skips it), and `~/.ssh` stays unreadable (Tasks 4, 8).
- `paths` reach with an empty `projectPaths`: reads only the device roots and tool directories;
  adding a project outside answers `project_refused` / `outside-reach` (Tasks 6, 9).

---

### Task 1: Minimal `listConnections` (only when phase 5 has not landed)

Skip this task when `packages/device/src/connections.ts` exists and exports `listConnections`.

**Files:**
- Create: `packages/device/src/connections.ts`
- Test: `packages/device/test/connections.test.ts`

**Interfaces:**
- Consumes: `stateDir(env?, home?)` and `readCredential(dir)` from `packages/device/src/state.ts`.
- Produces (the signature phase 5 also produces; phase 5 may add fields):

```ts
export interface ConnectionInfo {
  deviceId: string;
  /** `<stateDir()>/connections/<deviceId>` */
  stateDir: string;
  /** The working directory from its credential.json; null when that file cannot be read. */
  dir: string | null;
}
export function listConnections(env?: Record<string, string | undefined>, home?: string): ConnectionInfo[];
```

- [ ] **Step 1: Write the failing test** `connections.test.ts`, under a temp `XDG_CONFIG_HOME`:
  - `it("lists every connections/<id> with its working directory")`: two dirs with valid
    `credential.json` → `expect(listConnections(env, home).map((c) => c.deviceId).sort())
    .toEqual(["a", "b"])` and `dir` equals each credential's `dir`.
  - `it("an unreadable credential yields dir null, never a skipped entry")`: `b/credential.json`
    mode 0644 → entry `{ deviceId: "b", dir: null }` present.
  - `it("a flat legacy credential.json is not a connection")`: only `<root>/credential.json` →
    `[]`.
- [ ] **Step 2: Run** `pnpm exec vitest run packages/device/test/connections.test.ts` — expected
  FAIL: cannot find module `../src/connections.js`.
- [ ] **Step 3: Implement** `listConnections` in `connections.ts`: `readdirSync(join(stateDir(env,
  home), "connections"), { withFileTypes: true })` (missing dir → `[]`), directories only (no
  links), `readCredential` per entry inside try/catch → `dir: null` on any throw.
- [ ] **Step 4: Run** the same command — expected PASS.
- [ ] **Step 5: Commit**

```bash
git add packages/device/src/connections.ts packages/device/test/connections.test.ts
git commit -m "feat(device): list the connections of this machine

Co-Authored-By: Capybara <noreply@capybarahq.com>"
```

---

### Task 2: Protocol: project reach values and the `project_refused` outcome

**Files:**
- Modify: `packages/plugin-sdk/src/device-protocol.ts` (the subpath module phase 2 kept; today
  `DeviceOwnerCeiling` ~915-928, `DeviceOwnerCeilingNarrowing` ~934-940, the res error kinds
  ~1020-1036, `parseOwnerCeilingReport` ~1203-1232, `parseOwnerCeilingNarrowing` ~1240-1265, the
  `res ok:false` parser ~1483-1508, `DEVICE_PROTOCOL_VERSION`)
- Test: `packages/plugin-sdk/test/device-protocol.test.ts`
- Create: `.changeset/device-project-reach-sdk.md`
- Regenerate: `packages/plugin-sdk/api/*.api.md` (`pnpm gen:sdk-api`)

**Interfaces:**
- Produces:

```ts
export type DeviceProjectReach = "machine" | "paths" | "workspace";
export type DeviceProjectRefusal = "other-connection" | "outside-reach" | "denied";
// DeviceOwnerCeiling: `restrictedProjectReach` replaced by
readonly projectReach: DeviceProjectReach;
// DeviceOwnerCeilingNarrowing: `restrictedProjectReach?: "workspace"` replaced by
readonly projectReach?: "workspace";
// res ok:false error: kind gains "project_refused"; that kind (only) carries
refusal: DeviceProjectRefusal;
```

- [ ] **Step 1: Write the failing tests** in `device-protocol.test.ts`:
  - `it("parses an owner ceiling report with each project reach")`: for each of `machine`,
    `paths`, `workspace` → `parseOwnerCeilingReport({...base, projectReach}).projectReach` equals
    it; `restrictedProjectReach` (old key) → throws `DeviceProtocolError`; `projectReach:
    "os-user"` → throws.
  - `it("a narrowing may only set the project reach to workspace")`: `{ projectReach: "workspace"
    }` parses; `{ projectReach: "paths" }` and `{ projectReach: "machine" }` throw "may only
    narrow".
  - `it("a project_refused outcome carries a refusal code")`: a device frame `{ type: "res", id,
    ok: false, error: { kind: "project_refused", message: "x", refusal: "other-connection" } }`
    parses with `error.refusal === "other-connection"`; `refusal: "nope"` throws; `refusal` on
    kind `denied` throws; `project_refused` without `refusal` throws.
  - `it("the protocol version is the one this phase speaks")`: `DEVICE_PROTOCOL_VERSION` equals
    phase 2's value + 1 (6), unless no SDK release carried phase 2's version yet (then unchanged);
    write the literal the branch ends with. If phase 5 bumped already and that bump is
    unreleased, keep phase 5's number.
- [ ] **Step 2: Run** `pnpm exec vitest run packages/plugin-sdk/test/device-protocol.test.ts` —
  expected FAIL on `projectReach` (unknown key / undefined).
- [ ] **Step 3: Implement** the types and parsers above in `device-protocol.ts` (strict keys:
  `refusal` allowed only with `project_refused`). Replace every `restrictedProjectReach` in the
  file; no alias for the old key.
- [ ] **Step 4: Run** the test file, then `pnpm typecheck` — expected PASS for the test; fix any
  core reader of the old field the typecheck names by switching to `projectReach` (phase 2 should
  have left none outside `packages/device`, which Tasks 6, 10 and 11 change).
- [ ] **Step 5: Run** `pnpm gen:sdk-api`; write the changeset (`"@capybara-hq/plugin-sdk":
  minor`, "device protocol: per-connection project reach and project refusals").
- [ ] **Step 6: Commit**

```bash
git add packages/plugin-sdk .changeset/device-project-reach-sdk.md
git commit -m "feat(plugin-sdk): project reach machine|paths|workspace and project refusals

Co-Authored-By: Capybara <noreply@capybarahq.com>"
```

---

### Task 3: The local read model

**Files:**
- Create: `packages/device/src/exec/read-model.ts`
- Test: `packages/device/test/read-model.test.ts`

**Interfaces:**
- Consumes: `ConnectionInfo` (Task 1 / phase 5), `SandboxRoots` (SDK), `within`,
  `withCanonicalForms` from `exec/operation-types.ts`, `defaultWorkDir` from `state.ts`.
- Produces:

```ts
export type ProjectReach = DeviceProjectReach; // re-export of the SDK type (Task 2)
export const PROJECT_REACH_RANK: Readonly<Record<ProjectReach, number>>; // workspace 0, paths 1, machine 2
export function reachWidens(cur: ProjectReach, next: ProjectReach): boolean;

/** Every other connection's working directory (and on macOS its private temp parent). Throws
 *  SandboxScopeDeniedError naming connections/<id> when one has dir === null. */
export function otherConnectionDenies(input: {
  ownDeviceId: string;
  connections: readonly ConnectionInfo[];
  /** macOS user temp dir; adds join(base, privateTempParentName(id)) per other connection. */
  macTempBase?: string;
}): string[];
export function privateTempParentName(deviceId: string): string; // "capybara-op-<deviceId>"

/** What one sandboxed operation may read. machine: ["/"]; paths: projectPaths ∪ roots ∪ writeRoots;
 *  workspace: roots ∪ writeRoots. Deduplicated, normalized. */
export function readRootsFor(input: {
  reach: ProjectReach;
  projectPaths: readonly string[];
  roots: Readonly<SandboxRoots>;
  writeRoots: readonly string[];
}): string[];

/** null when allowed; else the refusal code. `path` is checked in its given and canonical forms. */
export function projectPathRefusal(
  path: string,
  input: {
    reach: ProjectReach;
    projectPaths: readonly string[];
    roots: Readonly<SandboxRoots>;
    secretAndStateDenies: readonly string[];
    otherConnectionDenies: readonly string[];
  },
): DeviceProjectRefusal | null;
```

- [ ] **Step 1: Write the failing tests** in `read-model.test.ts` (temp dirs for the symlink case):
  - `it("ranks workspace < paths < machine")`: `reachWidens("workspace","paths")` true,
    `reachWidens("machine","paths")` false, `reachWidens("paths","paths")` false.
  - `it("machine reach reads the whole machine")`: `readRootsFor({reach:"machine",…})` →
    `["/"]`.
  - `it("paths reach reads the listed paths, the device roots and the write roots only")`:
    expect exactly `[...projectPaths, roots.workspace, roots.skills, roots.tmp, ...writeRoots]`
    deduped; empty `projectPaths` → the roots and write roots only.
  - `it("workspace reach reads the device roots and write roots")`.
  - `it("denies every other connection's working directory, never its own")`: connections
    `a`(own), `b` → `["<b.dir>"]`; with `macTempBase: "/T"` adds `"/T/capybara-op-b"`.
  - `it("fails closed on a connection whose credential cannot be read")`: `dir: null` → throws
    `SandboxScopeDeniedError` whose message contains `connections/b` and `capybara-device logout
    -c b`.
  - `it("refuses another connection's directory, also through a symlink")`: `projectPathRefusal`
    of `<b.dir>/repo` → `"other-connection"`; of a symlink `<tmp>/link -> <b.dir>` →
    `"other-connection"`; of `~/.ssh` → `"denied"`; under `paths` a path outside every listed
    path and root → `"outside-reach"`; under `workspace` a path outside roots → `"outside-reach"`;
    under `machine` `/opt/x` → `null`; a path that contains B's directory (`~`) under machine →
    `null` (the sandbox denies inside it).
- [ ] **Step 2: Run** `pnpm exec vitest run packages/device/test/read-model.test.ts` — expected
  FAIL: module not found.
- [ ] **Step 3: Implement** the functions above in `read-model.ts`; `projectPathRefusal` checks
  `withCanonicalForms([path])` against `withCanonicalForms(denies)` with `within` (inside or
  equal), other connections first, then secret/state, then reach.
- [ ] **Step 4: Run** the same command — expected PASS.
- [ ] **Step 5: Commit**

```bash
git add packages/device/src/exec/read-model.ts packages/device/test/read-model.test.ts
git commit -m "feat(device): local read model with project reach and other-connection denies

Co-Authored-By: Capybara <noreply@capybarahq.com>"
```

---

### Task 4: Linux read carve

**Files:**
- Create: `packages/device/src/exec/linux-read-carve.ts`
- Test: `packages/device/test/linux-read-carve.test.ts`

**Interfaces:**
- Produces:

```ts
export const MAX_CARVED_READ_ROOTS = 4096;
/** Landlock only grants: each read root containing a denied path is replaced by the real
 *  directories beneath it that lie off every denied path, recursively along the denied paths'
 *  ancestors. Symbolic links, non-directories and entries the process cannot open (R_OK|X_OK)
 *  are skipped; a root inside a denied path is dropped; a root clear of every denied path is kept
 *  as is. Throws SandboxScopeDeniedError above MAX_CARVED_READ_ROOTS. */
export function carveReadRoots(
  readRoots: readonly string[],
  denied: readonly string[],
  fs?: { readdir(path: string): string[]; lstat(path: string): { isDirectory(): boolean; isSymbolicLink(): boolean }; canOpen(path: string): boolean },
): string[];
```

- [ ] **Step 1: Write the failing tests** with a temp tree `R/{a/{x,y},b,c.txt,link->a}` and
  denied `R/a/x`:
  - `it("replaces a root holding a denied path with the directories beside it")`:
    `carveReadRoots([R], [R+"/a/x"])` sorted equals `[R+"/a/y", R+"/b"]` (no `c.txt`, no `link`,
    no `R`, no `R/a`).
  - `it("keeps a root clear of every denied path and drops one inside a denied path")`:
    `carveReadRoots([R+"/b", R+"/a/x/deep"], [R+"/a/x"])` → `[R+"/b"]`.
  - `it("carves / around the denied paths")` with an injected fs whose `/` holds `home, usr` and
    `/home/u` holds `.ssh, src`: denied `/home/u/.ssh` → `["/home/u/src", "/usr"]`.
  - `it("skips entries it cannot open")`: injected `canOpen` false for `R/b` → no `R/b`.
  - `it("refuses more than MAX_CARVED_READ_ROOTS roots")`: injected dir with 4097 subdirs →
    throws `SandboxScopeDeniedError` mentioning `paths` reach.
- [ ] **Step 2: Run** `pnpm exec vitest run packages/device/test/linux-read-carve.test.ts` —
  expected FAIL: module not found.
- [ ] **Step 3: Implement** `carveReadRoots` (default fs from `node:fs` sync calls, `accessSync`
  for `canOpen`); only canonical denied paths matter (the real tree is walked), so pass the
  `withCanonicalForms` list as given.
- [ ] **Step 4: Run** — expected PASS.
- [ ] **Step 5: Commit**

```bash
git add packages/device/src/exec/linux-read-carve.ts packages/device/test/linux-read-carve.test.ts
git commit -m "feat(device): carve Linux read roots around denied paths

Co-Authored-By: Capybara <noreply@capybarahq.com>"
```

---

### Task 5: Policy format: `projectReach` and `projectPaths`

Starts after phase 5's change to `state.ts`.

**Files:**
- Modify: `packages/device/src/state.ts` (today: `RestrictedProjectReach` ~45, `OwnerCeilingPolicy`
  ~54-58, `POLICY_VERSION` ~61, `Policy` ~72-83, `FULL_OWNER_CEILING` / `SANDBOX_OWNER_CEILING` /
  `ownerCeilingOfMode` / `convertV2OwnerCeiling` ~86-121, `DEFAULT_POLICY` ~126-136,
  `MISSING_POLICY_OWNER_CEILING` ~144-148, `readPolicyFile` ~254-390, `writePolicy` ~393-418,
  `convertPolicyFile` ~429-441)
- Test: `packages/device/test/owner-ceiling.test.ts` (describe "version-3 local owner policy" →
  rename "local owner policy format")

**Interfaces:**
- Consumes: `ProjectReach` (Task 3).
- Produces:

```ts
export const POLICY_VERSION = 4;
export interface OwnerCeilingPolicy { outsideSandbox: boolean; network: DeviceNetworkMode; projectReach: ProjectReach }
export interface Policy { /* as phase 5 left it */ projectPaths: string[] }
// DEFAULT_POLICY.ownerCeiling.projectReach === "machine"; DEFAULT_POLICY.projectPaths === []
// MISSING_POLICY_OWNER_CEILING.projectReach === "workspace"
```

`network` stays as phases 2 and 3 left it (the machine's narrowing). `RestrictedProjectReach`,
`FULL_OWNER_CEILING`, `SANDBOX_OWNER_CEILING`, `ownerCeilingOfMode`, `convertV2OwnerCeiling`,
`LEGACY_POLICY_KEYS` and the `legacy` / `converted` paths go if phase 5 kept them (no
compatibility).

- [ ] **Step 1: Write the failing tests** in `owner-ceiling.test.ts`:
  - `it("a new policy reads the whole machine and lists no project paths")`:
    `DEFAULT_POLICY.ownerCeiling.projectReach === "machine"`, `projectPaths` `[]`.
  - `it("a missing policy file reads as the workspace reach")`.
  - `it("round-trips projectReach and projectPaths, keeping unknown keys")`: `writePolicy` then
    `readPolicyFile` returns the same `projectReach: "paths"` and `projectPaths: ["/src/a"]`; an
    unknown key survives.
  - `it("refuses another version, a bad reach and relative or unnormalized project paths")`:
    `version: 3` → throws naming the file and `capybara-device ceiling set`; `projectReach:
    "os-user"` → throws; `projectPaths: ["rel"]`, `["/a/../b"]`, `["/a/"]` → throw.
  - Delete the tests of the version 2 / pre-`mode` conversion.
- [ ] **Step 2: Run** `pnpm exec vitest run packages/device/test/owner-ceiling.test.ts` — expected
  FAIL on `projectReach` undefined.
- [ ] **Step 3: Implement** the format in `state.ts`: `readPolicyFile` accepts only `version: 4`,
  `ownerCeiling` keys `outsideSandbox`, `network`, `projectReach`; `projectPaths` absolute,
  `normalize(p) === p`, no trailing slash, at most 100 entries.
- [ ] **Step 4: Run** the test file and `pnpm --filter @capybara-hq/device exec tsc --noEmit` —
  test PASS; the compile errors left are the readers Tasks 6, 10-12 change (note them, do not fix
  here beyond what keeps this task's test file compiling).
- [ ] **Step 5: Commit**

```bash
git add packages/device/src/state.ts packages/device/test/owner-ceiling.test.ts
git commit -m "feat(device)!: policy format 4 with per-connection project reach and paths

Co-Authored-By: Capybara <noreply@capybarahq.com>"
```

---

### Task 6: Owner ceiling: project reach and deny other connections [review alone, most capable model]

**Files:**
- Modify: `packages/device/src/exec/operation-types.ts` (`DeviceOwnerCeiling` 24-35,
  `LocalOperationGrant` 41-56, `readStrictOwnerCeilingSync` 75-120, `checkRoots` 144-178,
  `intersectOperation` 199-277)
- Modify: `packages/device/src/exec/docker-operations.ts:190-202` (`containerCeiling`)
- Test: `packages/device/test/operation-ceilings.test.ts`, `packages/device/test/linux-backend-selection.test.ts:215-235`

**Interfaces:**
- Consumes: Task 3 (`readRootsFor`, `otherConnectionDenies`, `projectPathRefusal`), Task 5
  (`Policy.projectPaths`, `ownerCeiling.projectReach`), `listConnections()` (Task 1 / phase 5),
  `stateDir()` (state.ts, the program root holding `machine.json` and `connections/`), the scope
  `filesystem: { kind: "scoped"; projectRoot: string | null; writeRoots: string[] }` (index,
  phase 1).
- Produces:

```ts
export interface DeviceOwnerCeiling {
  readonly revision: string;
  readonly outsideSandbox: boolean;
  readonly network: DeviceNetworkMode;
  readonly allowedDomains: readonly string[];
  readonly roots: Readonly<SandboxRoots>;
  readonly projectReach: ProjectReach;
  /** Canonical (realpath) forms of Policy.projectPaths that exist. */
  readonly projectPaths: readonly string[];
  /** Secret paths + the program state root, canonical forms included. */
  readonly secretAndStateDenies: readonly string[];
  /** Other connections' working dirs (+ macOS private temp parents), canonical forms included. */
  readonly otherConnectionDenies: readonly string[];
  /** secretAndStateDenies ∪ otherConnectionDenies: what every sandboxed grant denies. */
  readonly restrictedDeniedReadRoots: readonly string[];
  readonly preparation: Readonly<{ skillsRoot: string; attachmentsBase: string }>;
}
export function readStrictOwnerCeilingSync(input: {
  stateDir: string; deviceId: string; dir: string; home?: string;
  /** default stateDir() */ stateRoot?: string;
  /** default listConnections */ connections?: () => readonly ConnectionInfo[];
  /** darwin default: the user temp dir */ macTempBase?: string;
}): DeviceOwnerCeiling;
// LocalOperationGrant keeps its fields; readRoots now comes from readRootsFor, never the scope.
```

- [ ] **Step 1: Write the failing tests** in `operation-ceilings.test.ts` (temp `HOME`,
  `XDG_CONFIG_HOME`, injected `connections`):
  - `it("machine reach grants / and denies secrets, the state root and other connections")`:
    `intersectOperation(scope{projectRoot: P, writeRoots:[P]}, ceiling, authority)` →
    `readRoots` `["/"]`, `deniedReadRoots` contains `<home>/.ssh`, the state root, `<b.dir>`, and
    not the own `dir`.
  - `it("the revision changes when a connection is added or removed")`: two reads with
    connections `[a]` then `[a, b]` → different `revision`; `grantStillHolds(oldGrant, newGrant)`
    is `false`.
  - `it("fails closed when another connection's credential cannot be read")`: `dir: null` →
    `readStrictOwnerCeilingSync` throws `SandboxScopeDeniedError` (message names `connections/b`).
  - `it("paths reach reads only the listed paths, refusing a project root outside them")`:
    policy `projectReach: "paths", projectPaths: [L]`; projectRoot `L/repo` → `readRoots`
    contains `L`, not `/`; projectRoot `/elsewhere` → throws `SandboxScopeDeniedError` whose
    message says the path is outside the connection's project reach and names `capybara-device
    policy add projectPaths`.
  - `it("refuses a project root or write root in another connection's directory")`: projectRoot
    `<b.dir>/x` → throws; a symlink to `<b.dir>` as projectRoot → throws.
  - `it("workspace reach keeps today's workspace refusal")`: replaces the old "allows outside
    projects only under independent OS-user reach" test (`os-user` → `machine`).
  - `it("an escalated call gets no deny list")`: unchanged expectation of the existing escalated
    test (`deniedReadRoots: []`, `readRoots: ["/"]`).
  - In `linux-backend-selection.test.ts` "maps the owner's ceiling to the container's mounted
    roots": input with `projectReach: "machine", projectPaths: ["/src"]` and a non-empty
    `otherConnectionDenies` → mapped `projectReach: "workspace"`, `projectPaths: []`,
    `restrictedDeniedReadRoots: []`.
- [ ] **Step 2: Run** `pnpm exec vitest run packages/device/test/operation-ceilings.test.ts
  packages/device/test/linux-backend-selection.test.ts` — expected FAIL (`projectReach`
  undefined, readRoots taken from the scope).
- [ ] **Step 3: Implement** in `operation-types.ts`: `readStrictOwnerCeilingSync` adds
  `resolve(stateRoot)` (not only the connection's directory) to the state denies, calls
  `connections()` on every read, includes `projectReach`, the canonical `projectPaths` and
  `otherConnectionDenies` in the `digest` behind `revision`; `checkRoots(writeRoots, ceiling)`
  refuses a write root inside any denied root, outside the reach (`paths`: listed paths or roots;
  `workspace`: roots) or in a runtime / socket directory, as today; `intersectOperation` checks
  `projectRoot` with `projectPathRefusal` (non-null → `SandboxScopeDeniedError` with the refusal's
  English text) and sets `readRoots = readRootsFor(...)`. In `docker-operations.ts`
  `containerCeiling` sets `projectReach: "workspace"`, `projectPaths: []`, both deny lists `[]`.
- [ ] **Step 4: Run** the same command — expected PASS. Then `pnpm exec vitest run
  packages/device/test/owner-ceiling.test.ts packages/device/test/mac-operation-backend.test.ts`
  — expected PASS (fix fixtures that built `DeviceOwnerCeiling` by hand).
- [ ] **Step 5: Commit**

```bash
git add packages/device/src/exec/operation-types.ts packages/device/src/exec/docker-operations.ts packages/device/test
git commit -m "feat(device): per-connection project reach and other-connection denies in the owner ceiling

Co-Authored-By: Capybara <noreply@capybarahq.com>"
```

---

### Task 7: macOS: whole-machine reads under Seatbelt [review alone, most capable model]

**Files:**
- Modify: `packages/device/src/exec/mac-read-policy.ts:77-117` (add `macReadConfig`)
- Modify: `packages/device/src/exec/operation-worker.ts` (private temp ~585-610 and ~775-784; the
  read config ~797-831 and `denyRead` ~871)
- Modify: `packages/device/src/exec/mac-self-check.ts:95-140` (a machine-reach probe)
- Test: `packages/device/test/mac-read-policy.test.ts` (unit), `packages/device/test/mac-read-scope.test.ts` (real OS, already in `os-tests.json`), `packages/device/test/mac-self-check.test.ts`

**Interfaces:**
- Consumes: `LocalOperationGrant` (Task 6: `readRoots` `["/"]` means machine reach),
  `privateTempParentName` (Task 3).
- Produces:

```ts
/** The read part of the runtime config. machine (grant.readRoots includes "/"): denyRead = the
 *  denied roots only, allowRead = [], allowReadExact = only `exact` (the staged helper, the Java
 *  agent, pinned native components: they live in the denied state directory). Otherwise today's
 *  ["/", ...denied] plus macReadAllows. */
export function macReadConfig(input: {
  readRoots: readonly string[];
  exact: readonly string[];
  deniedReadRoots: readonly string[];
  userTempDir?: string;
  isSymlink?: (path: string) => boolean;
}): { denyRead: string[]; allowRead: string[]; allowReadExact: string[] };
```

- [ ] **Step 1: Write the failing unit tests** in `mac-read-policy.test.ts`:
  - `it("machine reach denies only the denied roots and re-allows nothing inside them but the staged files")`:
    `macReadConfig({ readRoots: ["/"], exact: [H], deniedReadRoots: [S, B] })` →
    `{ denyRead: [S, B], allowRead: [], allowReadExact: [H] }`.
  - `it("other reaches keep the deny-from-root model")`: `readRoots: [P]` → `denyRead[0] === "/"`,
    `allowRead` contains `P` and `/usr`.
- [ ] **Step 2: Write the failing real-OS tests** in `mac-read-scope.test.ts` (darwin only, as
  the file does; temp dirs `A` own, `B` other connection's working dir with `B/secret`, `S` state
  root with `S/connections/b/credential.json`, `U` unrelated with `U/file`, link `A/link -> B`):
  - `it("machine reach reads an unrelated file but not another connection's directory or state")`:
    grant `readRoots: ["/"], writeRoots: [A], deniedReadRoots: [S, B]`; `cat U/file` exits 0;
    `cat B/secret`, `cat A/link/secret`, `cat S/connections/b/credential.json`, `ls B` each fail;
    `: > U/new` fails (writes only in write roots).
  - `it("a private temp lives under this device's own parent")`: the command's `$TMPDIR` starts
    with `<userTemp>/capybara-op-<deviceId>/`.
- [ ] **Step 3: Run** `pnpm exec vitest run packages/device/test/mac-read-policy.test.ts
  packages/device/test/mac-read-scope.test.ts` — expected FAIL (`macReadConfig` missing; the
  machine-reach `cat U/file` is denied by `/`).
- [ ] **Step 4: Implement** `macReadConfig`; in `operation-worker.ts` build `filesystem.denyRead`
  / `allowRead` / `allowReadExact` from it, create private temps with `mkdtemp(join(base,
  privateTempParentName(scope.deviceId), "op-<pid>-"))` (parent 0700) and sweep only that parent;
  in `mac-self-check.ts` add one more probe: a machine-reach grant (`readRoots: ["/"]`) must read
  `unrelated` (positive control, exit 8 when it cannot) and must not read `hidden/secret`.
- [ ] **Step 5: Run** the two test files plus `packages/device/test/mac-self-check.test.ts` and
  `packages/device/test/mac-tool-homes.test.ts` — expected PASS on macOS (skipped elsewhere).
- [ ] **Step 6: Commit**

```bash
git add packages/device/src/exec/mac-read-policy.ts packages/device/src/exec/operation-worker.ts packages/device/src/exec/mac-self-check.ts packages/device/test
git commit -m "feat(device): macOS sandboxed reads cover the machine minus the deny list

Co-Authored-By: Capybara <noreply@capybarahq.com>"
```

---

### Task 8: Linux: whole-machine reads under Landlock [review alone, most capable model]

**Files:**
- Modify: `packages/device/src/exec/linux-operation-backend.ts:87-104` (`checkLinuxRestrictedGrant`)
- Modify: `packages/device/src/exec/linux-operation-worker.ts:216-236` (exec read roots)
- Test: `packages/device/test/linux-backend-selection.test.ts:176-191`, `packages/device/test/linux-operation-worker.test.ts`, `packages/device/test/linux-operation-backend.test.ts` (real Linux in Docker, already in `os-tests.json`)

**Interfaces:**
- Consumes: `carveReadRoots` (Task 4), `LocalOperationGrant` (Task 6).
- Produces: `checkLinuxRestrictedGrant(grant, kind)` now refuses only a **write** root containing a
  denied path (message unchanged in substance); exec read roots sent to the agent are
  `carveReadRoots([...grant.readRoots, ...toolHomes.readRoots, ...extra], grant.deniedReadRoots)`.
  Native requests keep `grant.readRoots` (the agent checks every resolved path against
  `denied`).

- [ ] **Step 1: Write the failing tests**:
  - `linux-backend-selection.test.ts`: rename "refuses an exec grant whose root contains an
    owner-denied path" → `it("refuses an exec write root that contains an owner-denied path, not a read root")`:
    `readRoots: ["/"], writeRoots: [P], deniedReadRoots: ["/home/u/.ssh"]` → no throw;
    `writeRoots: ["/home/u"]` → throws.
  - `linux-operation-worker.test.ts`: `it("a machine-reach exec sends carved read roots, never /")`:
    with the fake agent, the recorded request's `readRoots` does not contain `/` nor any path
    within a denied root, and contains the tool-home roots.
  - `linux-operation-backend.test.ts` (real Landlock): `it("machine reach reads beside a denied path, never inside it")`:
    in the container, `B/secret` denied, `U/sub/file` readable; `cat U/sub/file` exits 0, `cat
    B/secret` fails, a symlink in the carved parent does not fail the launch.
- [ ] **Step 2: Run** `pnpm exec vitest run packages/device/test/linux-backend-selection.test.ts
  packages/device/test/linux-operation-worker.test.ts packages/device/test/linux-operation-backend.test.ts`
  — expected FAIL (machine-reach grant refused; `/` sent).
- [ ] **Step 3: Implement** the two changes above.
- [ ] **Step 4: Run** the same command — expected PASS (the Docker-backed file skips without
  Docker, as it does today; run it where Docker is available).
- [ ] **Step 5: Commit**

```bash
git add packages/device/src/exec/linux-operation-backend.ts packages/device/src/exec/linux-operation-worker.ts packages/device/test
git commit -m "feat(device): Linux sandboxed reads carve the machine around the deny list

Co-Authored-By: Capybara <noreply@capybarahq.com>"
```

---

### Task 9: Browse refusals reach the deployment as `project_refused`

**Files:**
- Modify: `packages/device/src/exec/types.ts` (add the error)
- Modify: `packages/device/src/exec/mac-operation-backend.ts:300-333` (`auxiliaryGrant`, browse
  branch)
- Modify: `packages/device/src/server-ops.ts:620-688` (`errorKind` and the error response)
- Test: `packages/device/test/mac-operation-backend.test.ts`, `packages/device/test/server-ops.test.ts`

**Interfaces:**
- Consumes: `projectPathRefusal` (Task 3), `DeviceOwnerCeiling` (Task 6), `DeviceProjectRefusal`
  and the `project_refused` outcome (Task 2).
- Produces:

```ts
export class DeviceProjectRefusedError extends Error {
  constructor(readonly refusal: DeviceProjectRefusal, message: string);
}
// English messages (fixed):
// other-connection: "This directory belongs to another connection on this machine."
// outside-reach:    "This directory is outside this connection's project reach (capybara-device ceiling set --project-reach, capybara-device policy add projectPaths)."
// denied:           "This directory holds secrets or capybara-device's own state."
```

- [ ] **Step 1: Write the failing tests**:
  - `mac-operation-backend.test.ts`: `it("browsing another connection's directory is refused with its code")`:
    `backend.browse(h, scope{readRoots: [<b.dir>]})` rejects with `DeviceProjectRefusedError`
    whose `refusal === "other-connection"`; a symlink into `<b.dir>` likewise; under `paths` reach
    a root outside the list → `"outside-reach"`; under `machine` `/opt/x` resolves.
  - `server-ops.test.ts`: `it("answers a project refusal as project_refused with its code")`: a
    `browseList` that throws `DeviceProjectRefusedError("outside-reach", …)` → response
    `{ ok: false, error: { kind: "project_refused", refusal: "outside-reach", message } }`, and it
    passes the SDK frame parser (`parseDeviceFrame(..., "device")`).
- [ ] **Step 2: Run** `pnpm exec vitest run packages/device/test/mac-operation-backend.test.ts
  packages/device/test/server-ops.test.ts` — expected FAIL (`denied` returned).
- [ ] **Step 3: Implement**: `auxiliaryGrant` (browse) runs `projectPathRefusal` on each read root
  before `checkRoots` and throws `DeviceProjectRefusedError`; `errorKind` maps it first to
  `project_refused` and the error response adds `refusal`.
- [ ] **Step 4: Run** — expected PASS.
- [ ] **Step 5: Commit**

```bash
git add packages/device/src/exec/types.ts packages/device/src/exec/mac-operation-backend.ts packages/device/src/server-ops.ts packages/device/test
git commit -m "feat(device): answer refused project paths with a project_refused code

Co-Authored-By: Capybara <noreply@capybarahq.com>"
```

---

### Task 10: Owner report and wire narrowing carry the project reach

**Files:**
- Modify: `packages/device/src/owner-report.ts:95-115`
- Modify: `packages/device/src/server-ops.ts:139-210` (`ownerCeilingNarrowing`, the `policy` op
  change)
- Test: `packages/device/test/owner-ceiling.test.ts` (describes "owner report sequence sidecar",
  "staged policy op with owner reports")

**Interfaces:**
- Consumes: Task 2 (`projectReach` in the report and narrowing), Task 5, Task 6.
- Produces: the owner report sends `projectReach`; `CeilingNarrowing.workspaceReach` is set by
  `{ projectReach: "workspace" }`; `projectPaths` never crosses the wire (count included: the
  deployment sees refusals and the description only).

- [ ] **Step 1: Write the failing tests**:
  - `it("reports owner fields exactly in the protocol report")` (existing, updated): the report
    has `projectReach: "machine"` and no `restrictedProjectReach`, no `projectPaths`.
  - `it("a deployment narrowing sets the reach to workspace and keeps the paths")`: policy op
    `ownerCeiling: { projectReach: "workspace" }` on a `paths` policy → file has `projectReach:
    "workspace"` and its `projectPaths` unchanged.
  - `it("refuses a narrowing to paths or machine and writes nothing")`: `{ projectReach: "paths" }`
    → refused (`PolicyRefused`), file unchanged.
- [ ] **Step 2: Run** `pnpm exec vitest run packages/device/test/owner-ceiling.test.ts` — expected
  FAIL.
- [ ] **Step 3: Implement** the field rename in `owner-report.ts` and `server-ops.ts`.
- [ ] **Step 4: Run** — expected PASS.
- [ ] **Step 5: Commit**

```bash
git add packages/device/src/owner-report.ts packages/device/src/server-ops.ts packages/device/test/owner-ceiling.test.ts
git commit -m "feat(device): report the project reach and accept only a workspace narrowing

Co-Authored-By: Capybara <noreply@capybarahq.com>"
```

---

### Task 11: `ceiling set --project-reach machine|paths|workspace` and the risk text

Starts after phase 5's change to `args.ts` and `commands/ceiling.ts` (the `-c` selector).

**Files:**
- Modify: `packages/device/src/args.ts` (ceiling parsing, today ~190-240 and usage ~81)
- Modify: `packages/device/src/commands/ceiling.ts` (`CEILING_WIDENING_TEXT` 8-16, `describe`
  48-52, `widens` 55-61, `target` 64-73, the `--json` show 96-106, the result lines 175-189)
- Test: `packages/device/test/owner-ceiling.test.ts` (describe "capybara-device ceiling"),
  `packages/device/test/ceiling-json.test.ts`, `packages/device/test/args.test.ts`

**Interfaces:**
- Consumes: `reachWidens` (Task 3), `listConnections()` (Task 1 / phase 5), Task 5.
- Produces:

```ts
export const CEILING_OTHER_CONNECTIONS_TEXT =
  "Other connections exist on this machine: a call outside the sandbox runs as you and can read " +
  "their working directories and state.";
export function widens(cur: OwnerCeilingPolicy, next: OwnerCeilingPolicy): boolean; // reach via reachWidens
```

- [ ] **Step 1: Write the failing tests**:
  - `args.test.ts`: `it("ceiling set takes --project-reach machine|paths|workspace")`: each parses
    to `projectReach`; `os-user` → `UsageError` whose usage lists `machine|paths|workspace`.
  - `owner-ceiling.test.ts`: `it("widening the reach needs --yes; narrowing it does not")`:
    `workspace → paths` and `paths → machine` without `--yes` exit 2 with `CEILING_NEEDS_YES`;
    `machine → workspace` exits 0.
  - `it("outside the sandbox on names the other connections when there are some")`: with
    `listConnections` returning two entries, `--outside-sandbox on --yes` prints
    `CEILING_WIDENING_TEXT` and `CEILING_OTHER_CONNECTIONS_TEXT`; with one entry, not the second.
  - `ceiling-json.test.ts`: `--json` prints `projectReach` with the new values and
    `projectPaths` (local output only).
- [ ] **Step 2: Run** `pnpm exec vitest run packages/device/test/args.test.ts
  packages/device/test/owner-ceiling.test.ts packages/device/test/ceiling-json.test.ts` — expected
  FAIL.
- [ ] **Step 3: Implement**: parsing, `widens`, `describe` (`Project reach: machine` / `paths (N
  listed)` / `workspace`), the widening text's reach sentence ("The machine reach lets sandboxed
  work read the whole machine except secrets, this program's state and other connections; the
  paths reach only the listed project paths."), and the other-connections sentence printed after
  `CEILING_WIDENING_TEXT` when the target turns `outsideSandbox` on and `listConnections().length
  > 1`. Result line for `paths` with no paths: "No project paths are listed yet: capybara-device
  policy add projectPaths <dir>".
- [ ] **Step 4: Run** — expected PASS.
- [ ] **Step 5: Commit**

```bash
git add packages/device/src/args.ts packages/device/src/commands/ceiling.ts packages/device/test
git commit -m "feat(device): ceiling set --project-reach machine|paths|workspace

Co-Authored-By: Capybara <noreply@capybarahq.com>"
```

---

### Task 12: `policy add|remove|set projectPaths`

Starts after phase 5's change to `commands/policy.ts`.

**Files:**
- Modify: `packages/device/src/commands/policy.ts` (`KEYS` 15, `CEILING_COMMAND` 22-24,
  `LIST_KEYS` 52, `describeCeiling` 93-110, `policyCommand` 120-213)
- Test: `packages/device/test/policy.test.ts` (describe "policy command")

**Interfaces:**
- Consumes: Task 5 (`Policy.projectPaths`), `projectPathRefusal` (Task 3) with the ceiling's deny
  lists from `readStrictOwnerCeilingSync` (Task 6) when logged in.
- Produces: `projectPaths` joins `KEYS` and `LIST_KEYS`.

- [ ] **Step 1: Write the failing tests**:
  - `it("add projectPaths stores the real absolute path, deduped")`: `add projectPaths ./rel`
    resolves against the cwd; a symlink is stored by its `realpath`; adding twice reports "already
    in projectPaths".
  - `it("add refuses a missing directory, a file, a secret path and another connection's directory")`:
    each exits 2, file unchanged; messages name the reason (`does not exist`, `is not a
    directory`, `holds secrets`, `belongs to another connection`).
  - `it("remove takes any listed entry")`.
  - `it("says the list applies only under the paths reach")`: with `projectReach: "machine"` the
    output adds "Project paths apply while the project reach is paths (capybara-device ceiling set
    --project-reach paths)."
  - `describeCeiling` test updated: the reach line for each value; `CEILING_COMMAND` shows
    `--project-reach machine|paths|workspace`.
- [ ] **Step 2: Run** `pnpm exec vitest run packages/device/test/policy.test.ts` — expected FAIL.
- [ ] **Step 3: Implement** the key: validate before the lock (`resolve`, `realpathSync`,
  `statSync().isDirectory()`, `projectPathRefusal` with reach `machine` so only the deny lists
  decide), apply inside it with `edit`.
- [ ] **Step 4: Run** — expected PASS.
- [ ] **Step 5: Commit**

```bash
git add packages/device/src/commands/policy.ts packages/device/test/policy.test.ts
git commit -m "feat(device): policy add|remove projectPaths

Co-Authored-By: Capybara <noreply@capybarahq.com>"
```

---

### Task 13: `device-local`: describe the reach, map refusals to `ProjectPathRefusedError`

Repo `capybara-hq/plugins`, after the SDK release carrying Task 2 (bump with the pnpm override:
one `plugin-sdk` instance). File names are the ones phase 2 created in `plugins/device-local`
(the provider from kernel `local-device-provider.ts`, the report from `owner-report*`); below they
are `src/provider.ts` and `src/report.ts`.

**Files:**
- Modify: `plugins/device-local/src/report.ts` (description and limits)
- Modify: `plugins/device-local/src/provider.ts` (`list` / `scan`: the error mapping; the policy
  narrowing field)
- Create: `plugins/device-local/src/project-refusal.ts`
- Test: `plugins/device-local/test/report.test.ts`, `plugins/device-local/test/project-refusal.test.ts`
- Create: `.changeset/device-local-project-reach.md`

**Interfaces:**
- Consumes: `DeviceProjectReach`, `DeviceProjectRefusal`, the `project_refused` outcome (Task 2);
  `ProjectPathRefusedError` and `DeviceReport` (index, phase 1).
- Produces:

```ts
export const PROJECT_REFUSAL_TEXT: Readonly<Record<DeviceProjectRefusal, { en: string; zh: string }>>;
// other-connection: { en: "This directory belongs to another connection on this machine.", zh: "这个目录属于本机上的另一个连接。" }
// outside-reach:    { en: "This directory is outside the project reach the machine's owner set for this device.", zh: "这个目录不在本机所有者为此设备设定的项目范围内。" }
// denied:           { en: "This directory holds secrets or the device program's own state.", zh: "这个目录存放密钥或设备程序自身的状态。" }
export function projectRefusalError(refusal: DeviceProjectRefusal): ProjectPathRefusedError;
export function describeLocalDevice(c: { projectReach: DeviceProjectReach; outsideSandbox: boolean; mode: "os" | "docker" }): { en: string; zh: string };
```

- [ ] **Step 1: Write the failing tests**:
  - `project-refusal.test.ts`: `it("maps each refusal code to fixed text, never the machine's message")`:
    a `project_refused` response with `message: "<b>evil</b>"` and `refusal: "other-connection"`
    → `list` rejects with `ProjectPathRefusedError` whose `reason` equals
    `PROJECT_REFUSAL_TEXT["other-connection"]`; a `denied` outcome stays the existing scope error.
  - `report.test.ts`: `it("describes each reach in en and zh")`: `machine` + outside off → en
    "Reads the whole machine except secrets and other connections; writes only in the project and
    workspace; never runs outside the sandbox", zh "读取本机全部文件（密钥和其他连接除外）；只在项目和工作区写入；从不在沙箱外运行";
    outside on → ends "runs outside the sandbox only per approved call" / "仅在获批的单次调用中在沙箱外运行";
    `paths` → starts "Reads only the project directories the machine's owner listed" /
    "只读取本机所有者列出的项目目录"; `workspace` and `mode: "docker"` → "Reads and writes only the
    device's workspace" / "只读写设备的工作区". zh never contains `agent` or 企业.
  - `it("lists the project reach under limits and changes the revision with it")`: `limits`
    contains `{ label: { en: "Project reach", zh: "项目范围" }, value }` with value `machine` /
    `listed directories` / `workspace`; two ceilings differing only in reach → different
    `revision`.
  - `it("a narrowing sends projectReach workspace")`: the policy op the provider builds carries
    `ownerCeiling: { projectReach: "workspace" }`, never `restrictedProjectReach`.
- [ ] **Step 2: Run** `pnpm exec vitest run plugins/device-local/test/report.test.ts
  plugins/device-local/test/project-refusal.test.ts` (from the plugins repo root) — expected FAIL.
- [ ] **Step 3: Implement** the functions above and wire them into `report()` and `list` / `scan`.
- [ ] **Step 4: Run** the tests, then the plugin's `pnpm verify` — expected PASS.
- [ ] **Step 5: Changeset** `"@capybara-hq/plugin-device-local": minor` ("project reach
  machine|paths|workspace and refusals").
- [ ] **Step 6: Commit**

```bash
git add plugins/device-local .changeset/device-local-project-reach.md package.json pnpm-lock.yaml
git commit -m "feat(device-local): describe the project reach and refuse project paths with reasons

Co-Authored-By: Capybara <noreply@capybarahq.com>"
```

---

### Task 14: Docs and the device changeset

**Files:**
- Modify: `packages/device/README.md` (§ Permissions ~84-115: the project reach bullet, the
  defaults paragraph, the command block; § Sandboxed work ~118-130: the read rule, the deny list,
  the Linux residual)
- Modify: `docs/deploy/upgrade.md:165` (the `--project-reach` values)
- Modify: `.agents/skills/writing-device-providers/SKILL.md` (phase 1's rename of
  `writing-sandbox-providers`; today's lines ~414-415, ~561-563, ~637 on `os-user` /
  `restrictedProjectReach`)
- Create: `.changeset/device-local-read-model.md`

- [ ] **Step 1: Edit** the README: reads = the whole machine minus secrets, this program's state
  directory and every other connection's working directory and private temps (machine reach);
  `paths` = only `projectPaths` plus the device roots and tool directories; `workspace` = the
  device roots; writes only in the project and workspace; Linux residual (files directly inside a
  directory on the path to a denied one, and listing such a directory); escalated calls read
  everything; commands `capybara-device ceiling set --project-reach machine|paths|workspace`,
  `capybara-device policy add|remove projectPaths <dir>`. Remove the old conversion paragraph
  (version 2 / pre-rc.58).
- [ ] **Step 2: Edit** `upgrade.md` and the skill to the new values and the `project_refused`
  outcome (no `os-user`, no `restrictedProjectReach`).
- [ ] **Step 3: Run** `grep -rn "os-user\|restrictedProjectReach" packages/device packages/plugin-sdk/src docs .agents/skills`
  — expected: no output (applied migrations and CHANGELOGs excepted). Then `pnpm check` and
  `pnpm verify` — expected PASS (`check:test-portfolio` passes: every new real-OS test sits in a
  file already in `os-tests.json`).
- [ ] **Step 4: Changeset** `"@capybara-hq/device": minor` ("sandboxed reads cover the machine
  minus secrets and other connections; per-connection project reach machine|paths|workspace;
  policy format 4").
- [ ] **Step 5: Commit**

```bash
git add packages/device/README.md docs/deploy/upgrade.md .agents/skills .changeset/device-local-read-model.md
git commit -m "docs(device): local read model and per-connection project reach

Co-Authored-By: Capybara <noreply@capybarahq.com>"
```

---

## Not in this phase

- Marking a directory "also used by another connection on this machine" in `status` and on the
  device page (spec §7.2): phase 5 (`status`, the device page) using `listConnections`.
- The kernel's removal of `restrictedProjectReach`, `withinMode` and the hidden-project count:
  phases 1 to 3.

## Index issues

- The index's Review Focus attributes "a sandboxed command of connection A reading connection B's
  working directory or state … must fail" to phase 5, Task "deny other connections". The deny
  list is enforced in `exec/` and `operation-types.ts`, which the index gives to phase 4, and this
  phase's brief assigns it here: it is Task 6 ("Owner ceiling: project reach and deny other
  connections") with Tasks 7 to 9. Phase 5 only provides `listConnections` and the
  `connections/` layout.
- The index fixes neither `ConnectionInfo`'s fields nor the protocol version this phase speaks.
  This plan needs `{ deviceId, stateDir, dir: string | null }` (a `null` dir makes restricted work
  fail closed) and bumps `DEVICE_PROTOCOL_VERSION` once over the last released version (Task 2);
  phases 4 and 5 share one bump if both land before a release.
- `server-ops.ts` and `owner-report.ts` are not in the index's ownership split; this phase
  changes their error mapping and reach field (Tasks 9, 10).
