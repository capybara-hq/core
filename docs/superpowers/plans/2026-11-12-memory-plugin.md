# Memory Plugin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `memory` plugin in `capybara-hq/plugins` that gives agents Claude Code-style memory per
(agent × member): an index at run start, five tools, hybrid search, cleanup, and a "记忆" page with
the directory neural tree.

**Architecture:** One extension (`plugins/memory`). Server side: rows in `plugin_memory`, a
`context@1` provider that renders the guidance and index, tools `view / search / write / edit /
delete`, an embedding queue, lifecycle cleanup hooks, and an `org.page` server view with actions.
Client side: one `org.page` component that draws the graph on a canvas and the rest with the design
re-exports.

**Tech Stack:** TypeScript, `@capybara-hq/plugin-sdk`, `@capybara-hq/plugin-client` (React peer),
Kysely, PostgreSQL (+ pgvector when present), `Intl.Segmenter`, vitest, `@capybara-hq/testing`.

**Spec:** `capybara-hq/core` `docs/superpowers/specs/2026-11-12-memory-plugin-design.md` (§3–§5,
§6.4 plugin side, §6.5, §7). **Depends on** the core plan
`docs/superpowers/plans/2026-11-12-memory-kernel.md` being released as an SDK / kernel release
candidate (the plugin needs `context@1`, `ToolSpec.sources`, the new `ToolCallContext` fields and
the lifecycle hooks).

## Global Constraints

- Plugin name `memory`; tool keys `plugin__memory__<name>`; English tool descriptions and actionable
  `ToolError` messages (writing-tools in this repo).
- Types `user | feedback | project | reference`; path `<type>/…/<name>.md`, ≤ 200 chars, segments
  of lowercase `[a-z0-9-_.]` or CJK; first segment is the type.
- Limits: description ≤ 200 chars, body ≤ 8 KB (UTF-8), 1,000 memories per (org, agent, account),
  index ≤ 200 lines or 16 KB, search `limit` ≤ 20.
- Every query filters `org_id, agent_id, account_id` taken from the call context, never from tool
  input; the owner is `ToolCallContext.ownerAccountId` and must equal `accountId`.
- Memory only when `source ∈ {web, channel_dm}` and `role !== "guest"`; tools declare
  `sources: ["web","channel_dm"]`.
- Embedding purpose `memory.embed` (`kind: "embedding"`); no plugin config field for the model.
- Optional plugin, not bootstrap; ships client code.
- UI copy zh and en; zh says 智能体, never `agent`. Delete confirmation copy (spec §6.5), verbatim:
  zh "已删除的记忆不会再出现在新的索引里，但之前对话中已出现的内容仍保留在那些对话的记录中。"
  en "Deleted memories no longer appear in new indexes, but what earlier conversations already
  showed stays in those conversations' records."
- Multi-replica: no in-process state; queue job ids without `:`.
- Tests from the repo root: `pnpm exec vitest run plugins/memory/test/<file>`.

## Review Focus

1. **Cross-member leakage through a crafted path or query** (`../`, another member's path, SQL
   wildcards in `search`) → Task 2 and Task 4 isolation tests with two members and two agents.
2. **Chinese text with no spaces must be findable by a word inside it** ("回复用中文" by "中文")
   → Task 3 test.
3. **An org with no embedding model mapped, and a deployment without pgvector, must still search**
   → Task 3 tests on both paths.
4. **A long index (more than 200 memories) must truncate with the "N more" line, never exceed
   16 KB, and stay identical across runs when nothing changed** (else every run writes an event)
   → Task 5 tests (stable ordering, no timestamps in the text).
5. **An admin switching to another member on the page sees that member's memories, is logged, and
   cannot edit; a member cannot reach another member by crafting action args** → Task 7 tests.

---

### Task 1: Package, migration, path rules

