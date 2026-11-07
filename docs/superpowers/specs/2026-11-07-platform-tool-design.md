# The `Platform` tool: agents that understand and operate the platform

- Date: 2026-11-07, written against `main` at `76b32e10`.
- Status: draft for review.
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
operation **(designer's call)**.

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
  operations (`me`'s environment, org config). The plan is written after both merge, against
  `main` then **(designer's call)**; routes those branches add before that are classified by this
  work's first fence run.

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
