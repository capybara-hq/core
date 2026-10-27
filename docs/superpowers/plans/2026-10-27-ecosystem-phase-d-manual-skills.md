# Manual Skill Invocation (Ecosystem Phase D) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A person invokes any skill of the conversation's agent with `/name args` (web composer
and IM). The rendered skill is logged as their message. Claude Code commands import as ordinary
skills. `disable-model-invocation` skills are manual-only. `context: fork` skills run as a phase C
sub-agent when a person invokes them.

**Architecture:** The SDK gets a pure `SkillInvocation` reader and renderer. Each skill version
stores its invocation metadata in `skill_versions.manifest.invocation`. The kernel resolves, reads
and renders a skill at send time and appends a `user_message` with a new non-model-visible `skill`
field. Model-visible text sits in `content`, so replay needs no new DriftReason. A fork invocation
starts its own run: the loop's `prepare` node dispatches it through phase C's `dispatchSubagent`
and suspends. When the run resumes, `prepare` appends the model-visible `skill_fork_result` before
the parent's first model call. The web builds on UI refresh B's `ComposerBar`.

**Tech Stack:** TypeScript, pnpm monorepo, NestJS + Fastify (kernel HTTP), Kysely/PG, BullMQ, LangGraph loop, Next + `@capybara-hq/design` (web), vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-27-phase-d-manual-skills-design.md` (decisions of
2026-10-27 at its top). Also read: `2026-10-26-subagents-design.md` ("Phase C as built"), and
`2026-10-22-package-ecosystem-design.md` §8.3, §9 and "Phase B as built".

## Global Constraints

- Extensions and the SDK import nothing from `@capybara-hq/kernel`. The SDK depends on no
  `@capybara-hq/*` package. Web depends only on `@capybara-hq/design`. Web pages write no styles
  (`pnpm check:web-ui`).
- Model-visible text is English, quoted from the spec. It is frozen in the log once written, so
  never re-render it from the database at request-building time.
- The skill invocation wrapper is `<skill_invocation name="{name}" version="{version}">`…`</skill_invocation>`.
  Inside the body, `</skill_invocation` is written `<\/skill_invocation`.
- Model-visible text, verbatim from the spec:
  - inline invocation lead: `The user invoked the skill "{name}" with /{name}{ arguments}. Follow its instructions for this request.`
  - files line, with `skill_load`: `Its files are not in the sandbox yet: call skill_load with "{name}" to copy them to /skills/{name}/ before running its scripts.`
  - files line, without `skill_load`: `Its other files are not available in this conversation.`
  - shell-injection line (only when the agent has `sandbox_bash`): ``Lines written as !`command` were meant to run before you read this; run those commands with sandbox_bash if you need their output.``
  - fork lead: `The user ran the skill "{name}" in a sub-agent ({agentType}) with /{name}{ arguments}. The sub-agent gets the skill's instructions as its task; its report follows. Do not do the task yourself.`
  - fork report header: `Report from the sub-agent that ran the skill "{name}":`
  - compaction line: `Skills the user invoked earlier in this conversation: {names}. Call skill_load with a name to read its instructions again.`
  - `skill_load` of a forked skill, sub-agents available: `This skill is written to run in a sub-agent: call agent with subagent_type "{type}" and a prompt containing these instructions and the details of the task, then use its report; do not follow the instructions yourself.`
  - `skill_load` of a forked skill, sub-agents not available: `This skill is written to run in a sub-agent, which is not available here; follow the instructions yourself.`
  - unknown fork agent warning: `Skill "{name}" asked for sub-agent type "{agent}", which this agent does not have; it ran as general-purpose.`
- Argument rules (from Claude Code):
  - `$ARGUMENTS` is the whole argument string.
  - `$ARGUMENTS[N]` / `$N` are 0-based positional values; a missing one stays as written.
  - `$name` takes its value from frontmatter `arguments`; a missing one becomes empty.
  - `\$` becomes `$`.
  - `${CLAUDE_SKILL_DIR}` becomes `/skills/<name>`; every other `${…}` stays as written.
  - With no placeholder consumed and non-empty args, append `\n\nARGUMENTS: <args>`.
  - Arguments are at most 10 000 characters. Substituted text is never re-scanned.
- Nothing is executed at render time (spec A1). `allowed-tools`, `model`, `effort`, `hooks`,
  `paths`, `shell` and `when_to_use` stay ignored (N2).
- Commands import as **model-invocable** skills that also appear in the `/` menu; only
  `disable-model-invocation: true` makes a skill or command manual-only (decided, 2026-10-27).
- The `/` menu lists only the agent's effective skills, where `user-invocable` is not `false`
  (decided).
- New keys take effect only on skill versions written from phase D on. There is no backfill
  (decided). A skill version written from phase D on includes an org install or upgrade, after
  phase D, of a catalog version imported before it: that install honours the version's keys (a
  behaviour change, consistent with "the next version honours it"). Stored files are read
  leniently there, and a key the strict checks would refuse (both flags off, an over-long
  `argument-hint` or `agent`, a wrong type) is left out (`cleanInvocationKeys`, batch 1 review M2).
- Fork dispatch call id is `skill-<seq>` and the wait id is `sa-<runId>-<step>`. BullMQ queue names
  and job ids contain no `:`.
- New error code `skill.not_invocable` (400, `details: [{ reason: "not_found" | "not_user_invocable" }]`).
  New reasons:
  - `agent.pinned_invalid { reason: "manual_only" }`;
  - `skill.invalid_package` for a skill that neither the model nor a person could use.
- New translation codes:
  - `skill_manual_only` and `skill_forked` (converted);
  - `command_imported` (imported);
  - `command_invalid` (ignored);
  - `skill_shell_injection` and `skill_agent_unknown` (warnings).

  `skill_manual_invocation`, `command_manual_invocation` and `skill_needs_subagents` stay in the
  type but are no longer emitted.
- The translator revision string is `claude-translation-2`. It is folded into
  `claudeContentDigest` only when the tree has a command, a manual-only skill or a forked skill.
- Migration: one additive file, `0061_queued_skill.sql`. Its number is the next free one after
  UI refresh B's renumbered 0056–0060; re-check it at merge time. Use the `IF NOT EXISTS` style.
- Phase D's web tasks (10, 11) and the queue task (9) start only after UI refresh B
  (`feat/ui-refresh-b`) has merged into `main`. Tasks 1–8 do not need B.
- Run vitest from the repo root (`pnpm exec vitest run <path>`). Commits are Conventional Commits
  with body lines ≤ 100 characters. A change to a published package needs a changeset. The SDK API
  report must be regenerated (`pnpm gen:sdk-api`) with a changeset bumping `@capybara-hq/plugin-sdk`.
- Zero-drift fixtures (`packages/kernel/test/evals/reconstruct.test.ts`, `rename-compat.test.ts`)
  pass before and after every task that touches request building.

## Review Focus

1. **Arguments that look like placeholders.** For example `/x '$ARGUMENTS' "$1"`, arguments
   containing `${CLAUDE_SKILL_DIR}`, or non-ASCII text. These must appear in the rendered text
   exactly as typed and must never be expanded again. Test in Task 1.
2. **The skill changes between opening the menu and sending.** A deselected or deleted skill gives
   400 `skill.not_invocable` and writes nothing. A new version renders that new version. A storage
   failure gives 503 and writes nothing. Tests in Task 3.
3. **A fork invocation sent while a run is active.** It is never absorbed into that run. It
   starts its own run after the current one ends, and no model call precedes its dispatch. Test in
   Task 6.
4. **A retry with the same `clientMessageId`.** It returns the same event, writes no second
   message and makes no second dispatch, even when the skill changed in between. Tests in Task 3
   (message) and Task 6 (dispatch).
5. **A manual-only skill deleted or deselected after it was invoked.** The model's later
   `skill_load` gets the existing "removed" text, never the files of another skill with the same
   name. Test in Task 4.

---

## File map

| File | Responsibility |
|---|---|
| `packages/plugin-sdk/src/skill-invocation.ts` (new) | `SkillInvocation`, `skillInvocation`, `parseSkillArguments`, `renderSkillInvocation`, `SKILL_INVOCATION_LIMITS` |
| `packages/plugin-sdk/src/skill.ts` | `parseSkillMd` type checks for the new keys |
| `packages/kernel/src/skills/package.ts`, `skills.service.ts`, `catalog.ts` | `manifest.invocation`; catalog leaves out manual-only versions |
| `packages/kernel/src/agents/*` (pinned checks) | `manual_only` |
| `packages/kernel/src/skills/invoke.ts` (new) | resolve, read, render an invocation; the invocable list |
| `packages/kernel/src/skills/invocable.controller.ts` (new) | `GET …/agents/:agentId/invocable-skills` |
| `packages/kernel/src/conversations/{events,conversations.service,conversations.controller}.ts` | `user_message.skill`, `skill` on messages and first message |
| `packages/kernel/src/tools/builtins/skill-load.ts` | invoked manual skills, forked-skill text |
| `packages/kernel/src/runtime/context/{build,skills}.ts` | `skill_fork_result` rendering, compaction line |
| `packages/kernel/src/runtime/subagents/skill-fork.ts` (new) | fork dispatch, report, stop pairing |
| `packages/kernel/src/runtime/langgraph-loop.ts`, `waits.ts` | run boundary, `prepare` hook, sweep |
| `packages/kernel/src/evals/{run-replay,snapshot,recorded-tools}.ts` | fork report in full-run replay |
| `packages/kernel/src/catalog/claude/{translate,report,manifest}.ts`, new `commands.ts` | commands → skills, codes, digest |
| `packages/kernel/src/channels/inbound.ts` | `/name args` in IM |
| `packages/kernel/src/conversations/queue.ts` (after B), `migrations/0061_queued_skill.sql` | queued invocations |
| `packages/design/src/conversation/composer.tsx`, `command-palette` | skill chip, item tags |
| `apps/web/src/components/conversation/ComposerBar.tsx`, `lib/skills.ts` (new), bubble and agent page | the web |

---

### Task 1: SDK: invocation metadata and rendering

**Files:**
- Create: `packages/plugin-sdk/src/skill-invocation.ts`
- Modify: `packages/plugin-sdk/src/skill.ts` (`parseSkillMd` type errors), `packages/plugin-sdk/src/index.ts`
- Test: `packages/plugin-sdk/test/skill-invocation.test.ts`, `packages/plugin-sdk/test/skill.test.ts`
- Modify: `packages/plugin-sdk/api/plugin-sdk.api.md` (generated), `.changeset/phase-d-sdk.md`

**Interfaces:**
- Produces:
  ```ts
  export interface SkillInvocation {
    model: boolean; user: boolean;
    fork?: { agent?: string };
    argumentHint?: string; arguments?: string[];
  }
  export const SKILL_INVOCATION_LIMITS: { argumentHintMaxChars: 200; argumentNames: 20; argumentsMaxChars: 10_000; renderedMaxChars: 200_000 };
  export function skillInvocation(frontmatter: Record<string, unknown>): SkillInvocation;
  export function parseSkillArguments(args: string): string[];
  export interface RenderSkillInvocationInput {
    name: string; /* as typed, may be <plugin>:<name> */ skillName: string; /* bare: /skills/<skillName>/ */
    version: number; body: string; invocation: SkillInvocation; args: string;
    /** decided by the caller from the agent's tools and the version's manifest */
    lines: { files?: "load" | "unavailable"; shellHint?: boolean };
  }
  export function renderSkillBody(body: string, invocation: SkillInvocation, args: string, skillName: string): string; // substitution + ARGUMENTS append, no wrapper
  export function renderSkillInvocation(i: RenderSkillInvocationInput): string;  // lead + wrapper + optional lines
  export function hasShellInjection(body: string): boolean;
  ```
  `parseSkillMd` returns errors such as `disable-model-invocation must be a boolean`, `user-invocable must be a boolean`,
  `context must be "fork"`, `agent must be a string of 1-130 characters`, `argument-hint must be a string of at most 200 characters`,
  `arguments must be a list of at most 20 names` and `a skill with disable-model-invocation: true and user-invocable: false cannot be used`.

- [ ] **Step 1: Write the failing tests** in `skill-invocation.test.ts`:
  - `skillInvocation({})` → `{ model: true, user: true }`. `{ "disable-model-invocation": true, context: "fork", agent: "code-reviewer", "argument-hint": "[n]", arguments: ["issue"] }` → `{ model: false, user: true, fork: { agent: "code-reviewer" }, argumentHint: "[n]", arguments: ["issue"] }`.
  - `parseSkillArguments('"hello world" second \\"x')` → `["hello world", "second", "\"x"]`. Single quotes group too.
  - `renderSkillBody("Migrate $0 from $1 to $2.", inv, "SearchBar JavaScript TypeScript", "m")` → `"Migrate SearchBar from JavaScript to TypeScript."`.
  - `$2` with one argument stays `$2`. With `arguments: ["issue"]`, `$issue` and no args becomes `""`. `\$1.00` becomes `$1.00`.
  - `${CLAUDE_SKILL_DIR}/run.sh` becomes `/skills/m/run.sh`. `${CLAUDE_SESSION_ID}` stays as written.
  - No placeholder and args `"a b"` → body + `"\n\nARGUMENTS: a b"`. Empty args with no placeholder → the body unchanged.
  - Review Focus 1: args `'$ARGUMENTS' "${CLAUDE_SKILL_DIR}" ünï` with body `X $ARGUMENTS Y` → `X '$ARGUMENTS' "${CLAUDE_SKILL_DIR}" ünï Y`, not re-scanned.
  - `renderSkillInvocation`:
    - output is exactly the lead + `\n\n<skill_invocation name="m" version="3">\n` + body + `\n</skill_invocation>`;
    - `lines.files: "load"` appends `\n\n` + the files line, `lines.shellHint` appends the shell line;
    - `</skill_invocation>` in the body becomes `<\/skill_invocation>`;
    - args longer than 10 000 characters throw `RangeError`.
  - `hasShellInjection`: `` "!`git status`" `` at line start → true; `` "KEY=!`x`" `` → false; ` ```! ` fence → true.
  - `skill.test.ts`: each type error above; both flags off → the "cannot be used" error.
