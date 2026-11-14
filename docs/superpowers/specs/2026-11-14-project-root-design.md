# Project root: a conversation that knows which repository it is working in

- Date: 2026-11-14.
- Status: draft for maintainer review. Calls made here are marked **(designer's call)** until the
  maintainer decides them; the direction (a device serves many projects; a conversation binds one;
  no binding means free mode) is the maintainer's, 2026-11-14.
- Relates to: the auto mode design `2026-11-13-auto-mode-design.md` (it widens file tools to
  absolute paths and rewrites the same device policy frame this spec extends).
- Sequence **(maintainer, 2026-11-14)**: this work starts after auto mode, which landed on
  2026-11-14 (PR #265 with its 15 tasks, migrations `0130_auto_mode` / `0131_device_mode`, the
  bootstrap pin #280). The assumptions this spec makes about that work were checked against
  `4283d6480` on 2026-11-14 and are listed in §11.
- Revised 2026-11-15 **(maintainer)**: a device's projects are kept in PostgreSQL, keyed by the
  device's id, with the kernel as the only writer; local and cloud devices share one logic. The first
  draft kept the list in the device program's local `policy.json`; §12 records what changed.

## 1. Why

The goal is Capybara developing Capybara: a person opens a conversation, and the agent already knows
the repository it is working in — its `AGENTS.md`, its `.agents/skills/`, the checks it must run.

Today it does not. The repository has no standing in the kernel:

- `device_paths` records three roots (`workspace`, `skills`, `tmp`). The `skills` root is where the
  platform's own skills land; it is not a project directory.
- Skills reach the model as a `skills_catalog` snapshot plus the `Skill` builtin that loads a body.
  Only platform and agent skills are in it.
- An agent's instruction files (`AGENTS.md` plus up to 19 more) are **baked into its system prompt
  when the agent is saved** (`agents/definition.ts:305`: derived on save). Editing `AGENTS.md` in a
  repository changes nothing until somebody saves the agent again.

So a repository's conventions reach the model only if a person copies them into an agent definition,
and they go stale the moment the repository changes. A coding agent has to read them where they
live.

## 2. Goals, non-goals, anti-goals

Goals:

- A device can offer **several projects** (a name and a directory each), kept by the kernel per
  device, the same way for a local and a cloud device.
- A conversation may bind **one** project. When it does, the model sees that project's `AGENTS.md`
  and the skills under its `.agents/skills/`, without a person copying anything.
- Free mode stays exactly as today: a conversation with no project is an ordinary Capybara
  conversation (system load, desktop files, ad-hoc questions).
- The project's files are read where they live, re-read when they change, and recorded in the event
  log so a replay sees what the model actually saw.

Non-goals:

- Project hooks. They execute repository code and have a different trust model; a later spec.
- Nested instruction files (`sub/AGENTS.md`). Only the project root's `AGENTS.md` in v1.
- A recursive scan or a file manager in the web: candidates come from a bounded two-level scan the
  device runs in its own mode, and every added path is checked on the device (§4.1).
- Any path outside what the device's current mode can read (§4.2).

Anti-goals (would make this a failure even if it works):

- Two vocabularies for the same idea: a project root is not a second agent, a second workspace or a
  second sandbox.
- A stale copy: if the repository's `AGENTS.md` changes, the next run must see the new one.
- A project that breaks the conversation when it is missing, unreadable or huge.
- Model-visible text that is not in the log.

## 3. Terms

- **Project**: a name and a directory on a device.
- **Project binding**: the optional association of one conversation with one project.
- **Free mode**: a conversation without a binding; today's behaviour, unchanged.
- **Project knowledge**: the project's `AGENTS.md` text and its `.agents/skills/*/SKILL.md` entries.

## 4. Design

### 4.1 Choosing a project happens in Capybara, not in a terminal

A person adds and picks projects from the web. Nothing in this design requires them to leave the
conversation and run a command on the device: a device that is connected, and in auto mode, already
has the capability, and asking its owner to go to a terminal is a worse experience for no safety
**(maintainer, 2026-11-14)**.

**Where the list lives (maintainer, 2026-11-15).** A table `capybara.device_projects` keyed by the
device's id (`devices.id`, the same row for a local machine and a cloud device): `device_id`, `name`,
`path`, `created_by`, `created_at`, unique on `(device_id, name)`, deleted with its device. The
kernel is the only writer; the device program keeps no project list of its own.

**What the device is asked.** The device stays the authority on what it can read: the kernel never
assumes a path exists or is readable, it asks. Two calls, the same for a local device (forwarded as
device operations) and a cloud device (its provider):

| Call | Args | Returns |
|---|---|---|
| `list` | `{ path, limit, limits }` | `{ entries: { name, isDir }[], truncated }`, or null when the path does not exist; a file, an unreadable path, or a path the request's mode cannot reach throws |
| `scan` | `{ base, limits }` | `base` itself and the directories down to two levels under it that hold `.git` or `AGENTS.md`: `{ path, suggestedName }[]`, sorted by path, at most 50; `[]` when `base` does not exist |

Both carry the kernel's **current** ceiling (`limits: { mode }`), and the device answers in the mode
it would run that request in — never by a ceiling it saw on an earlier command **(designer's call,
2026-11-15: before its first command a device has seen no ceiling)**.

`scan` follows one traversal everywhere, so the local device and each cloud provider suggest the same
list: it does not follow symbolic links or enter hidden directories, keeps descending after a hit (a
monorepo's sub-projects are candidates too), skips paths its mode cannot reach, and skips a directory
whose name breaks the name rule rather than truncating it **(designer's call, 2026-11-15)**.

**Adding a project.**
- The form takes the path **relative to the device's base**, shown as a fixed prefix, never a free
  absolute path **(maintainer, 2026-11-14)**; the base follows the mode (§4.2).
- The kernel checks the name (at most 64 UTF-16 code units, not `.` or `..`, no `/`, no control
  characters, no leading or trailing whitespace, unique on the
  device, defaulting to the directory's basename), resolves the path against the base, checks it is
  inside what the device may offer in its current mode (§4.2), then asks the device: `list(path,
  { limit: 1 })` returning entries means a readable directory; null means it does not exist; an error
  means it is a file or unreadable. Each outcome is a readable refusal at the form, so a typo fails
  there, not at the first run.
- The directory need not hold `.git` or `AGENTS.md` yet: an empty directory is how a new project
  starts **(designer's call, 2026-11-15)**.
- At most 100 projects per device.

**Candidates** fill the picker's suggestions: one `scan` of the base, never file contents.

**Where it appears**: adding and removing a project is a device setting, so it belongs on the
device's **设置** view beside the run mode and the allowlist (the page was split into 概览 / 设置
on 2026-11-14, `DeviceModeSection.tsx` is its model); the 概览 view lists the projects read-only.
Binding a conversation to one stays in the composer (§4.3) **(designer's call: configure the device
on one page, pick a project per conversation — never the reverse)**.

Rejected alternative (the first draft): the device program keeps the list in its `policy.json` and
reports it on its policy summary. Overturned by the maintainer on 2026-11-15 — a cloud device has no
device program, so local and cloud would need two stores, and the kernel needs the list anyway to
bind conversations and answer the web.

### 4.2 Which paths a device may offer

**One device logic, local and cloud (maintainer, 2026-11-14).** The kernel and the web see one device
with one mode; which mechanism supplies the containment — Seatbelt, bubblewrap, a container, a remote
VM — is the provider's business, not a second set of rules. A device may offer what it can read in
its current mode, and that is the whole rule:

- **Auto mode**: any directory its owner can read.
- **Sandbox mode**: the device's `workspace` only — nothing outside it is readable anyway.
- **Cloud device**: the container's workspace, in either mode; the container is the environment's
  containment, so "sandbox" there is the container plus the network allowlist, not a label.

Both sides check. The kernel scopes every project by the device's current effective mode, which it
already knows (the platform, the org and the device decide it): when adding, when listing projects to
the web, and when binding. The device then enforces its mode on every access it serves (`list`,
`scan`, reads, commands), and the kernel's tools check paths again through `checkToolPath` /
`validateSandboxPath` (`tools/builtins/sandbox/common.ts`). A stored path therefore grants nothing:
a project added in auto mode is hidden while the device runs in sandbox mode, not deleted.

The form's prefix and the base of a relative path follow the mode: `workspace/` in sandbox mode and
on a cloud device, the owner's home in auto mode **(designer's call: one rule read off the mode, not
a phased rollout)**. A local device reports its owner's home directory in its hello for this.

### 4.3 Binding a conversation to a project

- The binding is chosen when the conversation is created, from the device's projects in
  `device_projects` that its current mode can read **(designer's call: the choice belongs in the composer's existing device/agent
  affordances, not a new settings page)**.
- Only the device's owner may bind a project **(designer's call: the paths are that person's)**.
- The binding is immutable once the conversation exists. Switching projects means a new
  conversation **(designer's call: the log is the source of truth; a mid-conversation root change
  makes both replay and context unexplainable)**.
- A sub-agent's runs inherit its root conversation's binding; a scheduled task's run inherits the
  binding of the conversation it fires.
- **The project root becomes the conversation's working directory** **(maintainer, 2026-11-14)**:
  `Bash` takes its `cwd` from it (`tools/builtins/sandbox/bash.ts` sets `cwd: roots.workspace`
  today), `Glob` and `Grep` default under it, and a relative path in `Read` / `Write` / `Edit`
  resolves against it. **It is also the review's `workspace` fact, not only the cwd.**
  `review.service.ts` takes the device's root as `workspace` and uses it both as the default `cwd`
  and as the inside/outside test for writes; with a project root outside the device's workspace,
  every write inside the project would be judged "outside the workspace" and ask every time. This
  amends the auto-mode design's "the working directory stays the device's `workspace/`".
- A conversation whose bound project was removed, is outside the device's current mode, or whose
  directory is gone continues in free mode, with a notice in the conversation **(designer's call:
  losing a project must never fail a run)**.

### 4.4 Reading the project knowledge

The knowledge is read **once at the start of every run, before the first model call** — not at the
first tool call **(designer's call: the first request must already carry the repository's rules; a
first-tool-call read leaves the first turn blind, and hoisting the text into the system block later
would break the append-only request and the prompt cache)**. Only a conversation with a binding
pays for it.

- `<root>/AGENTS.md`, up to 64 KiB; a larger file is truncated with a visible marker
  **(designer's call: an unbounded file must not be able to consume the context)**.
- `<root>/.agents/skills/*/SKILL.md`: name and description for the catalog, plus a digest of each.
  **Bodies are not recorded** — `Skill` reads one body on demand and its result is a tool result in
  the log **(designer's call: this repository alone has 19 skills and 713 KB of bodies; recording
  them would swamp both the context and the log)**.
- Listing uses the `list` call of §4.1 (`SandboxProvider.list`, beside `stat`); the device,
  `sandbox-docker` and `sandbox-e2b` implement it. It lists entries, never contents, and never
  recursively. Today the provider exposes only `create`, `exec`, `readFile`, `writeFile` and `stat`,
  so this is a genuine addition to the public contract.
- **Cost, accepted**: reading before the first model call needs a device session first. Today the
  roots are known only once a session exists — `device_paths` is recorded at the first sandbox tool
  call — so a bound conversation starts its device eagerly, even for a run that never executes a
  command. That is acceptable for a conversation that names a project **(designer's call: naming a
  directory is a statement of intent to work in it)**; free-mode conversations keep starting the
  device lazily.

The result is recorded as one `project_root` event: the project name, the root path, the
`AGENTS.md` text when the root has one (omitted otherwise, with no reason recorded), and per skill
its name, description and digest (at most 100 skills, `skillsTruncated` when more exist; each
`SKILL.md` read up to 1 MiB). A project the run cannot use records `unavailable: { reason, message }`
instead, with `reason` one of `gone`, `outside_mode`, `unreadable`, `unsupported` (a device that does
not announce `projects`), so an earlier snapshot stops applying. The event
is model-visible and rendered with the run's first system block, before the model's first turn.

A run records the event again when any digest differs from the conversation's latest recorded one;
within a run the snapshot is fixed, so the request stays append-only.

### 4.5 What the model sees

- **Instructions**: the project's `AGENTS.md` is rendered as a system segment **after** the agent's
  own instructions. On a direct conflict the agent's instructions win **(designer's call: a
  repository must not be able to loosen the agent's safety rules)**.
- **Skills**: project skills join the catalog with the source `project` and the callable name
  `project:<name>` **(designer's call: the prefix makes a collision with a platform or plugin skill
  impossible instead of resolving it by precedence)**. `Skill` loads them from the device's copy
  under `<root>/.agents/skills/<name>/`.

### 4.6 What the person sees

The composer's `/` menu already lists the agent's invocable skills
(`GET /api/v1/orgs/:orgId/agents/:agentId/invocable-skills?conversationId=`,
`skills/invocable.controller.ts`; the palette fills it in `ComposerBar.openPalette("prompts")`). A
project adds entries to that list rather than a second menu:

- **The conversation header** shows the bound project — its name, its root, and whether `AGENTS.md`
  was loaded. A project that is gone degrades here (§4.7).
- **The `/` menu** gains the project's skills when the conversation is bound, under their callable
  name `project:<name>`. `InvocableSkill` gains a `source` (`platform` / `plugin` / `agent` /
  `project`) so the palette can group them **(designer's call: one menu, grouped by source, not one
  menu per source)**.
- **The project entries come from the conversation's latest `project_root` event**, not from a fresh
  read of the device, so the menu lists what the model saw in this conversation.

Choosing an entry is unchanged: it fills the composer's skill chip and sends `skill: "project:<name>"`,
which `SkillInvoker` already carries through to the log.

### 4.7 Failure behaviour

Every failure is a degraded conversation, never a failed run:

- The project directory is gone or unreadable: free mode, one notice.
- `AGENTS.md` is absent: a project with skills only; no notice.
- A skill is unparsable: skipped, logged.
- The device is offline: the run does not start, as today; the binding stays.

## 5. Replay

`project_root` is a new event whose payload contains everything it renders, so the request is
reconstructable from the log and no `DriftReason` is needed for the event itself. Two cases need the
zero-drift fixtures:

- A recorded conversation without a project must render exactly as today (the event is simply
  absent).
- A recorded conversation with a project must render from the recorded text, never by re-reading
  the device at replay time **(the replay rule: replays use recorded tool results and never touch a
  device)**.

## 6. Multi-replica

Nothing is held in process memory. The project list is the `device_projects` table, written in
`@Transactional()` methods with the uniqueness enforced by the database; the binding is two columns
on the conversation row; the knowledge is an event. Two replicas serving the same conversation read
the same rows and append to the same log. The device calls (`list`, `scan`) happen outside
transactions, before the write that records their outcome.

## 7. Contract and protocol changes (outline; the plan details them)

- `@capybara-hq/plugin-sdk`: `DeviceOp` gains `list` (`{ path, limit, limits }` → `{ entries:
  { name, isDir }[], truncated }` or null) and `scan` (`{ base, limits }` → `{ path, suggestedName }[]`,
  at most 50, two levels), since a local device's provider forwards each file method as one op.
  `DeviceFeature` gains `projects`: the kernel sends `list` and `scan` only to a device that announced
  it, as it gates `policy` on `policyOp`. `DeviceHello` gains `home?: string` (the owner's home, a
  local device only). `SandboxProvider` gains optional `list(h, path, { limit, limits, signal })` and
  `scan(h, base, { limits, signal })` with the same results (entries sorted by code unit; a file or an
  unreadable directory throws). No project list in the device's policy summary and no project
  operations. A changeset and `pnpm gen:sdk-api`.
- `capybara-hq/plugins`: `sandbox-docker` and `sandbox-e2b` implement `list` and `scan` inside the
  container's workspace (v1 covers cloud devices, §4.2).
- `packages/device`: serves `list` and `scan` in the mode the request's ceiling gives, reports `home`
  in its hello, and announces `projects`. It keeps no project list.
- Kernel: migration `0133` (`device_projects`, `conversations.project_name` / `project_path`), a
  device projects service (list by current mode, add with the device check, remove, candidates)
  behind owner-only routes with their Platform operations, `LocalDeviceProvider.list` / `scan`, the
  `project_root` event, the run-start reader, the rendering, the binding on create, the
  working-directory change of §4.3, the review's `workspace` fact, the free-mode fallbacks.
- Amendment to `2026-11-13-auto-mode-design.md` §4.1: the working directory follows the project
  binding, and the command review takes the project root as its `workspace` fact.
- Web: the project section on the device's 设置 view (name + base-relative path, candidates
  suggested, owner only), the project line in the conversation header, the project entries in the
  existing `/` palette (§4.6), the notice for a lost project.
- Docs: `docs/guide/devices.md`, the `writing-sandbox-providers` and `writing-tools` skills.

## 8. Testing

- Device: `list` and `scan` answer in the request's ceiling — before any command, with the owner on
  auto and the ceiling sandbox, nothing outside the workspace is listed or scanned.
- Kernel: adding a project refuses a path outside the device's current mode, a missing path, a file,
  a duplicate name; a project outside the current mode is hidden from the list and from binding, not
  deleted; a non-owner cannot add, remove or bind.
- Kernel: reading `AGENTS.md` and a skills tree from a fake device; the 64 KiB cap; an unparsable
  skill is skipped; a missing project degrades to free mode.
- Replay: the two zero-drift cases of §5, run before and after.
- End to end: on a local device in auto mode, bind an existing checkout of `capybara-hq/core`, ask
  the agent what this repository's rules are, and check the answer quotes `AGENTS.md`; then run one
  command and check it ran in the checkout, not in the device's workspace.

## 9. Out of scope for this spec

- **Project hooks.** The maintainer raised them with this design. They execute repository code, and
  their trust model is not the extension's or the agent's; the likely shape is that hooks run on the
  device around exec, never in the kernel, so that a repository cannot run code inside the
  deployment. That needs its own spec.
- Narrowing what a project may expose beyond v1 (include/exclude patterns, a read-only project).
- Knowledge beyond `AGENTS.md` and `.agents/skills/` (`docs/`, `.claude/` files, a CLAUDE.md
  compatibility reader — pre-0.1.0, no compatibility layers).

## 10. Calls left to review

1. The 64 KiB cap on `AGENTS.md`.
2. `project:<name>` as the skill namespace.
3. Binding is create-time only and owner-only.
4. Reading at run start, before the first model call, rather than at the first tool call.
5. The containment rule read off the device's mode, enforced on the device and again in the kernel.
6. The device-owned list of the first draft was replaced by `device_projects` (maintainer,
   2026-11-15); `list` doubles as the existence check when adding.
7. The candidate scan's depth (two levels) and its size (50), run on the device as `scan`.
8. Whether the binder is the composer's device affordance or the conversation header's project line
   — one entry point, not both.

## 11. Assumptions checked against the auto-mode implementation

Checked against `4283d6480` on 2026-11-14, after auto mode merged (PR #265, migrations
`0130_auto_mode` / `0131_device_mode`, bootstrap pin #280):

| Assumption | Result |
|---|---|
| `DeviceLocalPolicySummary` shape | Holds: `{ mode: "auto" \| "sandbox"; allowedDomains: string[] }`, `remoteGrants` gone. |
| Cloud mode still a derived label (P-D6) | Holds in the merged plan. The maintainer asked for the *reason* to be rewritten (the container supplies the containment); that is a documentation change of that line, not of this spec. |
| The old knobs are gone | Holds: `remoteGrants` has no reference; `sandboxTier` and `isolation` remain only as readers for a pre-auto-mode device payload. |
| The review's workspace fact | **Changed this design** (§4.3): it is the device root, used both as the default `cwd` and as the inside/outside test, so a project root outside the workspace would make every write ask. |
| File tools widened to absolute paths | Holds: `checkToolPath` accepts any clean absolute path in auto mode and keeps the roots in sandbox mode (§4.2). |
| Platform limits after the change | `sandbox.limits.allowHosts` remains as the allowlist's default; an org's `cloudNetwork` is `{ mode, allowHosts }` and its `allowHosts` still **replaces** the deployment's list — the standing `org-egress-replaces-deployment` finding, outside this spec. |

Re-checked after merging `main` on 2026-11-15 (`bffe0ef3f`): the interfaces above are unchanged. The
device page was split into 概览 / 设置, which moved where a project is added (§4.1); the tool
catalog's header wording (#287) and the device service control do not touch this design.

## 12. Revision of 2026-11-15: projects move to PostgreSQL

The first draft kept a device's projects in the device program's `policy.json`, reported them on its
policy summary, and gave the device four project operations (`projectList`, `projectCandidates`,
`projectAdd`, `projectRemove`). The maintainer overturned that: projects are kept in PostgreSQL keyed
by the device's id, the same for a local and a cloud device. What changed:

- **Store**: `device_projects`, written only by the kernel (§4.1, §6).
- **Device contract**: the four project operations and the policy summary's `projects` are removed;
  the device answers `list` and `scan`, both carrying the kernel's current ceiling, and reports its
  owner's home (§4.1, §7).
- **Checks**: the kernel scopes projects by the device's current mode; the device still enforces its
  mode on every access, so a stored path grants nothing (§4.2).
- Work already built on the first draft (the SDK contract, the kernel's parse of the summary, the
  device's project store) is reworked in place; pre-0.1.0, no compatibility layers.

