# Memory plugin

- Date: 2026-11-12.
- Status: draft, waiting for the maintainer's review. A builder check ran (2026-11-12); its two open
  questions were answered by the maintainer (pgvector stays, §6.4; deletion semantics, §6.5).
- Markers: **(decided)** is the maintainer's direction from the 2026-11-12 brainstorm;
  **(designer's call)** is a call made here that the maintainer may overturn.
- Scope: two deliveries. Core (this repository): a context extension point, the conversation source,
  durable lifecycle hooks, and pgvector in the images. `capybara-hq/plugins`: a new `memory` plugin.
  The kernel parts are general; `memory` is their first consumer.

## 1. Why

An agent forgets everything about a person between conversations. Members repeat the same
preferences ("reply in Chinese", "don't open PRs unless asked"), the same background (their role,
the project they are on), and the same pointers (where the test logins live). Claude Code solves this
with a small file-based memory the model keeps itself; members of this platform want the same thing
with their agents.

The architecture spec (`2026-10-17-capybara-architecture-design.md` §0.2) left memory out of the
kernel and pictured it as "external app + thin plugin". This design keeps it out of the kernel but
makes it a self-contained plugin with its own storage **(decided)**: the plugin owns the data, the
retrieval and the page; the kernel only gains general mechanisms another plugin could use too.

What the code offers today (verified on `main`, 2026-11-12):

- **Plugins can already**: keep their own tables (`ctx.db` on `plugin_<name>`, expand-only
  migrations), register tools (the call carries `orgId`, `accountId`, `agentId`, `conversationId`,
  `ToolCallContext` in `packages/plugin-sdk/src/tool.ts`), embed text through `ctx.models.embed`
  with a declared purpose (`permissions.models`, `kind: "embedding"`; org admins map the purpose to a
  model, the super admin sets the deployment default), and add a full page to the org navigation
  (`org.page` slot, `minRole: "member"`, accepts `view`, `embed` and `component`; the caller's role
  arrives with the render args and embed claims).
- **Plugins cannot**:
  1. put anything into the model's context. Hooks observe or deny (`HOOKS_AVAILABLE` in
     `packages/plugin-sdk/src/hooks.ts`); `agent.preStep` and `session.*` are reserved names that
     cannot be registered.
  2. tell a web conversation from a channel DM or a channel group. The `conversations` row has no
     source column; the link to a chat lives in `channel_threads` (`thread_key` is `dm:<externalId>`
     for a DM, `packages/kernel/src/channels/threads.ts:104`). Tools cannot be hidden per
     conversation either: `ToolRegistry.forAgent` (`packages/kernel/src/tools/registry.ts`) filters
     by org, config, org switch, the agent's `disabledTools` and sub-agent keys only.
  3. learn that a member left an org, an agent was deleted or an org was deleted. Offboarding
     (`packages/kernel/src/orgs/offboarding.ts`), agent soft delete
     (`packages/kernel/src/agents/agents.service.ts:1002`) and org soft delete
     (`packages/kernel/src/orgs/orgs.service.ts:254`) notify no extension; `org.deleted` on
     `KernelEventMap` is in-process and lossy. Plugin schemas are never cleaned per org.
  4. use vectors in PG: the images are `postgres:17` (`docker/compose.yaml`,
     `docker/compose.dev.yaml`, `packages/testing/src/containers.ts`), no migration runs
     `CREATE EXTENSION`.

## 2. Goals, non-goals, anti-goals

Goals:

- An agent remembers facts about **one member**, across that member's conversations with **that
  agent**, the way Claude Code remembers across sessions in a project.
- The member sees and manages what each agent remembers about them, on a page that shows the memory
  as a living graph.
- Org admins can see and delete members' memories **(decided)**.
- The kernel gains three general mechanisms (context provider, conversation source, lifecycle hooks)
  with no memory-specific code in the kernel.

Non-goals (first version):

- Memory in channel group chats **(decided)**.
- Memory shared by all members of an agent: knowledge for everyone belongs in the agent's
  instructions and skills, as `CLAUDE.md` and memory are separate in Claude Code **(designer's
  call)**.