- [ ] **Step 2: Run** `pnpm exec vitest run packages/plugin-sdk/test/skill-invocation.test.ts packages/plugin-sdk/test/skill.test.ts` and confirm it FAILS (missing exports).
- [ ] **Step 3: Implement** in `skill-invocation.ts`.
  - Substitution is a single regex pass with a replacer over `\\\$|\$ARGUMENTS\[\d+\]|\$ARGUMENTS|\$\d+|\$[A-Za-z_][A-Za-z0-9_]*|\$\{CLAUDE_SKILL_DIR\}`.
  - Track whether any argument placeholder matched.
  - Lead text and lines come from Global Constraints.
- [ ] **Step 4: Run** the tests and confirm they PASS. Then run `pnpm gen:sdk-api`, add the changeset (patch, `@capybara-hq/plugin-sdk`: "Skill invocation metadata and rendering") and run `pnpm check:sdk-api`, which should PASS.
- [ ] **Step 5: Commit** `feat(plugin-sdk): skill invocation metadata and argument rendering`

### Task 2: Kernel: store invocation metadata; manual-only skills leave the catalog

**Files:**
- Modify:
  - `packages/kernel/src/skills/package.ts` (`checkSkillFiles` returns `invocation`)
  - `packages/kernel/src/skills/skills.service.ts` (manifest at upload / install / upgrade)
  - `packages/kernel/src/tools/builtins/skill-write.ts`
  - `packages/kernel/src/db/kernel-schema.ts` (`SkillManifest.invocation?: SkillInvocation`)
  - `packages/kernel/src/skills/catalog.ts` (`resolveSkills` skips `invocation.model === false`; `fitPinned` drops manual-only with `log.warn("pinned skill is manual-only")`)
  - the pinned save check (`assertPinnedSkills`, `agents/`)
  - `packages/kernel/src/errors.ts` (reason docs only)
