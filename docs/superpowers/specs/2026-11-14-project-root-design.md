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
  `4283d6480` on 2026-11-14 and are listed in §10.

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

- A device can offer **several projects** (a name and a directory each), declared on the machine.
- A conversation may bind **one** project. When it does, the model sees that project's `AGENTS.md`
  and the skills under its `.agents/skills/`, without a person copying anything.
- Free mode stays exactly as today: a conversation with no project is an ordinary Capybara
  conversation (system load, desktop files, ad-hoc questions).
- The project's files are read where they live, re-read when they change, and recorded in the event
  log so a replay sees what the model actually saw.

Non-goals:

- Project hooks. They execute repository code and have a different trust model; a later spec.
- Nested instruction files (`sub/AGENTS.md`). Only the project root's `AGENTS.md` in v1.
- A recursive scan or a file manager in the web: `projectCandidates` is a shallow two-level scan and
  the device validates every choice (§4.1).
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

The device gains four operations on the existing request channel (`KernelReq.op`, which today
carries ten operations and no listing).

| Op | Args | Returns |
|---|---|---|
| `projectList` | — | the projects the device serves, `{ name, path }[]` |
| `projectCandidates` | — | directories that look like projects (`.git` or `AGENTS.md`) under what the device may offer, at most two levels deep, bounded to a page |
| `projectAdd` | `{ path, name? }` | the added entry, or the reason it was refused; the name defaults to the directory's basename |
| `projectRemove` | `{ name }` | — |

- **Where it lives**: adding and removing a project is a device setting, so it belongs on the
  device's **设置** view beside the run mode and the allowlist (the page was split into 概览 / 设置
  on 2026-11-14, `DeviceModeSection.tsx` is its model); the 概览 view lists the projects read-only.
  Binding a conversation to one stays in the composer (§4.3) **(designer's call: configure the
  machine on one page, pick a project per conversation — never the reverse)**.
- The form takes the path **relative to the device's base**, shown as a fixed prefix
  (`workspace/` today), never a free absolute path **(maintainer, 2026-11-14)**.
- `projectCandidates` is a shallow scan, never a recursive walk and never file contents; it only
  fills the picker's suggestions.
- `projectAdd` validates on the device: the path exists, is inside what the device may offer (§4.2),
  and is a project. The answer is immediate, so a typo fails at the form, not at the first run.
- The device reports the resulting list in the frame it already sends when its local policy changes
  (`DevicePolicyChanged`, `policy?: DeviceLocalPolicySummary`), so the web learns a project added on
  the machine as well. The command line stays available for headless and scripted setups; it is no
  longer the only way in.

Rejected alternative: enumerating the file system from the kernel. The kernel would be browsing the
owner's disk on behalf of a web session, with no way to bound what it sees.

### 4.2 Which paths a device may offer

**One device logic, local and cloud (maintainer, 2026-11-14).** The kernel and the web see one device
with one mode; which mechanism supplies the containment — Seatbelt, bubblewrap, a container, a remote
VM — is the provider's business, not a second set of rules. A device may offer what it can read in
its current mode, and that is the whole rule:

- **Auto mode**: any directory its owner can read.
- **Sandbox mode**: the device's `workspace` only — nothing outside it is readable anyway.
- **Cloud device**: the container's workspace, in either mode; the container is the environment's
  containment, so "sandbox" there is the container plus the network allowlist, not a label.

The check lives where the files are — on the device, or in the provider — and the kernel enforces it
a second time, through `checkToolPath` / `validateSandboxPath`
(`tools/builtins/sandbox/common.ts`): in sandbox mode a path must be under the roots; in auto mode
it must be a clean absolute path and the review judges a write outside the workspace. A device that
lies therefore changes nothing. The form's prefix follows the mode: `workspace/` in sandbox mode,
the owner's home in auto mode, `workspace/` on a cloud device **(designer's call: one rule read off
the mode, not a phased rollout)**.

### 4.3 Binding a conversation to a project

