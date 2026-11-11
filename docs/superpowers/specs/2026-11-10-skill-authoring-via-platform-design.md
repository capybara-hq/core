# Skill authoring through files and the Platform tool

Status: Approved; implemented by plans/2026-11-10-skill-authoring-via-platform.md. Replaces the builtin tool `SkillWrite` (M5 T15,
R3 / R4) and the shared-agent skill change flow.

## 1. Intent

An agent should create and upgrade skills the way a person does: write the skill's files, package
them, and register the package through the same API the web uses. The kernel already gives agents
everything for the first two steps (sandbox `Write` / `Edit` / `Bash`), and the `Platform` tool
exists so that an agent can do through the API what a person does on the web. A dedicated
`SkillWrite` tool, with its own synthesis of `SKILL.md`, its own limits (text only, 1 MB) and its
own approval flow, is a second, narrower way to do the same thing. It goes.

What makes skill authoring good is knowledge, not a tool: how a skill is laid out, how its
description triggers, how to keep `SKILL.md` short and push detail into files. That knowledge ships
as a builtin skill, `skill-guide`, that every agent can load.

## 2. Maintainer decisions (2026-11-10)

1. Remove `SkillWrite`. Agents author skills with the sandbox file tools and `Bash` (zip), then
   register the package through a `Platform` operation.
2. A skill an agent registers belongs to **the current agent** by default (its own skill, `scope =
   agent`), as `SkillWrite` skills do today. `Skill` (loading) stays as it is.
3. **Only the agent's owner** may create or upgrade the agent's skills. On a shared agent
   (`visibility` `org` or `members`), users who are not the owner cannot change its skills. The
   shared-agent change request flow (R4: user proposes, owner approves, trial in the proposing
   conversation) goes.
4. An agent's own skill can be **shared within the org**: the owner asks, an **org admin
   confirms**. Once shared it is an **org skill owned by the org**; the agent's owner is recorded as
   its maintainer. Deleting it, its 可共享 flag and cross-org use follow the org skill rules.
5. After sharing there is **one** skill, never a fork. The maintainer's agent registering a new
   version of it creates a version proposal that an org admin confirms; once confirmed every agent
   using it gets the new version from its next run.
6. Cross-org stays the existing mechanism: the org marks the skill 可共享, the super admin gives it a
   scope (`all` / `optional` / `named`), which promotes it (plugin scope spec §14,
   `catalog/component-promotion.ts`). Nothing new.
7. Confirmation rule: the same person signs once even when they hold several roles; asking is
   consent (the owner who asks to share has agreed, only the org admin remains). The Platform
   confirmation rules apply unchanged (Platform spec §6.2: no write runs without confirmation;
   only `personal` writes may be remembered); see §5.3.
10. Registration is a Platform write like any other and is just as strict: it is unavailable when
    the org's `platformTool` setting is `off` or `read-only`, and in runs with no person present
    (scheduled runs, eval runs, anonymous channel users). `SkillWrite` was not bound by these; the
    stricter behavior is intended.
11. Skills enter only as packages (decision 2026-11-10, follow-up). Every text form that builds a
    `SKILL.md` from fields goes: the web 技能 page's 新建 dialog (`SkillCreateDialog`), the text
    branch of `POST /orgs/:orgId/skills`, the Platform operation `skills.create`, and any text form
    of agent registration. The two ways in are: an agent registers its own skill from a zip (and
    may ask to share it), or a person uploads a zip on the web.