- Test: `packages/kernel/test/skills/manual-skills.test.ts` (new), `packages/kernel/test/agents/pinned-skills.test.ts`

**Interfaces:**
- Consumes: `skillInvocation` and the `parseSkillMd` errors (Task 1).
- Produces:
  - `checkSkillFiles(files): { name; description; invocation: SkillInvocation }`;
  - `invocationOf(manifest: SkillManifest): SkillInvocation`, in `skills/catalog.ts`; it returns the defaults when the field is absent.

- [ ] **Step 1: Write the failing tests:**
  - Uploading a zip whose SKILL.md has `disable-model-invocation: true` stores `manifest.invocation.model === false`.
  - With both flags off, the upload is 400 `skill.invalid_package`.
  - `recordSkillsCatalog` for an agent that selects a manual-only and an ordinary skill writes a snapshot holding only the ordinary one.
  - A new manual-only version of a selected skill makes the next snapshot's change text list it under removed.
  - A version without `invocation` (insert a pre-D manifest row) stays in the catalog, even though its stored SKILL.md says `disable-model-invocation: true` (no backfill).
  - Pinning a manual-only skill is 400 `agent.pinned_invalid` with `details[0].reason === "manual_only"`.
  - A pinned skill whose new version is manual-only is dropped at run start, and the snapshot has no pinned entry for it.
  - `skill_write` of a SKILL.md with `disable-model-invocation: true` creates a manual-only version.
- [ ] **Step 2: Run** `pnpm exec vitest run packages/kernel/test/skills/manual-skills.test.ts packages/kernel/test/agents/pinned-skills.test.ts` and confirm it FAILS.
- [ ] **Step 3: Implement.** Write `manifest.invocation` only when it differs from the defaults, so
  that manifests of ordinary skills stay byte-identical. Run the existing skills, catalog and
  pinned tests, which must stay green: `pnpm exec vitest run packages/kernel/test/skills packages/kernel/test/agents packages/kernel/test/catalog/claude-install.test.ts`.
- [ ] **Step 4: Run** the zero-drift fixtures with `pnpm exec vitest run packages/kernel/test/evals/reconstruct.test.ts packages/kernel/test/evals/rename-compat.test.ts`. They should PASS.
- [ ] **Step 5: Commit** `feat(kernel): manual-only skills stay out of the model's catalog`

### Task 3: Kernel: invoke a skill from a message (inline)

