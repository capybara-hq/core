# UI Refresh B (Conversation Page) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the signed reference set with the conversation page, get it signed off, then rebuild `/chat` as the refined-E conversation page: a title bar with model-generated titles, a properties panel and one right panel at a time, a composer that holds agent / model / effort and a message queue, tool groups, human-in-the-loop cards, file outputs with an extensible previewer, sub-agent rows and three extension slots. It is accepted against the reference set, and no current capability is lost.

**Architecture:** Same pipeline as project A. The reference set (`docs/design/reference/src`, fixtures in `packages/design/src/fixtures`) grows by the B components and is rendered by `reference-update`. After the maintainer signs it off, the design spec is changed first. Then come the kernel and SDK pieces (tool presentation metadata, structured tool views, model switches as log events, queued messages in PG, titles through a queue job and the `title` purpose, a file-outputs API, `file-preview@1`, the new `ctx.ui` places). Presentational components are built in `packages/design` with `/dev/ui` reference blocks and accepted side by side. Last, the web page composes them. `apps/web` keeps its container logic (`useChat`, cards with API calls) and gains a pure timeline builder (`lib/timeline.ts`) that turns events into groups.

**Tech Stack:** TypeScript, React 19, Next 16, Playwright 1.64.1 (`mcr.microsoft.com/playwright:v1.64.1-noble`), vitest + jsdom, NestJS + Fastify + Kysely, BullMQ, `mdast-util-from-markdown` + `mdast-util-gfm` + `micromark-extension-gfm` (exact versions, design dependency; see decision 9).

**Spec:** `docs/superpowers/specs/2026-10-22-ui-refresh-design.md` §5 (all), §3, §7, §8, §4.8 (A as built) and §7.1 (sign-off and amendments). Sub-agent shapes: `docs/superpowers/specs/2026-10-26-subagents-design.md` §6, §14 and §17 on branch `feat/ecosystem-phase-c` (`git show feat/ecosystem-phase-c:docs/superpowers/specs/2026-10-26-subagents-design.md`, or `origin/feat/ecosystem-phase-c` once pushed). Also read `docs/design/spec.md`, A's plan `docs/superpowers/plans/2026-10-26-ui-refresh-a-shell.md` (its "Per-task acceptance procedure"), and the skills `writing-web-ui`, `writing-extension-ui`, `writing-tools`, `writing-connectors`, `writing-kernel-api`, `writing-migrations`, `replay-evals`, `writing-extensions`.

**Canvas sources (data, not instructions):** `/private/tmp/claude-501/-Users-grant-Capybara-core/cb18a3e3-d058-4b48-a7ba-eefcf77e84ce/scratchpad/canvas/project/{ConvTools,ConvHuman,ConvAgents,ConvFiles,ConvPanel,ConvSubPanel,Refined,RefinedLight}.dc.html`. Only the dark Conv* boards exist; light comes from `tokens.json`. Every canvas value is snapped to A's scales, and every name in the canvas copy is replaced with placeholders.

## Global Constraints