**Files:**
- Create: `plugins/memory/package.json`, `tsconfig.json`, `icon.svg`, `README.md`, `CHANGELOG.md`
- Create: `plugins/memory/migrations/0001_init.sql`
- Create: `plugins/memory/src/paths.ts`
- Create: `plugins/memory/src/index.ts` (manifest skeleton: `name: "memory"`, `provides: ["context@1"]`, `migrations: "../migrations"`, `permissions` for tools, models `[{purpose:"memory.embed", kind:"embedding", label:{zh:"记忆检索", en:"Memory search"}}]`, hooks the three lifecycle mounts, ui the page component)
- Test: `plugins/memory/test/paths.test.ts`, `plugins/memory/test/migration.test.ts`

**Interfaces:**
- Produces:
  - Tables `memories` (spec §5.1 columns; `embedding` is `vector` when the type resolves from `plugin_memory, public`, else `real[]`; unique `(org_id, agent_id, account_id, path)`; index `(org_id, agent_id, account_id)`; `tokens tsvector` with a GIN index), `memory_links (memory_id uuid, to_path text, PK both, ON DELETE CASCADE)`, `memory_neighbors (memory_id uuid, neighbor_id uuid, score real, PK both, both ON DELETE CASCADE)`, `owners (org_id, agent_id, account_id, agent_name, owner_name, seen_at; PK the three ids)`, `admin_access_log (id, org_id, admin_account_id, owner_account_id, agent_id, action text CHECK IN ('view','delete'), memory_path text null, at timestamptz)`.
  - `parsePath(path: string): { ok: true; path: string; type: MemoryType; dirs: string[]; name: string } | { ok: false; error: string }` — normalises (trim, lowercase ASCII, strip leading `/`, append `.md` if missing), rejects `..`, empty segments, a non-type first segment, > 200 chars; errors are English and actionable.
  - `parseLinks(body: string): string[]` — `[[name]]` targets, normalised by `parsePath` rules (bare name → resolved later by name match), deduped, ≤ 50.

- [ ] **Step 1: Write failing tests**: `parsePath("feedback/Reply-In-Chinese")` → `feedback/reply-in-chinese.md`; `"notes/x.md"` → error naming the four types; `"user/../x"` rejected; CJK segment `project/记忆插件.md` accepted; `parseLinks("see [[a]] and [[user/b.md]] [[a]]")` → `["a","user/b.md"]`. Migration test (pgvector container): column type is `vector`; (plain `postgres:17` container): `real[]`.
- [ ] **Step 2: Run** `pnpm exec vitest run plugins/memory/test/paths.test.ts plugins/memory/test/migration.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** the package, the migration (one `DO` block choosing the column type; a comment explaining the `dynamic_sql` review warning), `paths.ts`.
- [ ] **Step 4: Run** the tests and `pnpm check` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(memory): scaffold the plugin, schema and path rules`.

### Task 2: The store

**Files:**
- Create: `plugins/memory/src/store.ts`
- Test: `plugins/memory/test/store.test.ts`

**Interfaces:**
- Consumes: Task 1 tables, `parsePath`, `parseLinks`.
- Produces (all take `owner: Owner = { orgId; agentId; accountId }` first):
  - `list(db, owner, dir?: string): Promise<MemoryRow[]>`; `get(db, owner, path)`; `put(db, owner, { path, description, body, conversationId }): Promise<{ row: MemoryRow; created: boolean }>` (replaces links; enforces limits and the 1,000 cap with `MemoryLimitError`); `edit(db, owner, path, old, next, description?)` (exactly one occurrence, else `MemoryEditError` with the count); `remove(db, owner, path): Promise<boolean>`; `touch(db, owner, ids: string[])` (`recall_count += 1`, `last_recalled_at = now()`); `linksOf(db, owner, id): Promise<{ path: string; target: MemoryRow | null }[]>` (resolves a bare name to the unique memory with that file name, else dangling); `purge(db, filter: { orgId; agentId?; accountId? }): Promise<number>` (also deletes matching `owners` rows); `rememberOwner(db, owner, names: { agentName; ownerName })` (upsert).
  - `MemoryRow` = the row minus `tokens`, `embedding` as `number[] | null`.

