# Composer menus Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Execution here uses the `wave-planned-subagent-development` layer (wave table at the end).

**Goal:** ＋, `/` and `@` open one composer-anchored menu (`ComposerMenu`) with icons, a person can reference files of the device's project without uploading them, and (phase B) the composer gets its device / project strip and control-row layout.

**Architecture:** Kernel: a per-directory listing route over the owner browse scope (`SandboxService.withBrowse`), bounded to the project root, and a `projectFiles` send field that stats each path and logs one English text block per path in the `user_message`. Design: a new `ComposerMenu` (anchored above the frame, BottomSheet on compact) and a `ProjectFilePicker`, both data-only components; `ComposerBox` hosts the menu and makes the textarea a combobox. Web: `ComposerBar` builds the menu groups and passes data only.

**Tech Stack:** NestJS + Fastify + Kysely (kernel), React + CSS tokens (`packages/design`), Next 16 + TanStack Query + next-intl (`apps/web`), vitest (jsdom for design / web), Playwright (compare, visual).

**Spec:** `docs/superpowers/specs/2026-11-28-composer-menus-design.md` (binding). Read it fully before any task.

## Global Constraints

- AGENTS.md is binding (Web UI, Mobile and shells, Runtime and replay, Device access, Platform tool, Kernel, Language rules).
- Model-visible text is English and exactly: `Referenced project file: <relative path> (in the project root <project path>; read it with Read when needed).`
- Listing: at most 200 entries per call; `projectFiles` at most 10 per message; resources stay `MAX_ATTACHMENTS` (5).
- Error codes (exact): `device.path_outside_project`, `device.list_unsupported`, `conversation.project_file_unavailable` (path in `details`).
- Menu footer copy (zh): `@ 文件与资源 · / 技能与命令 · ↑↓ 选择 · ↵ 使用 · esc 关闭`, muted hint 「输入以搜索」; ＋ groups 添加 / 能力 / 连接器 with rows 上传文件 · 文件库 · 项目文件 · 连接器资源 · 技能; disabled connector badge 待配置; picker primary 「引用」. zh never says 企业 or `agent` (智能体).
- Icons: command `terminal`, skill `skills`, connector rows / prompts / resources the connector icon through `ObjectMark` (`image`, initial fallback), files a file-type mark.
- `apps/web` writes no styles and imports no `cmdk`; every read is a `defineQuery`, keys only in `lib/query/keys.ts`.
- Phase A never edits the composer's control-row layout, the StatusBar or anything context-meter related (the layered shell line owns them). The ＋ button stays where it is.
- Comments, test titles, commits in English; commit body lines ≤ 100; every commit ends with `Co-Authored-By: Capybara <noreply@capybarahq.com>`. Each implementer `git add`s only its own paths.
- Run tests from the repo root: `pnpm exec vitest run <path>`.

## Decisions taken while planning (spec gaps)

1. **No send-message Platform operation exists**: `POST …/conversations/:id/messages` and `POST …/conversations` are exclusions (`platform/exclusions.ts`, "internal"). `projectFiles` goes into the shared `MessageFields` schema (so the exclusion and the web parity check see it); no operation is added for sending. The listing route gets the read operation `devices.list-project-files`.
2. **Content order and the text rule**: `content = [text, ...resource bodies, ...project file blocks, ...uploaded file blocks]`; `payload.projectFiles: [{ path }]`, block i at `content[1 + attachments.length + i]`. `projectFiles` need text (or a skill) exactly like `@` resources (extend `textRule`), so the index rule stays one rule; the web keeps send disabled with the existing resource hint when text is empty.
3. **New conversation**: `projectFiles` need `project` in the create body (refused `conversation.project_file_unavailable` with `details.reason: "no_project"` otherwise); the project path comes from `DeviceProjectsService.resolveForBinding` read before the transaction (the binding inside stays authoritative).
4. **Queue path** (deprecated queue, scheduled tasks): `QueueInput` omits `projectFiles`; nothing changes there.
5. **Project file picker** is a design component (`ProjectFilePicker`) because it needs a list with folder navigation, a path row and multi-select, which no design component draws today.