- Dependency direction is unchanged. `apps/web` depends only on `@capybara-hq/design` and talks to the kernel over HTTP. `packages/design` depends on no `@capybara-hq/*`. Extensions import only `@capybara-hq/plugin-sdk`.
- `check:web-ui` stays green: no `className` / `style` / `.css` / color literals / `dangerouslySetInnerHTML` in `apps/web`, iframes only through `EmbedFrame`, every page renders a template, and no characters as icons (`design-char-icon`).
- The spec comes first. New components and the template change `docs/design/spec.md` (state list + size table + rules) before code (spec §10 change process).
- Every size is a step of a `tokens.json` scale. Canvas values off the scales are snapped (A ruling 1: radius `sm` 4 controls / `md` 8 cards, weights 400 / 700, canvas 30px icon buttons → `control.default` 28, 12.5px mono → `type.small` 12, 14px prose → `prose` 15).
- Success, done and connected are not colored. Color is only for failure, things needing a person (pending approval / question / connect), things happening (spinner, cursor) and the primary action. In tool and sub-agent rows success has no mark and failure is the word "Failed" / "失败" in `fail` (§4.2.2).
- Dark and light ship together. Text contrast meets WCAG AA (4.5:1, and 3:1 for UI boundaries). Status never relies on color alone. `prefers-reduced-motion` makes the spinner static, the cursor steady and expand / collapse instant.
- UI copy goes through i18n (zh and en): `apps/web/messages/{zh,en}.json` for web, `packages/design/src/i18n.ts` for design defaults. UI copy says "files" (zh 文件) for file outputs and never "artifacts" / 产出物 (reserved for project C). Model-facing text (tool descriptions, the `description` argument, tool errors, the title prompt) is English.
- Placeholder copy only in fixtures and reference pages: 示例组织, 研究助手, 客服分流, 周报助手, Acme, `reports/2026-09/示例表.xlsx`. None of the canvas's real names (AURE, Revolut, 金蝶, SGD, BLOOMBERG, Lockton, Tokihiko, CHANHUA, DBS, Chong Hing, PWM, Xu YanLi, `RP List`, `f10/calc`).
- The event log is the single source of truth. Anything that changes a model request goes into the log, request building (`runtime/context/build.ts`) skips every new display-only event, and both zero-drift groups pass before and after each kernel task that touches tools, events or request building: `pnpm exec vitest run packages/kernel/test/evals/reconstruct.test.ts packages/kernel/test/tools/rename-compat.test.ts`.
- Multi-replica: queued messages, titles state, the selected model and previewer order live in PG. Timers and in-process maps are not allowed. Delayed work goes through BullMQ queues whose names and job ids contain no `:`. Every `ctx.kv` write has a TTL.
- Migrations: one file per task that needs one, named `NNNN_<snake>.sql` with the **next free number at implementation time** (phase C uses `0053`; rebase before numbering; the migrator refuses a file older than one already applied), `IF NOT EXISTS` / `IF EXISTS`, expand-only.
- Kernel: domain classes do not depend on Nest, constructor params use explicit `@Inject`, new error codes are registered in `errors.ts` with zh / en messages, every route has `@OrgAction`.
- SDK: changing the public API regenerates `packages/plugin-sdk/api/plugin-sdk.api.md` (`pnpm gen:sdk-api`) and adds a changeset bumping `@capybara-hq/plugin-sdk` (minor). Existing extensions using `place: "conversation"` keep working unchanged.
- Changesets: `@capybara-hq/web` (minor), `@capybara-hq/kernel` (minor), `@capybara-hq/plugin-sdk` (minor), `@capybara-hq/plugin-todo` and `@capybara-hq/plugin-connector-mcp` (minor). `example-board` and `design` are private and need none.
- Screenshot baselines and reference PNGs are generated only by the `visual-update` / `reference-update` workflows, never committed from darwin.
- Every new automatic check has a violating-fixture test seen red first, and states full vs. by-diff in `AGENTS.md` "CI and checks" and the `ci.yml` header comments.
- Commits: Conventional Commits, body lines ≤ 100 characters, ending `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Work only in `.claude/worktrees/feat-ui-refresh-b` (branch `feat/ui-refresh-b`).
- **Out of scope:** MCP Apps widgets (stage B2; B leaves the inline-card slot able to host them), Artifacts (project C; no "Share" on file outputs), the sub-agent runtime itself (phase C), terminal and browser panels, mobile beyond the narrow-screen rules.

## Review Focus

1. **A run that is waiting or has just stopped while the person keeps typing.** ↵ while running interjects (unchanged); ⌘↵ / Ctrl+↵ queues. Queued messages never jump ahead of an interjection, wait through approvals and questions, pause on failure or stop, and survive a reload and a kernel replica restart. Two tabs editing the same queue converge. Tested in Task 9 (dual-replica dispatch, pause on `run_failed` / `run_aborted`, `send now` racing the dispatcher) and Task 19 (keyboard, reload).
2. **Old conversations and old logs.** A conversation written before B (no `description` on `sandbox_bash`, no `view` on `tool_result`, no `model_switched`, no title) renders without errors: rows fall back to the tool key and the first string argument, failures fall back to `isError`, the title shows the untitled placeholder, and replay of old cases still matches recorded `sandbox_bash` calls. Tested in Task 5 (rename-compat fixtures, `RecordedToolPipeline` ignoring `description`), Task 13 (`timeline.test.ts` with a pre-B fixture log) and Task 8 (zero drift with and without switches).
3. **Extension failure isolation.** An inline card, properties section, right panel or previewer whose view throws, times out (10 s), returns an invalid view, or whose extension is disabled mid-conversation shows "Failed to load · Retry" in that block only. The message stream keeps rendering and the composer keeps working. Tested in Task 12 (kernel 5xx / timeout codes), Task 18 (frames) and Task 20 (Playwright: a failing fake extension next to a streaming run).
4. **Big and hostile content.** A 2 MB command output, a 10,000-line diff, a 300-character file name, a 60-character CJK title, Markdown with raw `<script>` / `javascript:` links / 5,000-row tables, and a file path chip that names a file not in the conversation are all handled: truncation with "View all" from the archive, the diff capped at `TOOL_VIEW_DIFF_MAX_LINES` with a "diff truncated" line, middle truncation keeping the extension, HTML rendered as text, links only http(s), and a chip only for paths that match a file output. Tested in Task 5 (diff cap), Task 13 (Markdown safety), Task 15 (file names) and Task 14 (output cap).
5. **Switching model, agent and conversation mid-flight.** Changing model or effort while a run is in progress applies from the next run and is logged once. A switched-to model that disappears falls back to the agent's model with a notice. Navigating to another conversation while a right panel is open or an upload is in progress never shows the old conversation's panel, files or queue under the new one. Tested in Task 8 (fallback event, replay honoring), Task 19 (conversation switch drops panel and queue state; uploads are per conversation).

---

## File Structure

| Path | Responsibility | Task |
|---|---|---|
| `docs/design/tokens.json` (+ generated `tokens.css`, `tokens.ts`) | New B tokens: diff tints, layout widths, motion | 1 |
| `packages/design/src/fixtures/conversation.ts` (re-exported from `fixtures/index.ts`) | One fixture set for the B reference pages and `/dev/ui` | 1 |
| `docs/design/reference/src/{conversation-*,tool-*,…}.html`, `reference.css`, `fill.js` | B reference blocks | 2 |
| `docs/design/spec.md`, `.agents/skills/{writing-web-ui,writing-extension-ui,writing-tools}/SKILL.md` | B rules, state lists, size tables, interaction spec | 3 |
| `packages/plugin-sdk/src/tool.ts`, `packages/kernel/src/tools/{info.ts,registry.ts,specs.ts}`, `plugins/connector-mcp/src/session.ts` | Tool title, key args, kinds; tool info API | 4 |
| `packages/kernel/src/tools/builtins/sandbox/{bash,edit,write,read,common}.ts`, `packages/kernel/src/tools/view.ts`, `packages/kernel/src/evals/recorded-tools.ts` | `description`, structured tool views, diffs, replay matching | 5 |
| `packages/kernel/src/tools/{approvals.service,approvals.controller,pipeline,policy}.ts` | Deny reason, policy source on approvals | 6 |
| `packages/kernel/src/conversations/{conversations.service,conversations.controller,titles}.ts`, `packages/kernel/src/models/purposes.ts` | Create on first send, rename, title job and `title` purpose | 7 |
| `packages/kernel/src/conversations/events.ts`, `runtime/{run-worker,model-call}.ts`, `evals/{reconstruct,step-replay,run-replay}.ts` | `model_switched`, runtime selection, replay | 8 |
| `packages/kernel/src/conversations/queue.ts`, `runtime/run-queue.ts`, `runtime/run-finish.ts` | Queued messages | 9 |
| `packages/kernel/src/conversations/files.ts` | File-outputs list, versions, text content route | 10 |
| `packages/plugin-sdk/src/file-preview.ts`, `packages/kernel/src/files/{previewers,previewers.controller}.ts` | `file-preview@1` | 11 |
| `packages/plugin-sdk/src/{ui,permissions,tool}.ts`, `packages/kernel/src/ui/*`, `plugins/todo/src/index.ts`, `plugins/example-board/*` | New `ctx.ui` places, open targets, tool-result cards | 12 |
| `packages/design/src/display/markdown.tsx`, `packages/design/src/conversation/{prose,divider,thinking}.tsx` | Prose, Markdown, cursor, user bubble, dividers | 13 |
| `packages/design/src/conversation/{tool-group,tool-row,diff-block}.tsx` | Tool display | 14 |
| `packages/design/src/conversation/{hitl,queued}.tsx` | Approval / question / connect blocks, queued message | 15 |
| `packages/design/src/conversation/{files,file-preview}.tsx` | File cards, outputs, chips, attachment strip, preview frame, built-in previewers | 16 |
| `packages/design/src/conversation/subagents.tsx` | Sub-agent group, row, task block | 17 |
| `packages/design/src/templates/conversation-page.tsx`, `packages/design/src/conversation/{title-bar,properties,right-panel,inline-card,composer}.tsx` | Template and frames | 18 |
| `apps/web/src/lib/{timeline,tool-info,queue,files,previewers}.ts`, `apps/web/src/components/conversation/*`, `apps/web/src/app/[locale]/(app)/chat/{page.tsx,[conversationId]/page.tsx}` | The web page | 19–20 |
| `apps/web/src/components/conversation/SubagentPanel.tsx`, `apps/web/src/lib/subagents.ts` | Sub-agent wiring (phase C dependent) | 21 |
| `apps/web/e2e/conversation-*.spec.ts`, `apps/web/visual/conversation.interaction.spec.ts` | Anti-goal capability matrix, interaction specs | 22 |

---

### Task 1: B tokens and conversation fixtures

Step 0 part 1 for B. Values come from the canvas `p` / `s` maps, snapped to the scales.

**Files:**
- Modify: `docs/design/tokens.json`; regenerate `packages/design/src/styles/tokens.css` and `packages/design/src/tokens.ts` (`pnpm gen:tokens`)
- Create: `packages/design/src/fixtures/conversation.ts`; modify `packages/design/src/fixtures/index.ts` (`export * from "./conversation"`)
- Test: `packages/design/test/fixtures.test.ts` (extend), `tools/checks/test/tokens.test.ts` (repo case still green)

**Interfaces:**
- Produces tokens (dark / light / purpose). Colors: `diff-add` `rgba(63,212,131,.08)` / `rgba(22,128,63,.10)` "Added lines in a diff"; `diff-del` `rgba(255,92,82,.08)` / `rgba(207,34,46,.08)` "Removed lines in a diff". `size.layout` gains `title-bar: 48`, `properties: 300`, `panel-min: 520`, `panel: 560`, `chat-min: 480`, `tool-output: 120`, `file-card: 240`, `thumb: 56`, `inline-image: 360`. `motion` gains `cursor: "1000ms"`, `spin: "800ms"`. `contrast` gains `["ink","diff-add",4.5]` and `["ink","diff-del",4.5]` (rgba tokens are composited over `bg` by `contrastRatio`; if the A implementation skips rgba pairs, extend it to composite over `bg` and add a fixture case).
- Produces `@capybara-hq/design/fixtures` additions. They are pure data, typed with plain shapes so design components can take them as props:

```ts
export const CONV_FIXTURE: {
  title: string;                       // "分析 9 月示例表差异"
  untitledAt: string;                  // ISO, for the untitled placeholder
  agent: { id: string; name: string }; // 研究助手
  models: { provider: string; label: string; models: { id: string; label: string; efforts?: string[] }[] }[];
  selected: { provider: string; model: string; effort: string };
  stats: { turns: number; elapsed: string; context: string; status: string; version: string };
};
export type FixtureTool = {
  id: string; kind: "command" | "read" | "edit" | "search" | "connector" | "meta" | "tool";
  verb: string; source?: string; title: string; keyArg?: string; extra?: string;
  status: "running" | "done" | "failed"; elapsed?: string; durationMs?: number;
  input?: [string, string][]; command?: string; output?: string; outputBytes?: number;
  error?: string; diff?: FixtureDiffLine[]; added?: number; removed?: number;
};
export type FixtureDiffLine = { kind: "ctx" | "add" | "del"; old?: number; new?: number; text: string };
export const TOOL_FIXTURES: Record<"single" | "running" | "done" | "doneFailed" | "oneObject" | "expanded" | "diff" | "largeOutput" | "hookDenied", FixtureTool[]>;
export const PROSE_FIXTURE: { markdown: string; streaming: string; thinking: string; thinkingSeconds: number };
export const HITL_FIXTURE: { approval: {…}; question: {…}; questionUrl: {…}; connect: {…}; decided: {…} };
export const QUEUE_FIXTURE: { text: string }[];      // 2 items
export const DIVIDER_FIXTURE: { stopped: {…}; failed: {…}; compacted: {…}; fallback: {…} };
export const SUBAGENT_FIXTURE: { running: FixtureSubagent[]; done: FixtureSubagent[]; open: string; panel: {…} };
export type FixtureSubagent = { id: string; agentType: string; description: string; status: "running" | "done" | "failed"; toolCalls: number; duration: string; steps?: string[]; result?: string };
export const FILE_FIXTURE: { attachments: {…}[]; outputs: FixtureFile[]; many: FixtureFile[]; image: FixtureFile; text: FixtureFile & { head: string }; removed: FixtureFile & { reason: string }; paths: string[] };
export type FixtureFile = { id: string; name: string; type: string; size: string; version?: number; removed?: boolean };
export const PANEL_FIXTURE: { context: {…}; tasks: { done: number; total: number; items: {…}[] }; background: {…}; csvRows: string[][] };
```

- [ ] **Step 1: Failing tests.** In `fixtures.test.ts` extend the banned-name list with BLOOMBERG, Lockton, Tokihiko, CHANHUA, DBS, Chong Hing, PWM, Xu YanLi, `RP List`, `f10/calc` and assert it over every export. Add: `TOOL_FIXTURES.diff[0].diff` has ≥ 1 `add` and ≥ 1 `del` line; `FILE_FIXTURE.many.length === 6`; one output name is ≥ 60 characters and ends in `.xlsx`; `SUBAGENT_FIXTURE.running.length === 2`. Run `pnpm exec vitest run packages/design/test/fixtures.test.ts` → FAIL.
- [ ] **Step 2: Implement** the tokens (then `pnpm gen:tokens`) and `conversation.ts`, drawing structure and counts from the canvas sections with placeholder copy.
- [ ] **Step 3: Run** `pnpm exec vitest run packages/design/test tools/checks/test/tokens.test.ts` → PASS; `pnpm check:tokens` → passed.
- [ ] **Step 4: Commit** `feat(design): conversation tokens and fixtures for the B reference set`.

### Task 2: Reference pages for B

Step 0 part 2. One block per component state, drawn from the canvas rows 3 / 5 / 6 (Refined, ConvTools, ConvHuman, ConvAgents, ConvFiles, ConvPanel, ConvSubPanel), snapped to the scales, with Task 1's fixtures.

**Files:**
- Create: `docs/design/reference/src/{template-conversation,title-bar,composer,picker-menu,prose,thinking-row,user-bubble,run-divider,tool-group,tool-row,diff-block,approval-block,question-block,connect-block,queued-message,subagent-group,inline-card,property-section,right-panel,file-card,file-outputs,attachment-strip,file-preview}.html`
- Modify: `docs/design/reference/src/{index.html,reference.css,fill.js}`, `docs/design/reference/README.md`, `apps/web/reference/review-page.mjs` (group B blocks under their own heading)
- Test: `apps/web/reference/render.spec.ts` is the renderer (block-id uniqueness and real-font checks already there)

**Interfaces:**
- Block ids (`<component>-<state>`). This list is final for step 0 and Task 3 copies it into the spec:
  - `template-conversation`: `properties`, `file-panel`, `subagent-panel`, `new`, `sheet` (1280 × 820; `sheet` is 1100 wide with the right panel as an overlay)
  - `title-bar`: `default`, `untitled`, `rename-menu`, `panel-active`, `overflow`, `long-title`
  - `composer`: `idle`, `new`, `running`, `attachments`, `focus`, `no-effort`
  - `picker-menu`: `model`, `effort`, `agent`
  - `prose`: `markdown`, `streaming`, `file-chip`
  - `thinking-row`: `collapsed`, `expanded`, `live`
  - `user-bubble`: `default`, `attachments`
  - `run-divider`: `stopped`, `failed`, `compacted`, `compacted-open`, `fallback`, `hook-denied`
  - `tool-group`: `single`, `running`, `collapsed`, `collapsed-failed`, `one-object`, `expanded`, `edited`
  - `tool-row`: `default`, `hover`, `focus`, `running`, `failed`, `expanded-command`, `expanded-connector`, `expanded-failed`, `large-output`, `hook-denied`
  - `diff-block`: `default`, `truncated`
  - `approval-block`: `pending`, `pending-once`, `deny-reason`, `approved`, `denied`
  - `question-block`: `pending`, `url`, `answered`, `skipped`
  - `connect-block`: `pending`, `closed`
  - `queued-message`: `default`, `hover`, `editing`, `paused`
  - `subagent-group`: `running`, `done`, `failed`, `expanded`, `row-open`
  - `inline-card`: `view`, `embed`, `loading`, `failed`
  - `property-section`: `context`, `files`, `background`, `extension`, `failed`
  - `right-panel`: `extension`, `file`, `subagent`, `switcher`, `failed`
  - `file-card`: `default`, `hover`, `focus`, `long-name`, `removed`
  - `file-outputs`: `two`, `more`, `image`, `image-hover`, `text`
  - `attachment-strip`: `image`, `file`, `uploading`, `rejected`
  - `file-preview`: `image`, `text`, `markdown`, `csv`, `none`, `failed`
- Snap rules to apply while drawing (each becomes a size-table row in Task 3): title bar `layout.title-bar` 48, icon buttons `control.default` 28 with `radius.sm`; properties panel `layout.properties`; right panel `layout.panel` with `panel-2` ground and a `line-soft` divider; tool row padding `pad.default` (canvas 6/12), tool text `type.small`, group box `panel` + `radius.md`, rows divided by `line-soft`; expanded output `bg` ground, `radius.sm`, `type.small`, max height `layout.tool-output`; key / value grid gap `space.1` × `space.3`, keys `faint`, values `ink`; inline cards / approval / composer `raised` ground, 1px `line` border, `radius.md`, padding `space.3` (canvas 12/14 → 12/12); pending approval border `accent`; primary button `control.default`; user bubble `selected` ground, `radius.bubble`, padding `pad.default`, max width 75%; queued bubble the same with opacity .6 and a 1px dashed `line` border; divider `type.small` `muted` with `line` rules; file card min width `layout.file-card`, padding `pad.default` (canvas 6/10 → 6/12), type badge `type.micro` 700 with a `line` border and `radius.sm`; thumbnails `layout.thumb`; diff gutter 4 characters, add / del rows `diff-add` / `diff-del` ground only.
- The file-preview header has no Share button (spec §5.8). The pending approval is the only accent-outlined card. Success marks are absent (canvas `ok` dots are dropped).

- [ ] **Step 1: Write the pages** (one `.html` per component, each block `<section data-ref-block="<id>" style="width:…;height:…">`, icons as `<i data-icon>`, data from `window.__CB_FIXTURES__`). Add any icon names the pages need to `packages/design/scripts/gen-icons.mjs` (expected: `maximize-2`, `minimize-2`, `panel-right`, `sliders-horizontal`, `square-pen`, `trash-2`, `send` (arrow-up already exists), `list-plus`, `git-compare`, `terminal`, `file-pen`, `bot`, `list-checks`, `link`, `zoom-in`) and run `pnpm --filter @capybara-hq/design gen:icons`.
- [ ] **Step 2: Render locally** `pnpm --filter @capybara-hq/web reference:render` → PASS (ids unique, fonts loaded). Do not commit darwin PNGs (`git restore docs/design/reference/*.png`).
- [ ] **Step 3: Commit** `feat(design): reference pages for the conversation page`. Push, run `gh workflow run reference-update.yml -f branch=feat/ui-refresh-b`, pull the bot's commit, and build the review page (`node apps/web/reference/review-page.mjs`) for the gate.

---

## ⛔ Sign-off gate (maintainer)

Execution **stops here**. The coordinator publishes the review page (dark | light per B block) with the Task 1 token additions and the "Needs a maintainer decision" list at the end of this plan. Changes loop back into Tasks 1–2 and the workflow re-renders. Tasks 3–22 start only after an explicit sign-off. From then on, changing the reference set goes through the design spec's §10 change process.

---

### Task 3: Design spec and skills for B

Docs only, reviewed before Task 13.

**Files:**
- Modify: `docs/design/spec.md`, `.agents/skills/writing-web-ui/SKILL.md`, `.agents/skills/writing-extension-ui/SKILL.md`, `.agents/skills/writing-tools/SKILL.md`

- [ ] **Step 1: Spec.**
  - §5: T7 becomes **Conversation** (`ConversationPage`): left sidebar | middle column (title bar, thread ≤ `layout.chat` centered, composer, status bar) | right area (properties panel `layout.properties` *inside* the middle column under its title bar, or one right panel, full height, `layout.panel-min`…viewport-limited, resizable, width per viewer). Below `layout.chat-min` + `layout.panel-min` of content width the right area is a sheet. `PlaygroundPage` is removed (only the chat page used it).
  - §6.16 is replaced by one subsection per component of Task 2 (rules + `<!-- states: … -->` with exactly the Task 2 states + `<!-- size-table: … -->` using the snap rules of Task 2). Remove the "(added by project B)" heading marker as part of this task; the components stay out of the completeness case until they are in `ACCEPTED`, so change §9.4 to: "except components listed in `PENDING_B` in `apps/web/visual/accepted.ts`", and Task 22 empties `PENDING_B`.
  - §6.9: ToolCallRow / IoBlock and the Inspector-only Checklist are superseded by tool-row / tool-group; keep EmbedFrame, CodeBlock, ImageBlock, AttachmentChip, FileDrop, FileButton rules.
  - §6.11 Interaction gains: ↵ send / interject, ⌘↵ (Ctrl+↵ off macOS) queue while running and send while idle, Shift+↵ newline, Esc closes the open menu, then the right-panel sheet (never stops a run); tool rows, tool groups, thinking and sub-agent rows are `button`s with `aria-expanded` and height transitions of `motion.expand`; ← / → on the right-panel resize handle by 16 px, Home / End to min / max; the open panel's title-bar icon has `aria-pressed="true"`.
  - §2.4: the queued state uses `circle` `faint` + the text "Queued" / "排队中"; the streaming cursor is a 2 × 1em `accent` bar blinking at `motion.cursor`.
  - §7 Copy: verbs per tool kind (zh / en) from Task 14's table; "files" vs "Artifacts".
- [ ] **Step 2: Skills.** `writing-web-ui`: Conversation template, the timeline builder rule (pages never group tool calls themselves; `lib/timeline.ts` does). `writing-extension-ui`: the new places (`panel`, `section`, `inline`), `conversation` = `panel`, `icon`, open targets, `ToolResult.card`, previewers (`file-preview@1`). `writing-tools`: `title`, `keyArgs`, tool kinds, `sandbox_bash` `description`, `tool_result.view`. Keep frontmatter valid.
- [ ] **Step 3: Verify** `pnpm check:terms && pnpm check:skills-frontmatter && pnpm exec vitest run packages/design/test/spec-tables.test.ts` → passed (the repo case: every new size table references existing tokens).
- [ ] **Step 4: Commit** `docs(design): conversation page rules, states and size tables`. Request review of the spec diff before Task 13.

### Task 4: Tool presentation metadata (title, key arguments, kinds)

Spec §5.9 rows "Tool kinds" and "Tools may declare key arguments and a title".

**Files:**
- Modify: `packages/plugin-sdk/src/tool.ts`; `packages/kernel/src/tools/registry.ts` (`specHash` excludes display fields), `packages/kernel/src/tools/builtins/*` (declare `title` / `keyArgs`), `plugins/connector-mcp/src/session.ts` (keep the MCP `title`)
- Create: `packages/kernel/src/tools/info.ts`; route in `packages/kernel/src/conversations/conversations.controller.ts`
- Test: `packages/kernel/test/tools/info.test.ts`, `packages/kernel/test/tools/registry.test.ts` (hash case), `plugins/connector-mcp/test/session.test.ts` (title case), `packages/plugin-sdk/test/tool.test.ts`
- Modify: `packages/plugin-sdk/api/plugin-sdk.api.md` (regenerated); `.changeset/ui-refresh-b-sdk.md`

**Interfaces:**
- SDK `ToolSpec` gains (display only, never sent to the model, not part of the definition fingerprint):

```ts
/** Short human title, e.g. the MCP `title` ("Search messages"). ≤ 80 chars. */
title?: string;
/** Up to 3 input property names shown on the tool's row, in order, e.g. ["query", "channel"]. */
keyArgs?: string[];
```
  plus `export function validateToolPresentation(spec: Pick<ToolSpec, "title" | "keyArgs" | "inputSchema">): string[]` (title 1–80 chars; keyArgs ≤ 3, unique, each a property of `inputSchema.properties`).
- Kernel `registry.ts`: `export const DISPLAY_ONLY_SPEC_FIELDS = ["title", "keyArgs"] as const`; `specHash(spec)` hashes the spec without them, so adding a title never changes a fingerprint, never triggers drift review and never changes `model_call.request.tools`. The `tool_specs` row keeps whatever was stored first (it is content-addressed by the same hash); display reads current metadata from `info.ts`, not from `tool_specs`.
- `info.ts`:

```ts
export type ToolKind = "command" | "read" | "edit" | "search" | "connector" | "meta" | "tool";
export interface ToolInfo {
  key: string;
  title: string | null;
  kind: ToolKind;
  keyArgs: string[];
  source: { kind: "builtin" } | { kind: "extension"; name: string } | { kind: "connector"; id: string; name: string };
}
export const BUILTIN_TOOL_KINDS: Record<string, ToolKind> = {
  sandbox_bash: "command", sandbox_read: "read", sandbox_write: "edit", sandbox_edit: "edit",
  sandbox_glob: "search", sandbox_grep: "search", sandbox_deliver: "tool",
  tool_search: "meta", skill_load: "meta", skill_write: "meta", read_tool_output: "meta", ask_user: "meta",
};
export async function toolInfo(deps: ToolInfoDeps, orgId: string, keys: string[]): Promise<ToolInfo[]>;
```
  Connector keys (`<slug>__<tool>`) read the connector's current stored tool spec; extension keys (`<ext>__<tool>`) the loaded extension's registration; unknown keys come back with `kind: "tool"`, `title: null`, `keyArgs: []`. Builtin titles / keyArgs: `sandbox_bash` ["command"], `sandbox_read` ["path"], `sandbox_write` ["path"], `sandbox_edit` ["path"], `sandbox_glob` ["pattern"], `sandbox_grep` ["pattern","path"], `sandbox_deliver` ["path"], `skill_load` ["name"], `tool_search` ["query"].
- HTTP: `GET /api/v1/orgs/:orgId/conversations/:id/tools?keys=a,b` (≤ 100 keys, each ≤ 200 chars), `@OrgAction("agents.use")`, same visibility as the events API (`conversation.not_found`). 200 `{ tools: ToolInfo[] }`.
- `connector-mcp`: a tool's `title` (or `annotations.title`) goes to `ToolSpec.title` (trimmed, cut to 80); the description fallback stays.

- [ ] **Step 1: Failing tests.** `registry.test.ts`: `specHash({...s, title: "X", keyArgs: ["q"]}) === specHash(s)`. `tool.test.ts`: `validateToolPresentation` rejects an 81-char title, 4 keyArgs, and a keyArg that is not an input property. `info.test.ts`: builtins map per the table; a connector tool with an MCP title returns it with `source.name` = the connector's name; an unknown key → `kind: "tool"`; another user's conversation → 404; 101 keys → 400. `session.test.ts`: an MCP tool with `title: "Search messages"` yields `spec.title`, and its `specHash` equals the same tool without a title (no drift review). Run → FAIL.
- [ ] **Step 2: Implement.** Extension registration validates presentation with `validateToolPresentation` (an invalid one is a setup error naming the field). Run → PASS. Run `pnpm exec vitest run packages/kernel/test/tools packages/kernel/test/evals/reconstruct.test.ts packages/kernel/test/tools/rename-compat.test.ts` → PASS.
- [ ] **Step 3: SDK API.** `pnpm gen:sdk-api`; changeset `@capybara-hq/plugin-sdk: minor` "ToolSpec gains display-only `title` and `keyArgs`". Kernel changeset line in `.changeset/ui-refresh-b-kernel.md` (`@capybara-hq/kernel: minor`), connector-mcp in `.changeset/ui-refresh-b-connector-mcp.md`.
- [ ] **Step 4: Commit** `feat(kernel): tool titles, key arguments and kinds for display`.

### Task 5: `sandbox_bash` description and structured tool views

Spec §5.5 items 5–9, §5.9 rows 1, 2, 5. Model-visible change: the `sandbox_bash` input schema.

**Files:**
- Modify: `packages/kernel/src/tools/builtins/sandbox/{bash,edit,write,read,common}.ts`, `packages/kernel/src/conversations/events.ts` (`tool_result.view`), `packages/kernel/src/tools/pipeline.ts` (pass `view` through), `packages/kernel/src/evals/recorded-tools.ts`
- Create: `packages/kernel/src/tools/view.ts` (`lineDiff`)
- Test: `packages/kernel/test/tools/sandbox/sandbox-tools.test.ts`, `packages/kernel/test/tools/view.test.ts`, `packages/kernel/test/evals/run-replay.test.ts` (matching), `packages/kernel/test/evals/reconstruct.test.ts` (zero drift with the new schema)

**Interfaces:**
- `sandbox_bash` input gains a **required** `description`: `{ type: "string", minLength: 1, maxLength: 120, description: "What this command does, in a few words (e.g. \"Generate the final PDF\"). Shown to the user." }`; `required: ["command", "description"]`. The tool description gets one sentence: "Always pass description: a few words saying what the command is for; the user sees it instead of the command." A missing description is a validation error the model can fix (existing schema validation; message stays the generic actionable one).
- `isError` stays as today (timeout or abort only); see decision 3. The non-zero exit becomes a display failure through `view`.
- `tool_result` payload gains optional `view` (display only; request building already ignores everything but `callId` / `content` / `isError`; not in compaction records):

```ts
export const TOOL_VIEW_DIFF_MAX_LINES = 2000;
const ToolViewSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("command"), description: z.string().max(120).optional(),
    exitCode: z.number().int().nullable(), timedOut: z.boolean() }),
  z.object({ kind: z.literal("edit"), path: z.string().max(1024), created: z.boolean(),
    added: count, removed: count, truncated: z.boolean(),
    hunks: z.array(z.object({ oldStart: count, newStart: count,
      lines: z.array(z.object({ kind: z.enum(["ctx", "add", "del"]), text: z.string().max(2000) })) })) }),
  z.object({ kind: z.literal("read"), path: z.string().max(1024), fromLine: count.optional(), toLine: count.optional() }),
]);
```
  `view.failed` is derived by the web: `command` with `exitCode !== 0 && exitCode !== null`, or `timedOut`, or `isError`.
- `view.ts`: `export function lineDiff(before: string, after: string, context = 3): { hunks: Hunk[]; added: number; removed: number; truncated: boolean }` (Myers diff on lines; output capped at `TOOL_VIEW_DIFF_MAX_LINES` lines total, `truncated: true` beyond; files over 1 MB on either side return `{ hunks: [], added, removed, truncated: true }` with counts from a line-set comparison). `sandbox_write` diffs against the previous content when the file existed (`created: false`), else all lines added.
- Builtins return the view through `BuiltinTool.run` → `{ …, view }` (extend the builtin result type in `registry.ts`; extension tools cannot set `view`).
- `RecordedToolPipeline` matching: for `sandbox_bash`, normalized arguments drop `description` before comparing, so old recordings (no description) and new calls (with one) still match, and vice versa.

- [ ] **Step 1: Failing tests.** `view.test.ts`: one replaced line → 1 add, 1 del, 3 lines context each side; 3,000 changed lines → `truncated: true` and ≤ 2,000 lines. `sandbox-tools.test.ts` (fake sandbox): a call without `description` → validation error result; `exit 1` → `isError: false`, `view: { kind: "command", exitCode: 1, timedOut: false, description }`; edit → `view.kind === "edit"` with `added`/`removed`; write over an existing file → `created: false` and a diff; read with offset → `fromLine`/`toLine`. `run-replay.test.ts`: a recording without `description` matches a replayed call with one. `reconstruct.test.ts`: a fixture conversation with new-style bash calls reconstructs with `drift: []`. Run → FAIL.
- [ ] **Step 2: Implement.** Run the tests above → PASS. Run both zero-drift groups → PASS.
- [ ] **Step 3: Docs.** `writing-tools` already updated in Task 3; add the `view` field to the `replay-evals` skill sentence listing display-only `tool_result` fields.
- [ ] **Step 4: Commit** `feat(kernel): shell command descriptions, exit codes and diffs for the tool rows`.

### Task 6: Approval deny reason and policy source

Spec §5.7 approval.

**Files:**
- Modify: `packages/kernel/src/tools/{approvals.service,approvals.controller,pipeline,policy}.ts`, `packages/kernel/src/conversations/events.ts`
- Create: migration `NNNN_approval_reason.sql` (`ALTER TABLE capybara.approvals ADD COLUMN IF NOT EXISTS deny_reason text`)
- Test: `packages/kernel/test/tools/approvals.http.test.ts`

**Interfaces:**
- `POST …/approvals/:id/decision` body gains `reason?: string` (1–500 chars, only with `deny`; with `approve` → 400 `validation_failed`).
- `approval_decided` payload gains `reason?: string` (display only). The denied call's `tool_result` text becomes `The user denied this tool call. Reason: <reason>` when a reason is given (model-visible, in the log; see decision 4), else unchanged `APPROVAL_DENIED_TEXT`.
- `approval_requested` payload gains `policy?: "agent" | "connector" | "default" | "role"` (display only: which rule asked — the agent's tool policy, the connector admin's policy, the tool's default, or role escalation), taken from the policy decision the pipeline already computes.
- `Approval` view gains `denyReason: string | null`.

- [ ] **Step 1: Failing tests:** deny with reason → event payload has `reason`, the call's result text ends with `Reason: too risky`, the approvals list shows `denyReason`; approve with reason → 400; a role-escalated approval has `policy: "role"`; an agent `ask` policy → `"agent"`. Run → FAIL.
- [ ] **Step 2: Implement**, migration, `pnpm check:migrations`. Run → PASS; zero-drift groups → PASS.
- [ ] **Step 3: Commit** `feat(kernel): deny reasons and the asking policy on approvals`.

### Task 7: Create on first send, rename, generated titles

Spec §5.1 titles, §5.2 new conversation, §5.9 rows 7–8.

**Files:**
- Create: `packages/kernel/src/conversations/titles.ts`; migration `NNNN_conversation_titles.sql`
- Modify: `packages/kernel/src/conversations/{conversations.service,conversations.controller,events}.ts`, `packages/kernel/src/models/purposes.ts` (`title` purpose), `packages/kernel/src/runtime/run-worker.ts` (enqueue after a completed run), `packages/kernel/src/runtime/usage-report.ts` (report `purpose: "title"`), `packages/kernel/src/evals/trajectory.ts` (skip title usage in steps, count in totals), `packages/kernel/src/errors.ts`
- Test: `packages/kernel/test/conversations/conversations.http.test.ts`, `packages/kernel/test/conversations/titles.test.ts`, `packages/kernel/test/conversations/titles.dual.test.ts`

**Interfaces:**
- Migration: `conversations` gains `title_source text CHECK (title_source IN ('generated','manual'))`, `title_attempts int NOT NULL DEFAULT 0`, `create_request_id text`; `CREATE UNIQUE INDEX IF NOT EXISTS conversations_create_request_idx ON capybara.conversations (org_id, account_id, create_request_id) WHERE create_request_id IS NOT NULL`.
- `POST /conversations` body: `{ agentId: string; message?: { text: string; clientMessageId: string; attachments?: …; files?: string[]; model?: ModelRef; effort?: string } }`. With `message`, the conversation and its first `user_message` (and a `model_switched` from Task 8 when `model` / `effort` differ from the agent's) are written in one transaction, `create_request_id = clientMessageId`; a retry with the same `clientMessageId` returns the same conversation and event (200 instead of 201). Response `{ conversation, event? }`. Without `message` the old behavior stays for API clients; the web never creates empty conversations again.
- `PATCH /conversations/:id` `{ title: string }` (1–120 chars after trim), owner only, sets `title_source = 'manual'`; publishes the change frame (below). `ConversationView` gains `titleSource: "generated" | "manual" | null`.
- Purpose: `KERNEL_PURPOSES` gains `{ purpose: "title", kind: "chat", label: { zh: "会话标题", en: "Conversation titles" } }`. Unmapped (`model.unconfigured`) → the conversation's current chat model (agent model or the `model_switched` selection from Task 8).
- `titles.ts`: queue `cap-kernel-titles`, job id `title-<conversationId>-<attempt>`, consumed on the `worker` role.

```ts
export const TITLE_MAX_ATTEMPTS = 3;
export const TITLE_PROMPT: string; // English: "Write a title of at most 8 words for this conversation, in the
// language the user writes in. Reply with the title only, no quotes or punctuation at the end."
export function titleExcerpt(firstUser: string, firstReply: string): string; // ≤ 1,000 chars each, joined
export async function maybeEnqueueTitle(deps, conversationId: string): Promise<void>;
// enqueues iff kind = 'chat', title IS NULL, title_source IS NULL, title_attempts < 3,
// and the log has an assistant_message with text
export async function runTitleJob(deps, conversationId: string, attempt: number): Promise<void>;
```
  `runTitleJob` increments `title_attempts` first, calls the model (max output 32 tokens, no tools), trims to one line of ≤ 120 chars, and writes `title` with `title_source = 'generated'` only `WHERE title_source IS NULL` (a manual rename wins, even mid-call). It appends a `usage` event with `runId: null`, `step: 0` and `purpose: "title"` (widen the `usage.purpose` enum to `["compaction", "title"]`). Not model-visible: request building skips `usage` already; trajectory steps skip it like compaction; run totals and `usage.report` include it. Failure leaves the title null; the next completed run calls `maybeEnqueueTitle` again.
- Change frame: `ConversationBusMessage` gains `{ kind: "changed"; what: "title" | "queue" | "selection" | "files" }`, sent as SSE `event: changed` with `data: {"what": …}`. Publishers: rename, title job, queue (Task 9), selection (Task 8), `artifact_created` (Task 10).

- [ ] **Step 1: Failing tests.** HTTP: create with `message` → 201, one `user_message`, a run is queued; same `clientMessageId` again → 200 with the same ids and still one event; create with `message` for an agent the caller cannot use → 404 `agent.not_found` and nothing written; PATCH title → `titleSource: "manual"`; PATCH by another member → 404; title of 121 chars → 400. `titles.test.ts` (fake model): after the first completed run the title is generated and a `usage` event with `purpose: "title"` exists; the model failing 3 times leaves `title: null` and stops; a rename between enqueue and model reply keeps the manual title; unmapped purpose uses the conversation's model; the SSE stream emits `event: changed` with `what: "title"`. `titles.dual.test.ts`: two replicas finishing the job concurrently write one title and one usage event. Run → FAIL.
- [ ] **Step 2: Implement** (queue wiring like `cap-kernel-usage-report`), migration, error codes. Run → PASS; zero-drift groups → PASS; `pnpm check:migrations`.
- [ ] **Step 3: Docs.** `replay-evals` skill: title usage events (not model-visible, no DriftReason, skipped by step consumers, counted in totals). `writing-kernel-api` needs nothing.
- [ ] **Step 4: Commit** `feat(kernel): create conversations on first send, rename, and model-generated titles`.

### Task 8: Model and effort switching

Spec §5.2 (decided), §5.9 "Mid-conversation model and effort switches".

**Files:**
- Modify: `packages/kernel/src/conversations/{events,conversations.service,conversations.controller}.ts`, `packages/kernel/src/runtime/{run-worker,model-call}.ts`, `packages/kernel/src/evals/{reconstruct,step-replay,run-replay}.ts`
- Create: migration `NNNN_conversation_selection.sql` (`conversations.selection jsonb`)
- Test: `packages/kernel/test/runtime/model-switch.test.ts`, `packages/kernel/test/evals/reconstruct.test.ts` (new cases), `packages/kernel/test/evals/step-replay.test.ts`, `packages/kernel/test/evals/run-replay.test.ts`

**Interfaces:**
- Event `model_switched` (not model-visible itself; its effect is recorded per request in `model_call.provider/model/request.params`):

```ts
ev("model_switched", z.object({
  model: ModelRef.nullable(),           // null = back to the agent's model
  effort: z.enum(EFFORT_VALUES).nullable(), // null = the model's / agent's default
  byAccountId: z.string().nullable(),   // null = the kernel (fallback)
  reason: z.enum(["user", "unavailable"]),
}))
```
- `POST …/messages` and `POST /conversations` `message` gain `model?: ModelRef`, `effort?: string`. When they differ from the current selection, the kernel validates (model resolvable through the registry → else 400 `agent.model_unavailable`; effort in the model's declared `effort` enum → else 400 `validation_failed`) and appends `model_switched` **before** the `user_message` in the same transaction, updating `conversations.selection = { model, effort }`. Effect starts with the next run that starts; a run already in progress keeps its model (an interjection absorbed by it is answered by the old model).
- `ConversationView.selection: { model: ModelRef | null; effort: string | null }`.
- Runtime (`run-worker.execute`): the effective definition = the agent version's definition with `model` replaced by the latest `model_switched.model` before the run's `trigger_seq` (when non-null), and `modelParams` = `{ ...(same model as agent ? agent.modelParams : {}), ...(effort ? { effort } : {}) }`. `fallback` / `fallbackParams` are untouched. `run_started.model` records the effective model. If the switched-to model no longer resolves, the worker appends `model_switched { model: null, effort: null, byAccountId: null, reason: "unavailable" }` (idem key `model_fallback:<runId>`) and runs on the agent's model.
- Replay: `export function selectionAt(events: ConversationEvent[], seq: number): { model: ModelRef | null; effort: string | null }` (shared, `conversations/selection.ts`). Baseline reconstruction is unchanged (it already uses `model_call`). Step replay: the base model and params for a candidate without a model override are the selection in effect at the step's run, not the definition's. Full-run replay: the replayed run uses `selectionAt(seeds, trigger_seq)` unless the candidate sets a model.
- `DriftReason` gains `"model_switched"` (in `DRIFT_ORDER` after `params_changed`): a non-baseline step reconstruction whose run used a person's switch and whose candidate replaces that model (decision 5).

- [ ] **Step 1: Failing tests.** `model-switch.test.ts` (fake providers): message with `model: B` → `model_switched` before the `user_message`, the next run's `model_call.model === B`; effort `high` on a model that declares it → `model_call.request.params.effort === "high"`; effort on a model without it → 400; switch while a run is active → the active run keeps A, the next run uses B; provider of B removed → `model_switched { reason: "unavailable" }` and the run uses A; selection survives a reload (`GET` returns it). `reconstruct.test.ts`: a conversation with two switches reconstructs every `model_call` with `drift: []`; the drift group gains a `model_switched` case. `step-replay.test.ts`: a candidate with only new instructions replays on B (the switched model). `run-replay.test.ts`: full-run replay of a switched run sends to B. Run → FAIL.
- [ ] **Step 2: Implement**, migration. Run → PASS; zero-drift groups → PASS.
- [ ] **Step 3: Docs.** `replay-evals` skill: the `model_switched` event, `selectionAt`, the new DriftReason in the list.
- [ ] **Step 4: Commit** `feat(kernel): switch model and effort mid-conversation through the event log`.

### Task 9: Queued messages

Spec §5.7 queue (decided + designer's calls), §5.9 queue row, §8 multi-replica.

**Files:**
- Create: `packages/kernel/src/conversations/queue.ts`; migration `NNNN_conversation_queue.sql`
- Modify: `packages/kernel/src/conversations/{conversations.controller,conversations.service}.ts` (shared message preparation), `packages/kernel/src/runtime/{run-queue,run-finish}.ts`, `packages/kernel/src/errors.ts`
- Test: `packages/kernel/test/conversations/queue.http.test.ts`, `packages/kernel/test/conversations/queue.dual.test.ts`

**Interfaces:**
- Migration: `capybara.conversation_queue (id text PRIMARY KEY, conversation_id text NOT NULL REFERENCES capybara.conversations(id) ON DELETE CASCADE, account_id text NOT NULL, position bigint NOT NULL, text text NOT NULL, content jsonb NOT NULL, files jsonb NOT NULL DEFAULT '[]', client_message_id text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE (conversation_id, client_message_id))`, index `(conversation_id, position)`; `conversations.queue_paused boolean NOT NULL DEFAULT false`.
- Limits: `QUEUE_MAX_ITEMS = 20` per conversation (`conversation.queue_full`, 409).
- HTTP (owner only, `agents.use`; 404 `conversation.not_found` otherwise):
  - `GET  /conversations/:id/queue` → `{ items: QueueItem[]; paused: boolean }`
  - `POST /conversations/:id/queue` `{ text, clientMessageId, attachments?, files? }` → 201 `{ item }` (same `clientMessageId` → the same item). `@` resources are read at enqueue time with the caller's credentials (the same path as `postUserMessage`) and stored as content blocks; `files` must be ready attachments.
  - `PATCH /conversations/:id/queue/:itemId` `{ text }` → `{ item }` (only the text block changes)
  - `DELETE /conversations/:id/queue/:itemId` → 204
  - `POST /conversations/:id/queue/:itemId/send` → 202 `{ event }`: removes the item and posts it as a user message now (an interjection when a run is active)
  - `POST /conversations/:id/queue/resume` → 202: clears `queue_paused` and calls `ensureRun`
  - `type QueueItem = { id; text; files: { attachmentId; name; mediaType }[]; attachments: { connectorId; name; uri }[]; createdAt; position }`
- Dispatch (`RunQueue.ensureRun`, inside its transaction holding the conversation row lock): when there is no unconsumed `user_message`, no active run, `queue_paused = false`, and the queue is non-empty → delete the head item and append it as a `user_message` (`authorAccountId` = the item's author, `clientMessageId` = the item's), then continue to create the run as for any message. One item per run (spec: one at a time). `finishRunIn` with status `failed` or `aborted` sets `queue_paused = true` when the conversation has queued items. Waiting runs (approval / question) are active, so nothing dispatches until the run ends.
- Every change publishes `{ kind: "changed", what: "queue" }`.
- Queued items are not events (spec: not in the log until sent).

- [ ] **Step 1: Failing tests.** HTTP: enqueue while a run is active → no `user_message` yet; on `run_finished` the head becomes a `user_message` and a run starts, the second item waits for that run; a run ending `failed` → `paused: true`, nothing dispatched until `resume`; `send` on the second item during a run → it becomes an interjection and the first item stays first; edit and delete; 21st item → 409 `conversation.queue_full`; another user → 404; enqueue retry with the same `clientMessageId` → one item. `queue.dual.test.ts`: two replicas finish / ensureRun concurrently → each item dispatched exactly once and in order; `send` racing the dispatcher → the item is posted once. Run → FAIL.
- [ ] **Step 2: Implement**, migration, error codes. Run → PASS; `pnpm exec vitest run packages/kernel/test/runtime packages/kernel/test/conversations` → PASS.
- [ ] **Step 3: Commit** `feat(kernel): queued messages sent one at a time after each turn`.

### Task 10: File outputs API

Spec §5.8, §5.9 "file-outputs list API".

**Files:**
- Create: `packages/kernel/src/conversations/files.ts`
- Modify: `packages/kernel/src/conversations/{conversations.controller,artifacts}.ts`, `packages/kernel/src/tools/builtins/sandbox/deliver.ts` (publish `changed: files`), `packages/kernel/src/errors.ts`
- Test: `packages/kernel/test/conversations/files.http.test.ts`

**Interfaces:**
- `GET /conversations/:id/files?after=<fileId>&limit=50` (visibility as the events API) → `{ files: FileOutput[]; next: string | null }`, newest first:

```ts
interface FileOutput {
  id: string;                 // artifactId of the latest version
  name: string; contentType: string; size: number;
  sourcePath: string;
  version: number;            // 1-based count of deliveries with the same sourcePath, in log order
  versions: { id: string; size: number; createdAt: string }[]; // newest first, ≤ 20
  callId: string; createdAt: string;
  status: "available" | "removed";  // object-store head() on this page's latest versions
  previewable: "image" | "text" | null; // existing isInlineArtifactType / isTextArtifactType
}
```
- `GET /conversations/:id/files/:fileId/content?limit=<bytes>` for text types only: streams at most `min(limit, 1 MiB)` bytes with the stored content type and `X-Content-Truncated: true` when cut; non-text → 415 `conversation.artifact_not_previewable`; missing object → 410 `conversation.artifact_removed`. The existing `…/artifacts/:artifactId/{download,preview}` stay (the web keeps using download).
- Removed status reason: `removed` covers deleted objects; the UI says "No longer available" (decision 8).

- [ ] **Step 1: Failing tests:** two deliveries of `/workspace/out/report.md` → one entry with `version: 2` and two `versions`; a deleted object → `status: "removed"` and content 410; text content truncated at `limit`; an image to `content` → 415; another user's conversation → 404; delivering publishes `changed: files`. Run → FAIL.
- [ ] **Step 2: Implement.** Run → PASS.
- [ ] **Step 3: Commit** `feat(kernel): list a conversation's file outputs with versions`.

