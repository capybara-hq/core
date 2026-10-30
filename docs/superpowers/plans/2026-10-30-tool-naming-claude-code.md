# Tool Naming and Display Aligned with Claude Code Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every model-visible tool key follows Claude Code: builtins are `Bash`, `Read`, `Write`,
`Edit`, `Glob`, `Grep`, `Deliver`, `Skill`, `SkillWrite`, `AskUserQuestion`, `ReadToolOutput`,
`ToolSearch`, `Agent` with Claude Code's parameters; connector tools are
`mcp__<slug>__<tool>`; extension tools are `plugin__<plugin>__<tool>`. `Skill` takes `args`;
`Write` and `Edit` require a prior `Read`. The UI shows tools as the Claude Code VS Code
extension does. Release-candidate data keeps working, and old recordings replay with zero drift.

**Architecture:** One key grammar lives in the SDK (`tool-key.ts`, pure) and the kernel builds and
parses every key through it. Builtin names are constants in one kernel module. One frozen legacy
map (`tools/legacy-keys.ts`) translates release-candidate keys and inputs wherever stored
configuration, in-flight calls and full-run replay meet them. Logs are never rewritten. The
read-before-write rule is decided from file digests recorded in the display-only
`tool_result.view`, so every replica decides it from PG.

**Tech Stack:** TypeScript, pnpm monorepo, NestJS + Fastify kernel (Kysely/PG, BullMQ), LangGraph
loop, Next + `@capybara-hq/design`, vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-29-tool-naming-claude-code-design.md` (decisions 1–9 at
its top; re-checked against `main` at `02b9634b`). Read the spec before any task: section numbers
below (§n) refer to it.

## Global Constraints

- Builtin keys match `^[A-Z][A-Za-z]{1,31}$`. Connector keys are `mcp__<slug>__<tool>`.
  Extension keys are `plugin__<plugin>__<tool>`. Every key matches `^[a-zA-Z0-9_-]{1,64}$`; a
  longer key is reported, never cut (§3).
- No old name stays callable by the model. Old keys appear only in `tools/legacy-keys.ts`,
  `runtime/context/legacy-text.ts`, applied migrations, pre-rename fixtures and historical docs.
- The event log is append-only: no task rewrites `conversation_events`, eval snapshots or audit
  rows.
- Model-visible text is English and quoted from the spec where the spec quotes it (§4.3, §4.5,
  §6).
- Kernel code follows `writing-kernel-api`: `@Injectable` providers with explicit `@Inject`,
  `@Transactional` writes, no enqueue or Redis call inside a transaction; `pnpm check` runs the
  `kc-*` rules.
- The SDK imports no `@capybara-hq/*` package; web imports only `@capybara-hq/design` (so web keeps
  its own copy of the key grammar and builtin names).
- Web pages write no styles; design changes go through `docs/design/spec.md` and the visual
  baselines (`writing-web-ui`).
- Run single tests from the repo root: `pnpm exec vitest run <path>`.
- Commits are Conventional Commits, body lines ≤ 100 characters, ending with
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **A conversation started on a release candidate continues after the upgrade**: its history has
   `sandbox_bash` calls, the new request offers `Bash`. Expected: the request is accepted and the
   model's next call uses `Bash`; a call to `sandbox_bash` gets the §4.3 hint. Test in Task 6.
2. **A call waiting for approval across the upgrade** (logged as `sandbox_edit` with `path` /
   `oldText`) is approved after the upgrade. Expected: it runs as `Edit` with translated input
   and its result is written under the logged key. Test in Task 6.
3. **An ambiguous old key**: the org has a connector slug `todo` and the `todo` extension, and a
   grant holds `todo__write`. Expected: the migration leaves it, logs
   `tools.legacy_key_unmapped`, and the grant no longer applies (the person is asked). Test in
   Task 7.
4. **Read-before-write edge paths**: `/workspace/./a.txt` read, `/workspace/a.txt` edited; a file
   read with `offset` / `limit` only; a file larger than `Read`'s byte limit. Expected: the path is
   normalized, a partial read counts as a read, and the digest compares the bytes `Read` read.
   Tests in Task 5.
5. **`Grep` pagination past the end** (`offset` beyond the last match). Expected: an explicit
   "no more results (N total)" text, not "No matches". Test in Task 3.

## File map

| Area | Files |
|---|---|
| Key grammar | `packages/plugin-sdk/src/tool-key.ts` (new), `packages/kernel/src/tools/naming.ts`, `apps/web/src/lib/tool-key.ts` (new) |
| Builtin names | `packages/kernel/src/tools/builtin-names.ts` (new), `tools/builtins/**`, `tools/builtins/builtin-tools.ts` |
| Legacy | `packages/kernel/src/tools/legacy-keys.ts` (new), `packages/kernel/src/runtime/context/legacy-text.ts` (new) |
| Read-before-write | `packages/kernel/src/tools/builtins/sandbox/file-state.ts` (new), `read.ts`, `write.ts`, `edit.ts`, `conversations/events.ts` (`ToolViewSchema`) |
| Data | `packages/kernel/src/migrations/0063_tool_keys_claude_code.sql` (new), `agents/definition.ts`, `agents/templates.ts`, `catalog/*`, `evals/snapshot.ts` |
| Replay | `evals/recorded-tools.ts`, `evals/diff.ts`, `runtime/context/build.ts`, `runtime/context/skills.ts`, `tools/builtins/tool-search.ts` |
| Display | `packages/design/src/conversation/tool-row.tsx`, `tool-copy.ts`, `docs/design/spec.md`, `apps/web/src/lib/timeline.ts`, `apps/web/src/lib/tool-label.ts` (new), the surfaces of §7.2, `packages/kernel/src/channels/cards.ts`, `apps/web/messages/{en,zh}.json` |
| Checks | `tools/checks/src/terms.ts`, `packages/plugin-tools/src/check/plugin-tool-keys.ts` (new) |

---

### Task 1: Key grammar and the `mcp__` / `plugin__` prefixes

**Files:**
- Create: `packages/plugin-sdk/src/tool-key.ts`; `apps/web/src/lib/tool-key.ts`
- Modify: `packages/plugin-sdk/src/index.ts`; `packages/kernel/src/tools/naming.ts` (remove
  `toolKey`, keep `toolKeyIssue`, `TOOL_KEY_RE`, slug rules); every builder and splitter from the
  spec's §3.1 list: `tools/registry.ts`, `tools/connectors.service.ts`, `tools/drift.ts`,
  `tools/info.ts`, `tools/resources.ts`, `tools/approvals.service.ts`, `channels/cards.ts`
  (`shortToolName`), `runtime/subagents/definition.ts` (`narrowTools`),
  `tools/builtins/tool-search.ts` (`tokenize`); web `components/conversation/PropertiesSections.tsx`
  (`slugOf`, and the `sandbox_` prefix test replaced by `info.kind`), `lib/subagents.ts`
- Modify (tests and fixtures): every test, e2e spec and model-fake script that names an
  `x__y` key (`docs__search` -> `mcp__docs__search`, `todo__write` -> `plugin__todo__write`), and
  `packages/design/src/fixtures/index.ts`
- Test: `packages/plugin-sdk/test/tool-key.test.ts` (new), `packages/kernel/test/tools/naming.test.ts`,
  `packages/kernel/test/tools/tool-search.test.ts`, `apps/web/test/tool-key.test.ts` (new)

**Interfaces:**
- Produces (SDK, exported):
  ```ts
  export type ParsedToolKey =
    | { kind: "builtin"; name: string }
    | { kind: "connector"; slug: string; tool: string }
    | { kind: "extension"; plugin: string; tool: string };
  export const BUILTIN_TOOL_NAME_RE: RegExp; // /^[A-Z][A-Za-z]{1,31}$/
  export function parseToolKey(key: string): ParsedToolKey | null;
  export function connectorToolKey(slug: string, tool: string): string; // "mcp__" + slug + "__" + tool
  export function extensionToolKey(plugin: string, tool: string): string; // "plugin__" + plugin + "__" + tool
  ```
  `parseToolKey` returns `builtin` only for a name matching `BUILTIN_TOOL_NAME_RE` (so an old
  `sandbox_bash` parses to `null`), and `null` for any key whose family is not `mcp` / `plugin` or
  whose parts are empty.
- Produces (web): the same three functions in `apps/web/src/lib/tool-key.ts`, same vectors.

- [ ] **Step 1: Write the failing tests** (`tool-key.test.ts`, SDK and web share one vector table):
  - `parseToolKey("Bash")` → builtin `Bash`; `"sandbox_bash"`, `"bash"`, `"Ba_sh"` → `null`.
  - `"mcp__crm__search_accounts"` → connector `crm` / `search_accounts`;
    `"mcp__crm__list_resources"` → connector `crm` / `list_resources`.
  - `"plugin__todo__write"` → extension `todo` / `write`; `"plugin__object-store-s3__x"` →
    extension `object-store-s3` / `x`.
  - `"mcp__plugin__x"` → connector `plugin` / `x` (no collision); `"docs__search"`,
    `"mcp____x"`, `"plugin__a"` → `null`.
  - `connectorToolKey("crm", "search")` === `"mcp__crm__search"`; round trip for every vector.
  - Kernel `naming.test.ts`: `toolKeyIssue(connectorToolKey("a".repeat(24), "b".repeat(34)))`
    reports 65 characters; `"b".repeat(33)` is fine.
  - `tool-search.test.ts`: a query `"mcp"` does not score every connector tool equally above a
    builtin (the family token is dropped).
- [ ] **Step 2: Run** `pnpm exec vitest run packages/plugin-sdk/test/tool-key.test.ts packages/kernel/test/tools/naming.test.ts packages/kernel/test/tools/tool-search.test.ts apps/web/test/tool-key.test.ts` — FAIL.
- [ ] **Step 3: Implement** the SDK module and the web copy; switch every builder to
  `connectorToolKey` / `extensionToolKey` and every split to `parseToolKey`. `narrowTools`
  matches a connector template entry by `parsed.kind === "connector" && parsed.slug === c.slug`.
  `tokenize` skips the first token when the key parses as connector or extension.
- [ ] **Step 4: Update** the tests, e2e specs, model-fake scripts and design fixtures that name
  `x__y` keys (search: `rg -l '"[a-z0-9_-]+__[a-zA-Z0-9_-]+"' packages apps plugins`).
- [ ] **Step 5: Run** `pnpm typecheck && pnpm exec vitest run packages/kernel/test/tools packages/kernel/test/runtime packages/kernel/test/channels apps/web/test packages/plugin-sdk/test` — PASS.
- [ ] **Step 6: Update** the SDK doc comments of the hook payloads' `toolKey` (`hooks.ts`) to state
  the grammar and point to `parseToolKey`; regenerate the SDK API report (`pnpm gen:sdk-api`) and
  add a changeset bumping `@capybara-hq/plugin-sdk` and `@capybara-hq/kernel`.
- [ ] **Step 7: Commit** `feat(tools): connector keys mcp__<slug>__<tool>, extension keys plugin__<plugin>__<tool>`

### Task 2: Builtin names

**Files:**
- Create: `packages/kernel/src/tools/builtin-names.ts`; `packages/kernel/src/tools/legacy-keys.ts`
  (only `LEGACY_BUILTINS` here; Task 6 adds the functions); `packages/kernel/src/runtime/context/legacy-text.ts`
  (the pre-rename texts of `SKILLS_CATALOG_HEADER`, the skills change / current / invoked /
  pinned texts and `CATALOG_HEADER`, copied verbatim from `main` at `02b9634b`, frozen)
- Modify (replay of system text): `runtime/context/build.ts` passes
  `usesLegacyToolNames(recordedTools)` to the text renderers, which pick the legacy or the new
  text
- Modify: every builtin in `tools/builtins/**` (`spec.name`, descriptions and error texts that name
  other builtins); the constants listed in spec §4.1 (`SANDBOX_TOOL_NAMES`,
  `SANDBOX_ASK_TOOL_NAMES`, `BUILTIN_TOOL_NAMES`, `R3_FIXED_ASK_TOOL_KEYS`,
  `R3_SHARED_AGENT_ONLY_TOOL_KEYS`, `CHILD_REMOVED_TOOLS`, `DEFAULT_AGENT_TOOLS`, `SKILL_LOAD`,
  `TOOL_SEARCH`, `AGENT_TOOL`, `BUILTIN_TOOL_KINDS`) now import from the new module;
  `runtime/context/skills.ts`, `tools/builtins/tool-search.ts` (`CATALOG_HEADER`,
  `notLoadedText`), `tools/pipeline.ts` (`unknownToolText`), `tools/outputs.ts`,
  `tools/elicitation.ts`, `skills/invoke.ts`, SDK `skill-invocation.ts` (the `skill_load` /
  `sandbox_bash` mentions); web `lib/agents.ts` (`BUILTIN_TOOLS`), `lib/timeline.ts`,
  `components/AgentSubagents.tsx`; tests and model-fake scripts naming builtins
- Test: `packages/kernel/test/tools/builtin-names.test.ts` (new), existing builtin tests

**Interfaces:**
- Produces (`tools/builtin-names.ts`, plain constants):
  ```ts
  export const BUILTIN = {
    Bash: "Bash", Read: "Read", Write: "Write", Edit: "Edit", Glob: "Glob", Grep: "Grep",
    Deliver: "Deliver", Skill: "Skill", SkillWrite: "SkillWrite",
    AskUserQuestion: "AskUserQuestion", ReadToolOutput: "ReadToolOutput",
    ToolSearch: "ToolSearch", Agent: "Agent",
  } as const;
  export type BuiltinName = (typeof BUILTIN)[keyof typeof BUILTIN];
  export const BUILTIN_TOOL_NAMES: readonly BuiltinName[];
  export const SANDBOX_TOOL_NAMES: readonly BuiltinName[]; // Bash Read Write Edit Glob Grep Deliver
  export const SANDBOX_ASK_TOOL_NAMES: ReadonlySet<string>; // Bash Write Edit Deliver
  ```
- Produces (`tools/legacy-keys.ts`, frozen):
  ```ts
  export interface LegacyBuiltin { name: BuiltinName; params: Readonly<Record<string, string>>; msParams?: readonly string[] }
  export const LEGACY_BUILTINS: Readonly<Record<string, LegacyBuiltin>>; // the 13 old names
  ```
  Param maps: `path→file_path` (read, write, edit, deliver), `oldText→old_string`,
  `newText→new_string`, `replaceAll→replace_all`, `ignoreCase→-i`, `timeoutSeconds→timeout`
  (`msParams: ["timeout"]`, value × 1000), `name→skill` (skill_load), `limit→max_results`
  (tool_search).
- Produces (`runtime/context/legacy-text.ts`):
  `usesLegacyToolNames(tools: readonly { key: string }[]): boolean` — true when the run's
  recorded tool keys contain a `LEGACY_BUILTINS` key.
- Consumes: `BUILTIN_TOOL_NAME_RE` (Task 1).

- [ ] **Step 1: Write the failing test** `builtin-names.test.ts`:
  - every value of `BUILTIN` matches `BUILTIN_TOOL_NAME_RE` and equals its key;
  - the `spec.name` of every tool `BuiltinTools.list()` returns is in `BUILTIN_TOOL_NAMES`, and
    together they equal it;
  - the web copy (`apps/web/src/lib/agents.ts`, read as text) names exactly the builtins it
    lists today under their new names (`AskUserQuestion`, `ReadToolOutput`, `SkillWrite`);
  - no builtin's description or schema description contains `sandbox_`, `skill_load`,
    `skill_write`, `tool_search`, `ask_user`, `read_tool_output` or the word `agent` used as a
    tool name (a regex list in the test).
  - `reconstruct.test.ts`: the existing fixtures still reconstruct with no drift (their recorded
    tools hold old keys, so the legacy texts render); a new recording made after the rename
    renders the new texts and also reconstructs with no drift.
- [ ] **Step 2: Run** `pnpm exec vitest run packages/kernel/test/tools/builtin-names.test.ts` — FAIL.
- [ ] **Step 3: Implement** the renames and move the constants. Rewrite every model-visible
  sentence that names a builtin with the new name; keep the meaning. The tool design check
  (`pnpm exec vitest run packages/plugin-tools/test/tool-design.test.ts` and the kernel's
  builtin design test) must pass.
- [ ] **Step 4: Update** the tests, model-fake scripts (`tool:sandbox_bash` -> `tool:Bash`, …),
  web e2e support (`apps/web/e2e/support/chat.ts` and the specs the spec inventory lists) and
  the i18n label keys `builtin.ask_user` / `builtin.read_tool_output` / `builtin.skill_write` ->
  `builtin.AskUserQuestion` / `builtin.ReadToolOutput` / `builtin.SkillWrite` (zh and en).
- [ ] **Step 5: Run** `pnpm typecheck && pnpm check && pnpm exec vitest run packages/kernel/test apps/web/test` — PASS, the zero-drift fixtures included.
- [ ] **Step 6: Commit** `feat(tools): builtins take Claude Code names`

### Task 3: Builtin parameters

**Files:**
- Modify: `tools/builtins/sandbox/{bash,read,write,edit,grep,deliver}.ts`,
  `tools/builtins/skill-load.ts` (`name` -> `skill` only; `args` is Task 4),
  `tools/builtins/tool-search.ts` (`limit` -> `max_results`), `tools/info.ts` keyArgs,
  `evals/recorded-tools.ts` (`MATCH_IGNORED_FIELDS` key `Bash`)
- Test: `packages/kernel/test/tools/sandbox/sandbox-tools.test.ts`,
  `packages/kernel/test/tools/tool-search.test.ts`, `packages/kernel/test/skills/skills-runtime.test.ts`

**Interfaces:**
- Produces the input schemas of spec §4.2, exactly. `Grep`:
  `{ pattern; path?; glob?; "-i"?: boolean; output_mode?: "content" | "files_with_matches" | "count"; "-n"?: boolean; "-A"?: integer ≥ 0; "-B"?: integer ≥ 0; "-C"?: integer ≥ 0; head_limit?: integer ≥ 0; offset?: integer ≥ 0 }`,
  defaults `output_mode: "files_with_matches"`, `-n: true` (content mode), `head_limit: 250`,
  `offset: 0`; `head_limit: 0` means up to the existing 500-line cap. `Bash.timeout` is
  milliseconds, clamped to `sandbox.limits.maxCommandSeconds * 1000`.
- Produces keyArgs: Bash `["command"]`, Read / Write / Edit / Deliver `["file_path"]`, Glob
  `["pattern"]`, Grep `["pattern", "path"]`, Skill `["skill"]`.

- [ ] **Step 1: Write the failing tests** (`sandbox-tools.test.ts`, on the sandbox-fake fixture):
  - `Edit({ file_path, old_string, new_string })` replaces one occurrence; `replace_all: true`
    replaces all; the old field names are a validation error naming `file_path`.
  - `Read({ file_path, offset: 2, limit: 1 })` returns `     2\t<line>`.
  - `Write({ file_path, content })` creates a file.
  - `Grep` default returns file paths only; `output_mode: "count"` returns `path:count` lines;
    `output_mode: "content", "-C": 1` returns context lines with line numbers; `head_limit: 1`
    returns one entry and says more exist; `offset` past the end returns
    `No more results (3 total).` (Review Focus 5).
  - `Bash({ command, description, timeout: 1500 })` stops after ~1.5 s with the timed-out view;
    `timeout` above the deployment maximum is clamped and the result says so.
  - `Deliver({ file_path })` delivers; its description no longer suggests `zip` (the sandbox image
    has none) but `tar -czf` with `Bash`.
  - `ToolSearch({ query, max_results: 2 })` returns two tools.
  - `Skill({ skill })` loads a skill as `skill_load({ name })` did.
- [ ] **Step 2: Run** `pnpm exec vitest run packages/kernel/test/tools/sandbox/sandbox-tools.test.ts packages/kernel/test/tools/tool-search.test.ts packages/kernel/test/skills/skills-runtime.test.ts` — FAIL.
- [ ] **Step 3: Implement.** Grep builds its `grep` command line from the options (`-l` for
  `files_with_matches`, `-c` for `count`, `-n`, `-A/-B/-C`), then applies `offset` and
  `head_limit` to the output lines in the kernel. Confirm the flags exist in the sandbox-docker
  image's grep (GNU) and BusyBox (E2B base); note the result in the commit body.
- [ ] **Step 4: Run** the step 2 tests and `pnpm exec vitest run packages/kernel/test/tools packages/kernel/test/skills` — PASS.
- [ ] **Step 5: Commit** `feat(tools): builtin parameters follow Claude Code`

### Task 4: `Skill` takes `args`

**Files:**
- Modify: `packages/kernel/src/tools/builtins/skill-load.ts`
- Test: `packages/kernel/test/skills/skills-runtime.test.ts`,
  `packages/kernel/test/skills/manual-invocation.e2e.test.ts`

**Interfaces:**
- Consumes: SDK `renderSkillBody(body, invocation, args, skillName)` and `invocationOf(manifest)`
  (`skills/catalog.ts`).
- Produces: `Skill` input `{ skill: string (1–64); args?: string (≤ 10 000) }`; the instructions
  in the result are `renderSkillBody(body, invocationOf(manifest), args ?? "", name)`, limited to
  200 000 characters (the phase D limit and its error).

- [ ] **Step 1: Write the failing tests:**
  - A skill whose body has `Fix issue $ARGUMENTS[0] in $1`: `Skill({ skill, args: "123 api" })`
    returns `Fix issue 123 in api`.
  - A body without placeholders: `args: "x y"` appends `ARGUMENTS: x y`, as a person's invocation
    renders.
  - No `args`: `$ARGUMENTS` renders empty; no literal `$ARGUMENTS` reaches the result.
  - `args` of 10 001 characters is a validation error.
  - The same skill invoked by a person with `/name 123 api` renders the same body text.
- [ ] **Step 2: Run** `pnpm exec vitest run packages/kernel/test/skills/skills-runtime.test.ts` — FAIL.
- [ ] **Step 3: Implement** in `skill-load.ts`; the file list and the sandbox copy are unchanged.
- [ ] **Step 4: Run** `pnpm exec vitest run packages/kernel/test/skills` — PASS.
- [ ] **Step 5: Commit** `feat(tools): Skill renders the skill with args`

### Task 5: Read before `Write` and `Edit`

**Files:**
- Create: `packages/kernel/src/tools/builtins/sandbox/file-state.ts`
- Modify: `sandbox/read.ts`, `sandbox/write.ts`, `sandbox/edit.ts`; `conversations/events.ts`
  (`ToolViewSchema`: optional `file` on `read` and `edit` views); `tools/view.ts` if the view type
  lives there
- Test: `packages/kernel/test/tools/sandbox/read-before-write.test.ts` (new); a dual-replica case
  in `packages/kernel/test/tools/sandbox/read-before-write.dual.test.ts` (new)

**Interfaces:**
- Produces:
  ```ts
  export interface FileState { size: number; sha256: string }
  export function fileStateOf(bytes: Uint8Array, fullSize: number): FileState;
  export function normalizeSandboxPath(path: string): string; // posix normalize, absolute
  export async function lastFileState(log: EventLog, conversationId: string, path: string): Promise<FileState | null>;
  export const NOT_READ_TEXT = "File has not been read yet. Read it first before writing to it.";
  export const MODIFIED_TEXT = "File has been modified since it was read, either by the user or by another command. Read it again before writing to it.";
  ```
  `lastFileState` reads the latest `tool_result` of this conversation whose `view.path` equals
  the normalized path and whose `view.file` is set (one indexed query on `conversation_events`;
  add an expression index in Task 7's migration only if the plan's EXPLAIN shows a sequential scan
  on a conversation with 10 000 events).
- `read` / `edit` views gain `file?: { size: number; sha256: string }` (display only; never in
  compaction or requests).

- [ ] **Step 1: Write the failing tests** (`read-before-write.test.ts`, sandbox-fake):
  - `Edit` on an existing file with no prior `Read` → error `NOT_READ_TEXT`, file unchanged.
  - `Read` then `Edit` → succeeds; a second `Edit` right after succeeds (its own result recorded
    the new state).
  - `Read`, then `Bash` appends to the file, then `Edit` → `MODIFIED_TEXT`; `Read` again, `Edit`
    succeeds.
  - `Write` to a new path → succeeds without a read; `Write` to an existing unread file →
    `NOT_READ_TEXT`.
  - `Read({ file_path: "/workspace/./a.txt", offset: 5, limit: 2 })` then
    `Edit({ file_path: "/workspace/a.txt", … })` → succeeds (Review Focus 4).
  - A file larger than `Read`'s byte limit: `Read`, then `Edit` succeeds; a change beyond the
    read bytes that keeps the size equal is not detected, and the test documents that limit.
  - A `tool_result` without `view.file` (a pre-change read) counts as not read.
- [ ] **Step 2: Write the dual-replica test:** `Read` handled on replica A, `Edit` on replica B
  succeeds; a `Bash` change through B then `Edit` on A fails with `MODIFIED_TEXT`.
- [ ] **Step 3: Run** `pnpm exec vitest run packages/kernel/test/tools/sandbox/read-before-write.test.ts packages/kernel/test/tools/sandbox/read-before-write.dual.test.ts` — FAIL.
- [ ] **Step 4: Implement.** `Read`, `Write`, `Edit` put `file` in their views from the bytes they
  read or wrote; `Write` and `Edit` call `lastFileState` before writing and compare with the
  content they already read. Add both error texts to the tools' descriptions in one sentence:
  "Read the file first; editing a file you have not read, or one changed since you read it, fails."
- [ ] **Step 5: Run** the step 3 tests and `pnpm exec vitest run packages/kernel/test/tools/sandbox packages/kernel/test/evals/reconstruct.test.ts` — PASS (the view is display-only, so reconstruct is unaffected).
- [ ] **Step 6: Commit** `feat(tools): Write and Edit require a prior Read`

### Task 6: Legacy map, the unknown-tool hint, in-flight calls

**Files:**
- Modify: `packages/kernel/src/tools/legacy-keys.ts`, `packages/kernel/src/tools/pipeline.ts`
  (`runCall`, `unknownToolText`)
- Test: `packages/kernel/test/tools/legacy-keys.test.ts` (new),
  `packages/kernel/test/tools/pipeline.test.ts`

**Interfaces:**
- Consumes: `LEGACY_BUILTINS` (Task 2).
- Produces (added to `tools/legacy-keys.ts`):
  ```ts
  export interface LegacyScope { connectorSlugs: ReadonlySet<string>; extensionNames: ReadonlySet<string> }
  export function legacyToolKey(key: string, scope?: LegacyScope): string | null;
  export function legacyToolInput(oldKey: string, input: unknown): unknown;
  export function legacyHint(key: string): string | null;
  ```
  `legacyToolKey` maps builtins without a scope; `<x>__<tool>` maps to
  `mcp__x__tool` when `x` is only a connector slug in scope, `plugin__x__tool` when only an
  extension name, else `null`. `legacyHint("sandbox_bash")` is
  `Tool "sandbox_bash" no longer exists; it is now "Bash" (parameters: command, description, timeout in milliseconds).`

- [ ] **Step 1: Write the failing tests:**
  - `legacy-keys.test.ts`: every old builtin maps to its new name; `legacyToolInput("sandbox_edit", { path, oldText, newText, replaceAll: true })`
    equals `{ file_path, old_string, new_string, replace_all: true }`; `timeoutSeconds: 3` →
    `timeout: 3000`; `"todo__write"` with both scopes holding `todo` → `null`; with only the
    extension → `plugin__todo__write`; a new key → `null`.
  - `pipeline.test.ts`: a model call naming `sandbox_bash` (the request that issued it offered
    `Bash`) gets an error whose text is `legacyHint("sandbox_bash")` (Review Focus 1).
  - `pipeline.test.ts`: a call `sandbox_edit` issued by a request whose recorded tools held
    `sandbox_edit`, waiting for approval, is approved after the tools were renamed: it runs as
    `Edit` with translated input, and its `tool_result.toolKey` is the logged `sandbox_edit`
    (Review Focus 2).
- [ ] **Step 2: Run** `pnpm exec vitest run packages/kernel/test/tools/legacy-keys.test.ts packages/kernel/test/tools/pipeline.test.ts` — FAIL.
- [ ] **Step 3: Implement.** In `runCall`, when no current tool has `call.name`: if
  `sentTools(ctx)` contains `call.name` (the request that issued the call offered the old key, so
  the call predates the upgrade) and `legacyToolKey` resolves it to a current tool, run that tool
  with `legacyToolInput` and write the result under `call.name`; otherwise append
  `legacyHint(call.name)` to the unknown-tool text when it is non-null.
- [ ] **Step 4: Run** the step 2 tests and `pnpm exec vitest run packages/kernel/test/tools` — PASS.
- [ ] **Step 5: Commit** `feat(tools): resolve release-candidate tool keys in flight and hint the new names`

### Task 7: Stored data: migration and read normalizers

**Files:**
- Create: `packages/kernel/src/migrations/0063_tool_keys_claude_code.sql`
- Modify: `agents/definition.ts` (a `normalizeToolKeys` preprocess next to `normalizeToolRef`),
  `agents/templates.ts` / `catalog/*` readers of template tool lists, `evals/snapshot.ts`
  (candidate definitions), the agent save validation (`agents/agents.service.ts`:
  `tool_not_selected` names the new key)
- Test: `packages/kernel/test/tools/legacy-data.test.ts` (new),
  `packages/kernel/test/tools/rename-compat.test.ts`

**Interfaces:**
- Consumes: `LEGACY_BUILTINS`, `legacyToolKey` (Task 6).
- Produces: `normalizeToolKeys(definition: unknown, scope: LegacyScope): unknown` in
  `agents/definition.ts`, applied wherever a stored definition or template is parsed; the scope
  comes from the org's connector slugs and the deployment's extension names, read once per parse
  call.
- Migration (one transaction, with the destructive-statement exemption comment and reason of
  `writing-migrations`): rewrites `tool_grants.tool_key`, `conversation_tool_grants.tool_key`,
  pending `approvals.tool_key` and pending `questions.spec->>'toolKey'` — builtins by a `VALUES`
  map; `<slug>__…` by a join on `connectors.slug` of the row's org when no extension of that name
  is installed; `<name>__…` by `extension_installs` when no connector slug matches. Unmapped rows
  stay.
- Startup notice: the kernel logs one `tools.legacy_key_unmapped` WARN with the count of rows
  still holding an old-format key (a read-only query at start; no write).

- [ ] **Step 1: Write the failing tests** (`legacy-data.test.ts`, real PG):
  - Seed rc-shaped rows: grants for `sandbox_bash`, `docs__search` (connector `docs`),
    `todo__write` (extension `todo`), and an ambiguous `todo__x` in an org that also has a
    connector slug `todo`. After migrating: `Bash`, `mcp__docs__search`, `plugin__todo__write`;
    `todo__x` unchanged and counted by the startup notice (Review Focus 3).
  - An agent version stored with `toolPolicies: { sandbox_bash: "allow", docs__search: "ask" }`
    and an inline sub-agent template `tools: ["sandbox_read"]` parses to the new keys and runs.
  - Saving a definition with an old key is 400 `validation_failed` naming the new key.
  - A pending approval for `sandbox_edit` shows `Edit` in `GET …/approvals`.
- [ ] **Step 2: Extend** `rename-compat.test.ts` with a pre-rename agent version and eval
  candidate that still run after this change.
- [ ] **Step 3: Run** `pnpm exec vitest run packages/kernel/test/tools/legacy-data.test.ts packages/kernel/test/tools/rename-compat.test.ts` — FAIL.
- [ ] **Step 4: Implement** the migration, the normalizer and the notice.
- [ ] **Step 5: Run** the step 3 tests and `pnpm exec vitest run packages/kernel/test/agents packages/kernel/test/catalog packages/kernel/test/tools` — PASS.
- [ ] **Step 6: Commit** `feat(kernel): migrate stored tool keys and normalize stored definitions`

### Task 8: Claude Code maps

**Files:**
- Modify: `packages/kernel/src/runtime/context/claude-tools.ts` (`CLAUDE_CODE_TOOL_MAP`),
  `packages/kernel/src/catalog/claude/agents.ts` (`TOOL_MAP`)
- Test: the existing tests of both (`rg -l CLAUDE_CODE_TOOL_MAP packages/kernel/test`,
  `packages/kernel/test/catalog/claude-*.test.ts`)

- [ ] **Step 1: Update the tests** to expect the spec §6 map text verbatim, and `TOOL_MAP` to map
  `Bash`…`Grep`, `Skill`, `AskUserQuestion`, `ToolSearch`, `Agent` to themselves, `MultiEdit` →
  `Edit`, `Task` → `Agent`, `TodoWrite` → `plugin__todo__write`; a Claude agent with
  `tools: [mcp__srv__x]` drops it and reports it.
- [ ] **Step 2: Run** them — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm exec vitest run packages/kernel/test/catalog packages/kernel/test/runtime` — PASS.
- [ ] **Step 5: Commit** `feat(kernel): shorter Claude Code tool maps`

### Task 9: Full-run replay of old recordings

**Files:**
- Modify: `evals/recorded-tools.ts`, `evals/diff.ts`, `evals/worker.ts` (`legacyKeyMatch` in
  result detail)
- Create (fixture): `packages/kernel/test/evals/fixtures/pre-tool-rename/*.json`, a recorded
  conversation from the current rc naming every builtin, a connector key and an extension key
- Test: `packages/kernel/test/evals/reconstruct.test.ts`, `packages/kernel/test/evals/run-replay.test.ts`,
  `packages/kernel/test/tools/rename-compat.test.ts`

**Interfaces:**
- Consumes: `legacyToolKey`, `legacyToolInput` (Task 6).

- [ ] **Step 1: Write the failing tests:**
  - `reconstruct.test.ts`: the new pre-rename fixture (every builtin, a connector key, an
    extension key) reconstructs with no drift.
  - `run-replay.test.ts`: a full-run replay of the pre-rename case, whose candidate calls `Edit`
    with `file_path`, matches the recorded `sandbox_edit` call with `path`; the result detail has
    `legacyKeyMatch: true`; `diff.ts` reports no tool-call difference.
- [ ] **Step 2: Run** `pnpm exec vitest run packages/kernel/test/evals/reconstruct.test.ts packages/kernel/test/evals/run-replay.test.ts` — FAIL.
- [ ] **Step 3: Implement.** `matchKey` normalizes the recorded side with `legacyToolKey` (builtins;
  connector and extension keys use the snapshot's own connectors and extensions as the scope) and
  `legacyToolInput` before comparing.
- [ ] **Step 4: Run** `pnpm exec vitest run packages/kernel/test/evals packages/kernel/test/tools/rename-compat.test.ts` — PASS.
- [ ] **Step 5: Commit** `feat(evals): old recordings replay with zero drift after the tool rename`

### Task 10: Display

**Files:**
- Modify: `docs/design/spec.md` (tool row anatomy: name, bracketed tool, key-argument preview,
  IN / OUT), `packages/design/src/conversation/tool-row.tsx` (`ToolRowData`: `name` replaces
  verb-plus-title, `tool?` for the bracket, `tooltip?`), `tool-copy.ts`, `tool-group.tsx`,
  `packages/design/src/fixtures/index.ts`, the `/dev/ui` reference for tool rows;
  `packages/kernel/src/tools/info.ts` (`ToolInfo.source` for extensions carries the plugin display
  name; add `tool: string | null`, the parsed local name); `apps/web/src/lib/timeline.ts`;
  `apps/web/src/lib/tool-label.ts` (new); the surfaces of spec §7.2
  (`ApprovalCard.tsx`, `inbox/page.tsx`, `settings/grants/page.tsx`, `TrajectoryParts.tsx`,
  `AgentForm.tsx`, `RightArea.tsx`, `lib/subagents.ts`); `packages/kernel/src/channels/cards.ts`;
  `apps/web/messages/{en,zh}.json` (also the connector form's slug hint: "A shorter slug leaves
  room for longer tool names; a tool key is at most 64 characters", §3.2)
- Test: `packages/design/test/tool-row.test.tsx` (new or the existing conversation test),
  `apps/web/test/tool-label.test.ts` (new), `apps/web/test/conversation-page.test.tsx`,
  `apps/web/test/inbox.test.tsx`, `packages/kernel/test/tools/info.test.ts`,
  the channels card test; visual specs under `apps/web/visual`

**Interfaces:**
- Produces (web): `toolLabel(info: ToolInfo, locale): { name: string; tool?: string; tooltip?: string }`
  — builtin → `{ name: key }`; connector → `{ name: source.name, tool }`; extension →
  `{ name: <plugin display name>, tool }`; `tooltip` = declared title when set; unknown source →
  `{ name: key }`.
- Produces (kernel): `ToolInfo` gains `tool: string | null`; `source.kind === "extension"` gains
  `displayName: string`.

- [ ] **Step 1: Update the design spec** (row anatomy, states) and get the change reviewed with the
  task; it is the authority for the component.
- [ ] **Step 2: Write the failing tests:**
  - design: a builtin row renders `Bash` bold and the description; a connector row renders
    `CRM [search_accounts]` and the key argument in monospace, cut with `…`; the title is the
    tooltip; expanded rows show `IN` and `OUT`; Edit keeps `+a −b` and the diff.
  - web `tool-label.test.ts`: the four source kinds.
  - `info.test.ts`: `tool` and the extension display name.
  - channel card: an approval card for `mcp__crm__delete` shows `CRM [delete]`.
  - `inbox.test.tsx`, `conversation-page.test.tsx`: labels as above.
- [ ] **Step 3: Run** `pnpm exec vitest run packages/design/test apps/web/test packages/kernel/test/tools/info.test.ts packages/kernel/test/channels` — FAIL.
- [ ] **Step 4: Implement**; `timeline.ts` stays the one builder; every surface uses `toolLabel`.
  Builtin names are shown untranslated.
- [ ] **Step 5: Run** the step 3 tests, `pnpm check:web-ui`, `pnpm check:i18n` — PASS.
- [ ] **Step 6: Trigger** the `visual-update` workflow on the branch, review the new baselines,
  push an empty commit to rerun CI.
- [ ] **Step 7: Commit** `feat(web): tool rows follow the Claude Code display`

### Task 11: Checks

**Files:**
- Modify: `tools/checks/src/terms.ts` (rule `terms-tool-key`), fixtures under
  `tools/checks/fixtures/terms/{clean,violations}`
- Create: `packages/plugin-tools/src/check/plugin-tool-keys.ts` (rule `plugin-tool-key-length`),
  fixtures under `packages/plugin-tools/test/fixtures`
- Modify: `packages/plugin-tools/src/check/*` (register the rule), `.github/workflows/ci.yml`
  comments and AGENTS.md "CI and checks" (both rules run in full on PRs: cheap scans)
- Test: `tools/checks/test/terms.test.ts`, `packages/plugin-tools/test/plugin-tool-keys.test.ts` (new)

- [ ] **Step 1: Write the failing tests** (red first, on fixtures):
  - `terms-tool-key`: a file containing `"sandbox_bash"` or `skill_load(` fails naming the new
    name; the same text in `packages/kernel/src/tools/legacy-keys.ts`,
    `runtime/context/legacy-text.ts`, an applied migration, `test/evals/fixtures/pre-tool-rename`,
    `docs/superpowers/{specs,plans}` or a synced skill passes; the word `agent` alone never
    matches (only the 12 unambiguous old names and the `sandbox_` tool prefix are listed).
  - `plugin-tool-key-length`: a plugin `example-very-long-plugin-name` registering a literal tool
    name of 40 characters fails with the computed key length; a non-literal name is reported as
    "cannot be confirmed statically"; `todo` passes.
- [ ] **Step 2: Run** `pnpm exec vitest run tools/checks/test/terms.test.ts packages/plugin-tools/test/plugin-tool-keys.test.ts` — FAIL.
- [ ] **Step 3: Implement**, reusing the `perm-hooks` source scanner of
  `plugin-permissions.ts` to find `ctx.tools.register` names.
- [ ] **Step 4: Run** the step 2 tests and `pnpm check` on the whole repo — PASS (the earlier
  tasks removed every old name outside the exemptions).
- [ ] **Step 5: Commit** `feat(checks): guard old tool keys and plugin tool key length`

### Task 12: Docs, changesets, acceptance

**Files:**
- Modify: AGENTS.md (the Tools, Sub-agents and Runtime bullets naming old keys);
  `.agents/skills/{writing-tools,replay-evals,writing-sandbox-providers,writing-connectors,writing-extensions,writing-plugins,writing-extension-ui}/SKILL.md`;
  `docs/config.md` (regenerated if config descriptions named tools); `plugins/model-fake/README.md`;
  the spec's "As built" section (new, short)
- Create: `.changeset/*.md` for `@capybara-hq/kernel`, `@capybara-hq/plugin-sdk`,
  `@capybara-hq/plugin-tools`, `@capybara-hq/plugin-model-fake`, `@capybara-hq/capybara`
- Create: `docs/superpowers/plans/tool-naming-live-acceptance-checklist.md`

- [ ] **Step 1: Update** the docs and skills; `pnpm check:skills-frontmatter && pnpm check:terms`.
- [ ] **Step 2: Write** the live checklist from spec §14: an rc database dump upgraded (grants,
  `toolPolicies`, inline sub-agent template, an old conversation continued, an approval across the
  upgrade, an eval set full-run replay); a Claude Code plugin skill naming Bash / Read / Edit /
  Skill / TodoWrite; each bundled provider dialect with a history holding old tool names (the
  live tests of `capybara-hq/plugins`, run with `CAPYBARA_TEST_*`).
- [ ] **Step 3: Run** `pnpm verify` — PASS; record the output in the PR description.
- [ ] **Step 4: Open** an issue in `capybara-hq/plugins` for the follow-up (tests and model-fake
  scripts using keys, author skills, hooks that match keys), linked from the PR.
- [ ] **Step 5: Commit** `docs: tool naming aligned with Claude Code`

## Order and dependencies

1 → 2 → 3 → {4, 5} → 6 → 7 → 8 → 9 → 10 → 11 → 12. Tasks 4 and 5 are independent of each other.
Every task leaves the suite green, the zero-drift fixtures included. Task 10 may start after
Task 2 (it needs only the names and the grammar) and run in parallel with 3–9. The whole plan is
one PR (one rename, released together); Task 12's issue covers `capybara-hq/plugins`.