## Review Focus

1. Path tricks on the listing and send: `a/../../etc`, `./`, `//x`, `%2e%2e` (already decoded by Fastify), a trailing `/`, a backslash, NUL, an empty path → refused or normalized, never outside the project root. Pinned in Task 1 (`projectRelativePath` table test) and Task 2 (send refusal).
2. A symlink inside the project pointing outside: the listing shows it as the provider reports; the browse scope's roots (owner ceiling) are the boundary, the kernel never follows it itself. Task 1 test: the scope passed to the provider is rooted at the project path.
3. A conversation whose project was removed from the device after binding: send with `projectFiles` still uses the conversation's stored `project_path` (stat decides). Task 2 test.
4. Device stopped / offline at send time: a stopped (suspended) device is started for its owner (`ensureRunningForOwner`, as the listing does; recorded decision) and the send goes through; an offline machine or a start that fails → refused with the existing device codes (`device.offline`, `device.not_running`), not a 500, and nothing is written. Task 2 tests (a suspended device resumed, a failing start, an offline machine).
5. `@` typed mid-word (`a@b`) or with a space directly after, IME composition Enter → no menu, no pick. Task 3 (keyboard) and Task 5 tests.

---

## Phase A

### Task 1: Kernel project file listing (HIGH: trust boundary)

**Files:**
- Create: `packages/kernel/src/devices/device-project-files.service.ts`, `packages/kernel/src/devices/project-paths.ts`
- Modify: `packages/kernel/src/devices/devices.controller.ts` (route), `packages/kernel/src/devices/devices.module.ts` (provider), `packages/kernel/src/errors.ts` (3 codes), `packages/kernel/src/platform/ops/devices.ops.ts` (operation), `apps/web/messages/zh.json` + `en.json` (`errors.device.path_outside_project`, `errors.device.list_unsupported`, `errors.conversation.project_file_unavailable`)
- Test: `packages/kernel/test/devices/project-paths.test.ts` (unit; add to the checked-in unit list), `packages/kernel/test/devices/project-files.http.test.ts` (integration), `packages/kernel/test/platform/ops-devices-skills.test.ts`

