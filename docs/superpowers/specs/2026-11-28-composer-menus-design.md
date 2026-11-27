# Composer menus: ＋, / and @, and the composer's layout

Status: approved by the maintainer (2026-11-28). Interaction settled on the composer canvas (row 1:
＋ / / / @ boards, `ComposerSizes`); visuals follow the layered shell spec
(`2026-11-28-layered-shell-design.md`) and the existing design components, not the canvas styling.
Depends on the file library spec (`2026-11-27-file-library-design.md`) for the @ menu's files.

## Intent

The composer hides what it can do: `/` and `@` are known only to people who know them, ＋ only uploads,
and both menus are a centred command palette with its own search box, no icons and no phone form.
This change gives the composer three menus in one shell anchored to it: ＋ (everything you can add or
use, for people who do not know the keys), `/` (commands and skills), `@` (files and resources, the
text after `@` is the search), each row with an icon that says what it is; lets a person reference a
file of the device's project without uploading it; and sets the composer's layout (device / project
on top, ＋ and mode left, model right).

## Decisions (maintainer, 2026-11-27/28)

1. ＋ opens a menu; `/` and `@` keep their triggers; the three share one menu shell: as wide as the
   composer, start-aligned, attached above it, a footer line of key hints on desktop.
2. Rows carry an icon for their kind, never a `/` or `$` prefix in the name: a command icon for
   commands, a skill icon for skills, the connector's own icon for its resources, prompts and its ＋
   entry, a file-type mark for files.
3. `@` searches the file library and connector resources together; picking a file attaches it
   without an upload.