- The binding is chosen when the conversation is created, from the projects the conversation's
  device declares **(designer's call: the choice belongs in the composer's existing device/agent
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
- A conversation whose device no longer declares the bound project continues in free mode, with a
  notice in the conversation **(designer's call: losing a project must never fail a run)**.

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
- Listing uses one new provider call, `list(path, { depth })`, added to `SandboxProvider` beside
  `stat`; the device, `sandbox-docker` and `sandbox-e2b` implement it. It lists entries, never
  contents, and never recursively. Today the provider exposes only `create`, `exec`, `readFile`,
  `writeFile` and `stat`, so this is a genuine addition to the public contract.
- **Cost, accepted**: reading before the first model call needs a device session first. Today the
  roots are known only once a session exists — `device_paths` is recorded at the first sandbox tool
  call — so a bound conversation starts its device eagerly, even for a run that never executes a
  command. That is acceptable for a conversation that names a project **(designer's call: naming a
  directory is a statement of intent to work in it)**; free-mode conversations keep starting the
  device lazily.

The result is recorded as one `project_root` event: the project name, the root path, the
`AGENTS.md` text (or why it is absent), and per skill its name, description and digest. The event
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

Nothing is held in process memory. The binding is a column on the conversation row; the project list
is part of the device's reported policy, stored with the device; the knowledge is an event. Two
replicas serving the same conversation read the same row and append to the same log.

## 7. Contract and protocol changes (outline; the plan details them)

- `@capybara-hq/plugin-sdk`: `DeviceLocalPolicySummary` gains `projects: { name: string; path:
  string }[]`, always present once parsed (`[]` when the device reports none) — the summary is
  `{ mode, allowedDomains }` today, so this is one added field. Bounds: at most 100 projects, a name
  of at most 64 characters without `/` or control characters, a reported path absolute and free of
  control characters (only `projectAdd`'s args may carry a base-relative path). `DeviceOp` gains the
  four project operations (`projectCandidates` answers `{ path, suggestedName }` suggestions, not
  served projects) and `list` (`{ path, limit }` → `{ entries: { name, isDir }[], truncated }`, or
  null when the path does not exist), since a local device's provider forwards each file method as
  one op. `DeviceFeature` gains `projects`: the kernel sends those five ops only to a device that
  announced it, as it gates `policy` on `policyOp`. `SandboxProvider` gains an optional
  `list(h, path, { limit, signal })` with the same result (entries sorted by code unit, never
  contents, never recursive; a file or an unreadable directory throws; whether a project root exists
  is answered by `stat`). A changeset and `pnpm gen:sdk-api`.
- `capybara-hq/plugins`: `sandbox-docker` and `sandbox-e2b` implement `list` (v1 covers cloud
  devices, §4.2).
- `packages/device`: the four project operations of §4.1, the containment check, `list`, the policy
  summary, and the `project` CLI kept as the headless equivalent.
- Kernel: the `project_root` event, the run-start reader, the rendering, the conversation column and
  its migration, the binding on create, the owner check, the working-directory change of §4.3, the
  review's `workspace` fact, the free-mode fallbacks, and the four project operations behind an
  owner-only route.
- Amendment to `2026-11-13-auto-mode-design.md` §4.1: the working directory follows the project
  binding, and the command review takes the project root as its `workspace` fact.
- Web: the project picker (name + workspace-relative path, candidates suggested, owner only), the
  project line in the conversation header, the project entries in the existing `/` palette (§4.6),
  the notice for a lost project.
- Docs: `docs/guide/devices.md`, the `writing-extensions` skill if the catalog source matters to
  extension authors.

## 8. Testing

- Device: `projectAdd` refuses a path outside what the current mode may offer (the workspace in
  sandbox mode); the reported summary round-trips.
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
6. `projects` in `DeviceLocalPolicySummary` rather than a frame of its own — auto mode lands first
   and has already rewritten that type.
7. The candidate scan's depth (two levels) and its page size.
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
