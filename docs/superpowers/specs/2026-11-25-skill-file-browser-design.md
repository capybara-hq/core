# Skill files: a file tree with a preview, through the file preview contract

Status: approved 2026-11-25. The maintainer asked for "the zip previewer kind of preview" of
a skill's files without depending on a plugin, both steps in one go (2026-11-25).

## Why

A skill's 文件 tab (`/skills/[id]`) is a table of paths and sizes; nothing opens. A skill is code and
instructions people want to read before they switch it on or debug it. The official file preview
plugin's archive previewer shows the look people want (a tree on the left, the file on the right),
but tying a core page to a plugin is wrong. The web already has one preview body for conversation
files and shares: built-in previewers (image, text, Markdown, CSV / TSV) with no plugin, and
`file-preview@1` previewers on top when an org has them. A skill file becomes one more source of that
body.

## Goals

1. The 文件 tab is a file tree with a preview pane: the tree lists the version's files (folders
   collapsible, sizes muted), SKILL.md selected first; the pane is the shared `FilePreviewBody`.
2. With no plugin at all, every text file (md, py, sh, js, json, yaml, txt, …) and every raster image
   previews through the built-ins; a binary file shows the file card with 下载.
3. Step two in the same change: `file-preview@1` previewers also take skill files, so an org with the
   file preview plugin gets code highlighting and its other previewers in the same pane, with the
   same order and switch as the conversation panel.
4. A version can be browsed: the tab shows the current version; a row of the 版本 tab opens the 文件
   tab at that version.

## Non-goals

- The platform skill page (`/admin/skills/[id]`, versions and orgs only today) and the skills inside
  a plugin review: they can mount the same browser later; this change builds the component and the
  org route only.