**Files:**
- Create: `packages/kernel/src/skills/invoke.ts`, `packages/kernel/src/skills/invocable.controller.ts`
- Modify:
  - `packages/kernel/src/conversations/events.ts` (`user_message.skill`)
  - `packages/kernel/src/conversations/conversations.service.ts` (`postUserMessage` input `skill?: { name: string }`; the first message of `create` once B merged, otherwise only `postUserMessage`)
  - `packages/kernel/src/conversations/conversations.controller.ts` (zod body)
  - `packages/kernel/src/errors.ts` (`skill.not_invocable`: 400)
  - `packages/kernel/src/http/api.module.ts`
- Test: `packages/kernel/test/skills/invoke.http.test.ts` (new)

**Interfaces:**
- Consumes: `renderSkillInvocation`, `renderSkillBody`, `hasShellInjection` (Task 1); `invocationOf`, `resolveSkills` (Task 2); the `skill_load` verified reader (`readVerified`, exported from `tools/builtins/skill-load.ts`).
- Produces:
  ```ts
  // events.ts, user_message payload
  skill?: { id: string; version: number; source: string; name: string; plugin?: string;
            arguments: string; mode: "inline" | "fork"; agentType?: string };
  // invoke.ts
  export interface InvocableSkill { id: string; name: string; plugin?: string; description: string;
    version: number; argumentHint?: string; arguments?: string[]; manual: boolean; fork: boolean }
  export async function listInvocableSkills(d: InvokeDeps, a: { orgId: string; agentId: string;
    accountId: string; conversationId?: string }): Promise<InvocableSkill[]>;
  export interface RenderedInvocation { text: string; skill: NonNullable<EventPayload<"user_message">["skill"]>;
    /** fork only: the rendered task for the child (Task 6) */ task?: string }
  export async function prepareInvocation(d: InvokeDeps, a: { orgId: string; agentId: string;
    conversationId?: string; agent: AgentDefinition; name: string; args: string }): Promise<RenderedInvocation>;
  export const parseSlashCommand: (text: string) => { name: string; args: string } | null; // ^/([a-z0-9-]+(?::[a-z0-9-]+)?)(\s|$)
  ```
  The route is `GET /api/v1/orgs/:orgId/agents/:agentId/invocable-skills?conversationId=` and
  returns `{ skills: InvocableSkill[] }`. Access: members who can use the agent; with
  `conversationId`, only that conversation's owner.

  In this task `prepareInvocation` already sets `mode: "fork"` and resolves `agentType`. For a fork
  it returns the fork lead as `text` and the wrapped invocation as `task`; Task 6 consumes both.

- [ ] **Step 1: Write the failing tests** in `invoke.http.test.ts` (kernel test helpers, `model-fake`):
  - The invocable list:
    - holds the agent's selected org skills and own skills, sorted by name, with `manual` and `fork` flags;
    - excludes a `user: false` skill and unselected org skills;
    - includes a trial draft only when `conversationId` is the one that started it;
    - is 404 for a non-member.
  - `POST …/messages { text: "123", skill: { name: "fix-issue" } }` appends one `user_message`:
    - its `content[0].text` starts with `The user invoked the skill "fix-issue" with /fix-issue 123.`;
    - it contains `Fix GitHub issue 123`;
    - `skill` is `{ name: "fix-issue", arguments: "123", mode: "inline", version: 1, … }`;
    - the next `model_call` request holds that text.
  - `skill: { name: "superpowers:brainstorming" }` resolves the plugin skill. Another plugin's prefix is 400 `skill.not_invocable` `not_found`. The renderer gets `skillName: "brainstorming"` (the bare name), so `${CLAUDE_SKILL_DIR}` and the files line say `/skills/brainstorming/` (batch 1 review I1).
  - A body whose placeholders push the rendered text past `SKILL_INVOCATION_LIMITS.renderedMaxChars` (the SDK throws `RangeError`) is 400 `validation_failed` with a clear English message ("the rendered skill must be at most 200000 characters; shorten the arguments") and no event (batch 1 review I2).
  - Files line:
    - a skill with a script, on an agent with `skill_load`, gets the "load" line;
    - without `skill_load`, it gets the "unavailable" line;
    - shell line only with `sandbox_bash`.
  - `@` resources and `files` with a skill: `content[0]` is the invocation, then the resource blocks, then the file blocks.
  - Review Focus 2: deselect the skill after listing, then send: 400 `skill.not_invocable` and no event. A new version uploaded between list and send renders `version="2"`. Object storage down: 503 `storage.unavailable` and no event.
  - Review Focus 4: the same `clientMessageId` twice returns the same `seq`. Change the skill between the two calls: the second still returns the first event.
  - `parseSlashCommand` unit cases: `/fix-issue 12` → `{ name: "fix-issue", args: "12" }`; `/etc/hosts x` → null; `/a:b` → `{ name: "a:b", args: "" }`; ` /x` → null.
- [ ] **Step 2: Run** `pnpm exec vitest run packages/kernel/test/skills/invoke.http.test.ts` and confirm it FAILS.
- [ ] **Step 3: Implement.** Resolve against the agent's **current** version and the
  conversation's trial drafts (`resolveSkills` with the invocation metadata). Read SKILL.md with
  `readVerified` outside the transaction. Then append through the existing `postUserMessage` path:
  `content[0]` is the rendered text, so the attachment and file ordering is unchanged. A model-invocable
  fork skill invoked by a person is `mode: "fork"`. Register the error code and the controller.
- [ ] **Step 4: Run** the test; it should PASS. Then run `pnpm exec vitest run packages/kernel/test/conversations packages/kernel/test/evals/reconstruct.test.ts`, which should PASS.
- [ ] **Step 5: Commit** `feat(kernel): invoke a skill from a message with arguments`

### Task 4: Kernel: `skill_load` for invoked and forked skills; the compaction line

**Files:**
- Modify: `packages/kernel/src/tools/builtins/skill-load.ts`, `packages/kernel/src/runtime/context/skills.ts` (`invokedSkillsText`), `packages/kernel/src/runtime/context/build.ts` (where the compaction restore adds `skillsCurrentText`)
- Test: `packages/kernel/test/skills/skills-runtime.test.ts`, `packages/kernel/test/evals/reconstruct.test.ts`

