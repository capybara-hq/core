# The `Platform` tool: agents that understand and operate the platform

- Date: 2026-11-07, written against `main` at `76b32e10`.
- Status: phase 1 implemented (#94, merged 2026-11-08; §13 As built). Phase 2 (§14) decided
  2026-11-08, in implementation.
- Amends: the co-build design (`2026-10-29-co-build-design.md`): its `PlatformInfo` builtin (§8.1)
  is replaced by this tool, and its agent docs and `check:agent-docs` gate (§8.2, §8.3) move here.
  The co-build design is rewritten separately on top of this one.
- Related: tool naming (`2026-10-29-tool-naming-claude-code-design.md`), plugin and component
  management (`2026-11-05-plugin-component-management-design.md`), environments
  (`2026-11-07-environments-design.md`, on a branch), platform / org layering (on a branch).
- Markers: **(decided)** is the maintainer's answer in the 2026-11-07 discussion; **(designer's
  call)** is decided here and may be overturned in review. Items without a marker restate current
  code.
- Written in English (AGENTS.md "Language").

## 1. Why

Employee co-build needs a precondition: an agent has to understand the platform the way a person
does before it can help extend it **(decided)**. Today an agent knows its own tools and skills and
nothing else: it cannot tell a person which skills the org has, what a marketplace offers, how to
request a plugin, what extension points exist or how to write a skill or a plugin. A person finds
all of this on the web pages; the agent cannot.

The platform's own operations, with the permissions of the person in the conversation, should be
available to the agent **(decided)**. Then an agent can answer "what can this platform do", look
at the marketplace, request a plugin, create a skill, and know where the platform can be extended
and how. Writing extensions needs more than the operations (extension points, the SDK, authoring
rules); that knowledge is served as documentation through the same tool **(decided)**.

## 2. Goals, non-goals, anti-goals

Goals:

1. One builtin tool, `Platform`, through which an agent discovers and calls platform operations,
   acting as the person who started the run, never with more rights than that person
   **(decided)**.
2. Small, fixed context cost however many operations exist: discovery is layered and on demand
   **(decided)** (§4).
3. Writes are confirmed by the person (§6) **(decided)**.
4. A fence: a new feature cannot ship without its `Platform` operation or a recorded reason why
   agents must not have it (§9) **(decided)**.
5. The agent learns how to use the tool from the tool itself (a short method, §5) **(decided)**.
6. The authoring knowledge (extension points, plugin format, skill and template fields, tool
   naming) is served live and kept current by a gate (§8).

Non-goals:

- A second API. Operations call the same services the HTTP controllers call; there is no new
  business logic (§7).
- Letting agents do what only people may do: deciding approvals and requests, confirming extension
  permissions, managing tokens and secrets, changing roles (§6.4).
- Package uploads and submissions: the co-build design adds them as operations later.
- Making extensions contribute operations (a possible later extension point; §11).

Anti-goals (a failure even if it works):

- An agent does something the person did not see and confirm, or something the person could not
  have done on the web page.
- The tool's context cost grows with the number of operations.
- The platform gains a feature on the web and the agent silently does not know about it.

## 3. Shape