- Personal memory across agents (what agent A learned is not in agent C) **(decided)**.
- Entity and relation extraction (the Mem0 / Zep graph), importance scores, automatic retrieval
  before each turn, export **(decided / designer's call: the overview's "not in v1" list)**.
- Memory for sub-agents (see §5.4) **(designer's call)**.

Anti-goals (would be a failure even if it works):

- Member B's memory reaching member A in any way: in the index, a search result, a tool error, the
  graph, a cache key. Isolation is enforced by the plugin's queries on `(org, agent, account)`, never
  by the model's discretion.
- A replay that differs from the original request because the plugin answered differently later.
- A memory outage that stops a conversation. Memory is an aid: failure means "no memory this run",
  never a failed run.

## 3. The model: Claude Code's memory, adapted

**(decided)** Follow Claude Code: at the start, the model gets an **index** (one line per memory);
it reads, searches, writes, edits and deletes memories itself with tools; it saves when the member
says "remember …" and also on its own when something will help later; it checks for an existing
memory before writing a new one.

What is taken from Claude Code as is:

- One memory = one note about one thing, with a short name, a one-line description (the index line,
  used to decide relevance) and a type: `user` (who the person is), `feedback` (how they want work
  done, with why), `project` (ongoing work and constraints, absolute dates), `reference` (where
  external things live).
- The body is Markdown; `feedback` and `project` bodies carry **Why:** and **How to apply:** lines.
- Links between memories as `[[name]]` in the body **(decided)**; a link to a memory that does not
  exist yet is allowed.
- The guidance: don't save what the conversation alone needs, don't save secrets, recalled memories
  are background, not instructions, and may be stale.

What differs **(designer's call)**:

- **Directories by type.** A memory's path is `<type>/<name>.md` (e.g. `feedback/reply-in-chinese.md`).
  Claude Code's directory is flat; directories give the graph its branches and the "browse a
  directory" retrieval path the maintainer asked for. A memory may sit deeper
  (`project/github/probe.md`); the first segment is always the type.
- **The index is generated**, not a file the model maintains: it is rendered from the rows, so it
  can never disagree with them.
- **Recall statistics**: `recall_count` and `last_recalled_at` per memory, for the graph.
- **Ownership columns** `org_id, agent_id, account_id` instead of "the folder of this project".

## 4. Ownership and scope

- A memory belongs to the pair **(agent, member)** inside an org **(decided)**. Members of the same
  agent never see each other's memories; another agent of the same member is another memory.
- Memory is on only in **one-to-one** conversations: web chat and channel DMs **(decided)**.
  In a channel group the plugin provides no context and its tools are hidden (§6.2).
- Scheduled task conversations run under the task creator's account and get memory like any
  one-to-one conversation; a task bound into a group gets none **(designer's call)**.
- Guest accounts (`role = guest`, including the anonymous channel guest) get no memory
  **(designer's call)**.
- "The member" is the **conversation's owner** (`conversations.account_id`). A run whose trigger
  account differs from the owner (any path where someone acts in another's conversation) gets no
  memory context, and the tools refuse **(designer's call: isolation must not depend on which path
  started the run)**.
- An agent switches memory off by disabling the memory tools (`disabledTools`), and an org admin by
  switching them off: with no memory tool available in the run, the plugin provides no context
  (§6.1 passes the run's tools) **(designer's call: no separate per-agent switch)**.
- A private copy of an agent made from a template is a new agent: memories are not copied
  **(designer's call)**.
- Eval conversations get none from the plugin: replays read the recorded context (§6.1).

## 5. The memory plugin (`capybara-hq/plugins`, `plugins/memory`)

An ordinary optional plugin (not a bootstrap entry: it ships client code). Off in every org until an
org switches it on.

### 5.1 Data (`plugin_memory`)

**(designer's call; names are the builder's)**

`memories`:

| column | notes |
|---|---|
| `id` | uuid |
| `org_id`, `agent_id`, `account_id` | ownership; every query filters on all three |
| `path` | `<type>/…/<name>.md`, unique per owner, ≤ 200 chars, lowercase `[a-z0-9-_/.]` plus CJK |
| `type` | `user` / `feedback` / `project` / `reference`, equals the first path segment |
| `description` | one line, ≤ 200 chars |
| `body` | Markdown, ≤ 8 KB |
| `tokens` | `tsvector` built from the plugin's segmentation (§5.3) |
| `embedding` | vector, null when no embedding model or not yet computed |
| `embedding_model` | `provider/id` of the vector, to detect stale vectors |
| `recall_count`, `last_recalled_at` | updated on read and on search hit |
| `created_at`, `updated_at`, `created_in` | `created_in` = conversation id, for the detail panel |

`memory_links`: `(from_id, to_path)` parsed from `[[…]]` on every write; resolved to a memory by path
at read time, so a dangling link becomes live when its target is written.

`admin_access_log`: one row per admin view of, or delete in, another member's memory (who, whose,
which agent, what, when). Not shown in v1; kept for audit questions **(designer's call)**.

Limits: 1,000 memories per owner pair; a write over the limit fails with an actionable tool error
telling the model to consolidate.

### 5.2 The context the plugin provides

At each run start the kernel asks the plugin for its context (§6.1). The plugin answers for
web / DM conversations of non-guest members only, and returns:

1. A fixed English block explaining the memory system to the model (types, when to save, what not
   to save, check before writing, links, recalled memories are background and may be stale, how to
   use the tools). Modeled on Claude Code's memory instructions.
2. The index: `- <path> — <description>` per memory, grouped by type directory, ordered by
   `recall_count` then `updated_at`. Cap: 200 lines or 16 KB; past the cap the index ends with
   "N more memories not listed; use search or view to find them, and consolidate".
3. When the owner has no memories: the block alone, with "no memories yet".

The plugin returns the same text whenever the data has not changed, so the kernel appends a new
event only when the index really changed (§6.1).

### 5.3 Tools

Model-visible keys `plugin__memory__<name>`; English descriptions and actionable errors
(writing-tools). **(designer's call: the names and shapes; the builder may refine)**

| tool | input | does |
|---|---|---|
| `view` | `path` (a directory or a memory; `/` for the root) | a directory: its entries with descriptions; a memory: its full text with its links (resolved or dangling). A read counts as a recall. |
| `search` | `query`, `limit ≤ 20` | hybrid search (below); returns path, description, a snippet. Each returned hit counts as a recall. |
| `write` | `path`, `description`, `body` | creates or replaces a memory; type comes from the path. Fails if the path's type segment is not one of the four. |
| `edit` | `path`, `old`, `new` | exact string replacement in the body (like `Edit`); `description` may be changed too. |
| `delete` | `path` | deletes; links pointing at it become dangling. |

All tools refuse with a clear error in a group or sub-agent conversation, for a guest, or when the
caller is not the conversation's owner (defence in depth; the kernel already hides them there,
§6.2; the role comes from the new `ToolCallContext.role`).

**Search (designer's call).** Both paths run when available and are merged by reciprocal rank
fusion:

- Keyword: text segmented in the plugin with `Intl.Segmenter` (`granularity: "word"`, locale from
  the text: `zh` for CJK, `en` otherwise; no dependency, works for Chinese), stored and queried as
  a `simple`-config `tsvector`. This replaces the `pg_trgm` idea of the brainstorm: one less PG
  extension, and real word boundaries for Chinese.
- Semantic: `ctx.models.embed` with purpose `memory.embed` (`inputType: "document"` on write,
  `"query"` on search), cosine distance over the owner's rows. Writes embed synchronously within the
  tool call (one short text); if embedding fails the memory is saved without a vector and a
  BullMQ job (`memory-embed`, job id `memory-embed-<memoryId>`) retries later. Rows whose
  `embedding_model` differs from the current model are re-embedded by the same job, lazily, when an
  owner's search finds stale rows.
- No embedding model mapped for the org → keyword only, no error.

**Embedding model choice (corrects the brainstorm).** The kernel already lets org admins map an
extension's model purpose to any enabled embedding model (and the super admin set the deployment
default), so the plugin declares the purpose `memory.embed` and adds no config field of its own. This
is the "configurable embedding model" the maintainer asked for.

### 5.4 Sub-agents

Sub-agent conversations get no memory context and no memory tools **(designer's call; changes the
overview page, which said they would)**. A sub-agent's definition may be a different agent, which
makes "whose memory" ambiguous, and Claude Code's sub-agents do not load memory either. The parent
can pass what it knows in the task prompt.

### 5.5 The memory page

An `org.page` contribution "记忆 / Memory" in "更多" **(decided)**, built as a client component
(`@capybara-hq/plugin-client`, L3) that draws the graph on a canvas and uses the design re-exports for
everything else; data through the plugin's server view and actions **(designer's call: component
over embed, so it follows the theme and the design system)**.

- Top bar: agent selector (agents the viewer has memories with; admins: all agents of the org),
  for admins a member selector, and a search box (the same hybrid search).
- Main area: the **directory neural tree** (option B, **decided**): the agent at the centre, the four
  type directories as branches (deeper directories as sub-branches), memories as leaves.
  - Node size = `recall_count`; brightness = `last_recalled_at` decaying with age; colour = type
    **(decided: the overview's recommendation was accepted)**.
  - Cross-branch edges: links written by the model (`[[…]]`) as solid lines, semantic neighbours
    (cosine above a threshold, top 3 per memory, computed from stored vectors) as faint dashed lines
    **(decided)**.
  - Nodes drift and can be dragged; edges carry a slow pulse (as in the brainstorm mockup).
- Side panel: the selected memory: path, type, description, body (Markdown), links, recalls, last
  used, created, and the conversation it was created in. Members can edit and delete their own;
  admins can delete any, and their view is logged (§5.1) **(decided: admins see and delete;
  designer's call: admins do not edit)**.
- A list view toggle for large memories (the graph is unreadable past a few hundred nodes).
- Empty, loading and no-access states follow the design system's templates; members see only their
  own memories; guests see no page (`minRole: "member"`).

### 5.6 Cleanup

The plugin registers the lifecycle hooks of §6.3 and deletes:

- `org.member_removed` → every memory of `(org, account)`.
- `agent.deleted` → every memory of `(org, agent)`.
- `org.deleted` → every row of the org.

Handlers are idempotent (a plain `DELETE … WHERE`).

## 6. Kernel changes (core)

### 6.1 The `context` extension point

A new extension point `context@1` **(designer's call: name and shape)**: multi-provider, orgScoped,
not brokered. A provider implements

```ts
interface ContextProvider {
  /** Context for this run, or null for none. Must not write; must be fast. */
  provide(req: ContextRequest): Promise<{ text: string } | null>;
}
interface ContextRequest {
  orgId: string;
  accountId: string;
  agentId: string;
  conversationId: string;
  runId: string;
  source: ConversationSource; // §6.2
  role: "owner" | "admin" | "member" | "guest";
  ownerAccountId: string;     // the conversation's owner; accountId is the run's trigger account
  tools: string[];            // this plugin's tool keys available in this run, after every filter
  config: unknown;            // the effective config for the org
  signal: AbortSignal;
}
```

Kernel behaviour:

- **When.** In `run-worker.ts`, at run start, right after `skillsCatalog.record` and
  `runContext.record` (the same "before the run is running" window). Only for `kind = "chat"`
  conversations; never for `eval` (replays use the recorded events) or `subagent` (§5.4).
- **Who.** Every provider of `context@1` enabled in the org with valid config, in plugin-name order,
  in parallel, each under a timeout (2 s) and the run's abort signal.
- **Fail open.** A provider that throws, times out or returns too much (cap 32 KB per provider) is
  skipped for this run and logged; the run continues. A previously recorded context from that
  provider stays in effect in the history.
- **Into the log.** A new event type `plugin_context` `{ plugin, text, hash }`, written like
  `run_context` (`RunContextService` is the template: `@Transactional`, conversation row
  `FOR UPDATE`, idem key `plugin_context:<runId>:<plugin>`). It is appended **only when the hash
  differs** from the last `plugin_context` of that plugin in the conversation, so a long DM
  conversation sees a new index only when memories changed, and the history stays append-only.
- **Rendered.** `build.ts` renders `plugin_context` as a system message at its position, wrapped in
  `<plugin-context plugin="memory">…</plugin-context>`; after a compaction summary the latest one per
  plugin is re-emitted, like `run_context`. A provider that later returns `null` (plugin switched off)
  produces an event with empty text, rendered as nothing, so the old text stops being re-emitted.
- **Replay.** The text is in the log, so the request rebuilds byte for byte and no `DriftReason` is
  needed (the same reasoning as `run_context`, `device_paths` and instruction files; AGENTS.md's
  "needs a `DriftReason`" is for inputs that are not fully recorded). Full-run replay
  (`evals/run-replay.ts`) seeds `plugin_context` events like `skills_catalog` and `run_context`. The
  zero-drift fixture tests get a case with a `plugin_context` event.
- **Permission.** Providing `context@1` is a manifest `provides` entry; the import review shows it as
  "adds text to the model's context in conversations of orgs that enable it".
- **Hooks.** The added text is model-visible and therefore reaches `model.request` hooks like any
  other part of the request; nothing else changes for hooks.

### 6.2 Conversation source

`ConversationSource = "web" | "channel_dm" | "channel_group" | "subagent"` **(designer's call)**:

- The source is **stored on the conversation row at creation** (new column `conversations.source`,
  never changed): channel inbound sets `channel_dm` / `channel_group` from the inbound `chatType`;
  a scheduled task's conversation takes `scheduled_tasks.chat.chatType` when the task targets a
  chat (the thread is bound only on the first outbound message, `schedules/fire.ts`, so it cannot be
  derived at run start); sub-agent dispatch sets `subagent`; everything else is `web`. The
  migration backfills existing rows from `channel_threads` **including archived thread rows**
  (`dm:` prefix → DM, other → group), `kind = 'subagent'` → `subagent`, the rest `web`.
- It is passed in `ContextRequest.source` and in `ToolCallContext.source`, and `ToolCallContext`
  also gains `role` (the caller's org role), both new fields.
- `ToolSpec` gains an optional `sources?: ConversationSource[]` (absent = all). `forAgent` gets the
  conversation's source and drops extension tools whose `sources` exclude it. The recorded
  `meta.tools` keeps replay consistent. The memory tools declare `["web", "channel_dm"]`, which also keeps them out of sub-agents (§5.4).
- SDK change: `pnpm gen:sdk-api` and a changeset for `@capybara-hq/plugin-sdk`.

### 6.3 Lifecycle hooks

Three new observe-only hook mount points, added to `HOOKS_AVAILABLE` **(designer's call)**:

| mount | payload | fired |
|---|---|---|
| `org.member_removed` | `{ orgId, accountId }` | after the offboarding transaction commits (remove, leave, directory offboard) |
| `agent.deleted` | `{ orgId, agentId }` | after the agent soft delete commits |
| `org.deleted` | `{ orgId }` | after the org soft delete commits |

- **Durable.** Delivery is a BullMQ job per (event, plugin) with a deterministic id
  (`lifecycle-<mount>-<subject>-<plugin>`), enqueued in `afterCommit`, consumed under
  `WorkerModule`, retried with backoff. The in-process `KernelEventMap` is not used.
- **Who receives.** Every loaded plugin that registered the mount and declared it in
  `permissions.hooks`, **whether or not the org has it enabled**: cleanup concerns data the plugin
  already holds. A plugin not loaded at delivery time (uninstalled) gets nothing.
- Handlers must be idempotent; the payload carries no personal data beyond ids.

### 6.4 pgvector

**(decided: switch the image; designer's call: how)**

- `docker/compose.yaml`, `docker/compose.dev.yaml` and the testcontainers image
  (`packages/testing/src/containers.ts`) move to `pgvector/pgvector:pg17`.
- A kernel migration runs `CREATE EXTENSION IF NOT EXISTS vector SCHEMA public` inside a `DO`
  block that (a) does nothing when `pg_available_extensions` does not list `vector`, (b) does nothing
  when the extension is already installed (in whatever schema a DBA put it), and (c) catches
  `insufficient_privilege` and only raises a notice, so a managed PG without pgvector, or without
  the right to create it, still starts. `SCHEMA public` matters: the kernel migrator's
  `search_path` is `capybara, public` (`packages/kernel/src/db/migrator.ts`), and a bare
  `CREATE EXTENSION` would put the type and `<=>` in `capybara`, invisible to plugin schemas (and
  `capybara.vector` in a plugin migration is flagged as a foreign schema).
- The memory plugin's migration creates `embedding vector` when the `vector` type is visible from
  its `search_path` (`plugin_memory, public`) and `embedding real[]` otherwise (one `DO` block); its
  search uses `<=>` with pgvector and computes cosine in the plugin otherwise. The `DO` block shows
  as a `dynamic_sql` warning in the import review; the plugin's README and the migration comment
  say why. An extension a DBA installed in another schema counts as absent (fallback path). Search is always scoped to one owner (≤ 1,000 rows), so no ANN
  index is needed in v1 and the vector column has no fixed dimension (different orgs may map
  different models).
- `docs/deploy` notes that pgvector is recommended, not required.

### 6.5 Deletion and the event log

**(decided: acceptable)** Deleting a memory, or a member leaving, removes rows from the plugin's
tables only. The event log is append-only: the next run appends a new index without the deleted
memory and the model goes by the newest one, but earlier `plugin_context` events and tool results
that showed the memory stay in that conversation's history (and in its trajectory and evals), as in
Claude Code. The delete confirmation on the memory page says so: "已删除的记忆不会再出现在新的索引里，
但之前对话中已出现的内容仍保留在那些对话的记录中。" (with the en string).

## 7. Multi-replica and safety

- No in-process state: the index is computed from PG at every `provide`; embedding retries and
  lifecycle deliveries are BullMQ jobs with deterministic ids and no `:`.
- Tool writes run in transactions; the embed call happens outside the transaction (an outside call
  inside a transaction would hold locks), the vector is written in a second short statement.
- Every query of the plugin carries `org_id, agent_id, account_id` from the call context, never from
  model input. The page's server view takes the owner from the caller (member) or from an explicit
  member selector only when the caller's role is `admin` or `owner`.
- The memory text is model-visible: the plugin never stores secrets on purpose (the guidance says
  not to), and the body limit keeps a pasted log from becoming a memory.

## 8. Testing

- Kernel: `context@1` (ordering, timeout, fail open, hash dedupe, re-emit after compaction, `null`
  after text, eval and sub-agent skip), zero-drift reconstruct and full-run replay with
  `plugin_context`, `sources` filtering in `forAgent`, lifecycle delivery (dual replica, once per
  plugin, retry, disabled-org delivery), the conditional `CREATE EXTENSION`. A fake extension under
  `packages/testing/fixtures/extensions/` provides `context@1` and the lifecycle hooks.
- Plugin: isolation tests (two members, two agents, every tool and the page view), group and guest
  refusal, links and dangling links, search with and without an embedding model (model-fake) and with
  and without pgvector, the index cap, recall counting, cleanup handlers, admin log.
- Page: component tests with the plugin-client fake host; a screenshot baseline through
  `visual-update`.

## 9. Delivery order

1. Core: `context@1`, conversation source + `ToolSpec.sources`, lifecycle hooks, pgvector images and
   migration; SDK changeset; release candidate.
2. Plugins: `memory` (data, tools, context provider, cleanup), then the page.

## 10. Left to the builder

Table and column names, the exact tool descriptions and the model-facing guidance text, the
semantic-neighbour threshold, the graph's physics and animation, how the source is stored, the order
of work inside each delivery.
