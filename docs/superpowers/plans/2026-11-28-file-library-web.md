# File library, part 2: the Files page

> **For agentic workers:** REQUIRED SUB-SKILL: wave-planned-subagent-development. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** A first-level Files page (`/files`, nav 文件 between 定时任务 and 更多) listing the person's
files with a preview beside it, details, share, download, delete and upload on the page; the query
the composer's `@` search will use; links from the conversation's file panel to Files.

**Spec:** [2026-11-27-file-library-design.md](../specs/2026-11-27-file-library-design.md) §6, §8;
mobile layout spec §4.1, §4.3, §5.2. Kernel routes come from part 1
(`2026-11-28-file-library-kernel.md`, task K8). Issue #971. Branch `feat/file-library-web`, stacked
on `feat/file-library-kernel`.

**Architecture:** A design template owns every size-class difference (pages never branch on size:
`web-ui-size-branch`); the page is a thin `page.tsx` + client `view.tsx` on `defineQuery` reads and
`useAppMutation` writes. The preview reuses `FilePreviewBody` with a new `FileSource` kind
`library`; plugin previewers embed through `EmbedTab` with a library `fileId`; `ShareDialog`
generalizes from conversation-keyed to a share target. Do not touch shell/token files (another line
is changing the shell look).

## Rules for every task

writing-web-ui skill, read first. No `className` / styles / CSS in apps/web; reads `defineQuery`,
writes `useAppMutation`; zh copy uses 智能体 / 平台 / 超级管理员, never 企业 or Latin "agent";
`pnpm check:web-ui`, `pnpm check:i18n`, `pnpm check:web-api-parity`. Commits as in part 1.

## Wave plan

| Task | Depends on | Files / areas | Risk | Wave | Review |
|---|---|---|---|---|---|
| W1 `LibraryPage` design template (list + preview, three size classes) + catalog + spec entry | – | `packages/design/src/templates/library-page.tsx` (+ css in `templates.css` only if a `ListDetail` width pair must be added), `templates/names.ts`, `tools/checks/src/web-ui.ts` (`WEB_UI_TEMPLATES`), `apps/web/src/dev/catalog/*`, `docs/design/spec.md`, `apps/web/visual/accepted.ts` | normal | 1 | batched (most capable: layout judgment) |
| W2 Library data layer: loaders, `defineQuery`s, mutations, `FileSource` `library`, share target generalization, library previewer embed | – | `apps/web/src/lib/{library-files,file-source,previewers,shares,html}.ts`, `lib/query/{keys,library,share-mutations,shares}.ts`, `components/file-preview/{FilePreviewBody,ShareDialog}.tsx`, `components/extension-ui/LibraryPreviewEmbed.tsx`, `components/extension-ui/ExtensionSlot.tsx` (args type), tests | normal | 1 | batched |
| W3 Files page + nav + route table + i18n + page tests | W1, W2 | `apps/web/src/app/(app)/files/{page,view}.tsx`, `components/shell/{nav,path}.ts(x)`, `lib/query/routes.ts`, `messages/{zh,en}.json`, `apps/web/test/{files-page,nav,pages,desktop-only-routes}.test.tsx`, `dev/catalog/routes.tsx` (`pages/member-files`) | normal | 2 | batched |
| W4 Conversation panel links to Files | W2 | `components/conversation/FilePanel.tsx`, `PropertiesSections.tsx`, test | normal | 2 | batched |