**Interfaces:**
- Produces:
  - `projectRelativePath(rel: string): string` in `project-paths.ts`: normalized posix relative path (`""` for the root), throws `ApiError("device.path_outside_project", …, { path: rel })` for absolute paths, `..` escaping, backslashes, NUL, length > 4096.
  - `joinProjectPath(projectPath: string, rel: string): string`.
  - `DeviceProjectFilesService.list(orgId, accountId, deviceId, projectName, { path?: string; q?: string }, signal): Promise<{ entries: { name: string; path: string; kind: "file" | "dir"; size?: number }[]; truncated: boolean }>` (`path` relative to the project).
  - `DeviceProjectFilesService.statAll(ctx: { orgId; accountId; deviceId }, projectPath: string, paths: string[], signal): Promise<{ missing: string[] }>` (normalizes each through `projectRelativePath`, stats inside one `withBrowse`; a directory counts as missing).
  - Route `GET /orgs/:orgId/devices/:id/projects/:name/files?path=&q=`; HUMAN_ONLY, the same `@OrgAction` as `GET :id/projects` (`agents.use`), owner only (others `device.not_found`).
  - Platform operation `devices.list-project-files` (read-only, `mirrors: ["GET /api/v1/orgs/:orgId/devices/:id/projects/:name/files"]`, input `{ deviceId, name, path?, q? }` from the route's exported schemas).

- [ ] **Step 1: Unit tests for `projectRelativePath`** — table: `"" → ""`, `"src/" → "src"`, `"./a/./b" → "a/b"`, `"a/../b" → "b"`, `"a/../../x"`, `"/etc"`, `"..", "a\\b"`, `"a\u0000"` throw `device.path_outside_project`. Run, see FAIL.
- [ ] **Step 2: Implement `project-paths.ts`** with `posix.normalize`; pass.
- [ ] **Step 3: Integration tests** (model on `projects.http.test.ts` and its device fake): lists the root (dirs then files, names sorted, `size` for files), `path=src` lists one directory, `q=rea` filters names case-insensitively in that directory, > 200 entries → 200 and `truncated: true`, `path=../x` → 422 `device.path_outside_project`, another member's device → 404 `device.not_found`, unknown project → `device.project_not_found`, a provider without `list` → `device.list_unsupported`, a PAT / agent principal → refused like other HUMAN_ONLY routes, the browse `list` is called with the absolute `joinProjectPath(project.path, rel)`.
- [ ] **Step 4: Implement the service** reusing `DeviceProjectsService`'s `onDevice` pattern (`ensureRunningForOwner`, then `withBrowse`; same error mapping); `list(abs, { limit: 201 })` to detect truncation; map provider entries to `{ name, path: rel, kind, size? }`. Register the three codes in `errors.ts` (422 / 409 / 422, mirroring `device.project_refused`) and the zh / en copy.
- [ ] **Step 5: Platform operation + parity**: add the op; run `pnpm check:platform-ops` and `pnpm exec vitest run tools/checks/test/platform-parity.test.ts packages/kernel/test/platform/ops-devices-skills.test.ts` → PASS.
- [ ] **Step 6: Run** `pnpm exec vitest run packages/kernel/test/devices/project-paths.test.ts packages/kernel/test/devices/project-files.http.test.ts` → PASS; `pnpm check:kernel-conventions && pnpm check:i18n` → PASS.
- [ ] **Step 7: Commit** `feat(kernel): list a device project's files through the owner browse scope` (Refs #973).

### Task 2: Kernel `projectFiles` on send

**Files:**
- Modify: `packages/kernel/src/conversations/conversations.controller.ts` (`MessageFields.projectFiles`, `textRule`), `packages/kernel/src/conversations/conversations.service.ts` (`ResolvedExtra.projectFiles`, `resolveExtra`, `userMessage`, `createWithMessage`), `packages/kernel/src/conversations/events.ts` (`user_message.projectFiles`), `packages/kernel/src/conversations/queue.service.ts` / `queue.ts` (type: omit), `packages/kernel/src/conversations/conversations.module.ts` if a provider import is needed
- Test: `packages/kernel/test/conversations/project-files-send.test.ts`, `packages/kernel/test/evals/reconstruct.test.ts` (one recorded log with a project file block)

**Interfaces:**
- Consumes: Task 1 `projectRelativePath`, `DeviceProjectFilesService.statAll`.
- Produces: body field `projectFiles?: { path: string }[]` (max 10, `.strict()` objects, `path` 1..4096) on `POST …/conversations/:id/messages` and the create body's `message`; `user_message.payload.projectFiles?: { path: string }[]` (normalized paths).

- [ ] **Step 1: Before**: `pnpm exec vitest run packages/kernel/test/evals/reconstruct.test.ts` → PASS (record the result in the report).
- [ ] **Step 2: Failing tests**: a send with `projectFiles: [{path:"src/a.ts"}]` on a conversation bound to a project writes `content[1]` = `Referenced project file: src/a.ts (in the project root /home/u/p; read it with Read when needed).` and `payload.projectFiles = [{path:"src/a.ts"}]`; with one `@` resource the block is `content[2]`; a missing path → 422 `conversation.project_file_unavailable` with `details.path`, nothing written; `../x` → `device.path_outside_project`; a conversation without a project → `conversation.project_file_unavailable` (`details.reason: "no_project"`); empty text → 400 validation; 11 entries → 400; a stopped device → the device code, nothing written; create-with-message with `project` + `projectFiles` works, without `project` refused; a bound project removed from the device afterwards still resolves through the stored `project_path`.
- [ ] **Step 3: Implement**: `resolveExtra` grows a `projectFiles` input and the conversation's `{ deviceId, projectPath }`; it stats outside any transaction, then returns text blocks appended after the resource bodies and `projectFiles` metadata; `userMessage` writes `projectFiles` when non-empty. Nothing is read at request-build time.
- [ ] **Step 4: Replay fixture**: add a recorded log with a project file block to `reconstruct.test.ts`'s fixtures (current format) and assert zero drift. **After**: run `reconstruct.test.ts` and the step tests → PASS.
- [ ] **Step 5: Run** `pnpm exec vitest run packages/kernel/test/conversations/project-files-send.test.ts packages/kernel/test/evals/reconstruct.test.ts`, `pnpm check:web-api-parity` (no web change yet, must stay green) → PASS.
- [ ] **Step 6: Commit** `feat(kernel): reference project files in a message`.

### Task 3: Design `ComposerMenu` and the ComposerBox menu host

**Files:**
- Modify: `docs/design/spec.md` (§6.16.2: ＋ opens a menu, the textarea as combobox, the menu slot; new §6.16.30 `ComposerMenu` with `<!-- states: composer-menu plus slash at empty loading compact -->` and `<!-- size-table: composer-menu -->`), `packages/design/src/conversation/composer.tsx` (host only: `menu` slot, combobox aria, ＋ `aria-expanded`), `packages/design/src/index.ts`, `packages/design/src/i18n/*` (footer copy), `packages/design/src/styles/` (a `composer-menu.css` imported with `layer(design)`), `apps/web/src/dev/catalog/conversation-page-blocks.tsx`
- Create: `packages/design/src/conversation/composer-menu.tsx`, `docs/design/reference/src/` blocks `composer-menu-{plus,slash,at,empty,loading,compact}`
- Test: `packages/design/test/composer-menu.test.tsx`

**Interfaces:**
- Produces (exported from `@capybara-hq/design`):
  ```ts
  type ComposerMenuKind = "plus" | "slash" | "at";
  type ComposerMenuItem = {
    id: string; label: string; description?: string;
    icon?: IconName;                          // command / skill / plus rows
    mark?: { text: string; image?: string };  // connector rows, prompts, resources (ObjectMark)
    file?: { name: string };                  // file-type mark
    hint?: string;                            // muted trailing text (argument hint)
    badge?: string; disabled?: boolean; keywords?: string[];
    onSelect(): void;
  };
  type ComposerMenuGroup = { id: string; label?: string; items: ComposerMenuItem[] };
  type ComposerMenuProps = {
    kind: ComposerMenuKind; groups: ComposerMenuGroup[];
    query: string;                 // composer text after the trigger; ranked with commandScore
    filter?: boolean;              // default true; false when the caller already searched (@ server results)
    loading?: boolean; empty: string;
    onClose(): void; onSwitch?(kind: "slash" | "at"): void;
    onQueryChange?(q: string): void; // the compact sheet's search field
    searchLabel?: string;
  };
  function useComposerMenu(p: ComposerMenuProps): {
    listboxId: string; activeId: string | undefined;
    onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>): boolean; // true = handled
    combobox: { role: "combobox"; "aria-expanded": boolean; "aria-controls"?: string; "aria-activedescendant"?: string; "aria-autocomplete": "list" };
  };
  function ComposerMenu(p: ComposerMenuProps & { controller: ReturnType<typeof useComposerMenu> }): JSX.Element;
  ```
  `ComposerBox` gains `menu?: { node: ReactNode; combobox: ComposerMenuController["combobox"]; onKeyDown: … }` and `attachOpen?: boolean` (the ＋ button's `aria-expanded`, keeps `aria-haspopup="menu"`). `onAttach` stays the ＋ click.
  `CommandPalette` stays exported for ⌘K.

- [ ] **Step 1: Spec change** per writing-web-ui "Adding a component": layout from spec §1 (same width as the frame, start-aligned, `space.2` above, `radius.md`, the menu overlay ground and line, max height `layout.menu-max-height`), rows = the `ConvMenu` described-item row, footer from 841 up with hints as text and the switch hints as buttons, compact = `BottomSheet` (`useOverlayHistory`, rows `touch.row`, search field at the top, no hints), size table values as `tokens.json` paths. Reference blocks per state (dark + light, fixtures from `@capybara-hq/design/fixtures`).
- [ ] **Step 2: Failing jsdom tests**: ↑↓ move `aria-activedescendant` skipping disabled rows and wrapping; ↵ calls the active item's `onSelect`; ↵ during IME composition (`isComposing`) does nothing; Esc calls `onClose` and keeps the text; `onKeyDown` returns false for keys it does not handle; `query="fix"` ranks by `commandScore` and hides non-matches, `filter={false}` keeps the order; group labels render; an item with `mark.image` renders `ObjectMark` with the image; the empty text shows when nothing matches; `loading` shows the loading row; footer buttons call `onSwitch("at")` / `onSwitch("slash")`; at compact (`useSizeClass` mocked `compact`) it renders a `BottomSheet` with a search field bound to `onQueryChange` and no footer; the textarea gets `role="combobox"` and `aria-expanded`; `findNestedBoxes` finds none.
- [ ] **Step 3: Implement** the component, hook, CSS (tokens only), i18n; wire the `menu` slot into `ComposerBox` without touching the control row's order or sizes.
- [ ] **Step 4: Catalog**: every state in `conversation-page-blocks.tsx` with a `RefBlock` of the same id (`composer-menu-<state>`), elements carrying the size table's `data-part` names.
- [ ] **Step 5: Run** `pnpm exec vitest run packages/design/test/composer-menu.test.tsx packages/design/test/composer.test.tsx`, `pnpm check:web-ui`, `pnpm typecheck` → PASS.
- [ ] **Step 6: Commit** `feat(design): ComposerMenu anchored to the composer`.

(Acceptance against the references, `ACCEPTED` and `visual-update` are the controller's Task 7.)

### Task 4: Design `ProjectFilePicker`

**Files:**
- Modify: `docs/design/spec.md` (new §6.16.31 with `<!-- states: project-file-picker root folder filtered selected empty loading unsupported compact -->` and a size table), `packages/design/src/index.ts`, design i18n, a CSS file, `apps/web/src/dev/catalog/conversation-page-blocks.tsx`
- Create: `packages/design/src/conversation/project-file-picker.tsx`, reference blocks `project-file-picker-<state>`
- Test: `packages/design/test/project-file-picker.test.tsx`

**Interfaces:**
- Produces:
  ```ts
  type ProjectFileEntry = { name: string; path: string; kind: "file" | "dir"; size?: number };
  type ProjectFilePickerProps = {
    open: boolean; onOpenChange(o: boolean): void;
    project: string;               // project name for the title / path row root
    path: string;                  // current relative directory ("" = root)
    onPathChange(path: string): void;
    entries: ProjectFileEntry[]; truncated?: boolean;
    filter: string; onFilterChange(q: string): void;
    loading?: boolean; error?: ReactNode; // the caller's ErrorDetail
    selected: string[]; onSelectedChange(paths: string[]): void;
    max: number;                   // 10
    onConfirm(paths: string[]): void; // 「引用」
  };
  ```
  Expanded / medium: a `Dialog`-sized popover-less dialog; compact: `BottomSheet` (`useOverlayHistory`). Path row = clickable segments from the project name; dirs navigate, files toggle a checkbox; the count and 「引用」 in the footer, disabled at 0; selecting past `max` is disabled with a hint.

- [ ] **Step 1: Spec + reference blocks** (as Task 3 step 1).
- [ ] **Step 2: Failing tests**: clicking a dir calls `onPathChange("src")`; a path-row segment calls `onPathChange("")`; a file row toggles selection; selection persists across folders (caller-owned `selected`); 「引用」 disabled with none, calls `onConfirm(selected)`; at `max` further file rows are disabled; the filter field calls `onFilterChange`; `truncated` shows the hint; compact renders a `BottomSheet`; no nested boxes; keyboard: rows are a listbox with ↑↓ and Space / ↵.
- [ ] **Step 3: Implement**; **Step 4: Catalog** RefBlocks; **Step 5: Run** the test, `pnpm check:web-ui`, typecheck → PASS; **Step 6: Commit** `feat(design): project file picker`.

### Task 5: Web menus: ＋ / `/` / `@` (resources)

**Files:**
- Modify: `apps/web/src/components/conversation/ComposerBar.tsx`, `apps/web/src/lib/connectors.ts` (+ `lib/query/connectors.ts`, `lib/query/keys.ts`: resources take `query`), `apps/web/messages/zh.json` + `en.json` (`chat.composerMenu.*`), `.agents/skills/writing-web-ui/SKILL.md` (composer menus replace the palette for `/` and `@`)
- Test: `apps/web/test/composer-menus.test.tsx` (new), existing `ComposerBar` tests updated

**Interfaces:**
- Consumes: Task 3 `ComposerMenu`, `useComposerMenu`, `ComposerBox.menu`, `attachOpen`.
- Produces: `ComposerBar` state `menu: { kind: "plus" | "slash" | "at"; at: number; scope?: "resources" | "files" | { connectorId: string } } | null`; the `@` query function `connectorResourcesQuery(orgId, query)`.

- [ ] **Step 1: Failing tests**: ＋ opens the plus menu with groups 添加 (上传文件, 文件库 hidden until the file library ships, 项目文件 only with a device project, 连接器资源), 能力 (技能), 连接器 (one row per connector with its icon URL as `mark.image`, a `needs_config` connector disabled with 待配置); 上传文件 opens the file input; 技能 inserts `/` and opens the slash menu; a connector row opens `@` scoped to it; `/` on an empty draft opens slash, `/fi` filters inline, commands (`compact`, icon `terminal`) stay last and never take the first ↵ meant for a skill; skills show `skills` and no leading `/`; `@` after whitespace opens at with resources grouped by connector, the kernel is asked `…/connectors/resources?query=rep` (debounced, its own cache key), picking adds `{connectorId, uri}`, the 6th is refused with the existing toast; `a@b` opens nothing; Backspace through the trigger closes; Esc closes and keeps the text; no `CommandPalette` in the composer.
- [ ] **Step 2: Implement** (data only; groups built in the bar; the palette import goes).
- [ ] **Step 3: Run** `pnpm exec vitest run apps/web/test/composer-menus.test.tsx apps/web/test/<existing ComposerBar tests>`, `pnpm check:web-ui`, `pnpm check:web-api-parity`, `pnpm check:i18n` → PASS.
- [ ] **Step 4: Commit** `feat(web): composer menus for ＋, / and @`.

### Task 6: Web project files: picker, send, bubble chips

**Files:**
- Modify: `apps/web/src/components/conversation/ComposerBar.tsx`, `apps/web/src/lib/devices.ts` + `lib/query/devices.ts` + `lib/query/keys.ts` (listing loader / query, freshness `live`), the send body type (`projectFiles`), `apps/web/src/lib/timeline.ts` + the user bubble component (chips from `payload.projectFiles`, the project file blocks hidden from the bubble text), messages zh / en
- Create: `apps/web/src/components/conversation/ProjectFilesPicker.tsx` (container: query + `ProjectFilePicker`)
- Test: `apps/web/test/project-files.test.tsx`, `apps/web/test/timeline.test.ts` (case added)

**Interfaces:**
- Consumes: Task 1 route, Task 2 body / payload, Task 4 `ProjectFilePicker`, Task 5 plus menu row 项目文件.

- [ ] **Step 1: Failing tests**: 项目文件 opens the picker on the project root; navigating a folder reads `…/projects/<name>/files?path=src`; the filter reads `q`; multi-select across folders and 「引用」 adds path chips to the attachment strip; a chip's × removes it; the send body carries `projectFiles: [{path}]`; send is disabled without text while project files are attached (same hint as resources); `device.list_unsupported` shows the row disabled with the reason; the bubble shows file chips for `payload.projectFiles` and not the English block text; `timeline.ts` maps a logged message with resources + project files correctly.
- [ ] **Step 2: Implement**; **Step 3: Run** the tests, `pnpm check:web-ui`, `pnpm check:web-api-parity`, `pnpm check:i18n` → PASS; **Step 4: Commit** `feat(web): reference project files from the composer`.

### Task 7 (controller): acceptance, baselines, PR

- [ ] `COMPARE=composer-menu,project-file-picker pnpm --filter @capybara-hq/web compare` inside `mcr.microsoft.com/playwright:v1.64.1-noble` against a local `next start` on a free port (never 3000 / 3917).
- [ ] Blind image reviewer (PNG paths + the writing-web-ui instruction only); fix severe / moderate, repeat; list minors.
- [ ] Add both to `ACCEPTED` (`apps/web/visual/accepted.ts`).
- [ ] Changesets: `@capybara-hq/kernel` (route, send field) and `@capybara-hq/capybara` (web).
- [ ] `pnpm verify --fast` + changed tests; `pnpm check:platform-ops`; `pnpm check:web-ui`; push, PR ready (Refs #973), trigger `visual-update` on the branch, `ci-ok` green.

## Phase B (after the layered shell and the file library are on main)

Rebase on main, then: composer top strip and control row per spec §6 / §7 (design spec §6.16.2, reference blocks, `ComposerBox` props `device` / `project` strip, compact single picker sheet, mode icon at medium), the `@` files group (`GET /orgs/:orgId/files?q=&limit=8`, picking puts the id in `files`) and 文件库 in ＋. Planned in detail in a second plan file once the two lines' interfaces are on main.

## Wave plan

| Task | Depends on | Files / areas | Risk | Wave | Review |
|---|---|---|---|---|---|
| 1 kernel listing | – | kernel devices, errors, platform ops, web messages | high | 1 | alone, most capable |
| 3 ComposerMenu | – | design composer, spec.md, reference, catalog | normal | 1 | batch W1 (mid) |
| 2 kernel send | 1 | kernel conversations, events, reconstruct | normal | 2 | batch W2 |
| 4 ProjectFilePicker | 3 (spec.md, catalog) | design picker, spec.md, reference, catalog | normal | 2 | batch W2 |
| 5 web menus | 3 | ComposerBar, connectors query, web messages, skill | normal | 2 | batch W2 |
| 6 web project files | 1, 2, 4, 5 | ComposerBar, devices query, timeline, web messages | normal | 3 | batch W3 |
| 7 acceptance + PR | all | compare, accepted, changesets | – | 4 | controller |

## Progress

- 2026-11-28 wave 1 fixes: the Task 3 review findings are fixed in 98dc79465 (touch: no focus return; Enter with no
  choosable row closes the menu; hover does not scroll; Esc closes once; Backspace with a selection;
  footer hints not tab stops; a space right after `@` closes the menu). The Task 1 trust-boundary fix
  (browse read roots narrowed to the project path; a project root above the ceiling is refused) was
  uncommitted in the worktree when this entry was written, owned by agent a689d6f534205b402. The
  duplicate worktree feat-composer-menus-design is removed.
- Next: commit the Task 1 fix, re-review it alone on the most capable model, then wave 2 (Tasks 2, 4
  and 5 in parallel), wave 3 (Task 6), then Task 7.
- Wave 1 fixes committed: 02025ec4a (Task 1: browse read roots = project path, project root outside
  the ceiling refused, sort, truncation, malformed output -> 503, op errors, tests), 98dc79465 and
  49a0b007b (Task 3). Duplicate worktrees fix-composer-menu-review and feat-composer-menus-design removed.
- Wave 2 partly done: 6f9d0cfe3 (Task 4 ProjectFilePicker), 8b254587e (Task 5 web menus); batch review
  findings fixed in 87058dc20 (design: outside close, picker focus) and 5c88f0558 (web: IME via
  composition events, stale @ picks filtered locally, skill plugin in description, English comments).
- Next: Opus re-review of the Task 1 trust boundary (in parallel with Task 2 kernel send), review
  Task 2, wave 3 (Task 6), Task 7.
- Opus re-review of the Task 1 trust boundary: holds; minors fixed in d9dc624ee (narrowed check before
  starting the device, claimBrowse re-checks the stored roots, statAll cap, no absolute path in
  device.project_path_too_broad, tests).
- Task 2 committed 0051e2895; review fixes ef896cf54 (decision: a send to a stopped device starts it,
  Review Focus 4 reworded; request signal into statAll; reconstruct fixture without the record mock,
  51/51 zero drift; root paths refused; command review reads typed text + project file lines only).
- Task 6 committed 5fd7b8ddb; review found a severe bug (bubble chip click downloads
  /attachments/project:...) plus moderates (no_project copy, marks lost on new-conversation remount,
  retry drops projectFiles, stale filter/dir fetches); fixes dispatched.
- Next: Task 6 fixes, then Task 7 (compare, blind image review, ACCEPTED, changesets, verify, PR).
- Task 6 review fixes c80a70da6 (project chips open nothing, no_project copy, marks survive the
  new-conversation remount, retry keeps projectFiles and resources, picker reads root on open and
  drops the old filter on navigation, optional strip size in design).
- Task 7 in progress: compare run in the Playwright Linux image (commands in the coordinator's
  report; reference PNGs rendered locally only). Blind review 1: stacked compact sheets in the
  catalog and picker compact sizes -> 300582bc7 (referenceAnchored, data-mobile-sizes reference
  blocks, square checkbox at every size, Input line-height: global ~1px baseline shift, so run
  visual-update). Blind review 2: moderates (disabled primary border/label, empty-state 8px offset,
  compact sheet top hairline) being fixed by agent a0be250abcd52f9f1.
- Next: those fixes + compare3 check, ACCEPTED entries, changesets (kernel, capybara, design),
  verify --fast, push, ready PR (Refs #973), visual-update, ci-ok green.
- Blind review 2 moderates: all three were reference-side against the spec, fixed in c3c5883e3
  (disabled primary keeps the `line` border and `disabled` text, §6.1; the menu and picker sheets
  keep the bottom sheet's top line, §6.59; an empty state without an action draws no action slot).
  Compare rerun in the Linux image: every pair pixel-equal but anti-aliasing (no moderate left, so
  no third blind pass). ACCEPTED + changesets 92469e2af; origin/main merged (project skills' bare
  names carried into the menu); verify --fast, check:platform-ops, check:web-ui and the changed
  kernel tests pass. Next: push, ready PR, reference-update + visual-update, ci-ok.
- PR #1000 opened. The first visual-update failed on fidelity (the compact composer menu row with a
  description is taller than `touch.row`, as drawn): the size table now measures `min-height`.
  origin/main with the layered shell (#979) merged in 9a0ca7427. Compare rerun in the Linux image is
  unchanged (anti-aliasing only), fidelity for both components passes, verify --fast passes;
  reference-update (42069b21c) and visual-update (5c5bcaf3d) ran on the branch. Next: ci-ok, then
  Phase B once the file library is on main.
