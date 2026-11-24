# Skill file browser Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A skill's 文件 tab is a file tree with the shared file preview body; built-in previewers work
with no plugin, and `file-preview@1` previewers also take skill files.

**Architecture:** Two read-only org routes (file list, file content) on the skill controller; a new
`"skill"` source in the file preview contract with kernel list / render / embed-token support; a design
`FileTree`; the web's `FileSource` gains a skill kind that `FilePreviewBody` already knows how to draw.

**Tech Stack:** NestJS kernel, `@capybara-hq/plugin-sdk`, Next web, `@capybara-hq/design`, vitest
(kernel http tests with testcontainers), Testing Library.

**Spec:** `docs/superpowers/specs/2026-11-25-skill-file-browser-design.md` (approved 2026-11-25:
"设计没问题，写计划开工吧"). Read it before any task.

## Global Constraints

- Reads only: no route writes. Visibility exactly as `GET /api/v1/orgs/:orgId/skills/:id`
  (`@OrgAction("skills.read")`, `requireUser`; own skill, or platform skill on in the org).
- A file is addressed only by a path present in that version's manifest; no storage key, object URL
  or prefix ever reaches the browser or an extension; sha256 checked against the manifest on every read
  (mismatch 409 `skill.file_changed`); unknown version / path 404 `skill.file_not_found`.
- Content headers: `X-Content-Type-Options: nosniff`; `Content-Disposition: attachment` unless
  `inline=1` and the type is png / jpeg / gif / webp; never inline for HTML or SVG; `limit` → at most
  that many bytes plus `x-content-truncated: 1` when cut.
- Previewer reads are a grant for that one object during the call, capped at the previewer's
  `maxBytes` (≤ `FILE_PREVIEW_MAX_BYTES`); embed tokens only for an enabled previewer that takes the
  file; embed tokens never valid for `/api`.
- Kernel conventions (`pnpm check:kernel-conventions`): `@Inject` on every constructor parameter, DTOs
  via `createZodDto`, route schemas registered (`SKILL_ROUTES`), error codes registered; Platform tool:
  an operation or an exclusion with a reason per new route (`pnpm check:platform-ops`, parity test).
- SDK public API change: `pnpm gen:sdk-api` and a changeset bumping `@capybara-hq/plugin-sdk`.
- apps/web writes no styles; web types parity-clean (`pnpm check:web-api-parity`); copy per design spec
  §7.1, zh + en; comments in English.
- New unit / container tests join their checked-in lists (AGENTS.md Tests); kernel http tests are
  integration (the default).

## Review Focus

1. A path with `..`, a leading `/`, or a path of another version: 404, nothing read.
2. A platform skill switched off in the org after the page loaded: list, content, previewers and embed
   token all 404.
3. A file whose object was replaced (sha mismatch): 409, and the preview shows the failure card.
4. A 10 MiB text file: the text built-in shows the first 1 MiB with the truncated note; an extension
   previewer whose `maxBytes` is smaller is not listed for it.
5. An HTML or SVG skill file: shown as source text, never rendered or served inline.

## Wave table