W3 owns the message files; W1, W2, W4 hand W3 their keys (listed in their reports) or use keys W3
adds. (W2's share dialog reuses the existing `shares.*` keys.)

## Task W1: `LibraryPage` template

Design (spec §6 sizes; reference mockup structure only, never its styles):

- Props: `header: PageHeaderProps` (path, title, `search`, origin `tabs`: 全部 / 智能体交付 / 我上传的),
  `filters` (agent + type selects), `actions` (upload), `usage` (a small meta line), `list` (the
  grouped rows; reuse `ListDetailList` with group headers 今天 / 本周 / 更早 — add `groups` support to
  `ListDetailList` if missing), `detail: ReactNode | null` (preview frame + details + action row),
  `open`, `onBack`, `empty`, `loading`.
- Expanded: list card and preview card side by side (`ListDetail`, `listMin`/`detailMin` from the
  supported pairs; add a pair to `LIST_DETAIL_FITS` + `templates.css` only with the matching
  container rules).
- Medium: two panes when both fit; otherwise the list fills and the detail opens in a right side
  sheet (the overlay primitive the conversation's medium right area uses, `DraggableRightSheet` or
  `Sheet`), closing returns to the list with the row still selected. StatusBar unchanged (shell).
- Compact: pushed page; rows icon + name + one meta line; origin tabs as a full-width `Segmented`
  (`fill`); agent/type filters in one 筛选 bottom sheet (ListPage's compact behavior); search as an
  icon that expands; detail as its own screen registered with `useRegisterShellPage({ onBack })`
  with a top bar of share / download / more. Mobile control sizes from tokens.
- Add to `PAGE_TEMPLATES`, `WEB_UI_TEMPLATES`, `TEMPLATE_ROUTES`, a catalog page with seeded rows,
  a section in `docs/design/spec.md`. Follow the skill's "Adding a component or template" flow
  (reference blocks, `ACCEPTED`). Visual baselines are rendered only by the `visual-update`
  workflow: trigger it on the PR branch (`gh workflow run visual-update.yml --ref <branch>`) after
  the push and commit nothing rendered locally.
- Tests: design unit tests for the three forms (jsdom with `stubWindowWidth`), `findNestedBoxes`
  guard (no box in a box).

## Task W2: Data layer

- `lib/library-files.ts`: `LibraryFileView` mirror of the kernel view; `listLibraryFiles(orgId,
  { origin?, agentId?, type?, q?, limit?, cursor? })`, `getLibraryFile`, `libraryUsage`,
  `deleteLibraryFile`, `uploadLibraryFile` (hash + `POST /files` with `purpose: "library"` +
  storage POST + finalize, sharing the composer's upload helper from part 1), `libraryFileText`.
- Keys (`lib/query/keys.ts`): `org(orgId).files(filter)`, `.filesAll()`, `.file(id)`,
  `.fileUsage()`, `.libraryPreviewers(id)`, `.libraryPreview(id, previewer, locale)`.
- Queries (`lib/query/library.ts`): `libraryFilesQuery(orgId, filter)` (freshness `mine`),
  `libraryFileQuery`, `libraryUsageQuery`, and **`libraryFileSearchQuery(orgId, q)`** =
  `listLibraryFiles(orgId, { q, limit: 8 })`, the composer `@` line's entry point (export and
  document it in the file header).
- Mutations: `useDeleteLibraryFile` (invalidates files + usage + every conversation `files()`),
  `useUploadLibraryFile`, share create keyed by file for the library target.
- `FileSource` gains `{ kind: "library", orgId, file }`; `sourceUrls` → `/files/:id/download`,
  inline, content, html token via `POST /files/:id/html-token`. `FilePreviewBody` handles it with
  library previewer queries. `ShareDialog` takes a `target: { kind: "conversation", conversationId,
  file } | { kind: "library", file }`.
- Library previewer embed: `components/extension-ui/LibraryPreviewEmbed.tsx` using `EmbedTab`
  with `{ fileId }` and no conversation (`requestEmbedToken` already takes optional ids).
- Tests: loaders (`stubApi`), "<mutation> invalidates <keys>", `FilePreviewBody` library kind.

## Task W3: Files page

- `app/(app)/files/page.tsx` (thin server) + `view.tsx` (client): `useWorkspace({ min: "member" })`
  (guests have no Files entry, like 定时任务), `usePageQuery(libraryFilesQuery(...))`, filter state in
  the URL search params, selection with `useHashItem()` (`#item=<id>`), grouping by 今天 / 本周 / 更早,
  usage line, upload action (file input → `useUploadLibraryFile`), details (origin, agent, source
  conversation link or "已删除的对话", times referenced, versions), actions: 在新对话中使用 (navigate to
  `/` with the file as a draft attachment: pass `?files=<id>` and let the composer seed its draft
  strip from it if supported; otherwise link only and note it), share, download, delete with a
  confirm dialog. Empty and filtered-empty states.
- Nav: `{ id: "files", key: "files", href: "/files", audience: "member", icon: "file", section:
  "primary" }` after schedules; `activeNavOf` maps `/files`; no drawer section (the drawer's union is
  closed; it appears in the drawer's primary list as other non-section entries do — check
  `useDrawerNav` and keep it out of `drawer: "section"`).
- `APP_PAGES`, `ROUTE_TABLE` entry (`/files`, member-gated, prefetch `libraryFilesQuery` default
  filter + usage), not desktop-only.
- i18n `nav.files`, `files.*` (zh + en).
- Tests: `apps/web/test/files-page.test.tsx` (hydrated first paint makes no read, empty cache shows
  loading then data, filters, empty states, delete invalidates, share dialog opens), updated nav /
  pages / desktop-only tests; `pages/member-files` catalog entry for the responsive matrix.

## Task W4: Panel link

- `FilePanel` and the properties `FilesSection`: each file links to `/files#item=<id>` ("在文件中查看").
- Test in `file-panel.test.tsx`.

## Final

`pnpm verify --fast`, changed tests, trigger `visual-update` for the new template, final review,
PR ready for review with the body ending `🤖 Generated with [Capybara](https://github.com/capybara-hq/core)`.