- [ ] **Step 1: Write failing tests**: put → get round trip; put on an existing path replaces and keeps `recall_count`; two owners with the same path are independent (and `list` / `get` / `remove` of owner A never see owner B, across agent and across member); 1,001st put fails with the cap message; edit with zero or two matches fails with the count; links resolve and dangle; `purge({orgId, accountId})` removes that member's rows in every agent only.
- [ ] **Step 2: Run** `pnpm exec vitest run plugins/memory/test/store.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** (writes in one transaction each; no embedding here).
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `feat(memory): store memories per agent and member`.

### Task 3: Segmentation, embeddings and hybrid search

**Files:**
- Create: `plugins/memory/src/segment.ts`, `plugins/memory/src/embed.ts`, `plugins/memory/src/search.ts`
- Modify: `plugins/memory/src/store.ts` (`put` / `edit` write `tokens`)
- Test: `plugins/memory/test/segment.test.ts`, `plugins/memory/test/search.test.ts`

**Interfaces:**
- Consumes: Task 2 store.
- Produces:
  - `segment(text: string): string[]` — `Intl.Segmenter` word granularity, locale `zh` for runs of CJK and `en` otherwise; lowercase; keeps `isWordLike` segments; also emits CJK bigrams of each CJK word longer than 2 chars (so "中文" matches inside "用中文"). Stored as `to_tsvector('simple', <space-joined tokens>)` over path + description + body.
  - `embedMemory(ctx, owner, row): Promise<void>` — `ctx.models.embed({ orgId, purpose: "memory.embed", input: [description + "\n" + body], inputType: "document" })`; writes `embedding`, `embedding_model`, then recomputes `memory_neighbors` for that row (top 3 by cosine ≥ **0.75** among the owner's rows, both directions). Errors `model.unconfigured` → return silently; others → `ctx.queue.add("memory-embed", { memoryId }, { jobId: "memory-embed-" + memoryId, delayMs: 30000 })`.
  - Queue `memory-embed` handler: re-loads the row, calls `embedMemory`; stale rows (`embedding_model` ≠ current `ctx.models.describe`) found by a search are enqueued the same way.
  - `search(ctx, db, owner, query, limit): Promise<{ row: MemoryRow; snippet: string; score: number }[]>` — keyword rank (`ts_rank` on `plainto_tsquery('simple', segment(query))`) and, when a model is mapped, cosine rank (`<=>` when the column is `vector`, else computed in TS over the owner's rows); merged by reciprocal rank fusion `Σ 1/(60 + rank)`; ties by `updated_at` desc; `touch`es the returned ids.

- [ ] **Step 1: Write failing tests**: `segment("回复一律用中文")` contains `"中文"`; `segment("Reply in Chinese")` → `["reply","in","chinese"]`; search "中文" finds `feedback/reply-in-chinese.md` whose body is "回复一律用中文" with no model mapped; with model-fake embeddings mapped, a query sharing no word but close in vector space ranks the right memory first; same on a `real[]` schema; another owner's matching memory never appears; `%` and `_` in the query are plain text; neighbours: two near-identical memories become neighbours, a dissimilar one does not.
- [ ] **Step 2: Run** `pnpm exec vitest run plugins/memory/test/segment.test.ts plugins/memory/test/search.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `feat(memory): hybrid keyword and vector search`.

### Task 4: Tools

**Files:**
- Create: `plugins/memory/src/tools.ts`
- Modify: `plugins/memory/src/index.ts` (register)
- Test: `plugins/memory/test/tools.test.ts`

**Interfaces:**
- Consumes: Tasks 2–3.
- Produces: five `ToolSpec`s with `sources: ["web","channel_dm"]` and handlers, inputs as spec §5.3. Shared guard `ownerOf(callCtx): Owner` throws `ToolError` when `source` is not web / DM, `role === "guest"`, or `ownerAccountId !== accountId` ("Memory is only available in one-to-one conversations with their owner.").
  - `view`: `/` or a directory → lines `<path> — <description>` (dirs end with `/`); a memory → `path`, `description`, body, `Links:` lines (`→ <path>` or `→ <name> (not written yet)`); touches the row.
  - `write`: success text says "created" or "updated" and lists dangling links; then `embedMemory` (not awaited past 5 s: on timeout enqueue).
  - `edit`, `delete`: concise success; errors from the store mapped to `ToolError` text.
  - `search`: numbered hits `path — description` + snippet (≤ 200 chars).