**Interfaces:**
- Consumes: `user_message.skill` (Task 3); `invocationOf` (Task 2); `resolveRoster`, `findType` (`runtime/subagents/roster.ts`).
- Produces: `export function invokedSkillsText(names: readonly string[]): string` (compaction line, empty for `[]`); `export function latestInvocation(events, name): { id; version; source } | undefined` in `runtime/context/skills.ts`.

- [ ] **Step 1: Write the failing tests:**
  - Model calls `skill_load("manual")` before any invocation → the existing "not in the skills catalog" text.
  - After a person invoked it, the same call copies its files into `/skills/manual/` (fake sandbox ops log) and returns the body.
  - Review Focus 5:
    - the skill is deleted after the invocation → the existing `removedText`;
    - a new org skill with the same name but another id → the "removed" text, never the new skill's files.
  - A model-invocable forked skill with `agent: code-reviewer`:
    - when the agent has `agent` and the roster has `<plugin>:code-reviewer`, the result starts with the "sub-agents available" line naming `<plugin>:code-reviewer`;
    - when it has no `agent` tool, it starts with the "not available" line.
  - The `skill_load` spec hash is unchanged (compare it with the constant from before the change).
  - `reconstruct.test.ts`: a conversation with two inline invocations, then a compaction over both. The request after the summary holds `Skills the user invoked earlier in this conversation: brainstorm, fix-issue. Call skill_load …`, and every `model_call` reconstructs with `drift: []`. A pre-D fixture log builds byte-identically.
- [ ] **Step 2: Run** `pnpm exec vitest run packages/kernel/test/skills/skills-runtime.test.ts packages/kernel/test/evals/reconstruct.test.ts` and confirm it FAILS.
- [ ] **Step 3: Implement.**
  - Name resolution falls back to `latestInvocation` when the name is not in the snapshot, then re-checks the skill row (id live, same name).
  - The fork prefix is decided from `invocationOf(manifest).fork`.
  - The compaction line holds the distinct invoked names (code point order) of the covered range, and only inline ones.
- [ ] **Step 4: Run** the tests plus `rename-compat.test.ts`; they should PASS.
- [ ] **Step 5: Commit** `feat(kernel): skill_load for invoked manual skills and forked skills`

### Task 5: Claude translation: commands, manual-only and forked skills

**Files:**
- Create: `packages/kernel/src/catalog/claude/commands.ts`
- Modify: `packages/kernel/src/catalog/claude/translate.ts` (`:528-535` skill gates, `:620-660` commands), `report.ts` (codes, groups), `manifest.ts` (`claudeContentDigest` revision)
- Modify (web copy, independent of B): `apps/web/src/lib/catalog.ts` (code detail keys), `apps/web/messages/{en,zh}.json` (new codes; the "phase D" wording of `skill_needs_subagents` and `skill_manual_invocation` kept for stored reports)
- Test: `packages/kernel/test/catalog/claude-translate.test.ts`, `claude-import.test.ts`, `claude-superpowers.e2e.test.ts`; fixtures `packages/kernel/test/catalog/fixtures/claude/mixed/commands/run.md` (exists), a new `commands/manual-cmd.md` with `disable-model-invocation: true`, a `commands/sh.md` with `` !`git status` `` and `allowed-tools`; `FIXTURE.md` updated

**Interfaces:**
- Consumes: `parseSkillMd`, `skillInvocation` (Task 1).
- Produces:
  ```ts
  export const GENERATED_COMMANDS_DIR = ".capybara-generated/commands";
  export const CLAUDE_TRANSLATOR_REVISION = "claude-translation-2";
  export function translateClaudeCommands(files: ReadonlyMap<string, Uint8Array>,
    commands: { name: string; path?: string; content?: string }[],
    skillNames: ReadonlySet<string>): { generated: Map<string, Uint8Array>; skillPaths: string[]; items: TranslationItem[] };
  ```
  The generated SKILL.md has a JSON frontmatter: `name`; `description` (the command's, else its
  first non-empty body line flattened and cut to `SKILL_LIMITS.descriptionMaxChars`); and the
  command's own `disable-model-invocation`, `user-invocable`, `argument-hint`, `arguments`,
  `context`, `agent`. The body follows unchanged.

- [ ] **Step 1: Write the failing tests:**
  - The `mixed` fixture:
    - `manual` → `skill_imported` + `skill_manual_only`;
    - `forked` → `skill_imported` + `skill_forked { agent: "general-purpose" }`;
    - `run` → `command_imported`, with a file at `.capybara-generated/commands/run/SKILL.md` whose frontmatter lacks `disable-model-invocation`;
    - `manual-cmd` → `command_imported` + `skill_manual_only`;
    - `sh` → `skill_shell_injection` and `skill_ignored_restrictions { keys: "allowed-tools" }`.
  - None of `skill_manual_invocation`, `command_manual_invocation` or `skill_needs_subagents` is emitted.
  - `command_invalid`:
    - a command named like a skill of the plugin ("the skill wins, as in Claude Code");
    - `Bad_Name.md`;
    - an object-map command with no description and an empty body ("no description").
  - Nested `commands/a/b.md` is not collected (unchanged non-recursive scan). An object-map `{ content }` command is generated from the inline content.
  - Forked skill with `agent: nonexistent` → `skill_agent_unknown`; with `agent: code-reviewer` and the plugin's agent `code-reviewer` → no warning.
  - Both flags off on a skill → `skill_invalid`.
  - Digest:
    - the superpowers fixture without commands gets the same digest as before (pin the value from `main`);
    - with `commands/brainstorm.md`, the digest changes;
    - re-importing a version imported with the old digest records `<version>+sha256.<12>` (`claude-import.test.ts`).
  - `claude-superpowers.e2e.test.ts`: `command_manual_invocation brainstorm` becomes `command_imported brainstorm`; after install, `brainstorm` is in an agent's catalog snapshot.
- [ ] **Step 2: Run** `pnpm exec vitest run packages/kernel/test/catalog/claude-translate.test.ts packages/kernel/test/catalog/claude-import.test.ts packages/kernel/test/catalog/claude-superpowers.e2e.test.ts` and confirm it FAILS.
- [ ] **Step 3: Implement.**
  - Skill gates become report items instead of `continue`. Commands go through `translateClaudeCommands`, after the skill names are known.
  - The generated paths are appended to the translated manifest's `skills`.
  - The digest folds in `\0claude-translator\0claude-translation-2` only when a command or a manual or forked skill exists.
  - Add the web messages (zh and en) and the detail keys, then run `pnpm check:i18n`.