8. `skill-guide` is **builtin**: on in every org, not switchable off by an org admin.
9. The skill format is the Agent Skills specification (https://agentskills.io/specification).

## 3. Goals, non-goals, anti-goals

Goals

- An agent can create, upgrade and test a full skill package (`SKILL.md`, `scripts/`,
  `references/`, `assets/`, any text or binary files within the package limits) in one
  conversation, and use the new version in the same run.
- One package reader and one set of limits for every way a skill enters the system (web upload,
  agent registration, plugins).
- Fewer approvals: the common case (an owner improving their own private agent) needs one card the
  first time, which the owner may remember; no inbox approval.
- Agents learn authoring from `skill-guide`, not from a tool description.

Non-goals

- Users of a shared agent suggesting skill changes to its owner (possible later as a request kind;
  not now).
- Agents deciding anything: org admins confirm shares and versions on the web (Platform
  "human only" rule).
- Editing a skill in place in the web UI.
- A new skill format or extensions to the Agent Skills frontmatter.
- Authoring without a sandbox: an agent without sandbox tools cannot author skills (decision 11).

Anti-goals (a failure even if it works)

- Two code paths that parse or validate skill packages differently.
- A shared org skill changing without an org admin having seen that version.
- A forked copy: the same skill name meaning different content for the original agent and the
  rest of the org.
- Compatibility shims for `SkillWrite` or for pending R4 requests (pre-0.1.0: change directly;
  applied migrations stay immutable).

## 4. Current state (what this replaces)

- `packages/kernel/src/tools/builtins/skill-write.ts`: the tool; synthesizes `SKILL.md` from
  `name` / `description` / an optional body and keeps six invocation keys; text only, ≤ 1 MB,
  ≤ 200 files.
- `packages/kernel/src/skills/changes.service.ts`: writes files to object storage, then in one
  transaction either creates a version (private agent) or a `skill_change_requests` row (shared
  agent); appends a `skills_catalog` snapshot to the conversation so the same run sees the skill;
  `decide`, inbox listing, trial revert, agent skill delete.
- `tools/policy.ts`: R3 fixed ask on shared agents (`R3_SHARED_AGENT_ONLY_TOOL_KEYS`),
  `skills.writePolicy` on private agents.
- Web: `SkillChangeReview.tsx`, the inbox's skill change rows, `agent/SkillsSection.tsx`,
  `AgentSkills.tsx`.
- Platform: `skills.create` (org skill from text, org admins), `agents.list-skills`,
  `agents.delete-skill`, skill change reads in `agent-skills.ops.ts`; the zip upload route
  `POST /orgs/:orgId/skills/uploads` is an exclusion (`transport`, "multipart bytes").
- Org skills: zip upload (`POST /skills/uploads` then `POST /skills` with `uploadId`), read by
  `readSkillPackage`; 可共享 (`PUT /skills/:id/shareable`) refuses an agent's own skill
  (`catalog.not_owned`).
- `SkillWrite` is also named in `builtin-names.ts`, `legacy-keys.ts`, the Claude Code tool map,
  sub-agent definitions, `invocation-keys.ts`, event types and the device policy command.

## 5. Design

### 5.1 Authoring flow

1. The agent loads `skill-guide` (or already knows the format).
2. It writes the skill directory in the sandbox: `<dir>/SKILL.md` plus any files.
3. It packages the directory as a zip with `Bash` (`skill-guide` gives the exact command and checks).
4. It calls a new Platform operation that registers the package as one of **this agent's** skills.
   Same name as an existing skill of the agent = a new version; a new name = a new skill.
5. The kernel reads the zip with the same reader and limits as the web upload
   (`readSkillPackage`, `SKILL_LIMITS`: 10 MB per file, 50 MB total, 1000 files), validates it,
   stores the version, and appends a `skills_catalog` snapshot to the conversation so the next step
   of the same run can `Skill` it (as `writeIn` does today).

The `SKILL.md` the agent writes is stored as written. The kernel no longer synthesizes it; the
skill's name is its frontmatter `name` (as for uploads today).

### 5.2 The registration route and operation

- New route: register a skill package as an agent's own skill (owner only), e.g.
  `POST /orgs/:orgId/agents/:agentId/skills` with `uploadId` (zip only). The web uses it
  too: an owner can upload a zip onto their agent from the agent page, so the Platform operation
  mirrors a real route (Platform rule: operations call the controllers' services).
- New operation, e.g. `agents.register-skill`, mirroring that route. Instead of `uploadId` it takes
  a path of a file in **this conversation's sandbox**; the operation reads the file and hands it to
  the same service as the upload. How the bytes get from the sandbox into the upload store
  (reuse `Deliver`'s sandbox read, or stage it as an upload attachment) is the builder's call; it
  must not add a second package reader.
- Refusals with actionable English errors: not the owner (decision 3), no sandbox / file missing,
  package invalid (the reader's messages), name clash with a shared org skill the agent does not
  maintain, agent skill cap (`AGENT_SKILLS_MAX`).
- The upload route's exclusion (`POST /skills/uploads`, `transport`) stays for org skills.

### 5.3 Who may write, and confirmation

- The actor of the run (trigger account) must be the agent's current owner, read live. Anyone else
  gets a refusal telling the model to say that only the owner can change this agent's skills. This
  holds for web and channel conversations alike.
- Confirmation follows the Platform rules with no new framework capability (maintainer decision
  2026-11-10):
  - On a **private** agent: class `personal`. The first call shows a card; the owner may remember it
    ("this conversation" / "always"). `skills.writePolicy: "ask"` makes it confirm every time and
    never remember.
  - On a **shared** agent (`org` / `members`): class `org`, confirmed every time, never remembered,
    as `agents.update` does today through `confirmFor` (the write changes what every user of the
    agent gets).
- Availability: the standard Platform `availability()` gates apply (decision 10); no exception.
- Sub-agents cannot register skills **(designer's call)**: only the root conversation's agent, the
  one the person talks with, may. A sub-agent's definition can come from another agent, a template
  or an inline definition, so ownership and the catalog snapshot target would be ambiguous. The
  refusal tells the sub-agent to hand the files back to its parent.

### 5.4 Sharing within the org

- The owner asks to share one of the agent's skills (web button on the agent page, and a Platform
  operation that creates the request; the request itself is the owner's consent).
- Org admins see the request in the inbox, with the files (as the skill change review shows them
  today), and confirm or reject it on the web (human only). If the owner is an org admin, the ask
  is the confirmation: no request, it is shared at once. When that ask comes through the Platform
  operation, its card is class `org` (every time, never remembered) and shows the skill's files,
  so someone has seen the content before the org's skill library changes.
- On confirm, in one transaction: the skill becomes an org skill (`scope = org`, owned by the org,
  `agent_id` cleared), the agent's owner is recorded as maintainer, and the original agent keeps
  using it (it is added to the agent's selected org skills, or resolved through the maintainer
  link; builder's call). Version history is kept.
- Storage for the request: a new kind on the existing org requests (`0077_scope_requests`,
  `requests.*`), or the existing `skill_change_requests` table repurposed. Builder's call; one
  mechanism, not both.

### 5.5 Upgrading a shared skill

- The maintainer's agent registering the same name creates a version proposal on the org skill,
  not a new agent skill. An org admin confirms it on the web; then it is the current version and
  every agent using it picks it up at its next run. If the maintainer is an org admin, it takes
  effect at once after the operation's card (class `org`, every time, showing the files).
- **Maintainer (designer's call):** an account, the agent's owner at the time of sharing (a column
  such as `maintainer_account_id` on the org skill). Agents the maintainer owns may propose versions.
  Transferring the original agent does not move the maintainer. When the maintainer leaves the org
  or is deactivated, nothing transfers: org admins manage the skill through the org skill routes as
  they do any org skill.
- **Promoted skills (designer's call):** a confirmed version is, to the rest of the system, the same
  as an org admin uploading a new version of the org skill on the web. Whatever the promotion code
  does for that today applies; this design adds no cross-org logic.
- Until confirmed, only the proposing conversation uses the proposed version (the existing trial
  mechanism: catalog snapshot in that conversation, reverted on reject).
- An agent that is not the maintainer's cannot propose versions of an org skill through this
  operation (org admins manage org skills through the existing org skill routes).

### 5.6 Cross-org

Unchanged: 可共享 on the org skill (org admins), then the super admin's component scope. Once an
agent skill has become an org skill, the existing chain applies.

### 5.7 `skill-guide`

- A skill-only plugin in `capybara-hq/plugins` (e.g. `skills-core`), pinned in
  `packages/kernel/bootstrap.json` with `builtin: true` (startup bootstrap spec, "Builtin entries":
  imported once the extensions loaded, since skills need the object store; a failure does not stop
  the start), so it is a builtin platform skill in every org. Later core skills go into the same plugin.
- Amended 2026-11-11 (maintainer decision): the skills of builtin catalog items (platform-owned,
  `catalog_items.builtin`) that are on in the org are in **every agent's** skills catalog without
  being selected (`skills/usable.ts` `builtinSkillIds`, added in `selectedSkills`, so the run-start
  snapshot, `Skill`, a person's `/` invocation and the `/` menu agree). Listed only (name and
  description), never pinned; ranking is unchanged (the agent's own skill of the same name, then
  an org skill, then the platform skill), a skill also selected is listed once, a manual-only
  version stays out of the model's catalog, and a skill off in the org (deployment disable, a
  component switch) is absent, as is one an org skill of the same name shadows org-wide (rule 10;
  the org's pinned copy of the builtin skill takes its place instead). Only platform-owned items
  and skills count (`owner_org_id IS NULL`), and a sub-agent template may pin one only when the
  parent selects it. Old conversations keep their recorded snapshots; the next run start
  records a new one with the usual "skills changed" reminder. The agent page shows these skills
  ticked and disabled with a "Built-in" tag (the library list's `builtin: true`).
- Content (English, Agent Skills format, `SKILL.md` under 500 lines / ~5000 tokens, detail in
  `references/`):
  - when to create a skill and when not to;
  - the layout and frontmatter rules (`name` 1-64 lowercase letters, digits and single hyphens;
    `description` 1-1024 characters saying what it does and when to use it; optional `license`,
    `compatibility`, `metadata`, `allowed-tools`, and the invocation keys this kernel supports);
  - progressive disclosure: references one level deep, say when to read each file, gotchas stay in
    `SKILL.md`;
  - the exact steps here: write, zip (command), register (the Platform operation), test with
    `Skill` in the same run, upgrade = register the same name again (each version is complete);
  - what needs the owner, what needs an org admin, and how to share.
- Whether the kernel needs any change to keep a required plugin's skill from being switched off is
  for the builder to check against the plugin scope rules (`builtin` items are fixed).

### 5.8 Removals

- Text-form skill creation (decision 11): `SkillCreateDialog` and the 新建 action on the 技能 page
  (the page keeps 上传技能), the text branch of `POST /orgs/:orgId/skills` (`createFromText`,
  `checkCreateFromText`, `textSkillFiles`), and the Platform operation `skills.create`; the route,
  now upload only, becomes an exclusion (`transport`: it consumes an uploaded archive).
- `SkillWrite`: the tool, `buildSkillWrite`, its entries in `builtin-names.ts`, `legacy-keys.ts`,
  the Claude Code tool map, sub-agent definition handling, device policy, events, docs
  (`docs/guide/skills.md`) and tests. Agent definitions that list it lose it (pre-0.1.0, no shim).
- R3 fixed ask for shared agents on skill writes (`R3_SHARED_AGENT_ONLY_TOOL_KEYS` entry) and the
  R4 flow: user-proposed changes on shared agents, their inbox rows and review page, their
  catalog trial. What §5.4 / §5.5 reuse (review page, trial snapshot) is kept and renamed as
  needed.
- `skills.writePolicy` stays, now read by the registration operation (§5.3).
- The `customSkills` platform setting: today it does not govern agent-written skills. Whether
  sharing an agent skill into the org needs `customSkills: allow` is the builder's call to raise
  if unclear; the default is that it does (sharing creates an org skill).

### 5.9 Format alignment

The SDK already matches the specification's limits (`SKILL_LIMITS`: name 64, description 1024,
compatibility 500; optional `license`, `metadata`, `allowed-tools`). The kernel does not require the
directory name to equal `name` (zip outer folders vary); `skill-guide` tells agents to keep them
equal. No format changes.

## 6. Replay and multi-replica

- Registration appends a `skills_catalog` snapshot like `writeIn`; no new model-visible input type,
  so no new `DriftReason`. Run the zero-drift fixture tests before and after.
- All writes in `@Transactional()` methods; object storage writes before the transaction and
  cleanup after failure, as `changes.service.ts` does; event log notify in `afterCommit`.
- Lock order on agent, conversation and skill rows as in `writeIn` (it records a past deadlock).

## 7. Testing

- The operation end to end with `model-fake`: write files, zip, register, `Skill` in the same run.
- Owner check: a non-owner on a shared agent is refused; a sub-agent is refused.
- Confirmation: `personal` and rememberable on a private agent, `org` every time on a shared one;
  `writePolicy: "ask"` disables remembering; `platformTool` off / read-only and no person present
  refuse.
- Share: request, org admin confirm, ownership moves, original agent keeps it; owner who is an org
  admin shares at once.
- Upgrade of a shared skill: proposal, trial only in its conversation, confirm, other agents see
  it next run; reject reverts the trial.
- Package parity: the same zip gives the same result through the web upload and the operation.
- Platform parity test and `check:platform-ops` for the new route and operation.

## 8. Left to the builder

- Route and operation names, and how the sandbox file reaches the upload store (§5.2).
- Request storage for shares and version proposals (§5.4).
- How the original agent keeps a shared skill (§5.4).
- The `skill-guide` text, within §5.7.
- Plan order (suggested: route + operation + removal of `SkillWrite`; then sharing; then
  `skill-guide` in the plugins repo and the bootstrap pin).