4. ＋ v1 includes 项目文件 (a file of the device's project, referenced, not uploaded).
5. Composer layout: the top strip holds device then project (a project belongs to a device), the left
   of the control row ＋ and the mode, the right the model (and effort) and send.
6. Every layout adapts expanded → medium → compact (below).

## Facts this design builds on (origin/main, 2026-11-28)

- `ComposerBox` (`packages/design/src/conversation/composer.tsx`): ＋ is a plain `IconButton` calling
  `onAttach()`; pickers `{agent?, device?, permission?, model, effort?}`; below 600 device / model /
  effort collapse into `ComposerOptions` (a bottom sheet). `ConvMenu` (`conversation/menu.tsx`) has
  items with icon / description / badge, group labels, an anchored footer, a filter above 10 items.
- `/` and `@` use `CommandPalette` (`overlays/palette.tsx`): a centred cmdk dialog with its own input,
  `CommandItem` without an icon, no compact form.
- `ComposerBar` (`apps/web/.../ComposerBar.tsx`): `/` opens on an empty draft; groups skills by source
  (project, agent, platform, plugin), then connector prompts, then unavailable connectors, then the
  `/compact` command last (a command never takes the first Enter meant for a skill). `@` opens at the
  caret after whitespace; resources grouped by connector; at most 5 (`MAX_ATTACHMENTS`). Sent body:
  `{text, attachments:[{connectorId, uri}], files:[ids], skill?}`.
- Skills (`invocable-skills`) and connector prompts / resources carry no icon; the connector icon is
  `GET /orgs/:orgId/connectors/:connectorId/icon` and the connector list has its URL.
- There is no person-facing sub-agent delegation; a `context: fork` skill runs as a sub-agent.
- Projects: `GET devices/:id/projects` lists `{name, path}`; there is no HTTP route that lists a
  project's files; the provider has an optional `list(h, path, {limit})` reached through the owner
  browse scope (`SandboxService.withBrowse`). The agent reads the workspace with `Read`.
- Model-visible text is English and goes into the log (replay-evals); the user message is logged.

## Design

### 1. The menu shell (design: `ComposerMenu`)

A new design component replacing `CommandPalette` for the composer (the palette stays for ⌘K):

- Anchored to the composer frame: same width, start-aligned, `space.2` above it, `radius.md`, the
  overlay ground and line of existing menus; max height `layout.menu-max-height`, its list scrolls.
- Rows: the `ConvMenu` described-item row (icon or image mark, name, one-line description, trailing
  badge or key hint), group labels, the selected row on `selected`. An image mark reuses `ObjectMark`
  (`image`, falling back to the initial).
- No search box of its own: the query is the composer text after the trigger (`/fix` filters skills,
  `@report` searches files and resources), ranked with the palette's existing `commandScore`.
- Footer (from 841 up): key hints as text (`@ 文件与资源 · / 技能与命令 · ↑↓ 选择 · ↵ 使用 · esc 关闭`)
  and a muted hint (「输入以搜索」); hints that switch menus are buttons.
- Keys: ↑↓ move, ↵ picks (no choosable row: ↵ closes the menu and never sends; the next ↵ sends), Esc
  closes once and keeps the text, Backspace through the trigger closes (a selection's Backspace is plain
  editing), a space right after `@` or after `@…` with no match closes. IME composition is respected
  (its ↵ never picks). Only key moves scroll the list; the footer hints are not tab stops.
- Compact (below 600): the same content in a `BottomSheet` (drag to dismiss, one history entry via
  `useOverlayHistory`), rows `touch.row`, no key hints, a search field at the sheet's top because the
  keyboard covers the composer; a choice never focuses the composer on touch.
- Accessibility: the composer textarea is a combobox (`aria-expanded`, `aria-controls`,
  `aria-activedescendant`), the list a listbox.

### 2. ＋ menu

| group | rows |
|---|---|
| 添加 | 上传文件 (opens the file picker, as ＋ did) · 文件库 (opens @ with files only) · 项目文件 (opens the project file picker, §5; shown when the conversation has a device project) · 连接器资源 (opens @ with resources only) |
| 能力 | 技能 (opens /) |
| 连接器 | one row per usable connector with its icon and description; picking one opens @ filtered to it; a connector waiting for setup shows 待配置 and is disabled |

No sub-agent row (there is no person-facing delegation). The ＋ button keeps `aria-haspopup="menu"`.

### 3. / menu

Same groups and order as today (skills by source, connector prompts by connector, unavailable
connectors, then commands last), with icons: skill (`skills`), connector prompt (the connector's
icon), command (`terminal`). Names without a leading `/`; the argument hint stays as muted text. The
picked skill becomes the chip as today; prompts with arguments keep their dialog; `/compact` keeps its
rules (no arguments, refused while running).

### 4. @ menu

- Groups: 最近文件 / 匹配的文件 (the file library: `GET /orgs/:orgId/files?q=<query>&limit=8`, from
  the file library line), then connector resources grouped by connector with the connector icon
  (`GET connectors/resources?query=<query>`: the web now passes `query`).
- Picking a file adds it to the attachment strip as an uploaded file (its id goes into `files`; the
  file library makes any ready file of the sender sendable). Picking a resource adds `{connectorId,
  uri}` as today. Limits: files per message as today; resources `MAX_ATTACHMENTS` (5).
- Until the file library ships the files group is absent (the menu works with resources alone).

### 5. Project files (kernel + web)

- **Listing route:** `GET /orgs/:orgId/devices/:deviceId/projects/:name/files?path=<rel>&q=<text>`
  (owner of the device only, `agents.use`, human principal) → `{entries:[{name, path, kind:
  "file"|"dir", size?}], truncated}`; one directory per call through the provider's `list` inside the
  owner browse scope rooted at the project path; `path` is relative and normalized, `..` and absolute
  paths are refused (`device.path_outside_project`); `q` filters names in that directory; at most 200
  entries. A provider without `list` answers `device.list_unsupported` and the ＋ row shows disabled
  with that reason. Errors registered with zh / en copy.
- **Sending:** the message body gains `projectFiles: [{path}]` (relative to the conversation's project,
  at most 10). The kernel checks the conversation has a device project, normalizes and bounds each path
  (same rule), and checks each exists with the provider's `stat` in the browse scope; any failure
  refuses the send with `conversation.project_file_unavailable` (path in details). No bytes are read or
  copied.
- **Model input:** each path becomes a text block after the user text, logged in the user message:
  `Referenced project file: <relative path> (in the project root <project path>; read it with Read
  when needed).` English, model-visible, part of the logged message, so replay is unchanged (no
  `DriftReason`). The web shows the paths as file chips on the bubble.
- **Picker (web):** a sheet / popover listing the project's root, folders navigable with a path row,
  a filter field, multi-select, 「引用」 adds the paths as chips to the attachment strip.
- Platform tool: the listing route gets an operation (read-only); `projectFiles` is a field of the
  existing send-message operation's shared schema (parity test).

### 6. Composer layout

- Top strip (inside the composer frame, above the textarea): device picker then project picker, `/`
  between them (`muted`); on an existing conversation the same strip shows the locked device / project
  as static text. Long project names truncate (hover shows the full name).
- Control row: left ＋ and the mode menu; right the model picker (with effort), the context meter (the
  layered shell spec) and send.
- Medium: the mode shows its icon only (tooltip names the mode); the project name truncates first.
- Compact: the top strip is one picker 「<device> / <project>」 opening a bottom sheet (device first, then
  that device's projects); ＋ and mode are `touch.hit` icon buttons; the model shows its name only, the
  effort moves into the model sheet. This replaces today's single `ComposerOptions` button for device;
  model and effort stay one picker.

### 7. Size classes

| | compact | medium | expanded |
|---|---|---|---|
| Menus | bottom sheet with a search field, rows `touch.row`, no key hints | anchored above the composer | anchored above the composer, key hints |
| Top strip | one 「device / project」 picker → sheet | device · project, project truncates | device · project in full |
| Control row | ＋, mode (icons, 44), model name, send | ＋, mode icon, model · effort, meter, send | ＋, mode with label, model · effort, meter, send |

## Not in this change

- A person starting a sub-agent from the composer.
- Recursive search across a whole project (the listing is per directory with a name filter).
- `/` commands beyond `/compact`.

## Spec and doc changes

- `docs/design/spec.md` §6.16.2 (composer: layout, ＋ menu), a new §6.x `ComposerMenu` with states
  (`plus`, `slash`, `at`, `empty`, `loading`, `compact`) and size table; reference blocks; catalog;
  visual baselines through `visual-update`.
- writing-web-ui skill: the composer menus replace the palette for `/` and `@`.

## Tests (outline)

- Design (jsdom): `ComposerMenu` keyboard (↑↓ ↵ Esc, Backspace through the trigger), combobox aria,
  compact sheet form, footer buttons switch menus.
- Web: ＋ entries open the right menu or picker; `/` filters inline and keeps commands last; `@`
  searches files and resources, picking a file puts its id in `files` without an upload; project file
  picker navigation and multi-select; the bubble shows project file chips.
- Kernel: the listing route refuses `..`, absolute paths, other people's devices, providers without
  `list`; send with `projectFiles` validates and logs the English block; refusal when a path is gone;
  replay zero-drift fixtures before and after.
- Platform parity: the new operation and the send schema field.

## AGENTS.md rules touched

- **Web UI.** New `ComposerMenu` and the composer layout live in `packages/design` (spec change,
  reference blocks, catalog, tests, `visual-update`); `apps/web` passes data only; no `cmdk` in the web.
- **Mobile and shells.** Menus and pickers adapt in the design component by size class; compact uses
  `BottomSheet` with one history entry; touch choices never focus the composer.
- **Runtime and replay.** The project file reference is logged in the user message (model-visible
  English text), nothing is read at request-build time; zero-drift fixtures before and after.
- **Device access / sandboxes.** The listing goes through the owner browse scope, read-only, bounded to
  the project root; no writes; the conversation owner's own device only.
- **Platform tool.** One read operation for the listing route; `projectFiles` added to the shared
  send-message schema (parity test).
- **Kernel.** Routes in the devices module with `createZodDto`, explicit `@Inject`, errors registered.
- **Language / i18n.** New copy zh / en; zh uses 智能体 / 平台 / 超级管理员.