- [ ] **Step 1: Write failing tests** with a fake `ToolCallContext`: each tool's happy path; guest, group, sub-agent and owner ≠ trigger each refused with the message above; `write` to `notes/x` fails naming the types; `view` of another owner's existing path says not found; `write` returns dangling links.
- [ ] **Step 2: Run** `pnpm exec vitest run plugins/memory/test/tools.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** with descriptions modelled on Claude Code's memory guidance (when to save, check before writing, one fact per memory, `Why:` / `How to apply:` for feedback and project).
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `feat(memory): memory tools`.

### Task 5: The context provider

**Files:**
- Create: `plugins/memory/src/context.ts`
- Modify: `plugins/memory/src/index.ts` (`ctx.provide("context@1", …)`)
- Test: `plugins/memory/test/context.test.ts`

**Interfaces:**
- Consumes: Task 1 `ContextProvider`, Task 2 `list`.
- Produces: `provideMemoryContext(db, req: ContextRequest): Promise<ContextResult>` — `null` unless `source ∈ {web, channel_dm}`, `role !== "guest"`, `ownerAccountId === accountId` and `req.tools` contains at least one `plugin__memory__*`; else `{ text: GUIDANCE + "\n\n" + index }`. Always (even when returning `null` for lack of tools) upserts `owners` via `rememberOwner` when source and role qualify. `GUIDANCE` is a fixed English constant in `context.ts` (spec §5.2 item 1). Index: grouped by type in the order user, feedback, project, reference; within a type `recall_count desc, path asc` (**no timestamps in the text**); line `- <path> — <description>`; stop before 200 lines or 16 KB and add `- … N more memories not listed; use plugin__memory__search or plugin__memory__view to find them, and consolidate.`; empty → `No memories yet.`

- [ ] **Step 1: Write failing tests**: group / sub-agent / guest / no memory tool → `null`; text contains the guidance and the lines in the order above; 250 memories → 200 lines + the "50 more" line and ≤ 16 KB; two calls with no data change → identical text; a `touch` that changes no order → identical text.
- [ ] **Step 2: Run** `pnpm exec vitest run plugins/memory/test/context.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `feat(memory): provide the memory index as context`.

### Task 6: Cleanup hooks and the kernel end-to-end test

**Files:**
- Create: `plugins/memory/src/cleanup.ts`
- Modify: `plugins/memory/src/index.ts`
- Test: `plugins/memory/test/kernel.http.test.ts` (pattern: `plugins/todo/test/kernel.http.test.ts`)

**Interfaces:**
- Consumes: Task 2 `purge`; lifecycle mounts from the SDK.
- Produces: observe handlers `org.member_removed → purge({orgId, accountId})`, `agent.deleted → purge({orgId, agentId})`, `org.deleted → purge({orgId})`.