- [ ] **Step 4: Run** the tests plus `pnpm exec vitest run packages/kernel/test/catalog apps/web/test/catalog*.test.tsx` and `pnpm check:i18n`; all should PASS.
- [ ] **Step 5: Commit** `feat(kernel): import Claude commands, manual-only and forked skills`

### Task 6: Kernel: forked skills run as a sub-agent

**Files:**
- Create: `packages/kernel/src/runtime/subagents/skill-fork.ts`
- Modify:
  - `packages/kernel/src/conversations/events.ts`: new `skill_fork_result`; `subagent_dispatched.invokedSeq?`; `subagent_started.template.invokedSkill?`
  - `packages/kernel/src/runtime/subagents/dispatch.ts`: a `forSkill` option, so `general-purpose` is always available and an unknown type falls back with the warning
  - `packages/kernel/src/runtime/subagents/roster.ts`
  - `packages/kernel/src/runtime/langgraph-loop.ts`: the `prepare` absorption boundary and the fork hook
  - `packages/kernel/src/runtime/context/build.ts`: render `skill_fork_result`
  - `packages/kernel/src/runtime/waits.ts`: `sweepOpenAgentCalls` pairs fork invocations
  - `packages/kernel/src/conversations/conversations.service.ts`: a fork invocation's `content[0]` is the fork lead
- Test: `packages/kernel/test/subagents/forked-skill.e2e.test.ts` (new), `forked-skill.dual.test.ts` (new)

**Interfaces:**
- Consumes: `prepareInvocation` (Task 3); `dispatchSubagent`, `childResult`, `stopChildren`, `subagentsWaitId` (phase C).
- Produces:
  ```ts
  // events.ts
  skill_fork_result: { invokedSeq: number; subagentId: string; childRunId: string; text: string } // model-visible
  // skill-fork.ts
  export const skillCallId = (seq: number) => `skill-${seq}`;
  export const forkResultIdemKey = (seq: number) => `skill_fork_result:${seq}`;
  /** In prepare: dispatch pending fork invocations of this run, or append finished reports. */
  export async function advanceSkillForks(d: SkillForkDeps, a: { ctx: LoopContext; step: number;
    absorbed: ConversationEvent[] }): Promise<{ kind: "ready" } | { kind: "suspend"; waitingFor: WaitingFor }>;
  export async function pairStoppedForks(d: SkillForkDeps, runId: string): Promise<number>; // stop text reports
  ```
  `dispatchSubagent(d, { ctx, callId: skillCallId(seq), input: { description: name, prompt: task, subagent_type: agentType }, forSkill: { id, version, name, seq } })`.

- [ ] **Step 1: Write the failing tests** in `forked-skill.e2e.test.ts` (one kernel, `model-fake` scripted, fake sandbox, an agent with plugin template `<plugin>:code-reviewer`, no `agent` tool):
  - Posting `/review src` (fork skill with `agent: code-reviewer`):
    - writes the `user_message` with the fork lead and `skill.mode: "fork"` and `agentType: "<plugin>:code-reviewer"`;
    - writes `subagent_dispatched { callId: "skill-<seq>", invokedSeq: <seq> }`;
    - the run goes `waiting`, and no parent `model_call` exists yet.
  - The child's first request holds only its system text and the `<skill_invocation name="review"` task with `src` substituted.
  - After the child completes, the parent log has `skill_fork_result`, whose text starts with `Report from the sub-agent that ran the skill "review":` and ends with phase C's status line. The parent's next `model_call` request contains it right after the invocation text, and the parent replies.
  - `agent: Explore` and `agent: nonexistent` both run as `general-purpose`, and `subagent_started.warnings` holds the unknown-type line.
  - Review Focus 3: a fork invocation posted while an inline run is active is not absorbed by that run. The active run's `consumed` stays below its seq, and the fork's own run starts afterwards with no `model_call` before its dispatch.
  - Review Focus 4: the same `clientMessageId` posted twice gives one dispatch row.
  - Stopping the parent while the child runs gives both runs `aborted` and a `skill_fork_result` with phase C's stop text. The next message's request contains that report before the new message.
  - A terminal run with a fork invocation and no report (delete the report row after a crash simulation) is repaired by the wait sweep (`repaired` ≥ 1).
  - `forked-skill.dual.test.ts`: the invocation is posted on A, the child runs on B, the parent resumes on A. A lost enqueue is repaired by the sweep.
- [ ] **Step 2: Run** `pnpm exec vitest run packages/kernel/test/subagents/forked-skill.e2e.test.ts packages/kernel/test/subagents/forked-skill.dual.test.ts` and confirm it FAILS.
- [ ] **Step 3: Implement.**
  - `prepare` absorbs pending messages in order. At the run's first step it stops **after** the first fork invocation; at later steps it stops **before** any fork invocation.
  - Then it calls `advanceSkillForks`:
    - an absorbed fork invocation without a dispatch row is dispatched, and the loop suspends with `subagentsWaitId(runId, step)`;
    - a terminal child gets `skill_fork_result` appended (idempotent by key) before the model step.
  - Request building renders `skill_fork_result` as user text at its log position.
  - The abort path and `sweepOpenAgentCalls` call `pairStoppedForks`.
  - Budget and limits are phase C's.
- [ ] **Step 4: Run** the tests, `pnpm exec vitest run packages/kernel/test/subagents packages/kernel/test/runtime` and the zero-drift fixtures; all should PASS.
- [ ] **Step 5: Commit** `feat(kernel): run forked skills as sub-agents when a person invokes them`

### Task 7: Replay and evals for invocations and forks

**Files:**
- Modify: `packages/kernel/src/evals/run-replay.ts` (fork runs read the recorded report), `packages/kernel/src/evals/snapshot.ts` (case metadata `invokedSkill`), `packages/kernel/src/evals/trajectory.ts` (fork span links the child)
- Modify: `.agents/skills/replay-evals/SKILL.md`
- Test: `packages/kernel/test/evals/reconstruct.test.ts`, `run-replay.test.ts`, `subagents-replay.test.ts`