One builtin tool named `Platform` **(decided)**, PascalCase like the other builtins (tool naming
spec). It is a builtin like `Bash` or `Skill`: listed in `BuiltinTools`, selectable per agent.
Default: on for new agents **(designer's call:** reads are harmless and every write is confirmed).

An org setting `platformTool` (`on` / `read-only` / `off`, default `on`) lets an org admin limit it
for the whole org **(designer's call:** per-org builtin switches do not exist on `main`; the tool's
`unavailable` reason reports `off`, and `read-only` lists writes as unavailable). Finer control is
per agent (`toolPolicies`, §6.2).

Input (one schema, the `action` decides which fields apply):

| `action` | Fields | Returns |
|---|---|---|
| `browse` | none | The domains (one line each) and the method (§5) |
| `browse` | `domain` | The domain's operations: id, one line, `read` / `write`, and whether this person may call it now (with the reason when not) |
| `search` | `query` | Matching operations across domains, as in `browse` |
| `describe` | `operation` | The full definition: description, input JSON Schema, an example, the errors it can return with what to do next, related operations, and the confirmation class (§6) |
| `call` | `operation`, `params` | The operation's result |
| `read` | `topic` | A documentation topic (§8); `read` without a topic lists the topics |

Operation ids are `<domain>.<verb>` (`skills.list`, `marketplaces.add`) **(designer's call)**.
They are values of an input field, not tool keys, so the "tool keys contain no dots" rule does not
apply; display and policy keys are in §6.

## 4. Context cost

ToolSearch's catalog puts every unloaded tool with up to 200 characters of description in the
system prompt of every request. A hundred or more operations as separate tools would cost about
ten thousand tokens per request. With one tool, the cost is the tool's own definition; each layer
is paid only when the agent opens it (the root is a few hundred tokens, a domain a few hundred, a
`describe` one operation) **(decided)**.

Every result is an ordinary tool result in the event log, so replay needs nothing new: no
`DriftReason`, no `tools_changed`. Large results (long lists) are paged by the operation and, past
the tool output limit, archived like any tool output (`ReadToolOutput`).

## 5. The method

How to use the tool is taught in three places, from short to long **(decided)**:

1. The tool description, one paragraph: start with `browse`, then `describe` the operation, then
   `call`; never guess parameters; read docs with `read`.
2. The root `browse` result carries the rules **(designer's call** on the wording, English,
   model-visible):
   - Read before you write: list or get what you are about to change.
   - Before a write, tell the person in one sentence what you will do and why; the platform then
     asks them to confirm.
   - A declined confirmation means stop; do not retry the same change another way.
   - An operation you may not call is not a dead end: its reason says who can (an org admin, the
     super admin) and whether a request operation exists; offer that.
   - Errors say what to do next; follow them.
   - When unsure how the platform works, `read` the docs before acting.
3. Skills (the co-build builder skills) for whole tasks: writing a skill, a template, a plugin.
   They call `Platform` for live facts instead of restating them.

## 6. Who acts, and confirmation

### 6.1 The actor

The actor is the run's `trigger_account_id`, re-read on every call: membership and role in the
org are checked at call time, exactly as the HTTP guard would (`OrgGuard`, `can()`, the
`@SuperAdmin` check) **(decided)**. Sub-agents act for the same person. A shared agent acts for
whoever started the run, not for its owner.

Runs without a person present (scheduled or service-token runs, evals, a channel message from an
unlinked user) get read operations only; writes are listed as unavailable with the reason
**(decided)**. Evals never execute tools anyway (full-run replay uses recorded results). Which run
origins count as "a person present" is left to the builder, with that principle: a person who can
see and answer a confirmation.

Platform-scope operations (those authorized by `@SuperAdmin`) run only in a conversation with
the super admin's **own private agent**, and their results never carry other orgs' names or
details: affected or using orgs are given as counts ("used by 3 orgs"), and the admin console shows
which **(decided)**. Why: the tool runs inside one org's conversation and its results enter that
org's event log, which shared agents, trajectories and eval snapshots expose to other people.

### 6.2 Classes

Every operation has a confirmation class, fixed in code **(decided)**:

| Class | Examples | Default | Remember ("this conversation" / "always") |
|---|---|---|---|
| `read` | list skills, browse a marketplace, my requests, docs | runs | not needed |
| `personal` | edit my own agent, create a request, (co-build) submit | confirm each time | allowed |
| `org` / `platform` | add a marketplace source, enable a plugin in the org, change a scope, change org settings, create an org skill | confirm each time | **never** |
| human only | decide approvals and requests, confirm extension permissions, tokens, secrets, role changes | **not offered** | — |

Rules:

- The confirmation goes to the actor (`approvals.requested_for` = the trigger account), through
  the existing approval flow: the conversation page, the inbox, IM approval cards.
- Policies can only tighten: an agent's `toolPolicies` may set an operation (or the whole tool) to
  `deny`, and the org setting `platformTool` (§3) can make the tool read-only or off for the org;
  nothing can make a write run without confirmation **(designer's call)**. Per-operation org policies
  are not in phase 1.
- Grants and policies are keyed by operation, not by the tool: the pipeline gains a policy key
  derived from the input, `Platform:<operation>` **(designer's call** on the spelling; the
  mechanics, approvals and grants keyed by it, are the builder's). The model-visible key stays
  `Platform`.

### 6.3 What the person sees

- The card is rendered by the kernel from the operation and its parameters (a per-operation
  bilingual summary such as 添加市场源 `https://…`), never from text the model wrote. Display label
  `Platform [marketplaces.add]`, as the bracket display of the tool naming spec.
- The approval binds the exact parameters (their hash is part of the approval); what runs is what
  was shown.
- An operation whose web flow already has a preview with a hash (the super admin's platform plugin
  update with its `diffHash`, an uninstall's confirm preview, creating an agent from a template with
  its `previewHash`) takes that hash as a parameter, obtained from its preview operation, and the
  card shows the same preview. A stale hash fails like on the web. Operations whose web flow has no
  preview get none here: no new review logic is invented for the tool **(designer's call)**.
- An operation whose web flow needs input a person must type that the tool may not carry
  (connector credentials, secret extension config) is refused with a pointer to the web page; e.g.
  enabling a plugin in the org works through `plugins.enable` only when it needs no such input
  (P2-10's 需要配置 otherwise) **(designer's call)**.

### 6.4 Never offered

Excluded by class, and recorded in the fence (§9): decisions on approvals, requests, submissions;
extension permission confirmations; API tokens and service tokens; reading or writing secrets and
credentials (a connector's credentials are always entered by a person on the web); member roles,
invitations, ownership transfer, org deletion; login and account security. Results never contain
secrets or config values marked secret.

## 7. Operations

An operation is defined in kernel code next to its domain **(designer's call)**:

- `id`, English `description`, input as a zod schema (every string bounded; JSON Schema generated
  for `describe`), an example;
- its authorization: the org action (`ACTION_MIN_ROLE`) or `@SuperAdmin`, the same as the route it
  mirrors;
- `mirrors`: the HTTP route(s) it corresponds to (`POST /api/v1/orgs/:orgId/skills`);
- confirmation class (§6.2) and, for writes, the bilingual card summary;
- the handler: calls the same service method the controller calls, with the actor as the
  principal; writes stay `@Transactional()` service methods as today.

Audit rows of writes made through `Platform` record `via: "agent"` with the conversation, run and
operation **(designer's call)**, as `{ via, operation, agentConversationId, agentRunId }`: keys
distinct from the business fields, so a write about another conversation or run (an eval case, a
background task) keeps its own `conversationId` / `runId` in the row.

Errors are the existing `ApiError` codes, turned into actionable tool errors (the tool error check
applies). An operation that is unavailable says why and who can do it.

Phase 1 domains **(designer's call)**: what co-build and the maintainer's examples need first.

| Domain | Operations (indicative) |
|---|---|
| `platform` | overview (what the platform is, the tool families, what this person may do), `me` (this agent: model, tools, skills, sub-agents, environment) |
| `skills` | list, get, create (新建技能), switch on/off in the org |
| `agents` | list, get, create, update (my own), create from template (with its preview) |
| `agent-templates` | list, get, save as template |
| `plugins` | list (org view and, for super admins, the platform view), get, enable/disable in the org, update (super admin, with the diff) |
| `marketplaces` | list sources, browse entries, add a source (super admin), request a plugin (org admin) |
| `requests` | list mine, create (member → org admin, org admin → super admin) |
| `connectors` | list, get, list templates (creation with credentials stays on the web) |
| `extensions` | list in the org (state only), extension points |

The other routes are either added as operations or excluded with a reason in phase 1; the fence
(§9) makes the list complete from day one, so nothing is silently missing.

## 8. Documentation (`read`)

- Topics come from an agent docs directory published with the SDK
  (`packages/plugin-sdk/agent-docs/*.md`), versioned with the contracts they describe
  **(designer's call**, taken from the co-build design): the plugin layout and `plugin.json`, skills
  (`SKILL.md` frontmatter), agent templates (all fields, including the phase 4 ones), connector
  templates, tool naming, extension points (one topic each, from `EXTENSION_POINTS`), writing an
  extension, and the platform's concepts (platform and org, scope, owner and shareable, requests,
  environments).
- Field tables are generated from the JSON Schemas and registries (`pnpm gen:agent-docs`); prose is
  hand-written. `EXTENSION_POINTS` entries gain a `description` (SDK API change, changeset).
- Live facts (which extension points are registered on this deployment, which plugins exist) come
  from operations, not docs.

## 9. The fence

`check:platform-ops`, part of `pnpm check`, full on PRs (a cheap source scan of controllers and the
operation registry) **(decided** that a fence exists; **designer's call** on its rules):

- `platform-op-missing`: an HTTP route (any `@Get` / `@Post` / `@Put` / `@Patch` / `@Delete` in a
  controller) that no operation `mirrors` and that the exclusion list does not name;
- `platform-op-exclusion-reason`: an exclusion without a reason, or with a reason category not in
  the allowed set (`human-only`, `secret`, `transport` (SSE, uploads, embeds, webhooks, health),
  `internal`, `later` with an issue link; one issue per domain is enough **(designer's call)**);
- `platform-op-authz`: an operation whose authorization differs from its mirrored route's
  (`@OrgAction` action or `@SuperAdmin`). Where the route's decorator is only a floor and the
  service enforces the real role (e.g. the org catalog switch, `@OrgAction("catalog.read")` with
  `skills.manage` / `org.extensions.manage` checked inside), the operation declares the role it
  needs and has a test that a lower role is refused **(designer's call)**;
- `platform-op-orphan`: an operation or exclusion naming a route that no longer exists;
- `platform-op-describe`: an operation without an English description, an example, or a card
  summary when it writes.

`check:agent-docs` (moved from the co-build design): `agent-docs-stale` (generated sections out of
date), `agent-docs-missing` (an extension point, a `plugin.json` field, an agent or connector
template field without an entry), `agent-docs-orphan`. Both checks are proven red first on
fixtures, as every check, and documented in `tools/checks/README.md`.

The rule also goes where people and agents read it when they add features **(decided)**: a line in
AGENTS.md "Rules by area" ("a new HTTP route gets a `Platform` operation or an exclusion with a
reason (`check:platform-ops`)") and a section in the `writing-kernel-api` and `writing-tools`
skills.

## 10. Constraints

- Multi-replica: no state in process; operations are request-scoped like the controllers.
- Replay: everything model-visible is a tool result; the tool definition is fixed (the root's
  content is a result, not part of the definition).
- Language: model-visible text English; card summaries zh and en through i18n; zh UI terms (平台,
  超级管理员, 智能体).
- Depends on: platform / org layering and environments (both on branches) for the shape of some
  operations (`me`'s environment, org config). This work starts on `main` now (decided, 2026-11-07):
  `me` reports the sandbox as it is today, and whichever lands second adapts. When this merges
  first, the fence makes those branches classify the routes they add.

## 11. Left to the builder

- How the pipeline carries the per-operation policy key into approvals, grants and the policy
  editor's UI; the approval card component.
- The exact operation list beyond the indicative table, paging, result shapes.
- The run origins that count as "a person present".
- Whether a later extension point lets extensions add operations to `Platform` (their own tools
  already exist; this would only be for discoverability).

## 12. Acceptance

- A member asks "what can this platform do for me"; the agent `browse`s and answers from live data.
- A member asks for a skill that does X; the agent searches skills, finds none, offers to create
  one; the person confirms the card 新建技能 …; the skill exists in the org (if the member may) or
  the agent offers a request when they may not.
- An org admin asks to enable a plugin; the card shows the same permission review as the web; a
  stale review fails.
- A super admin asks to add a marketplace source; the card shows the URL; "always allow" is not
  offered.
- An agent run by a member never sees `marketplaces.add` as callable, and the reason names the
  super admin.
- A super admin's platform-scope operation is unavailable through a shared agent; through their
  private agent, a plugin update preview shows the number of affected orgs, never their names.
- A prompt-injected skill telling the agent to add a marketplace produces a card the person can
  decline; declining stops it.
- A scheduled run lists writes as unavailable.
- Adding a route without an operation or exclusion fails `check:platform-ops`; adding an extension
  point without docs fails `check:agent-docs`.

## 13. As built

Decisions made while building, one per bullet (what, and why).

- `PlatformModule` holds only the operation registry, `PlatformActor` and `AgentDocs` and imports no
  domain module. Domain providers register their operations from `onModuleInit`
  (`PlatformOperations.register`), which throws on a duplicate or malformed id, an unknown domain,
  or a write without a `summary`. This keeps the dependency pointing from domains to the registry.
- A run started with a personal access token counts as a person present: the token is the person's
  own credential and the confirmations reach their inbox. No `trigger_kind` column was added; a
  wake run counts as the person whose run it continues. If this turns out wrong, a migration adds
  the column later.
- "The super admin's own private agent" is judged on the root conversation's agent, because the log
  tree belongs to it; a sub-agent of a shared agent's conversation never counts as private. The
  runtime passes the agent id, never the model.
- A kernel `callPolicy` may be async, because the actor's facts need PG.
- For a `call` whose params fail the operation's schema, the per-call policy denies with "Invalid
  params ... call describe". The person is never asked to confirm a call that cannot run, at the
  cost of one extra model step.
- `agents.update` may edit shared (org or members visible) agents the actor may edit on the web,
  with the same rights as the web; its description says shared agents can be edited, visibility
  cannot be changed (the input has no `visibility`), and each change on a shared agent is confirmed
  every time. `PlatformOperation.confirmFor(input, ctx)` gives a call's class when it depends on the
  target: `agents.update` is `personal` (may be remembered) only on a private agent the actor owns
  and `org` (never remembered) otherwise, so a grant from a private-agent edit never covers a shared
  agent. A `confirmFor` that throws counts as `org`. Created agents are always private.
- `summary(input, ctx)` may be async and read PG: cards name the target (plugin display name, agent
  name, template name, the source agent of a template save) instead of an id, and the hash-bound
  operations add their preview as counts (`plugins.update`: components updated / added / removed
  and the orgs it is on in; `plugins.set-enabled` off: components removed and agents using it). A
  summary that throws falls back to `Platform operation <id>`. Names are clipped to 80 characters.
  `skills.create` with `shareable: true` says "(shared with other orgs / 可共享给其他组织)".
- A write whose `params` hold a `{"$output": id}` reference is denied with "pass the content
  inline": the approval stores and shows the input as sent, so the person would confirm a
  reference instead of what is written. The pipeline passes the unresolved input to `callPolicy`
  as `CallPolicyContext.rawInput`. Reads may take references.
- `platform.me` lists tools by the keys the model calls: builtins by name, `plugin__<plugin>__<tool>`,
  and each connector reference expanded to its live tools' `mcp__<slug>__<tool>` keys as
  `ToolRegistry.forAgent` resolves them; connector tools that cannot load now are listed as
  `unavailableTools` with the registry's reason.
- `describe` returns an operation's notable errors with what to do next: `PlatformOperation` has an
  optional `errors: { code, next }[]`, filled for the operations that have notable failures.
- Operations that can return more than 50 entries page themselves (`params.cursor`, result `{ items,
  next }`); a bare list is capped at 50 with the hint "Narrow the query or pass params.cursor where
  the operation pages".
- Connector operations always return the public endpoint and never `connectorData`, whatever the
  role, because the result enters a shared log; admins read full URLs on the web.
- Super admin plugin operations omit every item owned by another org (counted only) and refuse
  get, preview and update on them with "use the admin console", following §6.1: never other orgs'
  names or details.
- `extensions.points` needs `org.extensions.read`; provider names are shown only with
  `org.extensions.manage`, otherwise a `hasProvider` flag, as the existing routes do.
- `plugins.disable-preview` (a read) was added, and `plugins.set-enabled` with `enabled: false`
  requires its `confirm`, so a preview-only call never prompts the person.
- Read operations never prompt: a read's per-call policy is `allow` and is not a fixed ask. A read an
  agent tightened to `ask` (a `toolPolicies` entry on `Platform:<operation>`) asks once-only and no grant
  applies, like an org write.
- The `later` exclusions all point to one tracking issue, core#91 ("Platform operations: remaining
  routes", one section per domain), instead of one issue per domain (decided, 2026-11-08). The check
  reads `issue` as a literal, so each entry carries the URL inline. (Superseded: §14.6, Task 12 removed
  the `later` category and the `issue` field.)
- Routes added by platform / org layering, merged first, were classified when this branch merged
  `main`: the org config copies (`…/extensions/:extension/overrides`, the admin `org-overrides`) are
  `secret`, the per-org extension tool switches `later`.
- One changeset, `.changeset/platform-tool.md`, describes the feature for the release notes, covering the
  kernel, web and design changes. `platform-agent-docs.md` stays separate because it is the only one that
  bumps `@capybara-hq/plugin-sdk`, and `platform-inbox.md` is the unrelated platform inbox for the super
  admin.
- A second `Platform` call with different params while another call's approval is pending or
  approved never runs on that approval: approvals bind the exact input and each call has its own
  (`platform-e2e.test.ts`, case g).

## 14. Phase 2: parity with the UI (decided, 2026-11-08)

Source: the maintainer's acceptance of #94 in the running acceptance session (`fix/acceptance`, session
c9a4e7bf) and the decisions taken there on 2026-11-08. Everything in this section is **(decided,
2026-11-08)** unless marked **(designer's call)**. Where it changes §1–§13, this section wins.

### 14.1 Principles

1. **Parity with the UI.** What I can do in the UI, my agent can help me do, as me: the identity and
   rights are the person in the conversation, no more and no less. Reads run; writes use the three
   classes (`personal` / `org` / `platform`) as in §6.2.
2. **Sensitive writes stay off; their reads come on.** The §6.4 exclusions stay for writes: deciding
   approvals and requests, confirming extension permissions, tokens, the values of secrets and
   credentials, changing roles. Their reads are offered: "what is waiting for my approval", "which
   requests are pending", "which extensions wait for permission confirmation" — state and summaries
   only, never a secret or credential value.
3. **The super admin's agent sees the admin console and does its ordinary writes**: creating
   accounts, managing orgs, limits, and the like. Only the class of item 2 stays off. Every exclusion
   states its reason. The §6.1 rule stands: platform-scope operations run only through the super
   admin's own private agent, and other orgs' private items appear as counts.
4. **Always in sync.** When a route is added, changed or removed, its Platform capability follows:
   - **Add**: a new route gets an operation or an exclusion with a reason (the phase-1 fence).
   - **Change**: an operation's input (and, where it mirrors a route's response, its output) is not
     written a second time: it uses the route's schema or one derived from it, so a changed route
     field changes the operation. Where sharing is not possible, the check finds the difference.
   - **Remove**: when a route is removed, the operations that mirror it and its exclusion entry go
     too; the check reports "an operation mirrors a route that does not exist" and "an exclusion names
     a route that does not exist".
   AGENTS.md and `writing-kernel-api` state the three rules.

### 14.2 Scope

#### Every `later` route

The 138 `later` routes of core#91 are all done in batches by how often they are used, or turned into
exclusions with a reason. At least:

- **Conversations**: list mine, get, rename, archive / unarchive (`personal`, rememberable); delete is
  offered and confirmed every time (the maintainer's preference: a destructive personal write, never
  remembered) **(designer's call** on the class name: `personal` with `remember: false`).
- **Agent profile**: quick actions and the preset avatar (`personal`; on a shared agent confirmed every
  time, through `confirmFor` as `agents.update`). Uploading a custom avatar image stays off (byte
  upload, `transport`). `platform.me` and `agents.get` return the profile (description, quick
  actions, avatar). The run-context work (`docs/superpowers/specs/2026-11-08-run-context-design.md`,
  §3.5) moves the description into the versioned agent definition, edited by `agents.update`; the
  profile operations cover quick actions and the avatar only. This part is built on `main` after the
  run-context work merges.
- **Skills**: switch a skill on / off in the org. #94's description named it but the code has only
  list / get / create; add `skills.set-enabled` (the component switch, `org`).
- **Admin console (super admin)**: accounts (list, get, create a user, disable), orgs (list, get,
  limits read and write), extension deployment state, plugins and marketplaces, the platform inbox
  (read), models and the default model per purpose.
- **The other pages**: channels, members (read; role changes stay off), org settings, personal
  settings, evals, connectors (without credentials), and the rest of what core#91 lists.

#### Problems found in the acceptance

1. **State.** An installed extension that is not loaded (e.g. Anthropic without its deployment API
   key) shows as `off` in `plugins.list`, and `extensions.list` says `available: false` with no reason;
   the model concluded that switching it on in the org would do. A not-loaded extension is
   **unavailable with a reason** (e.g. `needs_deployment_config`), the same state and reason the web
   shows.
2. **Check before the card.** `plugins.set-enabled` showed the confirmation card and only after the
   approval failed with `catalog.not_deployed`. Every write runs its preconditions **before** the card:
   when it is known to fail, the tool returns the reason and no card appears. **(designer's call:** an
   optional `precheck(input, ctx)` on the operation, run in `callPolicy` after availability; it reads
   only, and a failure becomes `deny` with the precheck's reason.)
3. **Errors that are wrong or not actionable.** The error said "extension is not deployed; ask the
   super admin to install and enable it" while it was installed, only missing deployment config, and
   the person was the super admin. Errors say what is missing and give the next step for the actor's
   role (super admin: admin console → Extensions → Anthropic → fill in the API key; org admin: send a
   request). Every Platform error is checked against this standard.
4. **Exploration cost.** "How do I enable it" took 8 Platform calls, and `plugins.list` /
   `plugins.platform-list` returned long results. With accurate state one call should decide it;
   list results carry a compact row (id, name, state, reason, next step) and details come from `get`.
5. **Docs that look alike.** After the error the model read the "writing extensions" doc, which was
   unrelated. Topic titles make "writing an extension / building a plugin" (authoring) clearly
   different from using the platform; using the platform is covered by operations and errors.

### 14.3 Agent docs

- Their role does not change: how to implement extensions and build plugin packages (plugin format,
  extension points, skills, templates, tool naming). They do not describe how to use UI features;
  operations' descriptions and errors cover that.
- In step with the platform: `check:agent-docs` already reports extension points and fields that are
  missing or stale. Phase 2 makes sure both directions are caught — "in the code, not in the docs" and
  "in the docs, gone from the code" — for extension points and every plugin-format field, with a
  failing fixture for each.
- Retrieval: 21 topics, about 3,600 words; a table of contents plus reading by topic is enough, so no
  vector search. When the topics grow markedly, `read` gains keyword search returning matching
  paragraphs with their source.

### 14.4 Acceptance

In the acceptance session, by a checklist:

- For each domain of §14.2 at least one read and one write, including the card's class.
- The five problems of §14.2 reproduced and confirmed fixed.
- The super admin's agent creates a user and reads "waiting for my approval".
- The sync check has a test that turns it red for each of the three failures: a missing operation; an
  operation whose fields differ from its route's; a removed route whose operation is still there.

### 14.5 Answers to the builder check (2026-11-08)

1. **Admin console data in full** **(decided, 2026-11-08)**. Admin-console operations return the same
   data the admin console shows (accounts with login, name and email; orgs with name and member count;
   the platform inbox), and run only through the super admin's own private agent (§6.1). The org admins
   of the org that conversation lives in can read it in the trajectory viewer; that is accepted. Other
   orgs' private **plugins** keep the phase-1 rule (counts only, refused for get / update).
2. **Creating a user** **(decided, 2026-11-08)**. The agent passes no password. The kernel generates a
   one-time initial password, the account must change it at first login, and the password is shown
   only to the person, on the web, after they approve the card; the tool result the model receives
   carries no password. The super-admin flag on create or update counts as a role change and stays off
   **(designer's call)**.
3. **What the sync check compares** **(designer's call)**. Inputs only; outputs come from the same
   service methods the routes call, so they are not compared. Route body and query schemas move out of
   the controllers into exported schema modules, and an operation builds its input from them
   (`pick` / `omit` / `extend`). A runtime test in the checks suite compares each operation's input
   JSON Schema with its mirrored route's body + query + path params: a field present in both must have
   the same type; a route field the operation leaves out must be listed in the operation's `omits`; an
   operation field the route lacks (e.g. `cursor`, a preview hash) must be listed in its `extras`.
   Bounds may be stricter in the operation, never looser. The red fixtures cover a type mismatch, an
   undeclared omission and an undeclared extra.
4. **Not-loaded reasons in the org view** **(designer's call)**. `OrgExtensionView` gains the
   deployment status and a reason (`needs_deployment_config`, `failed`, `dependency`,
   `pending_approval`, `pending_migration`), derived like the admin view's; the org extensions API and
   page show it (state and reason only, never config). Members and org admins see the reason and a
   next step for their role; only super admins get the admin-console path.
5. **Every `later` route is done in phase 2**, as an operation or a permanent exclusion
   (`human-only` / `secret` / `transport` / `internal`) with a reason **(decided** in §14.2; the
   end state is the **designer's call)**: afterwards the fence rejects the `later` category, so a new
   route ships with its operation or a permanent exclusion. Delivered as a series of PRs by domain
   from one plan **(designer's call)**.
6. **Agent profile operations** are the last wave of this plan and start once the run-context work is
   on `main` **(designer's call)**.
7. **Error standard** **(designer's call)**. Enforced by a rule plus review: every operation's
   `errors[]` entry has a `next` step, role-specific where the next step differs by role (keys
   `superAdmin` / `orgAdmin` / `member`), and the tool maps an `ApiError` through the operation's
   entry when one exists. `check:platform-ops` gains `platform-op-errors` for entries without `next`;
   the acceptance and the final review check the wording.


### 14.6 As built (phase 2)

Plan `docs/superpowers/plans/2026-11-08-platform-tool-phase-2.md`, built in four waves (PRs #98,
#100, #101). One bullet per decision: what was decided — why.

**What was built**

- 179 operations in 20 domains; every other kernel route is excluded for good
  with a reason (`human-only` / `secret` / `transport` / `internal`). No `later` route remains:
  the category is gone from `ExclusionCategory` and `check:platform-ops` rule `platform-op-later`
  rejects any `later` entry (red fixture in `tools/checks/fixtures/platform-ops/violations`).
- Task 12, agent profile: `agents.update-profile` mirrors `PATCH …/agents/:agentId/profile` —
  a preset avatar (or none) and the quick actions, built from the route's shared schemas
  (`AgentProfileBody`, moved out of the controller into `agents.schemas.ts`); `confirmFor` as
  `agents.update` (personal on an own private agent, org otherwise), precheck "not found / not
  editable", role-keyed `forbidden`. `agents.get` already returned the profile (`AgentView`);
  `platform.me` now returns it too (avatar, description, quick actions). `agents.update` takes the
  description, saved with the definition (run context spec §3.5).
- Sync (§14.1 item 4): each mirrored route's body / query / params schemas are exported from
  `<domain>.schemas.ts` and registered in `ROUTE_SCHEMAS`; operations build their input from them. The
  parity test (`tools/checks/test/platform-parity.test.ts`, `inputParity`) compares types, bounds,
  patterns / formats and required-ness, recursively, with `omits` / `extras` / `renames` / `loosens`
  declared on the operation and checked for staleness. New check rules: `platform-op-errors`,
  `platform-op-orphan` (a mirror or exclusion of a removed route), `platform-op-double` (a route both
  mirrored and excluded), `platform-op-later`, `platform-op-session-only` (a `@SessionOnly()` route
  mirrored, or excluded other than `human-only` / `secret`).
- `precheck` on writes (read only, 2 s bound, skipped on a throw or timeout), run before the card and
  again when an approved call resumes; role-keyed `next` in `errors[]` (`superAdmin` / `orgAdmin` /
  `member`); compact list rows paged by 50.
- Not-loaded extensions are `unavailable` with a reason (`needs_deployment_config`, …) in the org view,
  `extensions.list`, `plugins.list` / `get`, the same as the web; one call decides "why can't I use
  it", with the next step for the caller's role.
- `accounts.create`: the kernel generates a one-time password sealed per run and call (migration
  0090, hourly `@LockedCron` cleanup of expired copies), the approver reads it once on the web
  (`POST …/approvals/:id/initial-password`), the account must change it first; it is absent from the
  tool result, events, approvals, audit and logs.
- Agent docs: titles say `Authoring:`; both directions (in the code but not the docs, in the docs but
  gone from the code) are caught for extension points and every plugin-format, connector-template and
  agent-template field; hand-written tables are checked for orphans only.
- End to end: `platform-e2e-phase2.test.ts` (the deployment-config repro per role, `accounts.create`,
  a member's `approvals.waiting`, `conversations.delete` asked every time). The three sync failures
  are red in the checks suite (§14.4).

**Rulings**

- Parity is a vitest test, not part of `pnpm check` — it imports the kernel's zod schemas, which the
  tsx source scans cannot evaluate; `tools/checks` runs on every PR that runs tests.
- A renamed path param (`skillId` → `:id`) is declared through `renames` — the input keeps a
  readable name while the parity test still compares it.
- Nested optional route fields left out of an input need no declaration; top-level ones need `omits`
  — declaring every nested field would add noise without catching real drift.
- `asToolError` was removed from the operations; a service `ApiError` propagates and the tool maps
  it — one path for every error. Tool-only codes (`marketplace.already_added`, `plugin.needs_input`,
  `agent.visibility_web_only`, `catalog.org_owned`, `account.self`, `account.no_change`) exist only
  as precheck denials — they describe tool policy, no route answers them.
- `marketplaces.add` refuses a duplicate URL in its precheck although the web accepts duplicates —
  a duplicate source is never what the person wants.
- No request kind reaches the super admin about deployment state; the org admin's next step is "tell
  the super admin" with the extension name and what is missing — a new request kind
  (`extension_setup`) is a new contract, left for the maintainer.
- Admin component scope / preview / disable / visibility are `platform` writes, not human-only —
  they are ordinary admin-console writes (§14.1 item 3).
- `PlatformOperation.rememberable?: false` (static) makes a write never remembered whatever its
  class; used by `conversations.delete` / `abort` / `stop-background-task`, `agents.delete`,
  `agents.delete-skill`, `environments.delete` / `reset-files` — replaces routing destructive personal writes through
  `confirmFor` → `org`, which mislabelled their rights.
- `conversations.abort` is offered (`personal`, never remembered, refuses the run's own root
  conversation) — parity with the web's stop button.
- Admin data in full: org names are shown for platform-owned items and the conversation org's own
  items (previews, scope lists, the orgs a component is on in, results); items owned by other orgs
  are counts and refusals only; this also applies to the phase-1 plugin operations — §14.5 item 1.
  The admin component list stays compact (orgs counted); write results and previews name them.
- Org-owned items, shared or not, are managed by their owner org; the super admin's agent refuses
  them while the console can — the agent acts in one org's log, where another org's items do not
  belong.
- A route both mirrored and excluded is a check finding (`platform-op-double`) — a mirrored
  human-only or secret route is a hole in the fence.
- `agents.update-profile` is one operation, not two (`set-avatar` / `set-quick-actions` in the
  plan) — the route is one PATCH, and one card can say both changes.
- It reads the profile's `updatedAt` itself just before the write and passes it as
  `expectedUpdatedAt` (declared in `omits`) — the person approves the change as shown on the card,
  not a guard on an earlier read; a save racing that read still answers `agent.profile_conflict`.
- `description` is not an input — the run-context work moved it into the agent definition, so the
  profile route dropped the field and `agents.update` takes it; `omits` names only
  `expectedUpdatedAt`.
- The avatar input is the route's `preset` variant only; the `upload` kind needs no declaration
  — an input accepting less than the route passes the parity test, and `omits` names top-level
  fields only. A custom image stays on the web (the upload route is `transport`).
- A profile write through the tool audits `channel: "agent"` plus the `viaAgent` detail — it
  said `web` for every non-token write before.
- `later` and the exclusion `issue` field are removed with `LATER_ALLOWED` — nothing uses them,
  and the rule still fails a `later` entry found by the source scan.
- The run-context work's preference routes are excluded, not mirrored (#91): `GET /me/preferences`
  is `internal` (the run context already gives the agent the zone in effect) and
  `PUT /me/preferences` `human-only` (a person's own setting).
- `evals.get-case` / `get-result` return metadata and scores, never conversation content — replay
  privacy (trajectories 404 to others, no export); copying a case into another log would be an
  export.
- Eval case titles (excerpts of a person's message) are conversation content, so results and cards
  use neutral labels — same privacy rule.
- `environments.delete` and `environments.reset-files` are offered (`personal`, never remembered,
  the card warns that files are destroyed and names the conversations that lose their sandbox) —
  parity, like `conversations.delete`. Both refuse in the precheck (`environment.current`) the
  environment the run's root conversation is bound to (sub-agents use the root's) — like
  `conversations.delete` refusing the root; a root still unbound binds at its first sandbox call, so
  nothing is refused for it.
- Audit detail of a tool write is `{ via: "agent", operation, agentConversationId, agentRunId }` —
  `conversationId` / `runId` in the same row stay the write's own business fields (an eval case's
  source run, a background task's conversation), which the old keys overwrote.
- A `@SessionOnly()` route is excluded as `human-only` or `secret`, never mirrored
  (`platform-op-session-only`) — a web-session-only route is a person's own act or carries a
  secret. A controller switching a mirrored route to a schema outside its `ROUTE_SCHEMAS` entry is
  caught by review only — tying a `@ZBody` / `@ZQuery` DTO back to the entry needs cross-file
  resolution the source scan does not do, and the parity test reads only the registered schemas.
- Two list shapes stay: offset pages (`pageOf`, `params.cursor`, `{ items, total, next }`) for
  lists read whole, and the route's keyset (`params.after`, `{ <items>, next }`, no total) for
  `accounts.list`, `conversations.list` / `subagents` / `files` and `evals.list-results` — the
  keyset routes cannot give a total cheaply, and unifying would change model-visible results for
  no gain; the skill documents both.
- The `Platform` tool description names the current families (fixed text; `browse` lists every
  domain) — tool definitions are read by spec hash from the log, so old requests replay unchanged
  and the zero-drift fixtures pin no description. The new description changes the tool's specHash
  once, so remembered `Platform` grants and approvals pending at deploy are asked again — never
  wrongly allowed.
- `platformTool` `off` / `read-only` takes effect on the next call — the setting is re-read per call
  like the actor's facts.
- `inbox.platform-list` reports the console's `total` (everything waiting, other orgs' items
  included) plus `listed` and `otherOrgItems` for the newest 100 it reads — past the window, other
  orgs' items cannot be told apart, so the count is never reduced by a guess.
- Process: wave 1 ran Tasks 1 and 4 in parallel, then 2, then 3 (they share files); in the domain
  waves the first task of a wave owned the shared registries (`exclusions.ts`,
  `platform-ops.module.ts`, `route-schemas.ts`) and the others' entries were merged after the wave —
  to avoid index collisions, at the cost of merge work.
- `browse` and `search` rows carry `params`, the operation's input keys (`plugins.get` shows
  `itemId`, `?` marks an optional key, a union's keys merged), derived from the shared input schema
  (decided 2026-11-08, after acceptance showed calls guessing `pluginId` or leaving out `agentId`).
  Types, bounds and the example stay in `describe`; the method line says to describe when unsure
  and never to send a key `params` does not list.

**Left open**

- Notice dismissals write no audit row (service behaviour, unchanged); whether every Platform write
  must audit is for the maintainer.
- A webhook-capable test plugin would cover the channels webhook success path.