- [ ] **Step 1: Write failing tests** through a real test kernel with model-fake: run 1 in a web conversation scripts `plugin__memory__write`; run 2 in a **new** conversation's request contains a system message with `<plugin-context plugin="memory">` listing that path; a channel group conversation (fake-im) has neither the context nor the tools; removing the member deletes their rows; deleting the agent deletes its rows.
- [ ] **Step 2: Run** `pnpm exec vitest run plugins/memory/test/kernel.http.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `feat(memory): clean up on member, agent and org removal`.

### Task 7: Page server view and actions

**Files:**
- Create: `plugins/memory/src/page.ts`
- Modify: `plugins/memory/src/index.ts` (`ui` contribution `{ id: "memory-page", slot: "org.page", kind: "component", title: { zh: "记忆", en: "Memory" }, icon: "brain" }` with its server view `ctx.ui.view("memory-page", …)` and `ctx.ui.action("memory-page", …)`)
- Test: `plugins/memory/test/page.test.ts`

**Interfaces:**
- Consumes: Tasks 2–3.
- Produces: view data `MemoryPageData = { canAdmin: boolean; agents: {id; name}[]; members?: {id; name}[]; selection: { agentId: string | null; accountId: string }; nodes: GraphNode[]; edges: GraphEdge[]; truncated: boolean }` where `GraphNode = { id; path; type; description; recalls: number; lastRecalledAt: string | null; dir: string }`, `GraphEdge = { from; to; kind: "link" | "semantic"; score?: number }`; nodes capped at 1,000.
  Actions (`args.actionId`): `select {agentId, accountId?}` → `{ view }`; `open {memoryId}` → `{ view }` with `detail: { body; links; createdAt; createdIn; updatedAt }`; `search {query}` → `{ view }` with `hits`; `edit {memoryId, description, body}`; `delete {memoryId}`.
  Authorization: `accountId` other than the caller only when `role ∈ {admin, owner}`; admins: `edit` refused; every admin `select` / `open` of another member writes `admin_access_log` (`view`), every admin `delete` writes (`delete`). Agent and member names come from `owners` (spec §5.1); `agents` lists the caller's own owner rows, admins get every agent and member of the org from `owners`.

- [ ] **Step 1: Write failing tests**: member sees only own nodes; member `select` with another `accountId` → refused; admin `select` another member → nodes of that member and one log row; admin `edit` → refused; admin `delete` → deleted and logged; edges include `link` (resolved only) and `semantic` from `memory_neighbors`.
- [ ] **Step 2: Run** `pnpm exec vitest run plugins/memory/test/page.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `feat(memory): memory page data and actions`.

### Task 8: The page component (directory neural tree)

**Files:**
- Create: `plugins/memory/src/client/index.tsx` (`defineClientExtension` with `defineComponent("org.page", MemoryPage)`), `plugins/memory/src/client/graph.ts` (layout + canvas drawing, framework-free), `plugins/memory/src/client/i18n.ts`
- Test: `plugins/memory/test/client.test.tsx` (plugin-client `/testing` fake host), `plugins/memory/test/graph.test.ts`

**Interfaces:**
- Consumes: Task 7 `MemoryPageData` and actions via `useView` / `useAction`.
- Produces: the page: top bar (agent select, member select when `canAdmin`, search), canvas graph, side panel (detail, edit for own, delete with the confirmation copy from Global Constraints), list toggle; empty / loading / no-access states from the design re-exports.
  - `graph.ts`: `layout(data): Sim` — agent node at centre; a node per directory (from `dir` segments) linked to its parent; memory leaves linked to their directory; `link` edges solid, `semantic` edges dashed and faint; radius `4 + 1.2·√recalls` (cap 18); brightness `max(0.25, exp(-ageDays/30))` from `lastRecalledAt` (null → 0.25); colour by type from theme tokens (not literals); `step(sim, dt)` force simulation (repulsion, spring, centring); `prefers-reduced-motion` → no pulse, layout settles once.

- [ ] **Step 1: Write failing tests**: `graph.test.ts` — layout has 1 agent + 4 type dirs + nested dir + leaves with the right parent edges; radius / brightness at 0, 9, 100 recalls and 0 / 30 / 365 days; `client.test.tsx` — renders nodes count, clicking a node calls `open`, delete shows the exact confirmation copy, admin sees the member select and no edit button, reduced motion stops animation.
- [ ] **Step 2: Run** `pnpm exec vitest run plugins/memory/test/graph.test.ts plugins/memory/test/client.test.tsx` — Expected: FAIL.
- [ ] **Step 3: Implement**, following the client CSS rules and `data-cap-part` literal rule (writing-extension-ui in this repo).
- [ ] **Step 4: Run** the tests and `capybara-plugin check` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(memory): directory neural tree page`.

### Task 9: README, marketplace, release

**Files:**
- Modify: `plugins/memory/README.md` (what it does, permissions, the `dynamic_sql` warning reason, pgvector optional, embedding purpose mapping, deletion semantics)
- Modify: the marketplace listing (`pnpm check:marketplace`)
- Create: a changeset for `@capybara-hq/plugin-memory`

- [ ] **Step 1: Write them.**
- [ ] **Step 2: Run** `pnpm verify` — Expected: PASS.
- [ ] **Step 3: Commit** `docs(memory): readme and release notes`.