**Interfaces:**
- Consumes: `skill_fork_result`, `skillCallId` (Task 6).
- Produces: `CaseSnapshot.subagent.invokedSkill?: { id; version; name }`.

- [ ] **Step 1: Write the failing tests:**
  - `reconstruct.test.ts`: the conversation of Task 6's e2e (inline invocation, fork invocation with report, compaction) reconstructs every parent `model_call` with `drift: []`. A candidate agent version that deselects the invoked skill still reconstructs the recorded text, and its drift list holds no new reason.
  - `run-replay.test.ts`: a full-run replay of the fork-triggered run sends the same requests, writes no `subagent_*` events, starts no child run (count `runs` rows of kind `subagent`) and has zero `tool_unmatched`. A recording whose report is missing ends the replayed run `aborted` like the original.
  - `subagents-replay.test.ts`: a fork child's step replay reconstructs with `drift: []`, and its case metadata has `invokedSkill.name === "review"`.
- [ ] **Step 2: Run** `pnpm exec vitest run packages/kernel/test/evals` and confirm it FAILS.
- [ ] **Step 3: Implement.** The replayed `prepare` uses the recorded `skill_fork_result` instead
  of `advanceSkillForks` (the `RecordedToolPipeline` counterpart, chosen by the replay deps). Update
  the `replay-evals` skill: the `skill` field, `skill_fork_result`, the compaction line, and why
  there is no DriftReason (the `@` resources precedent).
- [ ] **Step 4: Run** `pnpm exec vitest run packages/kernel/test/evals`; it should PASS. Run `pnpm check:skills-frontmatter`; it should PASS.
- [ ] **Step 5: Commit** `feat(kernel): replay skill invocations and forked skills from the log`

### Task 8: IM: `/name args` in channels

**Files:**
- Modify: `packages/kernel/src/channels/inbound.ts` (after the `/new` check at `:237`, before `postUserMessage` at `:267`); `.agents/skills/writing-channels/SKILL.md`
- Test: `packages/kernel/test/channels/inbound.test.ts`; `plugins/slack` and `plugins/lark` are not changed

**Interfaces:**
- Consumes: `parseSlashCommand`, `listInvocableSkills` and the `postUserMessage` `skill` input (Task 3).

- [ ] **Step 1: Write the failing tests** with the fake channel server:
  - `@bot /fix-issue 7` in a group thread posts `skill: { name: "fix-issue" }` with `text: "7"`.
  - A direct message `/fix-issue 7` does the same.
  - A direct message `/new` still starts a new conversation (also when a skill named `new` exists).
  - `/unknown x` and `/etc/hosts` are posted as plain text.
  - A fork invocation from IM runs and the agent's reply reaches the thread.
  - A skill that went away between parse and post (400 `skill.not_invocable`) is posted as plain text, so the message is never lost.
- [ ] **Step 2: Run** `pnpm exec vitest run packages/kernel/test/channels/inbound.test.ts` and confirm it FAILS.
- [ ] **Step 3: Implement** the parse against the bound agent's invocable list, for the bound person.
- [ ] **Step 4: Run** `pnpm exec vitest run packages/kernel/test/channels`; it should PASS.
- [ ] **Step 5: Commit** `feat(kernel): invoke skills from IM messages`

### Task 9: Queued invocations (after UI refresh B merges)