| Task | Depends | Files / areas | Risk | Wave | Review |
|---|---|---|---|---|---|
| 1 Kernel file routes | — | packages/kernel/src/skills/*, errors, platform ops, kernel tests | high (file reads, authorization) | 1 | own (opus) |
| 2 Design FileTree | — | packages/design, docs/design/spec.md | normal | 1 | batched |
| 3 Previewers for skill files | 1 | packages/plugin-sdk (file-preview, ui claims), packages/kernel/src/files/previewers*, ui embed token, skills controller routes, sdk api report, docs/skills | high (embed tokens, read grants) | 2 | own (opus) |
| 4 Web: skill source and the 文件 tab | 1, 2, 3 | apps/web/src/lib (skills, file-source, previewers), components/file-preview, skills/[id]/view.tsx, messages, web tests | normal | 3 | own (mid) |

---

### Task 1: Kernel file routes

**Files:** `packages/kernel/src/skills/skills.controller.ts`, `skills.service.ts` (or a new `skill-files.ts` beside it), `skills.schemas.ts`, the error registry, `packages/kernel/src/platform/ops/skills.ops.ts` (or exclusions), tests `packages/kernel/test/skills/skill-files.http.test.ts` (new, integration).

**Interfaces — produces:**
- `GET /api/v1/orgs/:orgId/skills/:id/files?version=` → `{ version: number; files: { path: string; size: number; contentType: string; previewable: boolean }[] }`
- `GET /api/v1/orgs/:orgId/skills/:id/files/content?version=&path=&limit=&inline=` → bytes
- `SkillFiles.resolve(orgId, skillId, version?, path) → { store, key, size, sha256, contentType }` (kernel-internal, reused by Task 3; never returned to clients)

- [ ] Tests (red first): list for an org skill and for a platform skill on in the org (current version by default, `version=` picks an older one); content returns the bytes with nosniff and attachment; `inline=1` inline for png, still attachment for html / svg; `limit=4` returns 4 bytes and `x-content-truncated: 1`; 404 for a path not in the manifest, `../x`, `/SKILL.md`, an unknown version, a platform skill off in the org, another org's skill; 409 on a sha mismatch (overwrite the object in the test store); a member can read, a guest gets the role refusal the detail route gives.
- [ ] `contentType` from the kernel's existing extension → type lookup (find it: attachments / files use one); `previewable` with the same rule the conversation file listing uses.
- [ ] Platform tool: `skills.list-files` / `skills.read-file` operations or exclusions with reasons (binary content: exclusion "returns bytes for the web's preview; the Skill tool reads files for the model").
- [ ] Commit `feat(kernel): read a skill version's files`.

### Task 2: Design FileTree

**Files:** `packages/design/src/display/file-tree.tsx` (+ index export), styles, `packages/design/test/file-tree.test.tsx`, `docs/design/spec.md` (§6 new entry).

**Interfaces — produces:** `FileTree({ label: string; files: { path: string; size?: string }[]; selected: string | null; onSelect(path: string): void })` and `FileBrowser({ tree: ReactNode; children: ReactNode; label: string })` (the two-pane layout: tree column beside the preview at medium / expanded; at compact the tree alone, the preview pushed when a file is selected with a back control).

- [ ] Tests: folders built from paths and collapsible; selected row `aria-current`/`aria-selected`; ArrowUp / ArrowDown / Enter / ArrowLeft-Right (collapse / expand) keyboard; sizes muted; compact shows the tree, selecting shows the preview with back.
- [ ] Spec entry (anatomy, states, compact form, keyboard); follow the design change flow in writing-web-ui ("Adding a component or template").
- [ ] Commit `feat(design): FileTree and FileBrowser`.

### Task 3: file-preview@1 takes skill files

**Files:** `packages/plugin-sdk/src/file-preview.ts`, `packages/plugin-sdk/src/ui.ts` (claims), `packages/plugin-sdk/test/file-preview.test.ts`, `packages/plugin-sdk/api/plugin-sdk.api.md` (generated), `packages/plugin-sdk/agent-docs/extension-points/file-preview.md`; `packages/kernel/src/files/previewers.ts` (+ controller or skills controller routes), `packages/kernel/src/ui/embed-token.ts` and the embed-token route, kernel tests `packages/kernel/test/files/previewers.http.test.ts` (extend) with the `preview-fake` fixture; `.agents/skills/writing-extension-ui/SKILL.md` ("File previewers"), `.agents/skills/writing-tools/SKILL.md` ("Skill tools"); changeset for `@capybara-hq/plugin-sdk`.

**Interfaces — consumes:** `SkillFiles.resolve` (Task 1). **Produces:**
- `FilePreviewSkillArgs { source: "skill"; orgId: string; accountId: string; skillId: string; version: number; path: string }` in the `FilePreviewArgs` union; `file.id` = `${skillId}@${version}/${path}`.
- `GET /api/v1/orgs/:orgId/skills/:id/files/previewers?version=&path=` → `{ previewers: { plugin, id, title, kind }[] }`
- `GET /api/v1/orgs/:orgId/skills/:id/files/previews/:plugin/:previewerId?version=&path=&locale=` → `{ view }` (same 504 / 502 codes as the conversation route)
- the org embed-token route accepts `{ skillId, version, path }`; `OrgEmbedClaims.skillFile?: { skillId: string; version: number; path: string }`.

- [ ] SDK test: `FilePreviewArgs` narrows on `"skill"`; validation unchanged.
- [ ] Kernel tests: the fake provider is listed for a skill file it accepts (by extension / type, size ≤ maxBytes) and not otherwise; a view render reads exactly that object (`read()` bytes equal the file) and the grant is unusable after the call; disabled previewer not listed; embed token issued for a taking previewer with `skillFile` claims, refused (403/404 as the conversation case) otherwise; all four routes 404 for an off platform skill and another org's skill (Review Focus 2).
- [ ] `pnpm gen:sdk-api`; changeset `@capybara-hq/plugin-sdk` minor-in-prerelease per repo convention (look at recent changesets); skills docs updated.
- [ ] Commit `feat: file previewers take skill files`.

### Task 4: Web skill source and the 文件 tab

**Files:** `apps/web/src/lib/skills.ts` (files list type + loaders), `apps/web/src/lib/file-source.ts`, `apps/web/src/lib/previewers.ts`, `apps/web/src/lib/query/skills.ts` (`skillFilesQuery`), `apps/web/src/components/file-preview/FilePreviewBody.tsx` and its embed host, `apps/web/src/lib/ui.ts` (embed token body), `apps/web/src/app/(app)/skills/[id]/view.tsx`, route prefetch in `apps/web/src/lib/query/routes.ts`, messages `skills.detail.*`; tests `apps/web/test/skills.test.tsx` ("技能详情（DetailPage）"), `apps/web/test/file-preview-body.test.tsx`, `apps/web/test/file-source.test.ts`.

**Interfaces — consumes:** Tasks 1–3 routes and `FileTree` / `FileBrowser`.
- [ ] `FileSource` gains `{ kind: "skill"; orgId; skillId; version; file: { path; name; contentType; size; previewable } }`; `sourceUrls` → content `…/files/content?version&path`, inline (`&inline=1`), text (`&limit=`), no html; `sourceFile` maps it.
- [ ] `FilePreviewBody`: previewers for a skill source from the Task 3 list route; view render from the preview route; embed token with `{ skillId, version, path }`; HTML → Source only (Review Focus 5).
- [ ] 文件 tab: `FileBrowser` + `FileTree` over `skillFilesQuery`, SKILL.md selected by default, `?file=` and `?version=` in the address (replace, not push, on selection); the 版本 tab rows get 查看文件 (opens the tab at that version); loading and error states per the DetailPage template.
- [ ] Tests: default selection SKILL.md through the Markdown built-in; a nested `scripts/x.sh` through the text built-in; an extension previewer listed and chosen; a binary file shows the card with 下载; `?file=` deep link; version switch; compact pushes the preview; sha 409 shows the failure card (Review Focus 3); 1 MiB truncation note (Review Focus 4).
- [ ] Commit `feat(web): browse a skill's files with the shared preview`.

### Finish

- [ ] Changesets (`@capybara-hq/capybara` patch for kernel + web; the SDK one from Task 3); `pnpm verify --fast`; kernel http tests touched (`pnpm exec vitest run packages/kernel/test/skills/skill-files.http.test.ts packages/kernel/test/files/previewers.http.test.ts`); all web tests; english comments; PR; visual-update; reopen to run CI.