### Task 11: `file-preview@1`

Spec §5.8 "File preview is an extension point".

**Files:**
- Create: `packages/plugin-sdk/src/file-preview.ts` (export from `index.ts`); `packages/kernel/src/files/{previewers.ts,previewers.controller.ts}`; migration `NNNN_file_previewers.sql`
- Modify: `packages/plugin-sdk/src/{extension-point,ui,permissions}.ts` (point registered; place `"file-preview"` for embed previewers; bridge message `file`), `packages/kernel/src/http/api.module.ts`, `apps/web/src/lib/embed-bridge.ts` (send the file message), `apps/web/src/app/[locale]/(app)/settings/…` (previewer order section on the org extensions settings page)
- Create: a test-only fake previewer extension `packages/kernel/test/fixtures/extensions/preview-fake/` (no official plugin provides a previewer in B)
- Test: `packages/plugin-sdk/test/file-preview.test.ts`, `packages/kernel/test/files/previewers.http.test.ts`, `apps/web/test/previewers.test.tsx`

**Interfaces:**

```ts
export const FILE_PREVIEW_EXTENSION_POINT = "file-preview@1";
export const FILE_PREVIEW_MAX_BYTES = 20 * 1024 * 1024;
export interface FilePreviewer {
  id: string;                                  // unique within the extension, [a-z0-9-]{1,40}
  title: { zh: string; en: string };
  accepts: { mimeTypes?: string[]; extensions?: string[] }; // at least one entry; "image/*" allowed
  maxBytes: number;                            // ≤ FILE_PREVIEW_MAX_BYTES
  /** Exactly one of render / embed. */
  render?(args: FilePreviewArgs): Promise<UiView>;
  embed?: string;                              // id of a ui contribution { kind: "embed", place: "file-preview" }
}
export interface FilePreviewProvider { previewers: FilePreviewer[] }
export interface FilePreviewArgs {
  orgId: string; accountId: string; conversationId: string; locale: Locale; signal: AbortSignal;
  file: { id: string; name: string; contentType: string; size: number };
  /** The read grant: the file's bytes, valid only during this call; rejects over maxBytes. */
  read(): Promise<Uint8Array>;
}
export function validateFilePreviewProvider(p: unknown): string[];
export function previewerAccepts(p: Pick<FilePreviewer, "accepts" | "maxBytes">, file: { name: string; contentType: string; size: number }): boolean;
```
- `EXTENSION_POINTS["file-preview"] = info("multi", false, true)` (org scoped). `UiPlace` gains `"file-preview"` (embed only). `EmbedParentMessage` gains `{ protocol; type: "file"; name; contentType; size; data: ArrayBuffer }`, sent by the host after `init` to a `file-preview` embed; the embed never gets a URL.
- Kernel: `PreviewerRegistry.forFile(orgId, file): { plugin; id; title; kind: "view" | "embed" }[]` in org order (the org's `file_previewers` rows, then provider order; disabled ones dropped). Migration: `capybara.file_previewers (org_id text, plugin text, previewer_id text, position int NOT NULL, disabled boolean NOT NULL DEFAULT false, PRIMARY KEY (org_id, plugin, previewer_id))`.
- HTTP:
  - `GET /conversations/:id/files/:fileId/previewers` → `{ previewers: … }` (viewer can read the conversation)
  - `GET /conversations/:id/files/:fileId/previews/:plugin/:previewerId` → `{ view: UiView }` (render tier; 10 s timeout → 504 `ui.timeout`; an invalid view → 502 `ui.invalid_view`; extension error → 502 `ui.render_failed`; reuse the D13 codes)
  - Embed tier: the existing embed-token route with `contribution = <embed id>` and a `fileId` claim; the token is valid for that one file and conversation
  - `GET/PUT /orgs/:orgId/file-previewers` (`org.extensions.manage`): `{ items: { plugin; id; title; accepts; position; disabled }[] }`
- Built-in previewers stay in the web (Task 16); they come before extension previewers only when no extension previewer accepts the file (decision 7).

- [ ] **Step 1: Failing tests.** SDK: a provider with both `render` and `embed` → issue; `maxBytes` over the cap → issue; `previewerAccepts` matches `image/*`, extension `.docx` case-insensitively, and rejects over `maxBytes`. Kernel (fake extension providing a `.docx` previewer): `previewers` lists it for `a.docx` and not for `a.pdf`; render receives bytes via `read()` and the view is returned; `read()` of a 30 MB file → error, response 502; disabled in org order → not listed; the extension not enabled in the org → not listed; a render that hangs → 504 `ui.timeout`; another user → 404. Web `previewers.test.tsx`: the bridge sends one `file` message after `init`, only to `file-preview` embeds. Run → FAIL.
- [ ] **Step 2: Implement**, migration, admin section (FormSection list with up / down and a switch, in the org extensions settings page). Run → PASS.
- [ ] **Step 3: SDK API** regenerate, changeset line.
- [ ] **Step 4: Commit** `feat(kernel): file-preview@1 extension point with per-file read grants`.

### Task 12: `ctx.ui` places, open targets, tool-result cards; todo and example-board

Spec §5.3 (decided + designer's calls), §5.4.

**Files:**
- Modify: `packages/plugin-sdk/src/{ui,permissions,tool}.ts`; `packages/kernel/src/ui/{registry,views,views.controller}.ts`; `packages/kernel/src/conversations/events.ts` (`tool_result.card`); `packages/kernel/src/tools/pipeline.ts`; `tools/checks/src/extension-permissions.ts` (perm-ui accepts the new places)
- Modify: `plugins/todo/src/index.ts`, `plugins/todo/.capybara-plugin/plugin.json` if it lists ui; `plugins/example-board/src/*` (icon only)
- Test: `packages/plugin-sdk/test/ui.test.ts`, `packages/kernel/test/ui/views.http.test.ts`, `plugins/todo/test/todo.test.ts`, `tools/checks/test/extension-permissions.test.ts`

**Interfaces:**
- `export type UiPlace = "conversation" | "panel" | "section" | "inline" | "page" | "file-preview";` `conversation` is kept and means `panel` (the registry normalizes it; `UiContribution.place` in API output is the normalized value plus `legacyPlace: "conversation"` where it applied).
- `UiContribution` gains `icon?: UiIcon` where `export const UI_ICONS = ["list-checks","layout-grid","file","chart","calendar","users","bot","book","message-square","puzzle"] as const` (design `IconName`s; default `puzzle` → design `extension`).
- Open targets: `export type UiOpen = { contribution: string; item?: string }` (contribution is a `panel` of the same extension). `UiView` gains `open?: UiOpen` (the ⤢ in an inline card's title row and the section header). `checklist` items, `table` rows (`_open?: UiOpen` key is not allowed; use a parallel `open?: (UiOpen | null)[]` on the table block), and `keyValue` items gain `open?: UiOpen` and `id?: string`. `UiRenderArgs` gains `item?: string` (the panel scrolls to the block or item whose `id` matches) and `card?: { callId: string; key?: string }`.
- Inline cards hang off tool results: `ToolResult` gains `card?: { view: string; key?: string }` (an `inline` view of the same extension; display only). The pipeline validates the view id against the manifest and records `tool_result.card: { plugin, view, key? }`. Extensions cannot append card events themselves.
- Kernel views route accepts `?callId=&key=&item=` and passes them as `card` / `item`; `place: "section"` and `"inline"` views follow the `conversation` access rule (anyone who can read the conversation).
- todo: views `tasks-panel` (`place: "panel"`, icon `list-checks`), `tasks-section` (`place: "section"`, badge `done / total`, items with `open: { contribution: "tasks-panel", item: <index> }`), `tasks-card` (`place: "inline"`, the checklist with `open` on the view); `write` returns `card: { view: "tasks-card" }`. The old `tasks` (`conversation`) id is kept as an alias of `tasks-panel` for one release so open web pages do not break (decision 10).
- example-board: `icon: "layout-grid"`; nothing else.

- [ ] **Step 1: Failing tests.** SDK: `validateUiView` accepts `open` on checklist items and rejects an `open` with an empty contribution; `normalizePlace("conversation") === "panel"`. Kernel: contributions list returns todo's three places with icons; a `section` view renders for a guest who can read the conversation; `?callId=` reaches `args.card`; a tool result with `card` naming an unknown view → the card is dropped and logged, the result still succeeds. Checks: a fixture extension declaring `place: "inline"` without `permissions.ui.views` → `perm-ui` finding; with it → none. todo: `write` result has `card`; the section badge is `1/3` for one completed of three. Run → FAIL.
- [ ] **Step 2: Implement.** Run → PASS. `pnpm check:extension-permissions` → passed. Re-pack check: `pnpm check:plugin-pack` and `pnpm check:bootstrap` → passed (todo is not a bootstrap plugin; run anyway).
- [ ] **Step 3: SDK API** regenerate; changesets for SDK, kernel, `@capybara-hq/plugin-todo` (minor: "Tasks as an inline card, a properties section and a right panel").
- [ ] **Step 4: Commit** `feat(plugin-sdk): inline cards, properties sections and right panels for extension UI`.

### Task 13: Prose, Markdown, thinking, user bubble, run dividers

**Files:**
- Create: `packages/design/src/display/markdown.tsx`, `packages/design/src/conversation/{prose,thinking,bubble,divider,index}.tsx`, `packages/design/src/styles/conversation.css`
- Modify: `packages/design/package.json` (exact versions of `mdast-util-from-markdown`, `mdast-util-gfm`, `micromark-extension-gfm`), `packages/design/src/index.ts`, `packages/design/src/i18n.ts`, `apps/web/src/dev/catalog/reference-blocks.tsx` (+ new `conversation-blocks.tsx`)
- Test: `packages/design/test/markdown.test.tsx`, `packages/design/test/conversation-prose.test.tsx`

**Interfaces:**

```ts
export function Markdown(p: {
  text: string;
  /** Inline code spans equal to one of these paths render as FileChip and call onOpenPath. */
  paths?: ReadonlySet<string>;
  onOpenPath?(path: string): void;
}): JSX.Element;
// mdast → React elements: headings (h3–h5 only, mono), paragraphs, lists, blockquote, code (CodeBlock),
// inline code, emphasis, strong, links (http(s) only, target=_blank rel=noopener noreferrer; others as
// text), GFM tables (≤ 200 rows, then "N more rows"), thematic break. `html` nodes render as text.
// Images are not loaded (alt text as a link when http(s)). No dangerouslySetInnerHTML anywhere.
export function Prose(p: { markdown: string; streaming?: boolean; paths?: ReadonlySet<string>; onOpenPath?(p: string): void }): JSX.Element;
// prose font 15/26, cursor (data-part="cursor") when streaming
export function ThinkingRow(p: { seconds: number | null; text: string; live?: boolean }): JSX.Element; // replaces display/chat.tsx's
export function UserBubble(p: { text: string; attachments?: ReactNode; queued?: boolean }): JSX.Element;
export type DividerKind = "stopped" | "failed" | "compacted" | "fallback" | "hook-denied";
export function RunDivider(p: { kind: DividerKind; text: string; action?: { label: string; onClick(): void }; children?: ReactNode }): JSX.Element;
```
- [ ] **Step 1: Failing tests.** `markdown.test.tsx`: `<script>alert(1)</script>` renders as text (no script element); `[x](javascript:alert(1))` renders no anchor; `[x](https://a.test)` renders an anchor with `rel="noopener noreferrer"`; a 300-row table renders 200 rows and "100 more rows"; `` `reports/a.xlsx` `` with `paths` containing it renders a button named `reports/a.xlsx` that calls `onOpenPath`, without it an inline `code`; `# Title` renders an `h3`. `conversation-prose.test.tsx`: streaming shows `data-part="cursor"`; ThinkingRow toggles `aria-expanded`; RunDivider `failed` renders the action button. Run → FAIL.
- [ ] **Step 2: Implement** with tokens only and `data-part`s from the Task 3 size tables. Run → PASS.
- [ ] **Step 3: Blocks** for `prose`, `thinking-row`, `user-bubble`, `run-divider` in `/dev/ui/reference/<component>` from the fixtures.
- [ ] **Step 4: Acceptance** (A's procedure: the implementer runs `COMPARE=prose,thinking-row,user-bubble,run-divider pnpm --filter @capybara-hq/web compare` and hands `apps/web/compare-out/` to the controller, who dispatches the blind image-reviewing subagent; severe / moderate block; then append to `ACCEPTED` and remove from `PENDING_B`; `pnpm --filter @capybara-hq/web visual fidelity` → PASS).
- [ ] **Step 5: Commit** `feat(design): conversation prose with safe Markdown, thinking rows and dividers`.

### Task 14: Tool group, tool row, diff block

Spec §5.5.

**Files:**
- Create: `packages/design/src/conversation/{tool-group,tool-row,diff-block}.tsx`
- Modify: `packages/design/src/display/chat.tsx` (delete ToolCallRow, IoBlock, Timeline, TimelineItem once Task 19 stops using them; in this task mark them `@deprecated`), `packages/design/src/i18n.ts`
- Test: `packages/design/test/tool-group.test.tsx`; `apps/web/visual/conversation.interaction.spec.ts` (expand motion)

**Interfaces:**

```ts
export type ToolKind = "command" | "read" | "edit" | "search" | "connector" | "meta" | "tool";
export type ToolRowData = {
  id: string; kind: ToolKind;
  source?: string;            // connector or extension name ("Slack")
  title: string;              // declared title, else the key
  keyArg?: string;            // body color
  extra?: string;             // "42 results", "lines 1–120"
  description?: string;       // shell rows: shown instead of the command
  status: "pending" | "running" | "done" | "failed" | "cancelled";
  startedAt?: number; durationMs?: number;
  error?: string;             // first line shown on the row after "Failed"
  blockedBy?: string;         // extension name for hook denials
  detail?: {
    input?: [string, string][]; command?: string;
    output?: string; outputBytes?: number;  // shows "Output 82 KB, showing first 4 KB · View all" when output is a prefix
    errorText?: string; diff?: DiffData;
  };
};
export type DiffData = { hunks: { oldStart: number; newStart: number; lines: { kind: "ctx" | "add" | "del"; text: string }[] }[]; truncated: boolean };
export function ToolRow(p: { row: ToolRowData; open?: boolean; onToggle?(): void; onViewAll?(): void; onCopy?(): void; now?: number }): JSX.Element;
export function ToolGroup(p: { rows: ToolRowData[]; summary: ToolGroupSummary; open?: boolean; onToggle?(): void; children?: ReactNode }): JSX.Element;
export type ToolGroupSummary = { running?: { verb: string; done: number }; counts: { kind: ToolKind; n: number }[]; failed: number; added?: number; removed?: number; object?: string };
export function summarizeTools(rows: ToolRowData[], locale: "zh" | "en"): string;
export function DiffBlock(p: { diff: DiffData }): JSX.Element;
```
- Verb table (design i18n; counts in Arabic numerals; failures append `（N 个失败）` / ` (N failed)` in `fail`):

| Kind | zh single / group | en single / group | Running header |
|---|---|---|---|
| command | 已运行 / 已运行 N 个命令 | Ran / Ran N commands | 正在运行命令 / Running command |
| read | 已读取 / 已读取 N 个文件 | Read / Read N files | 正在读取 / Reading |
| edit | 已编辑 / 已编辑 N 个文件 · +a −b | Edited / Edited N files · +a −b | 正在编辑 / Editing |
| search | 已搜索 / 已搜索 N 次 | Searched / Searched N times | 正在搜索 / Searching |
| connector, tool | 已使用 / 已使用 N 个工具 | Used / Used N tools | 正在使用工具 / Using tool |
| meta | 已加载工具 | Loaded tools | 正在加载工具 / Loading tools |

  Mixed kinds join with "，" / ", " in first-appearance order ("已运行 1 个命令，已使用 19 个工具"). A group touching one object (all rows share `keyArg` and kind read / edit) names it ("已读取 示例表.xlsx"). The running row shows a spinner and elapsed `m:ss` from `startedAt` (the caller re-renders each second; reduced motion: static icon).
- [ ] **Step 1: Failing tests:** `summarizeTools` for `[command×1, connector×19]` → "已运行 1 个命令，已使用 19 个工具"; with 2 failed → contains "（2 个失败）"; two reads of one path → "已读取 <path>"; edit counts "+12 −3". ToolRow: done row has no status mark; failed shows "失败" + error first line; expanded command shows `$ <command>`, output in `data-part="output"`, "复制输出" and duration; a 4 KB prefix of an 82 KB output shows "输出 82 KB，已显示前 4 KB" and "查看全部" calls `onViewAll`; `blockedBy: "policy-x"` shows "被 policy-x 拦截"; a single-row group renders one line with no box. DiffBlock: line numbers, `data-kind="add"` rows, "差异已截断" when truncated. Run → FAIL.
- [ ] **Step 2: Implement.** Run → PASS.
- [ ] **Step 3: Blocks** for `tool-group`, `tool-row`, `diff-block`; interaction spec: expanding a row animates height over `motion.expand` and is instant under reduced motion.
- [ ] **Step 4: Acceptance** for `tool-group,tool-row,diff-block`.
- [ ] **Step 5: Commit** `feat(design): tool groups and rows after Claude Code, with diffs`.

### Task 15: Human-in-the-loop blocks and the queued message

Spec §5.7.

**Files:**
- Create: `packages/design/src/conversation/{hitl,queued}.tsx`
- Test: `packages/design/test/hitl.test.tsx`

**Interfaces:**

```ts
export function ApprovalBlock(p: {
  title: string; tool: string; args: [string, string][]; policy?: string;
  scopes: ("once" | "session" | "always")[];
  state: { kind: "pending"; busy?: boolean } | { kind: "decided"; who: string; when: string; decision: "approved" | "denied" | "expired" | "cancelled"; scope?: string; reason?: string };
  onApprove?(scope: "once" | "session" | "always"): void; onDeny?(reason?: string): void;
}): JSX.Element; // pending: accent border, the only one; "Deny…" opens an inline reason Textarea + confirm
export function QuestionBlock(p: {
  title: string; url?: string; fields: QuestionField[];
  state: { kind: "pending"; busy?: boolean } | { kind: "answered"; pairs: [string, string][] } | { kind: "skipped" | "expired" };
  onAnswer?(answer: Record<string, unknown>): void; onSkip?(): void;
}): JSX.Element; // url: link with the full address (not truncated), opens in a new tab
export function ConnectBlock(p: { service: string; reason: string; closed: boolean; onConnect?(): void }): JSX.Element; // "Only affects you"
export function QueuedMessage(p: { text: string; editing?: boolean; onCopy(): void; onEdit(): void; onSave?(text: string): void; onCancelEdit?(): void; onDelete(): void; onSendNow(): void }): JSX.Element;
export function QueuePaused(p: { onContinue(): void }): JSX.Element; // "Continue sending"
```
  `QuestionField` mirrors the web's `InputForm` field shape (key, label, description, options from the schema enum, `multiSelect`, `allowOther`, `required`), already rendered by today's QuestionCard; move its form layout into design.
- [ ] **Step 1: Failing tests:** pending ApprovalBlock with scopes `["once"]` renders only "批准" and "拒绝…"; with all three renders three approve buttons; "拒绝…" reveals a reason field and `onDeny("太危险")`; decided collapses to one line with who, when, reason; QuestionBlock with `url` renders an anchor whose text is the full URL; answered renders the pairs; "其他" free text appears when `allowOther`; QueuedMessage buttons have accessible names (复制 / 编辑 / 删除 / 立即发送) and the bubble has `data-queued="true"`. Run → FAIL.
- [ ] **Step 2: Implement.** Run → PASS.
- [ ] **Step 3: Blocks** for `approval-block`, `question-block`, `connect-block`, `queued-message`.
- [ ] **Step 4: Acceptance** for those four.
- [ ] **Step 5: Commit** `feat(design): approval, question and connect blocks, queued messages`.

### Task 16: Files: cards, outputs, chips, attachment strip, preview frame, built-in previewers

Spec §5.8.

**Files:**
- Create: `packages/design/src/conversation/{files,file-preview}.tsx`
- Modify: `packages/design/src/display/attachments.tsx` (AttachmentChip → strip styles; keep FileDrop / FileButton)
- Test: `packages/design/test/files.test.tsx`

**Interfaces:**

```ts
export function middleTruncate(name: string, max: number): string; // keeps the extension: "很长的名字…末尾.xlsx"
export function typeBadge(name: string, contentType: string): string; // "XLSX", "PDF", "MD", "PNG", …, else "FILE"
export function FileCard(p: { name: string; contentType: string; size: number; removed?: { reason: string }; selected?: boolean; onOpen?(): void }): JSX.Element;
export function FileOutputs(p: { files: FileCardProps[]; max?: number /* 4 */; onMore?(): void }): JSX.Element; // two columns, "N more files ›"
export function ImageOutput(p: { src: string; name: string; size: number; onOpen(): void; onDownload(): void }): JSX.Element; // shows natural dimensions once loaded
export function TextOutput(p: { name: string; head: string; onOpen(): void }): JSX.Element; // plain text, fade-out, "Open"
export function FileChip(p: { path: string; onOpen(): void }): JSX.Element;
export function AttachmentStrip(p: { items: AttachmentStripItem[] }): JSX.Element; // thumbnails + file strips, progress, rejected
export function FilePreviewFrame(p: { header: { badge: string; name: string; version?: string; files?: { id: string; name: string }[]; onSwitch?(id: string): void; previewers?: { id: string; title: string }[]; previewer?: string; onPreviewer?(id: string): void; onDownload(): void; onFullscreen(): void; onClose(): void }; state: "loading" | "ready" | "failed"; onRetry?(): void; children?: ReactNode }): JSX.Element;
export function TextPreview(p: { text: string; truncated: boolean }): JSX.Element;
export function CsvPreview(p: { text: string; delimiter: "," | "\t"; maxRows?: number /* 500 */ }): JSX.Element; // RFC 4180 parse
export function ImagePreview(p: { src: string; name: string }): JSX.Element;
export function NoPreview(p: { name: string; contentType: string; size: number; onDownload(): void }): JSX.Element;
```
  Markdown preview uses `Markdown` from Task 13. SVG never renders inline (it is not in the inline types).
- [ ] **Step 1: Failing tests:** `middleTruncate("一个非常长的……示例表.xlsx", 24)` ends with `.xlsx` and has length 24; `typeBadge("a.tar.gz", "application/gzip") === "GZ"`; FileOutputs with 6 files shows 4 and "还有 2 个文件"; removed card has `data-removed="true"`, strikethrough name and the reason; CsvPreview parses quoted commas and newlines, caps at 500 rows with a count line; a header without `files` hides the switcher; no "分享" / "Share" button exists anywhere in the frame. Run → FAIL.
- [ ] **Step 2: Implement.** Run → PASS.
- [ ] **Step 3: Blocks** for `file-card`, `file-outputs`, `attachment-strip`, `file-preview`.
- [ ] **Step 4: Acceptance** for those four.
- [ ] **Step 5: Commit** `feat(design): file outputs, attachment strip and the file preview frame`.

### Task 17: Sub-agent group, row and task block

Spec §5.6; shapes from phase C §14.1. Built with fixtures; wiring is Task 21.

**Files:**
- Create: `packages/design/src/conversation/subagents.tsx`
- Test: `packages/design/test/subagents.test.tsx`

**Interfaces:**

```ts
export type SubagentRowData = {
  id: string; agentType: string; description: string;
  status: "running" | "done" | "failed" | "stopped";
  toolCalls: number; startedAt?: number; durationMs?: number;
  summary?: { steps: string[]; result: string };   // in-place expansion
};
export function SubagentRow(p: { row: SubagentRowData; open?: boolean /* in the right panel */; expanded?: boolean; onOpen(): void; onToggle?(): void; now?: number }): JSX.Element;
export function SubagentGroup(p: { rows: SubagentRowData[]; openId?: string; onOpen(id: string): void; now?: number }): JSX.Element;
// running: "N 个子 agent 运行中" / "N subagents running"; done: "N 个子 agent 已完成（M 个失败）· X 次调用 · 2分28秒"
export function SubagentTask(p: { text: string; agent: string; model: string; tools: string }): JSX.Element; // gray task block + "agent · model · tools" line
export function BackgroundTasks(p: { running: { id: string; name: string; elapsed: string }[]; completed: number; onStop(id: string): void; onOpen(id: string): void; onCompleted(): void }): JSX.Element; // property-section content
```
- [ ] **Step 1: Failing tests:** two running rows → header "2 个子 agent 运行中" and spinners; done group with one failed → "（1 个失败）" in `fail` and the row says "失败"; the open row has `aria-current="true"` and `data-open="true"`; the row's `›` button is named "在右侧打开 <description>"; BackgroundTasks stop buttons are named "停止 <name>". Run → FAIL.
- [ ] **Step 2: Implement.** Run → PASS.
- [ ] **Step 3: Blocks** for `subagent-group`.
- [ ] **Step 4: Acceptance** for `subagent-group`.
- [ ] **Step 5: Commit** `feat(design): sub-agent groups and rows`.

### Task 18: Conversation template, title bar, properties panel, right panel, inline cards, composer

Spec §5.1–§5.3.

**Files:**
- Create: `packages/design/src/templates/conversation-page.tsx`, `packages/design/src/conversation/{title-bar,properties,right-panel,inline-card,composer,picker}.tsx`
- Modify: `packages/design/src/templates/{index,names}.ts` (`ConversationPage` replaces `PlaygroundPage`), `tools/checks/src/web-ui.ts` (template list comes from `names.ts`; check its test), `apps/web/src/dev/catalog/templates/*` (conversation template block), delete `templates/playground-page.tsx` once Task 19 lands (in this task keep it, marked deprecated)
- Test: `packages/design/test/conversation-shell.test.tsx`, `apps/web/visual/conversation.interaction.spec.ts`

**Interfaces:**

```ts
export function ConversationPage(p: {
  titleBar: TitleBarProps;
  thread: ReactNode;                 // follows the bottom like PlaygroundPage today (useFollowBottom moves here)
  composer: ReactNode;
  status: { left: string; right: string[] };   // read-only status bar of the middle column
  properties?: ReactNode;            // shown when right === "properties"
  panel?: ReactNode;                 // shown when right === "panel"
  right: "none" | "properties" | "panel";
  onCloseRight(): void;
}): JSX.Element;
// Panel width: localStorage "cap.chat.panelWidth" (try/catch), clamped to [layout.panel-min, content - layout.chat-min];
// below layout.chat-min + layout.panel-min of content width the right area renders as a Sheet.
export type TitleBarProps = {
  title: string | null; untitled: string;           // placeholder "未命名会话 · 10-26 14:02"
  menu: MenuItem[];                                   // rename, …
  properties: { pressed: boolean; onToggle(): void };
  panels: { id: string; label: string; icon: IconName; pressed: boolean; onOpen(): void }[]; // overflow into "More"
};
export function TitleBar(p: TitleBarProps): JSX.Element;
export function RenameDialog(p: { value: string; onSave(v: string): void; onCancel(): void }): JSX.Element;
export function PropertiesPanel(p: { children: ReactNode }): JSX.Element;
export function PropertySection(p: { title: string; badge?: string; open?: { label: string; onOpen(): void }; state?: "ready" | "loading" | "failed"; onRetry?(): void; children?: ReactNode }): JSX.Element;
export function RightPanel(p: { title: string; switcher?: { items: { id: string; label: string }[]; current: string; onSwitch(id: string): void }; onBack?(): void; actions?: HeaderAction[]; onFullscreen(): void; onClose(): void; state?: "ready" | "loading" | "failed"; onRetry?(): void; footer?: ReactNode; children?: ReactNode }): JSX.Element;
export function InlineCard(p: { title: string; source: string; onExpand?(): void; state: "loading" | "ready" | "failed"; onRetry?(): void; children?: ReactNode }): JSX.Element;
export function ComposerBox(p: {
  value: string; onChange(v: string): void; onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>): void;
  placeholder: string; hint?: string;                // "↵ 立即发送，⌘↵ 加入队列" while running
  attachments?: ReactNode; onAttach(): void;
  pickers: { agent: PickerProps; model: PickerProps; effort?: PickerProps };
  send: { mode: "send" | "stop"; disabled?: boolean; busy?: boolean; onClick(): void };
  textareaRef?: Ref<HTMLTextAreaElement>;
}): JSX.Element;
export type PickerProps = { label: string; value: string; disabled?: boolean; groups: { label?: string; items: { id: string; label: string; hint?: string; checked?: boolean }[] }[]; onPick(id: string): void };
export function Picker(p: PickerProps): JSX.Element;   // DropdownMenu with groups; agent locked = disabled with tooltip
```
- [ ] **Step 1: Failing tests** (`conversation-shell.test.tsx`): `right="properties"` renders the properties panel inside the middle column (sibling of the thread, under the title bar) and `right="panel"` renders the panel outside it, full height; never both; the pressed title-bar icon has `aria-pressed="true"`; with 6 panel icons and a narrow width (mock `ResizeObserver`) 3 move into "更多"; untitled title renders the placeholder; ComposerBox in `stop` mode renders a button named "停止"; a disabled agent picker has a tooltip "发送第一条消息后不能更换 agent"; a picker with `effort` undefined renders no effort control; PropertySection `failed` renders "加载失败 · 重试". Run → FAIL.
- [ ] **Step 2: Implement.** Run → PASS.
- [ ] **Step 3: Interaction spec** (`conversation.interaction.spec.ts` on the `/dev/ui` template block): opening a panel closes properties and vice versa; the resize handle moves by 16 px with ← / →, is clamped, and the width survives a reload; at a 1100 px viewport the panel is a sheet and Esc closes it with focus back on the title-bar icon; no horizontal page scroll at 1440 / 1279 / 959 / 640; reduced motion makes expand instant.
- [ ] **Step 4: Blocks** for `template-conversation`, `title-bar`, `composer`, `picker-menu`, `inline-card`, `property-section`, `right-panel`.
- [ ] **Step 5: Acceptance** for those seven.
- [ ] **Step 6: Commit** `feat(design): conversation template with title bar, properties panel, right panel and composer`.

### Task 19: The conversation page: composer, title, model switch, queue, timeline

**Files:**
- Create: `apps/web/src/lib/{timeline,tool-info,queue}.ts`; `apps/web/src/components/conversation/{ConversationView,Thread,ComposerBar,useConversation,useQueue,useSelection,TitleMenu}.tsx`; `apps/web/src/app/[locale]/(app)/chat/page.tsx` (new conversation, `?agent=`)
- Modify: `apps/web/src/app/[locale]/(app)/chat/[conversationId]/page.tsx`, `apps/web/src/components/{ChatView,Composer,ApprovalCard,QuestionCard,ConnectCard,use-draft-files}.tsx` (become containers over the design blocks), `apps/web/src/lib/{conversations,stream,approvals}.ts`, `apps/web/src/components/shell/{nav,conversations}.tsx` ("＋ New conversation" → `/chat`, group ＋ → `/chat?agent=<id>`, titles from `title`, refresh on `changed: title`), `apps/web/src/components/AgentList.tsx` (start → `/chat?agent=`), `apps/web/messages/{zh,en}.json`
- Delete: `apps/web/src/components/MessageList.tsx`, `ToolCallCard.tsx`, `chat-panel/RunTab.tsx` (after the timeline replaces them)
- Test: `apps/web/test/timeline.test.ts`, `apps/web/test/conversation-page.test.tsx`, `apps/web/test/queue.test.tsx`, `apps/web/test/stream.test.ts` (changed frames), update `apps/web/test/{chat,chat-files,tool-cards}.test.tsx`

**Interfaces:**
- `lib/timeline.ts` (pure, the only place that groups):

```ts
export type TimelineEntry =
  | { kind: "user"; key: string; text: string; files: MessageFile[]; attachments: MessageAttachment[]; retryOf?: number }
  | { kind: "prose"; key: string; text: string; streaming: boolean }
  | { kind: "thinking"; key: string; text: string; seconds: number | null; live: boolean }
  | { kind: "tools"; key: string; rows: ToolRowData[] }            // 1 row = single line
  | { kind: "subagents"; key: string; rows: SubagentRowData[] }
  | { kind: "approval" | "question" | "connect"; key: string; item: … }   // today's ChatItem payloads
  | { kind: "card"; key: string; plugin: string; view: string; callId: string; cardKey?: string }
  | { kind: "files"; key: string; files: FileRef[] }               // artifact_created after a tool group
  | { kind: "divider"; key: string; divider: "stopped" | "failed" | "compacted" | "fallback" | "hook-denied"; data: … };
export function buildTimeline(events: ConversationEvent[], drafts: Draft[], info: ReadonlyMap<string, ToolInfo>, locale: "zh" | "en"): TimelineEntry[];
```
  Rules: consecutive tool calls of one turn that are not separated by prose, a card or a human-in-the-loop item form one `tools` entry; prose is never collapsed; `agent` tool calls become `subagents` entries (Task 21; until then they are tool rows); a call's `tool_result.card` adds a `card` entry right after its group; `artifact_created` adds a `files` entry after the group of its `callId`; `hook_denied` with `callId` marks that row `blockedBy`; `run_aborted` / `run_failed` / `compaction_summary` (+ its `usage` purpose compaction for "saved N tokens") / `model_switched { reason: "unavailable" }` become dividers; a `user_message` with `retryOf` renders inside the failed divider as "已重试", not as a bubble. Row data: `title` from `ToolInfo.title ?? key`, `keyArg` from `ToolInfo.keyArgs[0]` (else the first string input), `description` from `view.description` (else the input's `description`), failure = `isError || view.timedOut || (view.exitCode ?? 0) !== 0`, duration = `tool_result.createdAt − tool_call_started.createdAt`, output = `tool_result.content`, `outputBytes` from the archive's `totalChars` when `outputId` is set (fetched lazily on expand).
- `lib/tool-info.ts`: `useToolInfo(orgId, conversationId, keys)`, batched `GET …/tools?keys=`, cached per conversation in memory (refetch on unknown keys only).
- `lib/queue.ts`: client for Task 9 routes; `useQueue` reloads on `changed: queue`.
- Composer keys: ↵ (no Shift, not composing) = send when idle / interject when running; ⌘↵ (macOS) or Ctrl+↵ = enqueue when running, send when idle; Shift+↵ newline. `/` prompts, `@` resources, file button / drop / paste, 5 attachments, `clientMessageId` dedupe carry over unchanged from `Composer.tsx` (move its logic into `ComposerBar`).
- New conversation (`/chat`): an empty thread with the agent picker enabled (default `?agent=` or the user's most recent agent from `listConversationGroups`, else the first usable agent); first send calls `POST /conversations` with `message` and then `router.replace("/chat/<id>")` keeping drafts; nothing is created before the first send. Uploads before the conversation exists go through the same attachments API (org-scoped).
- Selection: `useSelection` reads `conversation.selection`; picking a model / effort stores the choice locally and sends it with the next message (`model` / `effort` on `postMessage`), so the log records it at send time; the effort picker lists exactly the selected model's declared `effort` enum and hides when there is none; models grouped by provider with the agent's model first.
- Title: title-bar menu "重命名" opens `RenameDialog` → `PATCH`; the sidebar and title bar refresh on `changed: title`.
- Status bar: left `user@org:/chat/<short id>` · `第 N 轮 · 已用 m:ss` (turns = `run_started` count; elapsed of the current or last run); right: run status text (运行中 / 等待处理 / 空闲 / 已停止 / 失败), `上下文 N%`, version.
- Retry on the failed divider: `postMessage` with the last user message's text and files, `retryOf: <seq>` (Task 7's messages route accepts `retryOf?: number`, display only, written into the `user_message` payload; decision 6).

- [ ] **Step 1: Failing tests.** `timeline.test.ts` with fixture event logs: a pre-B log (bash without `description` / `view`) builds rows titled `sandbox_bash` with the command as key argument; `[bash, bash(exit 1), slack]` → one `tools` entry, `summarizeTools` → "已运行 2 个命令，已使用 1 个工具（1 个失败）"; prose between calls splits groups; an approval splits groups; `artifact_created` lands after its group; `hook_denied` with callId marks the row; `run_aborted` → `stopped` divider with `byAccountId`; compaction → divider with saved tokens; `retryOf` folds into the failed divider. `conversation-page.test.tsx` (mocked fetch + EventSource): ⌘↵ while running posts to `/queue`, ↵ posts to `/messages`; Enter during IME composition does nothing; switching model then sending sends `model` once; a model without effort hides the effort picker; `/chat?agent=a1` first send posts `POST /conversations` with `message` and replaces the URL; rename calls PATCH; navigating to another conversation clears the queue, panel and draft files of the previous one (never shows them under the new id). `queue.test.tsx`: paused queue shows "继续发送" and calls `/queue/resume`; "立即发送" calls `/send`. Run → FAIL.
- [ ] **Step 2: Implement.** Run → PASS. `pnpm typecheck && pnpm check:web-ui && pnpm lint` → pass.
- [ ] **Step 3: Commit** `feat(web): conversation page with composer pickers, queue, titles and tool groups`.

### Task 20: Right panel, properties sections, extension slots, files and previews on the page

**Files:**
- Create: `apps/web/src/components/conversation/{RightArea,PropertiesSections,ExtensionPanel,ExtensionSection,ExtensionCard,FilePanel,OutputPanel,ContextSection,FilesSection}.tsx`, `apps/web/src/lib/{files,previewers}.ts`
- Modify: `apps/web/src/lib/ui.ts` (places, open targets, `item` / `callId` params), `apps/web/src/components/chat-panel/{ExtensionViewTab,EmbedTab,ContextTab,ArtifactsTab}.tsx` (moved into the new components; then delete `chat-panel/`), `apps/web/src/components/ui-view/UiViewRenderer.tsx` (open targets, item ids, Markdown via design `Markdown`)
- Test: `apps/web/test/right-area.test.tsx`, `apps/web/test/extension-slots.test.tsx`, `apps/web/test/file-panel.test.tsx`; e2e `apps/web/e2e/{tasks-panel,embed-panel,files,sandbox-artifacts}.spec.ts` updated

**Interfaces:**
- Right-area state (per conversation, in the URL hash so a reload keeps it: `#panel=<plugin>/<contribution>[/<item>]`, `#file=<fileId>`, `#output=<callId>`, `#subagent=<id>`, `#properties`): `useRightArea(conversationId): { right; open(target); close() }`. Opening one closes the other (spec §5.1). Changing conversation resets it.
- Title-bar icons: enabled `panel` contributions (incl. `conversation`) in contribution order, then "More"; a disabled extension shows nothing (contributions API already filters by org enablement).
- Properties sections, in order: 上下文 (Context: usage ratio, model, sandbox status, connectors used; today's ContextTab data), 文件 (Files: `GET …/files`, open → file panel), 后台任务 (Background tasks: Task 21; hidden until there is a sub-agent), then extension `section`s in contribution order.
- Extension blocks (inline card, section, panel) each load through `GET …/ui/views/:plugin/:id` with their own 10 s timeout and abort on unmount; failure renders the frame's `failed` state with Retry; they never block the thread render (rendered after the thread items, in their own error boundary). Embeds keep `EmbedFrame` and the existing embed-token flow.
- Open targets: clicking an item with `open` opens `#panel=<plugin>/<contribution>/<item>`; the panel passes `item` to the view and scrolls to `[data-ui-item="<item>"]`.
- File panel: header switcher lists the conversation's files; previewer choice: extension previewers from `…/previewers` (Task 11) when any accepts the file, else built-in (image → `?inline=1` download URL; text / code / Markdown / CSV / TSV → `…/content?limit=1048576`); the user can switch previewer when more than one applies; a failing previewer shows Retry and a "Download" fallback; removed files show the removed card.
- Output panel (`#output=<callId>`): full archived output via `readToolOutput` in `TextPreview` (replaces RunTab's "View full output").
- [ ] **Step 1: Failing tests:** opening the todo panel from the title bar closes properties; clicking a todo section item opens the panel with `item`; a view that rejects after 10 s renders "加载失败 · 重试" in that section while a streaming assistant message keeps updating (fake timers); an extension removed from contributions (disabled) removes its icon, section and cards on the next contributions refresh; file panel with a `.docx` and one extension previewer renders it; with none renders NoPreview + Download; a `.csv` renders a table; `#file=<id>` survives a reload; switching conversation closes the panel. Run → FAIL.
- [ ] **Step 2: Implement**; delete `chat-panel/`. Run → PASS. Update the e2e specs listed above; run `pnpm --filter @capybara-hq/web e2e -- tasks-panel embed-panel files sandbox-artifacts` → PASS (Docker).
- [ ] **Step 3: Page acceptance:** screenshot `/chat/<fixture conversation>` in the e2e environment with properties open, a file panel and an extension panel (both themes), and run the same blind review against `template-conversation-{properties,file-panel}` (A's Task 11 Step 5 pattern).
- [ ] **Step 4: Commit** `feat(web): right panel, properties sections, extension slots and file previews`.

### Task 21: Sub-agent wiring (depends on phase C)

**Dependency:** phase C (`feat/ecosystem-phase-c`) adds `subagent_dispatched` / `subagent_waiting` / `subagent_finished`, the ephemeral `subagent_progress` bus message, `GET /conversations/:id/subagents`, child conversations (`kind = 'subagent'`, read-only, `conversation.read_only` on posts) and `POST /conversations/:childId/abort`. Check `git log origin/main --oneline -- packages/kernel/src/conversations/events.ts | grep -i subagent` (or the phase C PR state) when this task starts:
- **Phase C merged:** do Steps 1–4 against the real routes and events (rebase first; renumber B's migrations after C's `0053` if still unmerged on this branch).
- **Not merged:** do Steps 1–2 only, against the phase C §14.1 shapes copied into `apps/web/src/lib/conversations.ts` types (harmless: the kernel never sends them), and leave Steps 3–4 to phase C's own PR (its §17 says it wires B's components when B lands first). Record which path was taken in the task report.

**Files:**
- Create: `apps/web/src/lib/subagents.ts`, `apps/web/src/components/conversation/{SubagentPanel,BackgroundSection}.tsx`
- Modify: `apps/web/src/lib/{conversations,stream,timeline}.ts` (event types, `subagent_progress` frame), `apps/web/src/components/conversation/RightArea.tsx`
- Test: `apps/web/test/subagents.test.tsx`; e2e `apps/web/e2e/conversation-subagents.spec.ts` (merged path only)

**Interfaces:**
- `timeline.ts`: `agent` tool calls with `subagent_dispatched` become `subagents` rows (`status` from `subagent_finished.status`: `completed|max_steps|max_duration` → done, `aborted` → stopped, `budget|failed` → failed; `toolCalls`, `durationMs`; live counts from `subagent_progress`). `subagent_waiting` puts the existing approval / question / connect blocks into the parent thread with the sub-agent's description as a prefix.
- `SubagentPanel`: header (back, description, spinner + elapsed, stop → `POST /conversations/<childId>/abort`, full screen, close), `SubagentTask` from the child's first `user_message` (with `dispatch`) and `subagent_started` (agent type, model, tools), then the child thread through the same `useConversation` (events + SSE on the child id) and `buildTimeline`, no composer, and its own status bar ("子 agent 只读 · 不能和它对话", context %).
- Background tasks section: `GET …/subagents`, running ones with stop / open, then "N 个已完成 ›" opening the newest finished one.
- [ ] **Step 1: Failing tests** (fixture events): two dispatched, one finished → group header "1 个子 agent 运行中" plus one done row; clicking a row sets `#subagent=<id>` and marks the row open; the panel renders the task block and the child's tool group; stop calls the child abort route; a `subagent_waiting` approval renders an approval block prefixed with the description. Run → FAIL.
- [ ] **Step 2: Implement** (fixtures-backed when phase C is not merged). Run → PASS.
- [ ] **Step 3: (merged path)** e2e: a fake model dispatching two sub-agents; rows appear, one opens in the panel, streams, stop works, the parent resumes.
- [ ] **Step 4: Commit** `feat(web): sub-agents in the conversation and the right panel`.

### Task 22: Close-out: capability matrix, completeness, baselines, docs

**Files:**
- Create: `apps/web/e2e/conversation-capabilities.spec.ts`
- Modify: `apps/web/visual/{accepted.ts,fidelity.spec.ts}` (`PENDING_B` empty and removed), `apps/web/visual/catalog.spec.ts-snapshots/*` (workflow only), `AGENTS.md`, `.github/workflows/ci.yml` comments, `docs/design/spec.md` status line, `.changeset/ui-refresh-b-web.md`
- Modify: `docs/superpowers/specs/2026-10-22-ui-refresh-design.md` — add "§5.10 Project B as built" (deviations and rulings, like §4.8)

- [ ] **Step 1: Capability matrix** (`conversation-capabilities.spec.ts`, one test per anti-goal capability, Docker e2e with the fake model / fake connector servers already used by `chat.spec.ts`, `tools.spec.ts`, `files.spec.ts`):
  interject while running · stop while running and while waiting · approve once / for the conversation / always (each scope visible only when allowed; role escalation shows once only) · deny with a reason · question with options and "Other" · URL elicitation link · connect card → connect flow · crash resume (kill the worker mid-run; the run resumes and the page shows it) · reconnect (drop the SSE; events after the gap arrive) · upload by button, drag and paste, a rejected file shows the reason · `/` connector prompt · `@` connector resource · hook-denial notice naming the extension, and a denied tool row · "View all" of an archived output · queue: two queued messages go out in order after the turn · model switch logged and used · rename and the generated title in the sidebar · new conversation created on first send only.
  Run `pnpm --filter @capybara-hq/web e2e -- conversation-capabilities chat` → PASS.
- [ ] **Step 2: Completeness.** `ACCEPTED` equals every component with a state list (the fidelity completeness case, `PENDING_B` deleted). `pnpm --filter @capybara-hq/web visual fidelity conversation.interaction sidebar.interaction` → PASS.
- [ ] **Step 3: Full verification.** `pnpm verify` → required checks pass; zero-drift groups → PASS; `pnpm check:terms` → passed.
- [ ] **Step 4: Baselines.** Push, `gh workflow run visual-update.yml -f branch=feat/ui-refresh-b`, pull the bot's commit, push an empty commit (`test(web): rerun CI after baseline update`).
- [ ] **Step 5: Whole-PR side-by-side.** `COMPARE=<every B component> pnpm --filter @capybara-hq/web compare`; the controller runs one last blind review; hand `apps/web/compare-out/index.html` to the coordinator for the maintainer (spec §7.4).
- [ ] **Step 6: Docs and changesets.** AGENTS.md: the UI rule line mentions the Conversation template; the extension-UI rule line names `panel` / `section` / `inline` places and `file-preview@1`; the tools rule line names `title` / `keyArgs` / `description`; the runtime line names `model_switched` and queued messages; the visual job row mentions `conversation.interaction.spec.ts`. No new CI check is added by B (state below). Web changeset: "The conversation page is rebuilt: title bar with generated titles and rename, a properties panel and a right panel, model and effort pickers in the composer, a message queue, tool groups with diffs, file outputs with previews, and extension cards, sections and panels."
- [ ] **Step 7: Commit** `chore: close out UI refresh B (capability matrix, acceptance, docs)`.

**CI placement:** B adds no new static check. Its Playwright specs join the `visual` job (by diff, unchanged inputs) and the e2e specs the `e2e` job (by diff). The new kernel tests run in the `test` job by diff, as today.

---

## Needs a maintainer decision (raised while planning)

Each has the plan's default; the sign-off gate is the place to confirm them.

1. **Phase C overlap.** Phase C (sub-agents) touches the same files: `events.ts`, `purposes.ts` (three tier purposes next to B's `title`), `conversations.kind`, migrations from `0053`, and its §17 builds interim sub-agent UI in the Inspector, which B deletes. Default: whichever merges second rebases; if C merges first, B's Task 21 wires the real thing and deletes C's interim Inspector view; if B merges first, C wires B's components (C §17 already says so). Migration numbers are taken at implementation time.
2. **Tool titles outside the fingerprint.** Adding `title` / `keyArgs` to `ToolSpec` would change every MCP tool's `specHash` and send every connector with titled tools into drift review. Default: display-only fields are excluded from `specHash` (Task 4) and read live for display; `tool_specs` rows are not rewritten.
3. **Non-zero exit and `isError`.** The spec counts a non-zero exit as a failure for display. Changing `isError` would change what the model sees (Claude Code does mark it as an error; `grep` with no match exits 1). Default: keep `isError` as is (timeout / abort), carry `exitCode` in the display-only `tool_result.view`, and show "Failed" from it. Alternative: set `isError` on non-zero exit too (model-visible behavior change, replay-safe since results are logged).
4. **Deny reason reaches the model.** Default: yes, appended to the denied call's tool result ("The user denied this tool call. Reason: …"), as Claude Code does; it is in the log, so replay is unaffected.
5. **The model-switch DriftReason.** `model_call` already records the model and params, so baselines need nothing new. Default: honor switches in step and full-run replay through `selectionAt`, and add `model_switched` only to flag a candidate that overrides a person's mid-conversation choice. Alternative: no new DriftReason at all (the spec asks for "a matching DriftReason").
6. **Retry after a failed run.** Nothing in the kernel can re-run a consumed trigger. Default: Retry re-sends the last user message (text + files) with a display-only `retryOf`, folded into the failed divider instead of a second bubble; the model sees the user repeat it. Alternative: a kernel retry route that rewinds `consumed_seq` (breaks the "consumed never goes back" invariant).
7. **Built-in vs extension previewers.** Default: an accepting extension previewer wins over the built-in one for the same file; the person can switch back from the panel header. Alternative: built-ins first.
8. **"File cleaned up".** File outputs are copied to the object store at delivery, so a reclaimed sandbox never removes them. Default: "removed" means the object is gone from storage (manual or org cleanup), shown as "No longer available"; there is no "sandbox reclaimed" reason.
9. **A Markdown dependency in design.** Assistant text is plain `<Text pre>` today and the spec wants rendered Markdown. Default: `mdast-util-from-markdown` + `mdast-util-gfm` + `micromark-extension-gfm` (MIT) in `packages/design`, rendered to React elements with no HTML. Alternative: `marked`'s lexer with the same renderer.
10. **todo's view ids.** Default: new ids `tasks-panel` / `tasks-section` / `tasks-card`, with the old `tasks` kept as an alias of `tasks-panel` for one release. Alternative: keep `tasks` as the panel id.
11. **Esc never stops a run.** Claude Code's Esc interrupts. Default: Esc closes menus and the panel sheet only; stop stays on the button (and a click while waiting).
12. **Typography snaps.** Canvas 12.5px mono (tool rows, key / value, outputs) snaps to `type.small` 12, canvas 13px buttons to `type.body` 13, card padding 12/14 to `space.3` 12, file-card padding 6/10 to `pad.default` 6/12, icon buttons 30 to `control.default` 28, title bar 48 is a new `layout.title-bar` token.
13. **Right panel widths.** Spec "520–600, resizable". Default: min 520, default 560, max = content width − 480 (the chat minimum), so wide screens can make it larger than 600.
14. **The switchable model list.** Model providers are deployment-scoped (there is no per-org enablement of providers), so "the org's enabled providers" is the existing `GET /orgs/:orgId/models` (`agents.use`). Default: no new endpoint.
15. **Queued `@` resources.** Default: resources are read when the message is queued (stored in the queue row, not the log), so a queued message never needs the person's credentials later; editing changes only the text.