- Rendering HTML from a skill: an HTML file shows as Source (text), never rendered (AGENTS.md: HTML
  is served only by the sandboxed HTML pipeline; skills don't get one here).
- Editing skill files.

## Anti-goals

- A plugin dependency: the tab works fully with no extension enabled.
- A second preview stack: no skill-only previewers in the web; the same body, the same built-ins.
- A storage key or object URL reaching an extension (the file preview contract's rule). The browser
  may get a short-lived presigned download URL, as conversation files do (ruling R3).

## Data

Skill files are separate objects (`kernel/<orgId>/<prefix><path>` for org skills, the deployment
store with `platform:<prefix>` for platform skills; `skillFileStore` resolves both). The version
manifest (`SkillManifest.files`: path, size, sha256) is the only list. Platform skills reach an org
through the org route while they are on in it (`getPlatform`), so one org route serves both.

## Kernel

All under the existing org skill controller, `@OrgAction("skills.read")` (member and up, human users),
visibility exactly as `GET /skills/:id` (an org's own skill, or a platform skill on in the org):

- `GET /api/v1/orgs/:orgId/skills/:id/files?version=` → `{ version, files: { path, size,
  contentType, previewable }[] }` (version defaults to the current one; `contentType` from the
  extension through the kernel's existing type lookup; `previewable` with the same rule as
  conversation files: text and raster images within the preview limits). Added to the detail's
  versions too only if the builder finds it cheaper; the route is the contract.
- `GET /api/v1/orgs/:orgId/skills/:id/files/content?version=&path=&limit=` → the bytes. `path` must be
  a path of that version's manifest (no other key is ever built from input); the sha256 is checked
  against the manifest (as the Skill tool does) and a mismatch is 409 `skill.file_changed`. Headers:
  `X-Content-Type-Options: nosniff`, `Content-Disposition: attachment` unless `inline=1` is asked for a
  raster image type (png, jpeg, gif, webp), and never inline for HTML or SVG; `limit` returns at most
  that many bytes with `x-content-truncated` (the text built-ins' 1 MiB, as for conversation files).
  `as=url` (ruling R3, for a native shell's Download, whose system browser has no session) answers
  `{ url }` with `cache-control: private, no-store` instead of the bytes: the sha256 check first
  (the whole object read and hashed, nothing kept; 409 `skill.file_changed`), then a presigned GET
  of that file's own object, always `attachment` (`inline` is ignored), its type `text/plain` for
  text and `application/octet-stream` otherwise (never `text/html` or `image/svg+xml`), named by the
  last path segment, valid for the artifact download TTL (300 s). `as=url` with `limit` is 400.
- Errors: unknown version or path → 404 `skill.file_not_found`; registered error codes; route schemas
  in `SKILL_ROUTES`; the Platform tool gets operations for both routes (or exclusions with reasons),
  per the platform tool rule.

### file-preview@1 for skill files (step two)

- SDK: `FilePreviewArgs` gains `FilePreviewSkillArgs { source: "skill"; orgId; accountId; skillId;
  version: number; path }` (`file.id` is `<skillId>@<version>/<path>`). Public API change: `pnpm
  gen:sdk-api` plus a changeset bumping `@capybara-hq/plugin-sdk`; the extension point doc
  (`agent-docs/extension-points/file-preview.md`) says the new source.
- Kernel: `PreviewerRegistry` gets `forSkillFile` and `renderSkill` (the read grant reads that one
  object for the call only, capped at the previewer's `maxBytes`), with routes
  `GET …/skills/:id/files/previewers?version=&path=` and
  `GET …/skills/:id/files/previews/:plugin/:previewerId?version=&path=&locale=`, the same timeouts and
  error codes as the conversation routes. An HTML or SVG file (source only) gets no previewer: the
  list, the render and the embed token all refuse it with 404 `ui.not_found`, as the share routes
  refuse HTML.
- Embed previewers: the org embed-token route accepts `{ skillId, version, path }`; the kernel issues a
  token only when an enabled previewer of that extension takes that file, and the claims carry the
  file reference (`OrgEmbedClaims.skillFile`). The web posts the bytes through the bridge as today.
- The official file preview plugin needs no change: it never branches on `source` and matches by
  type. Its tests in the plugins repo are unaffected.

## Web

- Design: `FileTree` (or `FileBrowser`): a tree of paths with folders, the selected row, sizes muted,
  keyboard navigation (arrow keys, Enter), and beside it a slot for the preview; at compact the tree is
  the page and choosing a file pushes the preview (the design's pushed-page pattern). Spec entry, tests,
  reference states per the design package's change flow.
- `FileSource` gains `{ kind: "skill"; orgId; skillId; version; file }`; `sourceUrls` and
  `sourceFile` cover it; `FilePreviewBody` lists previewers for it through the new route and renders
  view and embed previewers as for a conversation file; HTML files show Source only.
- `/skills/[id]` 文件 tab: the browser over `skillFilesQuery(orgId, skillId, version)`, SKILL.md
  selected by default, `?file=` and `?version=` in the address so a file can be linked; the 版本 tab's
  rows get 查看文件.

## Tests

- Kernel http: files list and content for an org skill and a platform skill on in the org; 404 for a
  path outside the manifest, an off platform skill, another org's skill; sha mismatch 409; truncation
  header; no inline for HTML / SVG; member can read, guest cannot.
- Kernel previewers: a fake provider takes a skill file (view and embed); the read grant is only that
  object; a disabled previewer is not listed; the embed token is refused for a file no enabled
  previewer takes.
- SDK: `FilePreviewArgs` narrows on `"skill"`.
- Web: the tree selects SKILL.md, opens a nested file, shows text through the built-in with no
  previewers, an extension previewer when listed, the card for a binary file; `?file=` deep link;
  version switch from the 版本 tab; compact pushes the preview.

## Rulings

- **R3 (2026-11-25, amended by the final review)**: a native shell's Download on a skill file uses
  the content route's `as=url` form, the same model as conversation files' `as=url`: the browser
  gets a short-lived presigned attachment URL of that one object (it embeds the object key, as
  conversation downloads already do); no storage key or URL ever reaches an extension. No fallback
  for a store without presigning: `presignGet` is required by `object-store@1`. Cost: one full read
  and hash per shell download.

## AGENTS.md rules touched

None change. The work falls under the existing rules: Extension UI (embed tokens never valid for
`/api`), File sharing's HTML rule (HTML not rendered here), Public API reports (SDK change: `pnpm
gen:sdk-api` plus a changeset), Platform tool (operations or exclusions for the new routes). The
writing-extension-ui skill's "File previewers" section and the writing-tools skill's "Skill tools"
section get the new source and routes.