**Files:**
- Create: `packages/kernel/src/migrations/0061_queued_skill.sql` (`ALTER TABLE capybara.conversation_queue ADD COLUMN IF NOT EXISTS skill jsonb`; use B's actual table name and the next free number at merge time)
- Modify: `packages/kernel/src/conversations/queue.ts` (`QueueInput.skill?`, `QueueItem.skill?`, render at queue time, send with `skill`), `packages/kernel/src/db/kernel-schema.ts`
- Test: `packages/kernel/test/conversations/queue.http.test.ts`

**Interfaces:**
- Consumes: `prepareInvocation` (Task 3); B's queue.
- Produces: `QueueItem.skill?: { name: string; arguments: string; mode: "inline" | "fork" }`.

- [ ] **Step 1: Write the failing tests:**
  - Queuing `skill: { name: "fix-issue" }, text: "9"` while a run is active stores the rendered content.
  - Sending it later appends a `user_message` with `skill` and the text as rendered when queued, even after the skill got a new version.
  - Queuing a skill that is not invocable is 400 `skill.not_invocable`.
  - A queued fork invocation runs as Task 6.
  - The migration applies twice without error (`migration` test pattern).
- [ ] **Step 2: Run** `pnpm exec vitest run packages/kernel/test/conversations/queue.http.test.ts` and confirm it FAILS.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm exec vitest run packages/kernel/test/conversations` and `pnpm check` (applied-migrations, test-plugins); both should PASS.
- [ ] **Step 5: Commit** `feat(kernel): queue skill invocations`

### Task 10: Design: skill chip and palette item tags (after B)

**Files:**
- Modify: `packages/design/src/conversation/composer.tsx` (`ComposerBox` prop `token?: { label: string; onRemove(): void }` rendered before the text area; `placeholder` follows the token's hint), the `CommandPalette` item type (`tags?: string[]`, `hint?: string`, `search?: string` extra text matched by the filter)
- Modify: `packages/design/src/dev/*` (fixtures for `/dev/ui`), `docs/design/reference/src/composer.html` (a `composer-skill` state), `docs/design/spec.md` (§6 composer)
- Test: `packages/design/test/composer.test.tsx`, `packages/design/test/command-palette.test.tsx`

**Interfaces:**
- Produces:
  - `ComposerBoxProps.token?: { label: string; hint?: string; onRemove(): void }`;
  - `CommandItem.tags?: string[]`, `CommandItem.hint?: string`, `CommandItem.search?: string`.

- [ ] **Step 1: Write the failing tests:**
  - The token renders with its label.
  - Backspace with the caret at 0 calls `onRemove` and keeps the text.
  - The hint becomes the textarea placeholder.
  - Palette items show tags and the hint.
  - Filtering `brai` matches an item whose `search` holds `superpowers:brainstorming`.
  - Ranking: name prefix before name substring before description.
- [ ] **Step 2: Run** `pnpm exec vitest run packages/design/test/composer.test.tsx packages/design/test/command-palette.test.tsx` and confirm it FAILS.
- [ ] **Step 3: Implement** with design tokens only. Request reference images through the `visual-update` workflow.
- [ ] **Step 4: Run** the tests and `pnpm check:web-ui`; both should PASS.
- [ ] **Step 5: Commit** `feat(design): skill chip in the composer and tagged palette items`

### Task 11: Web: the `/` menu, invocation, bubble and agent page (after B)

**Files:**
- Create: `apps/web/src/lib/skills.ts` (`listInvocableSkills`, `parseSlashCommand` mirror with the same regex)
- Modify:
  - `apps/web/src/components/conversation/ComposerBar.tsx` (the `prompts` palette becomes the `/` palette with the Skills group first, chip state, typed recognition, `skill` in `ComposerMessage`)
  - `apps/web/src/lib/conversations.ts` (`MessageInput.skill?`)
  - the user-bubble renderer: chip, arguments and a "Skill instructions" `Disclosure` from `content[0]`; for forks, B's sub-agent row and a "Report" disclosure from `skill_fork_result`
  - the queue bubble (chip)
  - the agent page skill picker ("manual" / "sub-agent" tags, `manual_only` pinned error)
  - `apps/web/messages/{en,zh}.json`
- Test: `apps/web/test/composer-skills.test.tsx` (new), `apps/web/test/agent-skills.test.tsx`, `apps/web/e2e/skills.spec.ts`

**Interfaces:**
- Consumes: the route and the `skill` input (Task 3); `skill_fork_result` (Task 6); queue `skill` (Task 9); `token`, `tags`, `hint`, `search` (Task 10).

- [ ] **Step 1: Write the failing tests:**
  - Palette contents:
    - `/` in an empty composer lists "Skills" (sorted, with tags and the argument hint) above the connector groups;
    - typing `fix` narrows the list;
    - picking `fix-issue` shows the chip, and typing `123` then Enter posts `{ text: "123", skill: { name: "fix-issue" } }`.
  - Typing `/fix-issue 7` without the menu and pressing Enter posts as an invocation. `/nope 7` posts plain text.
  - ⌘↵ while running queues with `skill`.
  - The bubble:
    - for a `user_message` with `skill`, it shows `/fix-issue` and `123`, and the disclosure holds `content[0]`;
    - for a fork, it shows the sub-agent row and the report.
  - The agent page:
    - shows the "manual" tag;
    - pinning a manual-only skill shows the `manual_only` message.
  - e2e `skills.spec.ts`: "invoke a manual skill with arguments and see its instructions in the bubble".
- [ ] **Step 2: Run** `pnpm exec vitest run apps/web/test/composer-skills.test.tsx apps/web/test/agent-skills.test.tsx` and confirm it FAILS.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm exec vitest run apps/web/test`, `pnpm check:web-ui`, `pnpm check:i18n` and `pnpm --filter @capybara-hq/web exec playwright test e2e/skills.spec.ts`; all should PASS. Add the web changeset.
- [ ] **Step 5: Commit** `feat(web): the / menu invokes skills with arguments`

### Task 12: Acceptance, docs and verification

**Files:**
- Create: `packages/kernel/test/skills/manual-invocation.e2e.test.ts`; fixture `packages/kernel/test/catalog/fixtures/claude/commands-demo/` (`commands/fix-issue.md` with `argument-hint: [issue-number]`, a `skills/manual-script/` with `disable-model-invocation: true` and `scripts/run.sh`, a `skills/review/` with `context: fork`, `agent: code-reviewer`, `agents/code-reviewer.md`, MIT `FIXTURE.md`)
- Modify:
  - `AGENTS.md`: the tools rule line names manual-only skills and `/` invocation; the runtime line names `user_message.skill` and `skill_fork_result`
  - `.agents/skills/writing-plugins/SKILL.md` (commands, manual-only and forked skills, report codes)
  - `.agents/skills/writing-tools/SKILL.md` (`skill_load`)
  - `docs/superpowers/plans/m7-live-acceptance-checklist.md` (live item)
  - the spec ("Phase D as built" section), including the batch 1 review fixes: `skill_write`'s
    model-visible description now says the invocation keys of the `SKILL.md` entry's frontmatter
    are kept (M4, maintainer ruling), which changes its spec hash. That is ordinary tool-definition
    drift: replays use the recorded spec hashes, the zero-drift fixtures pass before and after, and
    remembered grants for `skill_write` lapse once. Also `renderSkillInvocation`'s `skillName`
    (I1), `renderedMaxChars` (I2), the Claude `argument-hint` fallback (I4), and the `toolMap`
    ruling (M8)
  - changesets: kernel and `@capybara-hq/capybara`

- [ ] **Step 1: Write the acceptance test** `manual-invocation.e2e.test.ts` (one kernel, `model-fake`, fake sandbox, local fake git server):
  - Import and install `commands-demo` from git; the agent selects all its skills.
  - The first request's catalog lists `fix-issue` and `review`, not `manual-script`.
  - The model's `skill_load("fix-issue")` returns the body with `$ARGUMENTS` as written.
  - `/fix-issue 123` puts `Fix GitHub issue 123` inside `<skill_invocation name="fix-issue"`.
  - `/manual-script` then the model's `skill_load("manual-script")` copies `scripts/run.sh`.
  - `/review src` runs `<plugin>:code-reviewer`, the parent answers the report, and the whole conversation replays with `drift: []`.
- [ ] **Step 2: Run** `pnpm exec vitest run packages/kernel/test/skills/manual-invocation.e2e.test.ts`. It should FAIL only if a step above is incomplete; fix the owning task's code.
- [ ] **Step 3: Update the docs and skills** listed above. Run `pnpm check:skills-frontmatter`, `pnpm check:terms` and `pnpm check:test-plugins`.
- [ ] **Step 4: Run** `pnpm verify`. It should PASS: lint, typecheck, check, and the tests of the affected packages.
- [ ] **Step 5: Commit** `test(kernel): phase D acceptance for manual skills, commands and forks`

## Order and dependencies

Tasks 1 → 2 → 3 are sequential. Task 4 and Task 5 come after 3 (5 only needs 1). Task 6 needs 3.
Task 7 needs 6. Task 8 needs 3. Tasks 9–11 wait for UI refresh B on `main`, then 9 → 10 → 11.
Task 12 comes last.
