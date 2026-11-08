# Setup Guides v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task, layered with
> `wave-planned-subagent-development` (the wave table below). Steps use checkbox (`- [ ]`) syntax
> for tracking.

**Goal:** Replace v1's fixed steps-and-files setup guides with dynamic Markdown guides shown on
channel connections and connector templates, with live checks run by the plugin's extension or the
kernel, agent-assisted setup through the `Platform` tool, and a client-side token paste warning;
then migrate the Slack plugin.

**Architecture:** The SDK owns the document format (parser, validator, renderer, content hash,
place registry) as pure functions used by the toolchain, the kernel and plugin tests. The kernel
renders per org and target (`PluginGuides`), records acks and drift on channel connections and
connectors, runs checks through a request-scoped runner with Redis cache, single flight, cooldown
and redaction (`SetupChecks`), and mirrors the routes as `Platform` operations. The web composes
design components (`GuideDocument`, `CheckRow`) in one `SetupGuideSection`.

**Tech Stack:** TypeScript, pnpm monorepo, NestJS + Fastify + Kysely (PG), Redis (ioredis),
BullMQ (not used here), zod 4, mdast (`mdast-util-from-markdown` 2.1.0, `mdast-util-gfm`,
`micromark-extension-gfm` 3.0.0, `mdast-util-to-markdown`), Next + TanStack Query, vitest.

**Spec:** `docs/superpowers/specs/2026-11-09-setup-guides-v2-design.md` (read it in full; section
numbers below refer to it). v1 for context: `docs/superpowers/specs/2026-11-08-plugin-setup-guides-design.md`.

## Global Constraints

- English for code, comments, identifiers, commit messages, model-visible text; UI text through
  i18n zh and en; zh UI says 平台 / 超级管理员 / 智能体, never 企业 or `agent` (`pnpm check:i18n`).
- Pre-0.1.0: change formats directly, no compatibility layer. Applied migrations are immutable;
  the new one is the next free number (`0102_setup_guides_v2.sql` at time of writing).
- Kernel: `@Injectable` providers, explicit `@Inject` on every constructor parameter, DTOs via
  `createZodDto`, writes in `@Transactional()` methods, Redis calls never inside a transaction
  (`pnpm check:kernel-conventions`).
- Multi-replica: no in-process state, no timers; every Redis key has a TTL; Redis keys prefixed
  `capk:`.
- Every new HTTP route gets a `Platform` operation or an exclusion with a reason (never `later`)
  (`pnpm check:platform-ops`, `platform-parity.test.ts`).
- SDK public API changes: `pnpm gen:sdk-api` plus a changeset bumping `@capybara-hq/plugin-sdk`.
  Changes to published packages carry a changeset (`pnpm changeset`).
- Web: pages from `@capybara-hq/design` only, no styles in apps/web, reads via `defineQuery`,
  writes via `useAppMutation`, never a box inside a box (`pnpm check:web-ui`).
- Limits (spec §4.4): 8 guides per plugin; 64 KiB per document; 24 code blocks; 16 check lines;
  16 sections; title / heading 100, check label 80, fence title 100 characters; depth 16; no
  U+E000–U+E0FF in source.
- Check limits (spec §10.5): 10 s per run; 8 concurrent runs per org; force once per 10 s per
  check and target; fresh 5 min with the same fingerprint; 30 runs per minute per account; reason
  300 / fix 500 characters per language.
- Drift hash covers code blocks and check lines only (spec §11, decided).
- Plugin checks never receive an OAuth client secret or member tokens (spec §10.2, decided).
- Run single tests from the repo root: `pnpm exec vitest run <path>`.
- Commits: Conventional Commits, body lines ≤ 100, identity
  `git -c user.name=Grant -c user.email=284885069@qq.com commit`, ending
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **A connection or org name holding Markdown, backticks, quotes, newlines or `{{other}}`** must
   render as literal text in prose, inline code and YAML; the pasted YAML must parse back to the
   exact name. Test: Task 1 `escapes hostile values in every context`.
2. **A guide viewed by a member of another org, or for another org's connection or connector id**,
   must 404, not render. Tests: Task 4 `refuses another org's connection`, Task 6
   `refuses another org's connector`.
3. **Two people opening the same channel page at once on two replicas** must cause one
   third-party call, not two. Test: Task 10 dual-replica `single flight`.
4. **A check whose reason echoes the bot token** must reach the browser, Redis and logs as
   `[REDACTED]`. Test: Task 10 `redacts target secrets from results, cache and logs`.
5. **Pasting a commit hash, a UUID or a long URL into the composer** must not warn; pasting
   `xoxb-…` must. Test: Task 15 `findTokenLikeSpans non-matches`.

---

## Wave plan

| Task | Depends on (interfaces) | Files / areas | Risk | Wave | Review |
|---|---|---|---|---|---|
| 1 SDK document format | — | `packages/plugin-sdk/src/setup-guide*.ts`, `plugin-manifest.ts` | high (sanitizer, active content) | 1 | alone, most capable |
| 2 Design `GuideDocument` / `CheckRow` | — | `packages/design/src/display/*`, design spec | normal | 1 | batch |
| 3 Toolchain pack / check / guide | 1 | `packages/plugin-tools/src/pack`, `check/plugin-pack.ts`, `cli.ts` | normal | 2 | batch |
| 4 Kernel rendering, channel place, import, admin route | 1 | `packages/kernel/src/extensions/plugin-guides.ts`, `guide-places.ts`, catalog controllers, channels service | high (cross-tenant visibility) | 2 | alone, most capable |
| 5 Web `SetupGuideSection` on channel pages | 2, 4 (route shape) | `apps/web/src/components/SetupGuide*.tsx`, channel pages, `lib/setup-guides.ts`, messages | normal | 2 | batch |
| 6 Kernel connector place, migration, connector ack | 4 | migration, `kernel-schema.ts`, `tools/connectors.*`, `catalog/org-catalog.service.ts` | high (migration, cross-tenant) | 3 | alone, most capable |
| 7 SDK checks contract | 1 | `packages/plugin-sdk/src/setup-check.ts`, `ctx.ts`, `permissions.ts`, `define-extension.ts` | high (trust boundary) | 3 | alone, most capable |
| 8 Static check `perm-setup-check` | 7 (manifest key) | `packages/plugin-tools/src/check/plugin-permissions.ts`, fixtures, `tools/checks/README.md` | normal | 3 | batch |
| 9 Web connector places | 2, 5, 6 | wizard, connector detail, account connections, admin template page, messages | normal | 4 | batch |
| 10 Kernel check runner and routes | 6, 7 | `packages/kernel/src/setup/*`, `ctx/create-ctx.ts`, throttlers, testing fixture | high (trust boundary, multi-replica) | 4 | alone, most capable |
| 11 Kernel `capybara:*` checks incl. token endpoint probe | 10 | `packages/kernel/src/setup/kernel-checks*.ts`, `channels/webhook.ts` | high (secret use, egress) | 5 | alone, most capable |
| 12 Web live check rows | 2, 10 | `apps/web/src/components/SetupGuideSection.tsx`, `lib/query/setup.ts`, messages | normal | 5 | batch |
| 13 Platform `setup` domain and list route | 10, 11 | `packages/kernel/src/platform/ops/setup.ops.ts`, `operation.ts`, `exclusions.ts`, `setup/setup-guides.controller.ts`, agent doc | normal | 6 | batch |
| 14 Ask-an-agent entry | 12 | `SetupGuideSection.tsx`, messages | normal | 6 | batch |
| 15 Composer token paste warning | — (wave 6 for messages ownership) | `packages/design/src/conversation/token-like.ts`, `composer.tsx`, design i18n, design spec | normal | 7 | batch |
| 16 Docs and skills | 1–15 | `.agents/skills/*`, v1 spec header, `docs/architecture.md` if touched | normal | 7 | batch |
| 17 Visual baselines and full verify | 1–16 | baselines via `visual-update` | normal | 8 | batch |
| 18 Core release gate | 17 merged | changesets, release workflow (maintainer) | normal | 9 | — |
| 19 Slack plugin migration (`capybara-hq/plugins`) | 18 published | `plugins/slack/*` | normal | 10 | batch |

Wave notes:

- Messages files `apps/web/messages/{zh,en}.json` are owned by one task per wave: Task 5 (wave 2),
  Task 9 (wave 4), Task 12 (wave 5), Task 14 (wave 6). Design `packages/design/src/i18n.ts` is
  owned by Task 2 (wave 1) and Task 15 (wave 7). `packages/plugin-sdk/api/plugin-sdk.api.md` is
  regenerated by Task 1 (wave 1) and Task 7 (wave 3). `exclusions.ts` by Task 4 (wave 2), Task 6
  (wave 3), Task 10 (wave 4), Task 13 (wave 6).
- **Wave 3's Task 7 and waves 4–5's Tasks 10 and 11 are the checks contract: each is reviewed on
  its own by the most capable model as a trust-boundary change** (spec §17), with the security
  checklist in each task.
- Task 18 is a maintainer action (merge, release PR, publish); Task 19 starts only once
  `@capybara-hq/plugin-sdk`, `@capybara-hq/plugin-tools` and `@capybara-hq/testing` with v2 are on
  npm.

---

## Wave 1

### Task 1: SDK document format (parser, validator, renderer, hash, places)

**Files:**
- Modify: `packages/plugin-sdk/src/setup-guide.ts` (replace v1 contents: places, limits, types,
  `setupGuideDocPath`, `setupGuideDocProblem`, `validateSetupGuide`, `setupGuideHash`)
- Create: `packages/plugin-sdk/src/setup-guide-parse.ts` (line scanner: title, sections, check
  lines, fence tracking; `parseSetupGuide`)
- Create: `packages/plugin-sdk/src/setup-guide-render.ts` (sentinels, mdast, escaping, sanitizing,
  blocks; `renderSetupGuide`)
- Modify: `packages/plugin-sdk/src/plugin-manifest.ts` (the `setupGuides` zod schema and
  superRefine, ~lines 154–157 and 349–410)
- Modify: `packages/plugin-sdk/src/index.ts`, `packages/plugin-sdk/package.json` (deps),
  `packages/plugin-sdk/api/plugin-sdk.api.md` (generated), JSON Schema output
  (`plugin.v1.schema.json`, generated)
- Create: `.changeset/setup-guides-v2-sdk-format.md` (minor bump `@capybara-hq/plugin-sdk`)
- Test: `packages/plugin-sdk/test/setup-guide.test.ts` (rewrite),
  `packages/plugin-sdk/test/setup-guide-render.test.ts`,
  `packages/plugin-sdk/test/plugin-manifest.test.ts` (setupGuides cases)

**Interfaces:**
- Produces (exported from `@capybara-hq/plugin-sdk`):
  ```ts
  export const SETUP_GUIDE_PLACES = ["channel-connection", "connector-template"] as const;
  export type SetupGuidePlace = (typeof SETUP_GUIDE_PLACES)[number];
  export type SetupGuideAudience = "admin" | "member";
  export type SetupGuideVariableType = "url" | "text" | "token";
  export interface SetupGuidePlaceInfo {
    modes: readonly string[];
    audiences: readonly SetupGuideAudience[];
    variables: Readonly<Record<string, SetupGuideVariableType>>;
    drift: boolean;
  }
  export const SETUP_GUIDE_PLACE_INFO: Readonly<Record<SetupGuidePlace, SetupGuidePlaceInfo>>;
  export const SETUP_GUIDE_LIMITS: { guides: 8; docBytes: 65536; codeBlocks: 24; checks: 16;
    sections: 16; titleChars: 100; checkLabelChars: 80; fenceTitleChars: 100; depth: 16 };
  export interface PluginSetupGuide { id: string; place: SetupGuidePlace; template?: string }
  export function setupGuideDocPath(id: string, locale: "en" | "zh"): string; // "guides/<id>.md" | "guides/<id>.zh.md"
  export function setupGuideDocProblem(path: string, data: Uint8Array | undefined): string | undefined;
  export interface SetupGuideIssue { level: "error" | "warning"; message: string }
  export function validateSetupGuide(input: { place: SetupGuidePlace; en: string; zh?: string;
    pluginChecks?: readonly string[] }): SetupGuideIssue[];
  export type SetupGuideBlock =
    | { kind: "markdown"; text: string }
    | { kind: "code"; language: string; title: string | null; text: string }
    | { kind: "check"; id: string; label: string };
  export interface RenderedSetupGuideDoc {
    title: string; modes: string[]; audiences: SetupGuideAudience[];
    blocks: SetupGuideBlock[];
    checks: { id: string; label: string; source: "plugin" | "kernel" }[];
    unresolved: string[];   // known variables without a value, in place order
  }
  export function renderSetupGuide(source: string, input: { place: SetupGuidePlace;
    mode: string | null; audience: SetupGuideAudience;
    values: Readonly<Record<string, string | null | undefined>> }): RenderedSetupGuideDoc;
  export function setupGuideHash(enSource: string, input: { place: SetupGuidePlace;
    guideId: string; mode: string | null; audience: SetupGuideAudience }): string; // sha256 hex
  ```
- Place info values: `channel-connection` = modes `["long_connection","webhook"]`, audiences
  `["admin"]`, variables `publicUrl:url, orgName:text, pluginName:token, pluginVersion:token,
  mode:token, webhookUrl:url, signInCallbackUrl:url, connectionName:text`, drift true;
  `connector-template` = modes `[]`, audiences `["admin","member"]`, variables common +
  `oauthCallbackUrl:url, signInCallbackUrl:url, templateId:token, templateName:text,
  connectorName:text`, drift true.

- [ ] **Step 1: Write the failing parser and validator tests** in `setup-guide.test.ts`:
  - `requires one leading level-1 heading` (missing → error "must start with a level-1 heading";
    a second `#` → error).
  - `parses mode and audience sections` (`::: audience admin` containing `::: mode webhook` is
    accepted; `::: mode x` inside `::: mode y` → error "sections do not nest"; unknown mode for the
    place → error naming the allowed modes; unclosed section → error).
  - `ignores directive lines inside fenced code` (a ```` ``` ```` block containing `::check a b`
    and `:::` parses as code).
  - `parses check lines` (`::check bot-token Bot token works` → id + label; `::check capybara:public-url
    Public URL` → source kernel; bad id / label > 80 → error).
  - `refuses indented code and private-use characters`.
  - `checks language parity`: zh with a different code block → error exactly
    `guides/<id>.zh.md: code block 2 ("<title>") differs from guides/<id>.md block 2 at line 14;
    code blocks must be identical in every language` (the test builds the inputs so block 2 differs
    at its line 14); different sections or check ids → error.
  - `refuses variables the place does not define` (error), `in fence info strings, directive lines,
    link titles` (error), `a text variable in a non-yaml/json fence` (warning).
  - `refuses check ids missing from pluginChecks` when `pluginChecks` is given.
  - `limits` for each entry of `SETUP_GUIDE_LIMITS`.

- [ ] **Step 2: Write the failing render and hash tests** in `setup-guide-render.test.ts`:
  - `selects sections by mode and audience` (webhook render excludes long_connection text and its
    checks; text outside sections always present; `modes`/`audiences` list what the doc uses).
  - `escapes hostile values in every context` (table-driven, value
    ``x`y"z\n[a](javascript:alert(1)) <script>{{orgName}}`` as `connectionName` in: a paragraph
    (rendered markdown, when parsed again with mdast, has a single text node equal to the value
    with the newline as a space and no link node), inline code (one inlineCode node, newline as
    space), a `yaml` fence inside double quotes (`yaml.parse` of the block gives the exact value),
    a `json` fence (`JSON.parse` gives it), a `sh` fence (no newline in the inserted part)).
  - `link policy` (author `https://` kept; author `http://`, `mailto:`, `./README.md`,
    `javascript:` become text; `[x]({{publicUrl}})` with `http://localhost:3000` kept; a text
    variable in a destination stays literal).
  - `raw HTML renders as text` (`<b>x</b>` appears as escaped text in the markdown block) and
    `images become links or alt text`.
  - `splits blocks` (code fence with `title="App manifest"` → code block with title; check line →
    check block; prose between → one markdown block).
  - `leaves unknown and unresolved variables as written` (`{{appSecret}}` literal, not listed;
    `{{webhookUrl}}` with null value literal and listed in `unresolved`).
  - `is deterministic` (two renders byte-equal).
  - `hash covers code blocks and check lines only`: equal after prose edit, heading edit, check
    label edit, connection rename (values not part of input); different after a code line change,
    a block added, a check added or removed; different per mode and per audience.

- [ ] **Step 3: Run tests to verify they fail**
  Run: `pnpm exec vitest run packages/plugin-sdk/test/setup-guide.test.ts packages/plugin-sdk/test/setup-guide-render.test.ts`
  Expected: FAIL (exports missing).

- [ ] **Step 4: Implement** `setup-guide-parse.ts`, `setup-guide-render.ts`, `setup-guide.ts` per
  spec §4.2–§4.5, §6, §7.1, §11. Add deps to `packages/plugin-sdk/package.json` at the versions
  `packages/design/package.json` pins, plus `mdast-util-to-markdown` (same major line as
  `mdast-util-from-markdown` 2). Render algorithm (spec §6.1): scanner selects sections and turns
  check lines into marker paragraphs `<n>`; known `{{name}}` → `<n>`;
  parse with gfm; walk and substitute per node type (table in spec §6.2); sanitize (spec §7.1);
  cut blocks; serialize markdown blocks with `toMarkdown(…, { extensions: [gfmToMarkdown()] })`.
  Hash: sha256 over `"capybara-guide-v2\0" + place + "\0" + guideId + "\0" + (mode ?? "") + "\0" +
  audience + "\0"` then per item `"code\0" + lang + "\0" + text + "\0"` or `"check\0" + id + "\0"`,
  LF-normalized, variables unsubstituted (`node:crypto`, as `skill.ts`).

- [ ] **Step 5: Manifest schema**: `setupGuides` items are `{ id, place, template? }`;
  superRefine: unique id, `template` required iff place is `connector-template` and must name one
  of `connectorTemplates`, at most one guide per template and one `channel-connection` guide.
  Update `plugin-manifest.test.ts` (`setupGuides v2 shape`, `template must name a connector
  template`, `one channel guide per plugin`).

- [ ] **Step 6: Run tests to verify they pass**
  Run: `pnpm exec vitest run packages/plugin-sdk`
  Expected: PASS.

- [ ] **Step 7: Generate API and schema, typecheck**
  Run: `pnpm gen:sdk-api && pnpm --filter @capybara-hq/plugin-sdk build && pnpm typecheck`
  Expected: api.md updated; the SDK and design typecheck. The v1 consumers (`plugin-guides.ts`,
  `pack.ts`, `connections.service.ts`, `apps/web/src/components/SetupGuide.tsx`) fail to compile
  until wave 2 rewrites them; the branch is green again at the end of wave 2, which is the first
  point a full `pnpm verify` is expected to pass.

- [ ] **Step 8: Commit** (`feat(plugin-sdk): markdown setup guide format`), with the changeset.

### Task 2: Design `GuideDocument` and `CheckRow`

**Files:**
- Create: `packages/design/src/display/guide-document.tsx`, `packages/design/src/display/check-row.tsx`
- Modify: `packages/design/src/display/index.ts`, `packages/design/src/index.ts`,
  `packages/design/src/styles/display.css`, `packages/design/src/i18n.ts`
- Modify: `docs/design/spec.md` (§6.9 CodeBlock note, new entries for GuideDocument and CheckRow)
- Modify: `apps/web/src/app/dev/ui/[[...slug]]/page.tsx` fixtures (or the fixtures module it reads
  in `packages/design/src/fixtures`)
- Test: `packages/design/test/guide-document.test.tsx`, `packages/design/test/check-row.test.tsx`

**Interfaces:**
- Produces:
  ```ts
  export type GuideBlock = { kind: "markdown"; text: string }
    | { kind: "code"; language: string; title: string | null; text: string }
    | { kind: "check"; id: string; label: string };
  export type CheckRowState = {
    status: "ok" | "failing" | "unknown" | "running" | "not_run" | "static";
    reason?: string; fix?: string; checkedAt?: string; cooldownUntil?: string;
  };
  export function GuideDocument(props: { blocks: GuideBlock[];
    renderCheck?: (block: { id: string; label: string }) => ReactNode }): JSX.Element;
  export function CheckRow(props: { label: string; state: CheckRowState;
    onRecheck?: () => void; staticNote?: string }): JSX.Element;
  ```
  (Design depends on no `@capybara-hq/*`: the block type is structurally equal to the SDK's.)

- [ ] **Step 1: Write failing tests**: `GuideDocument renders markdown, copyable titled code and
  checks in order`; `default check rendering is a static CheckRow`; `findNestedBoxes reports none
  inside a Card`; `CheckRow shows icon, label, reason, fix per status`; `Re-check disabled until
  cooldownUntil`; `running shows a spinner and no button`; `static shows staticNote` (e.g.
  「保存后检查」).
- [ ] **Step 2: Run** `pnpm exec vitest run packages/design/test/guide-document.test.tsx packages/design/test/check-row.test.tsx` → FAIL.
- [ ] **Step 3: Implement** with existing `Markdown`, `CodeBlock` (`title`, `copyable`), `Icon`,
  `Button`; strings 重新检查 / Re-check, 检查中 / Checking, status labels, relative checked-at, in
  design i18n. No box (one-box rule).
- [ ] **Step 4: Spec and fixtures**: design spec entries; `/dev/ui` fixture showing all states.
- [ ] **Step 5: Run** `pnpm exec vitest run packages/design && pnpm check:web-ui` → PASS.
- [ ] **Step 6: Commit** (`feat(design): guide document and check row`) with a changeset if
  `@capybara-hq/design` is published.

---

## Wave 2

### Task 3: Toolchain: pack, check and `capybara-plugin guide`

**Files:**
- Modify: `packages/plugin-tools/src/pack/pack.ts` (~lines 34–36, 231–232, 439–465: v1 file logic
  → v2 documents)
- Modify: `packages/plugin-tools/src/check/plugin-pack.ts`
- Create: `packages/plugin-tools/src/guide/cli.ts`; Modify: `packages/plugin-tools/src/cli.ts`
- Modify: `packages/plugin-tools/README.md` (the `guide` command)
- Test: `packages/plugin-tools/test/pack-guides.test.ts`, `packages/plugin-tools/test/guide-cli.test.ts`,
  fixtures under `packages/plugin-tools/test/fixtures/guides-*`
- Create: `.changeset/setup-guides-v2-plugin-tools.md`

**Interfaces:**
- Consumes: Task 1 `validateSetupGuide`, `setupGuideDocPath`, `setupGuideDocProblem`,
  `renderSetupGuide`.
- Produces: CLI `capybara-plugin guide <id> [--locale zh] [--mode m] [--audience a]
  [--var name=value]…` printing the title, then each block (`markdown` as is, `code` fenced with
  its title, `check` as `[check <id>] <label>`), then `unresolved: …`; exit 1 with the issues on an
  invalid guide.

- [ ] **Step 1: Failing tests**: `pack ships guides/<id>.md and .zh.md`; `pack fails on a missing
  English document`; `pack fails on zh code block drift with the exact message`; `pack fails on an
  unknown variable`; `pack warns on a text variable in a sh fence`; `pack fails when a check id is
  not in permissions.setupChecks` (read from the extension manifest when present; skipped for
  plugins without an extension, which may only use `capybara:` checks: `fails on a plugin check
  without an extension`); `guide prints rendered blocks with --var`.
- [ ] **Step 2: Run** `pnpm exec vitest run packages/plugin-tools/test/pack-guides.test.ts packages/plugin-tools/test/guide-cli.test.ts` → FAIL.
- [ ] **Step 3: Implement** pack and check over `validateSetupGuide` (errors fail, warnings
  printed); the `guide` command.
  **Decided (designer's call, 2026-11-09):** validator warnings (e.g. a text variable outside
  quotes in a yaml / json block, or in an unquoted fence) are printed by `capybara-plugin pack`
  (`PackResult.warnings`) and `check` (rule `plugin-pack-guide`, severity warning) and fail
  neither; errors fail both. The fake-im fixture's v1 guide becomes `guides/fake-im-app.md` +
  `.zh.md` in this task (its packing test lives here).
- [ ] **Step 4: Run** `pnpm exec vitest run packages/plugin-tools && pnpm check:plugin-pack` → PASS.
- [ ] **Step 5: Commit** (`feat(plugin-tools): pack, check and preview markdown guides`).

### Task 4: Kernel rendering, channel place, import validation, admin template route

**Files:**
- Modify: `packages/kernel/src/extensions/plugin-guides.ts` (rewrite render, acks, refs)
- Create: `packages/kernel/src/extensions/guide-places.ts` (per-place value resolvers, target
  lookups, unresolved reasons, place actions)
- Modify: `packages/kernel/src/catalog/org-catalog.controller.ts`, `org-catalog.schemas.ts`
  (`CatalogGuideQuery`: `mode`, `audience`, `locale`, `connectionId`, `name`, `connectorId`)
- Modify: `packages/kernel/src/catalog/admin-catalog.controller.ts`, `admin-catalog.schemas.ts`
  (new `GET api/v1/admin/catalog/:itemId/guides/:guideId`)
- Modify: `packages/kernel/src/catalog/plugin-package.ts` (or wherever `readPluginFiles` validates
  v1 guide files; grep `setupGuideFileProblem`) to read and validate v2 documents
- Modify: `packages/kernel/src/channels/connections.service.ts` (~lines 484–618, 712–765:
  `currentAck(plugin, "channel-connection", { mode })`)
- Modify: `packages/kernel/src/db/kernel-schema.ts` (`GuideAckJson.mode: string | null`)
- Modify: `packages/kernel/src/platform/exclusions.ts` (add the admin guide route, category
  `internal`, reason per spec §12)
- Test: `packages/kernel/test/catalog/guides.http.test.ts` (new),
  `packages/kernel/test/channels/connections.http.test.ts` (guide cases updated),
  `packages/kernel/test/catalog/import-guides.test.ts` (new)
- Fixture: a test plugin package with `guides/demo.md` + `guides/demo.zh.md` in
  `packages/kernel/test/fixtures/plugins/guide-demo/` (channel guide with both modes, a code block,
  a check line).

**Interfaces:**
- Consumes: Task 1 exports.
- Produces:
  ```ts
  export type UnresolvedReason = "not_saved" | "public_url" | "webhook_base" | "no_connector" | "no_org";
  export interface RenderedSetupGuide {          // spec §7.2
    itemId: string; plugin: string; version: string; id: string; place: SetupGuidePlace;
    locale: "en" | "zh"; title: string; modes: string[]; mode: string | null;
    audiences: SetupGuideAudience[]; audience: SetupGuideAudience;
    blocks: SetupGuideBlock[];
    checks: { id: string; label: string; source: "plugin" | "kernel" }[];
    unresolved: { name: string; reason: UnresolvedReason }[];
    hash: string;
    target: { kind: "channel-connection" | "connector"; id: string } | null;
  }
  export type GuideAck = { guideId: string; version: string; hash: string; mode: string | null };
  class PluginGuides {
    render(org: { orgId: string; role: OrgRole }, itemId: string, guideId: string,
      q: GuideQuery): Promise<RenderedSetupGuide>;
    renderForPlatform(itemId: string, guideId: string, q: { locale?: "en" | "zh" }): Promise<RenderedSetupGuide>;
    currentAck(plugin: string, place: SetupGuidePlace,
      o: { mode: string | null; templateId?: string }): Promise<GuideAck | null>;
    ackDrifted(plugin: string, place: SetupGuidePlace, ack: GuideAck | null,
      o?: { templateId?: string }): Promise<boolean>;
    channelGuides(...)   // unchanged signature
    connectionStates(...) // unchanged signature
    /** The document source of a guide's latest version, for Task 10's check lookup. */
    loadDocument(itemId: string, guideId: string, locale: "en" | "zh"): Promise<{ row; guide: PluginSetupGuide; source: string; enSource: string }>;
  }
  type GuideQuery = { mode?: string; audience?: SetupGuideAudience; locale?: "en" | "zh";
    connectionId?: string; name?: string; connectorId?: string };
  ```
  `PLACE_ACTIONS: Record<SetupGuidePlace, Partial<Record<SetupGuideAudience, OrgAction>>>` =
  channel admin → `channels.manage`; connector admin → `connectors.manage`, member →
  `connectors.use`. The connector-template resolver (values, `connectorId` lookup via
  `connectors.platform_template_id`) is stubbed to "no connector" here; Task 6 fills it.

- [ ] **Step 1: Failing tests** (`guides.http.test.ts`, using the fixture plugin imported into the
  catalog):
  - `renders the channel guide for an org admin` (blocks, title from heading, modes, default mode
    from the connection's `inbound_mode`, hash equals `setupGuideHash` of the English source).
  - `renders zh and falls back to en`.
  - `refuses a member (403 forbidden)`, `refuses an org that cannot see the item (404
    catalog.item_not_found)`, `refuses another org's connection (404 channel.not_found)`,
    `rejects an unknown mode or audience (400 validation_failed)`.
  - `unresolved reasons`: no connection → `webhookUrl: not_saved`; no `http.publicUrl` →
    `signInCallbackUrl: public_url`; no webhook base with a connection → `webhook_base`.
  - `contains no secret` (connection with `botToken`/`signingSecret` set: neither value appears in
    the JSON).
  - `admin template guide`: super admin gets it with `orgName` unresolved (`no_org`) and
    `target: null`; an org admin gets 403 on the admin route.
  - `import-guides.test.ts`: `import refuses an invalid guide with catalog.invalid_manifest naming
    it`; `import accepts an unknown variable`; `a v1-shaped stored manifest renders no guide`.
  - `connections.http.test.ts`: the v1 ack matrix kept with v2 hashes (create records ack, mode
    switch re-baselines only without drift, a drifted ack survives switching modes there and back,
    ack route 409 on a stale hash).
- [ ] **Step 2: Run** `pnpm exec vitest run packages/kernel/test/catalog/guides.http.test.ts packages/kernel/test/catalog/import-guides.test.ts packages/kernel/test/channels/connections.http.test.ts` → FAIL.
- [ ] **Step 3: Implement** `guide-places.ts` and the `PluginGuides` rewrite (visibility via
  `orgVisibleItems` unchanged; document bytes via `readCatalogDisplayFiles`; a stored manifest entry
  that fails the v2 schema is skipped with one `warn` log per render); controller changes; admin
  route (`@SuperAdmin`, platform visibility: any live item); import validation; exclusion entry.
- [ ] **Step 4: Run** the three files plus `pnpm exec vitest run packages/kernel/test/platform` and
  `pnpm check:platform-ops` → PASS.
- [ ] **Step 5: Commit** (`feat(kernel): render markdown setup guides`).

### Task 5: Web `SetupGuideSection` on the channel pages

**Files:**
- Create: `apps/web/src/components/SetupGuideSection.tsx` (replaces `SetupGuide.tsx`'s
  `SetupGuideBody`; delete `SetupGuide.tsx`)
- Modify: `apps/web/src/lib/setup-guides.ts` (types mirror `RenderedSetupGuide`; query params),
  `apps/web/src/lib/query/channels.ts` (`setupGuideQuery` key gains `audience`, `locale`,
  `connectorId`)
- Modify: `apps/web/src/app/(app)/channels/new/view.tsx`, `apps/web/src/app/(app)/channels/[id]/view.tsx`
- Modify: `apps/web/messages/zh.json`, `apps/web/messages/en.json` (`setupGuide.*` namespace:
  unresolved reasons, 保存后检查, mode label; move the v1 `channels.guide.*` keys)
- Test: `apps/web/test/setup-guide-section.test.tsx` (replaces `channel-setup-guide.test.tsx`)

**Interfaces:**
- Consumes: Task 2 `GuideDocument`, `CheckRow`; Task 4 route and `RenderedSetupGuide`.
- Produces:
  ```tsx
  export function SetupGuideSection(props: {
    orgId: string;
    guide: { itemId: string; guideId: string };
    query: { connectionId?: string; name?: string; connectorId?: string;
             audience?: "admin" | "member" };
    drift?: { from: string; to: string; onAck: (hash: string) => Promise<void> } | null;
    /** Live check rows (Task 12); without it check rows are static. */
    checks?: "static" | "live";
    admin?: boolean; // platform route (Task 9)
  }): JSX.Element;
  ```

- [ ] **Step 1: Failing tests** (`renderRouteWithCache` helpers): `renders blocks with copy
  buttons`; `mode switch re-queries with mode`; `unresolved lines by reason` (zh 「保存后显示」,
  「需要超级管理员设置 http.publicUrl」); `drift callout and ack posts the shown hash`; `409
  guide_changed refetches and shows the new guide`; `check rows static with 保存后检查 on 新建渠道`.
- [ ] **Step 2: Run** `pnpm exec vitest run apps/web/test/setup-guide-section.test.tsx` → FAIL.
- [ ] **Step 3: Implement**; switch both channel pages; remove `SetupGuide.tsx` and its test.
- [ ] **Step 4: Run** `pnpm exec vitest run apps/web && pnpm check:web-ui && pnpm check:i18n` → PASS.
- [ ] **Step 5: Commit** (`feat(web): markdown setup guides on channel pages`).

---

## Wave 3

### Task 6: Kernel connector-template place, migration and connector ack

**Files:**
- Create: `packages/kernel/src/migrations/0102_setup_guides_v2.sql`
- Modify: `packages/kernel/src/db/kernel-schema.ts` (`ConnectorsTable.guide_ack`)
- Modify: `packages/kernel/src/extensions/guide-places.ts` (connector-template resolver and target
  lookup), `packages/kernel/src/extensions/plugin-guides.ts` (`connectorStates`, `templateGuides`)
- Modify: `packages/kernel/src/tools/connectors.service.ts`, `connectors.controller.ts`,
  `connectors.schemas.ts` (ack route, view fields, ack on create-from-template)
- Modify: `packages/kernel/src/catalog/org-catalog.service.ts` (template entries gain `guide`;
  ack recorded when `POST /orgs/:orgId/catalog/:itemId/connectors` or the install creates a
  connector from a template), `packages/kernel/src/catalog/plugin-install.ts` if the create path
  lives there
- Modify: `packages/kernel/src/catalog/plugin-upgrade.ts` (preview line "setup guide of template X
  changed", counts only)
- Modify: `packages/kernel/src/platform/exclusions.ts` (connector ack route, `human-only`)
- Test: `packages/kernel/test/tools/connector-guides.http.test.ts` (new),
  `packages/kernel/test/migrations/0102.test.ts` (or the existing migration test pattern),
  `packages/kernel/test/catalog/plugin-upgrade.test.ts` (preview case)

**Interfaces:**
- Consumes: Task 4 `PluginGuides`, `GuideAck`, place resolvers.
- Produces:
  - `POST /api/v1/orgs/:orgId/connectors/:connectorId/guide-ack { hash }` → `{ connector }`
    (`connectors.manage`; 409 `connector.guide_changed`; 404 `catalog.guide_not_found`; audit
    `connector.guide_confirmed` with `{ guideId, version }`). Register both error codes.
  - Connector view fields `setupGuide: { itemId; guideId; version } | null`,
    `guideDrift: { from: string; to: string } | null`.
  - Org catalog template entries and `connectors.templates` items gain
    `guide: { itemId: string; guideId: string } | null`.
  - `PluginGuides.connectorStates(connectors: { id; templateId: string | null; plugin: string | null;
    guideAck: GuideAck | null }[], org): Promise<Map<string, ConnectionGuideState>>`.
- Migration content:
  ```sql
  ALTER TABLE capybara.connectors ADD COLUMN IF NOT EXISTS guide_ack jsonb;
  UPDATE capybara.channel_connections SET guide_ack = NULL WHERE guide_ack IS NOT NULL;
  ```

- [ ] **Step 1: Failing tests**: `renders the connector guide for admin and member audiences`
  (member sees only the member section; `oauthCallbackUrl` = `<publicUrl>/api/v1/oauth/callback`;
  `templateName` localized; `connectorName` from the connector); `member gets 403 on admin
  audience`; `refuses another org's connector (404 connector.not_found)`; `create from template
  records the ack`; `drift appears when the template guide's code changes and not when only prose
  changes`; `ack route 409 on stale hash, audits on success`; `migration clears v1 acks and adds
  the column (idempotent on rerun)`; `upgrade preview reports a changed template guide with counts,
  never org names`.
- [ ] **Step 2: Run** `pnpm exec vitest run packages/kernel/test/tools/connector-guides.http.test.ts packages/kernel/test/migrations packages/kernel/test/catalog/plugin-upgrade.test.ts` → FAIL.
- [ ] **Step 3: Implement**; `@Transactional()` ack with audit in the same transaction.
- [ ] **Step 4: Run** the same plus `pnpm check:migrations && pnpm check:platform-ops && pnpm exec vitest run packages/kernel/test/platform` → PASS.
- [ ] **Step 5: Commit** (`feat(kernel): setup guides for connector templates`).

### Task 7: SDK checks contract (trust boundary: reviewed alone, most capable model)

**Files:**
- Create: `packages/plugin-sdk/src/setup-check.ts`
- Modify: `packages/plugin-sdk/src/ctx.ts` (`ExtensionContext.setup`),
  `packages/plugin-sdk/src/permissions.ts` (`setupChecks`), `packages/plugin-sdk/src/define-extension.ts`
  (cross-check like `validateUiContributions` if checks are declared statically), `index.ts`,
  `api/plugin-sdk.api.md`
- Create: `.changeset/setup-guides-v2-sdk-checks.md`
- Test: `packages/plugin-sdk/test/setup-check.test.ts`, `packages/plugin-sdk/test/permissions.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type SetupCheckStatus = "ok" | "failing" | "unknown";
  export interface SetupCheckResult { status: SetupCheckStatus;
    reason?: { en: string; zh?: string }; fix?: { en: string; zh?: string } }
  export type SetupCheckTarget =
    | { kind: "channel-connection"; connectionId: string; config: unknown }
    | { kind: "connector"; connectorId: string; templateId: string;
        clientId: string | null; accountId: string | null };
  export interface SetupCheckArgs { orgId: string; config: unknown; locale: "en" | "zh";
    mode: string | null; target: SetupCheckTarget; signal: AbortSignal }
  export interface SetupCheckDefinition { place: SetupGuidePlace;
    run(args: SetupCheckArgs): Promise<SetupCheckResult> }
  export const SETUP_CHECK_ID_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;
  export const SETUP_CHECK_LIMITS = { timeoutMs: 10_000, reasonChars: 300, fixChars: 500,
    freshMs: 300_000, cooldownMs: 10_000, orgConcurrency: 8, perAccountPerMinute: 30,
    idsPerExtension: 32 } as const;
  /** The result, or why it is invalid (English). */
  export function validateSetupCheckResult(x: unknown): SetupCheckResult | { problem: string };
  // ExtensionContext:
  setup: { check(id: string, def: SetupCheckDefinition): void };
  // ExtensionPermissions:
  setupChecks?: string[];
  ```

- [ ] **Step 1: Failing tests**: `validateSetupCheckResult accepts the three statuses and rejects
  others, extra keys (no data field), over-long reason/fix, missing en`; `permissions accept
  setupChecks ids and reject bad ids, duplicates, more than 32`.
- [ ] **Step 2: Run** `pnpm exec vitest run packages/plugin-sdk/test/setup-check.test.ts packages/plugin-sdk/test/permissions.test.ts` → FAIL.
- [ ] **Step 3: Implement**; doc comments state the contract rules verbatim: a check never writes;
  pass `signal` to every request; no retries; never put a secret in `reason` or `fix`.
- [ ] **Step 4: Run** `pnpm exec vitest run packages/plugin-sdk && pnpm gen:sdk-api && pnpm check:sdk-api` → PASS.
- [ ] **Step 5: Commit** (`feat(plugin-sdk): setup check contract`).
- Review checklist (for the dedicated reviewer): the target types carry no client secret or member
  token; `validateSetupCheckResult` leaves no free-form field; limits match spec §10.5.

### Task 8: Static check `perm-setup-check`

**Files:**
- Modify: `packages/plugin-tools/src/check/plugin-permissions.ts` (rule `perm-setup-check`, the same
  scanner and exemption comment `// capybara:allow-dynamic-permission <reason>` as `perm-ui`)
- Create: fixtures `packages/plugin-tools/test/fixtures/perm-setup-check-{ok,undeclared,dynamic}/`
- Test: `packages/plugin-tools/test/plugin-permissions.test.ts` (new cases)
- Modify: `tools/checks/README.md` (entry: runs in full on PRs, a cheap source scan like `perm-ui`)

**Interfaces:** Consumes Task 7's manifest key `permissions.setupChecks` and the call shape
`ctx.setup.check("<id>", …)`.

- [ ] **Step 1: Failing tests (proven red first)**: `undeclared id fails perm-setup-check`;
  `dynamic id reports "Cannot statically confirm"`; `exempted dynamic id passes`; `declared literal
  and same-file const pass`.
- [ ] **Step 2: Run** `pnpm exec vitest run packages/plugin-tools/test/plugin-permissions.test.ts` → FAIL.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run** the test and `pnpm check:extension-permissions` → PASS.
- [ ] **Step 5: Commit** (`feat(plugin-tools): perm-setup-check`).

---

## Wave 4

### Task 9: Web connector places and the admin template page

**Files:**
- Modify: `apps/web/src/components/CatalogInstallWizard.tsx` (guide FormSection above the client
  fields in each template step), `apps/web/src/app/(app)/plugins/[itemId]/connectors/view.tsx`,
  `apps/web/src/app/(app)/connectors/install/view.tsx` (template path uses the wizard),
  `apps/web/src/app/(app)/connectors/[connectorId]/view.tsx` (section with drift + ack),
  `apps/web/src/app/(app)/account/connections/view.tsx` (如何连接 link and Sheet, member audience;
  org admin link 「查看管理员接入指南」 to `/connectors/<id>`),
  `apps/web/src/app/(app)/admin/connector-templates/[id]/view.tsx` (admin route, no checks)
- Modify: `apps/web/src/lib/query/channels.ts` → move guide queries to a new
  `apps/web/src/lib/query/setup.ts` (`setupGuideQuery`, `adminSetupGuideQuery`) and update Task 5's
  import; `apps/web/src/lib/connectors.ts` (view fields, `ackConnectorGuide`)
- Modify: `apps/web/messages/zh.json`, `apps/web/messages/en.json`
- Test: `apps/web/test/connector-setup-guide.test.tsx`

**Interfaces:**
- Consumes: Task 5 `SetupGuideSection` (`admin` prop for the platform route), Task 6 view fields and
  ack route, Task 4 admin route.

- [ ] **Step 1: Failing tests**: `wizard step shows the admin guide before client fields`;
  `connector detail shows drift and acks`; `member sheet shows member text only`; `org admin sees
  the admin guide link in the sheet; member does not`; `sheet link absent without a member
  section`; `admin template page renders the guide without checks`.
- [ ] **Step 2: Run** `pnpm exec vitest run apps/web/test/connector-setup-guide.test.tsx` → FAIL.
- [ ] **Step 3: Implement** (route table and prefetch entries for the new queries per
  writing-web-ui).
- [ ] **Step 4: Run** `pnpm exec vitest run apps/web && pnpm check:web-ui && pnpm check:i18n` → PASS.
- [ ] **Step 5: Commit** (`feat(web): setup guides on connector pages`).

### Task 10: Kernel check runner and routes (trust boundary: reviewed alone, most capable model)

**Files:**
- Create: `packages/kernel/src/setup/setup.module.ts`, `setup-check-registry.ts` (kernel and
  extension checks by plugin + id), `setup-checks.service.ts` (lookup, authorization, target
  loading, fingerprint, cache, single flight, semaphore, cooldown, timeout, redaction),
  `setup-checks.controller.ts`, `setup-checks.schemas.ts`, `redact-check.ts`
- Modify: `packages/kernel/src/ctx/create-ctx.ts` (`ctx.setup.check`: only during setup, id in
  `permissions.setupChecks`, else `ExtensionPermissionError` + out-of-scope audit, duplicate throws;
  sealed with `ui.view`), `packages/kernel/src/extensions/permission-set.ts` (snapshot key
  `setupCheck:<id>`, non-blocking like `ui.view:*`)
- Modify: `packages/kernel/src/infra/throttler/named-throttlers.ts` (`setup-check`: 30 / 60 s per
  account)
- Modify: `packages/kernel/src/errors.ts` (or the error registry: `catalog.check_not_found`)
- Create: `packages/kernel/src/platform/ops/setup.ops.ts` with `setup.status` and `setup.check`
  (read class, mirroring the two new routes), because a route ships with its operation (an
  exclusion "for later" is forbidden); Task 13 adds the rest of the domain
- Modify: `packages/kernel/src/platform/operation.ts` (`PLATFORM_DOMAINS` gains `setup`)
- Modify: `packages/testing/fixtures/extensions/fake-im/` (add
  `permissions.setupChecks: ["pass","fail","throw","hang","long","echo-secret","ignore-signal"]`
  and register them with `ctx.setup.check`; `fake-im` already provides `channel@1`, so channel
  connection targets exist; `echo-secret` returns the value of a `secret()` connection field in `reason`; add one to its `connectionSchema` if it has none)
- Test: `packages/kernel/test/setup/setup-checks.http.test.ts`,
  `packages/kernel/test/setup/setup-checks.dual.test.ts`, `packages/kernel/test/ctx/setup-check-registration.test.ts`
- Create: `.changeset/setup-guides-v2-testing.md` (`@capybara-hq/testing`)

**Interfaces:**
- Consumes: Task 7 types/limits; Task 4 `PluginGuides.loadDocument`, `PLACE_ACTIONS`; Task 6
  connector target lookup.
- Produces:
  ```ts
  export interface SetupCheckState { status: SetupCheckStatus | "running" | "not_run";
    reason?: { en: string; zh?: string }; fix?: { en: string; zh?: string };
    checkedAt?: string; cooldownUntil?: string }
  // GET  /api/v1/orgs/:orgId/catalog/:itemId/guides/:guideId/checks?connectionId=&connectorId=&mode=&audience=
  //   → { results: Record<string, SetupCheckState> }
  // POST /api/v1/orgs/:orgId/catalog/:itemId/guides/:guideId/checks/:checkId/run
  //   body { connectionId?, connectorId?, mode?, audience?, force?: boolean } → { result: SetupCheckState }
  export interface KernelCheckArgs { orgId: string; accountId: string; mode: string | null;
    target: KernelCheckTarget; signal: AbortSignal; secrets: string[] }
  export type KernelCheckTarget =
    | { kind: "channel-connection"; connectionId: string; plugin: string }
    | { kind: "connector"; connectorId: string; templateId: string; plugin: string };
  class SetupCheckRegistry {
    registerKernel(id: `capybara:${string}`, place: SetupGuidePlace,
      run: (a: KernelCheckArgs) => Promise<SetupCheckResult>): void;
  }
  class SetupChecksService {
    states(org, itemId, guideId, q): Promise<Record<string, SetupCheckState>>;
    run(org, itemId, guideId, checkId, body): Promise<SetupCheckState>;
  }
  ```
- Redis keys (spec §10.7): result `capk:setup-check:<orgId>:<targetKind>:<targetId>:<plugin>:<checkId>:<mode|->`
  (TTL 300 s, value `{ result, fingerprint, checkedAt }`), cooldown `…:cooldown` (TTL 10 s), lock
  `capk:setup-check-run:<same>` (`SET NX PX 15000`), org semaphore `capk:setup-check-org:<orgId>`
  (INCR with 15 s TTL, DECR after; > 8 → `running`).
- Fingerprint: HMAC-SHA256 with the kernel's secret key over `target.updated_at`, credentials
  `updated_at`, the org config revision of the extension, the plugin version, the mode.

- [ ] **Step 1: Failing tests** (`setup-checks.http.test.ts`, fake-im with checks):
  - `GET checks never runs` (spy on the fake: 0 calls) and returns `not_run`.
  - `run returns ok and caches` (second run without force: 1 call total; `checkedAt` equal).
  - `config change invalidates the cache` (PATCH the connection; next run calls again).
  - `force respects the 10 s cooldown` (`cooldownUntil` set, no call).
  - `timeout yields unknown "The check timed out"` (hang; fake clock not allowed: use the
    `SETUP_CHECK_LIMITS` override seam `setupCheckTimeoutMs` test seam set to 200 ms).
  - `throw / invalid result yield unknown and log redacted`.
  - `redacts target secrets from results, cache and logs` (`echo-secret` returns the secret field in
    `reason`: response, Redis value and captured log lines contain `[REDACTED]`, never the token).
  - `extension disabled in org / needsConfig / unregistered id yield unknown with the kernel
    reason`.
  - `check not in the rendered guide for this mode → 404 catalog.check_not_found`;
    `no target → 400`; `member → 403`; `other org's connection → 404`.
  - `throttle: the 31st run in a minute is 429`.
  - `Redis down: run answers unknown "checks are temporarily unavailable"; the guide still renders`.
  - `ctx registration`: `check outside setup throws`; `undeclared id throws and audits`;
    `duplicate throws`; `setupCheck:* in snapshot does not block loading`.
  - Dual-replica (`setup-checks.dual.test.ts`): `single flight` (two concurrent runs on replicas 0
    and 1: the fake counts 1 call; one answer is the result, the other `running` then the result
    via GET); `org semaphore caps at 8`.
- [ ] **Step 2: Run** `pnpm exec vitest run packages/kernel/test/setup packages/kernel/test/ctx/setup-check-registration.test.ts` → FAIL.
- [ ] **Step 3: Implement** per spec §10.3–§10.8. Redis calls outside transactions; no timers
  (timeout via `AbortSignal.timeout` merged with `ctx.signal`); the lock released in `finally`.
  Plugin checks get `target.config` decrypted exactly as `channel@1` `verify` gets it; connector
  targets get `clientId` only. Minimal `setup.status` / `setup.check` operations (read class,
  mirroring the two routes) so `check:platform-ops` passes.
- [ ] **Step 4: Run** the tests plus `pnpm exec vitest run packages/kernel/test/platform && pnpm check:platform-ops && pnpm check:kernel-conventions` → PASS.
- [ ] **Step 5: Commit** (`feat(kernel): run setup checks`).
- Review checklist: no secret in any response, log, Redis value or fingerprint input; plugin checks
  only for targets of their own plugin; org visibility and place action before any target load;
  every Redis key has a TTL; lock released on every path; timeout always aborts the signal.

---

## Wave 5

### Task 11: Kernel `capybara:*` checks and the token endpoint probe (trust boundary: reviewed alone)

**Files:**
- Create: `packages/kernel/src/setup/kernel-checks.ts` (`public-url`, `webhook-public`,
  `webhook-received`, `connection-active`, `oauth-client`, `connector-tools`,
  `connector-connected`), `packages/kernel/src/setup/oauth-token-probe.ts`
- Modify: `packages/kernel/src/channels/webhook.ts` (on `accept`, set
  `capk:channel-webhook-seen:<connectionId>` = ISO time, TTL 7 d, at most once per minute via
  `SET capk:channel-webhook-seen-min:<connectionId>:<minute> 1 NX EX 60`), outside any transaction
- Modify: `packages/kernel/src/tools/oauth/tokens.ts` only if the refusal parser needs exporting
  (`parseTokenRefusal(res): { code: string | null; status: number }`)
- Test: `packages/kernel/test/setup/kernel-checks.test.ts`,
  `packages/kernel/test/setup/oauth-token-probe.test.ts`

**Interfaces:**
- Consumes: Task 10 `SetupCheckRegistry.registerKernel`, `KernelCheckArgs`.
- Produces: the seven ids above plus `capybara:oauth-token-endpoint`, registered on module init.
  Probe: resolve the token endpoint as the connect flow does (`discovery.ts`), POST
  `grant_type=authorization_code&code=capybara-setup-probe&redirect_uri=<publicUrl>/api/v1/oauth/callback`
  with the stored client per `tokenAuthMethod`, via `packages/kernel/src/net` (no redirects), 10 s.
  Map per spec §10.6 table. The fix text for `redirect_uri_mismatch` / `bad_redirect_uri` contains
  the rendered callback URL.

- [ ] **Step 1: Failing tests**: one per kernel check (ok / failing / unknown cases from spec
  §10.6); `webhook marker set once per minute`; probe against `startFakeOAuthServer` default and
  `dialect: "slack"`: `invalid_grant` / `invalid_code` → ok; `invalid_client` /
  `invalid_client_id` / `bad_client_secret` / 401 → failing with the copy-again fix;
  `redirect_uri_mismatch` → failing with the callback URL; 429 / 5xx / network → unknown; a 2xx
  with `access_token` → unknown and nothing stored (no credential row written); `dcr` client →
  unknown; `client secret absent from captured logs and the result`; `no redirects followed`.
- [ ] **Step 2: Run** `pnpm exec vitest run packages/kernel/test/setup/kernel-checks.test.ts packages/kernel/test/setup/oauth-token-probe.test.ts` → FAIL.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run** the tests plus `pnpm exec vitest run packages/kernel/test/channels/webhook.test.ts` → PASS.
- [ ] **Step 5: Commit** (`feat(kernel): kernel setup checks and the token endpoint probe`).
- Review checklist: the secret is used only in the request body/header to the resolved token
  endpoint; egress through `net`; body never logged; a returned token is discarded; probe subject
  to Task 10's limits.

### Task 12: Web live check rows

**Files:**
- Modify: `apps/web/src/components/SetupGuideSection.tsx` (`checks="live"`: GET states, then POST
  run for `not_run` or stale rows, at most 4 in flight; poll GET every 1 s while any is `running`,
  up to 10 s; 重新检查 → `force: true`)
- Create: `apps/web/src/lib/query/setup-checks.ts` (`setupCheckStatesQuery`, `runSetupCheck`)
- Modify: channel detail and connector detail / member sheet call sites to pass `checks="live"`
  (files from Tasks 5 and 9)
- Modify: `apps/web/messages/zh.json`, `apps/web/messages/en.json`
- Test: `apps/web/test/setup-check-rows.test.tsx`

- [ ] **Step 1: Failing tests**: `runs not_run checks once on view`; `does not rerun fresh results`;
  `polls while running and stops`; `recheck sends force and honors cooldownUntil`; `429 keeps the
  last state with a muted line`; `new channel page keeps static rows`.
- [ ] **Step 2: Run** `pnpm exec vitest run apps/web/test/setup-check-rows.test.tsx` → FAIL.
- [ ] **Step 3: Implement** (reads via `defineQuery`, the run via `useAppMutation` invalidating the
  states key).
- [ ] **Step 4: Run** `pnpm exec vitest run apps/web && pnpm check:web-ui && pnpm check:i18n` → PASS.
- [ ] **Step 5: Commit** (`feat(web): live setup check rows`).

---

## Wave 6

### Task 13: Platform `setup` domain and the list route

**Files:**
- Create: `packages/kernel/src/setup/setup-guides.controller.ts` (`GET /api/v1/orgs/:orgId/setup-guides`),
  `setup-guides.service.ts` (lists guides the caller may see with targets, drift and cached check
  summary, web paths)
- Modify: `packages/kernel/src/platform/ops/setup.ops.ts` (add `setup.guides`, `setup.read`; keep
  Task 10's `setup.status`, `setup.check`)
- Modify: `packages/kernel/src/platform/exclusions.ts` (remove the v1 guide-route exclusion; keep
  the channel and connector ack exclusions `human-only`)
- Create: `packages/plugin-sdk/agent-docs/setup.md` (the assisted flow, human-only boundaries,
  "never ask for a secret in the conversation")
- Test: `packages/kernel/test/platform/setup-ops.test.ts`, `packages/kernel/test/setup/setup-guides.http.test.ts`

**Interfaces:**
- Consumes: Task 4 `PluginGuides.render`, Task 6 `connectorStates`, Task 10 `SetupChecksService`.
- Produces: `setup.guides` (read) → `{ guides: { itemId; plugin; guideId; place; title; targets:
  { kind; id; name; drift: { from; to } | null; checks: { ok: number; failing: number; unknown:
  number; notRun: number }; webPath: string }[] }[] }`; `setup.read` (read) → `{ title; markdown;
  modes; mode; audience; unresolved; webPath }` where `markdown` joins blocks and writes checks as
  `- [check <id>] <label>`.

- [ ] **Step 1: Failing tests**: `setup.guides lists only guides the actor may see` (member sees
  connector member entries only); `setup.read returns markdown with check lines and no secret`;
  `setup.check runs without confirmation (read class)`; `ack routes stay excluded human-only`;
  parity test passes; `check:agent-docs` sees the topic.
- [ ] **Step 2: Run** `pnpm exec vitest run packages/kernel/test/platform/setup-ops.test.ts packages/kernel/test/setup/setup-guides.http.test.ts` → FAIL.
- [ ] **Step 3: Implement** (operations call the services; no new logic).
- [ ] **Step 4: Run** `pnpm exec vitest run packages/kernel/test/platform && pnpm check:platform-ops && pnpm check:agent-docs` → PASS.
- [ ] **Step 5: Commit** (`feat(kernel): setup operations for the Platform tool`).

### Task 14: Ask-an-agent entry

**Files:**
- Modify: `apps/web/src/components/SetupGuideSection.tsx` (a ghost action 让智能体协助 / Ask an
  agent: navigates to `/` with the draft query the new conversation page already accepts; grep the
  home view for the draft prefill parameter and reuse it)
- Modify: `apps/web/messages/zh.json`, `apps/web/messages/en.json` (draft text
  "Help me finish setting up {title} for {target}" / 「帮我完成 {target} 的「{title}」接入设置」)
- Test: `apps/web/test/setup-guide-section.test.tsx` (new case)

- [ ] **Step 1: Failing test**: `ask an agent opens the new conversation with the draft, not sent`.
- [ ] **Step 2: Run** `pnpm exec vitest run apps/web/test/setup-guide-section.test.tsx` → FAIL.
- [ ] **Step 3: Implement**. If the home page has no draft prefill parameter, add one in
  `apps/web/src/app/(app)/view.tsx` (read `?draft=` once into the composer, never auto-send) and
  test it there.
- [ ] **Step 4: Run** `pnpm exec vitest run apps/web && pnpm check:i18n` → PASS.
- [ ] **Step 5: Commit** (`feat(web): ask an agent from a setup guide`).

---

## Wave 7

### Task 15: Composer token paste warning

**Files:**
- Create: `packages/design/src/conversation/token-like.ts` (`findTokenLikeSpans`)
- Modify: `packages/design/src/conversation/composer.tsx` (warn Callout, 移除, 仍然发送, Enter rule),
  `packages/design/src/i18n.ts`, `docs/design/spec.md` (composer section)
- Test: `packages/design/test/token-like.test.ts`, `packages/design/test/composer-token-warning.test.tsx`

**Interfaces:**
- Produces:
  ```ts
  export type TokenLikeKind = "slack-token" | "slack-app-token" | "github-token" | "api-key"
    | "aws-key" | "google-key" | "private-key" | "jwt" | "high-entropy";
  export function findTokenLikeSpans(text: string): { start: number; end: number; kind: TokenLikeKind }[];
  ```
  Patterns and the entropy rule exactly as spec §12.1 (≥ 32 chars of `[A-Za-z0-9+/=_-]`, Shannon
  entropy ≥ 4.0 bits/char, at least one digit and one letter; excluded: UUID, 40/64 lowercase hex,
  URL paths, `data:` URIs).

- [ ] **Step 1: Failing tests**: `findTokenLikeSpans matches` one sample per pattern
  (`xoxb-123456789012-abcdefghij`, `xapp-1-A0123456789-abcdef`, `ghp_` + 36 alnum, `github_pat_` +
  22, `sk-ant-api03-` + 30, `AKIA` + 16, `AIza` + 35, a PEM header, a JWT, a 40-char random
  base64url); `findTokenLikeSpans non-matches` (a UUID, a 40-hex commit hash, a 64-hex sha256,
  `https://example.com/a/very/long/path/with/many/segments/0123456789`, a prose sentence, a code
  block with words, `data:image/png;base64,…`); composer: `paste shows the warn with the kind
  label`; `Enter with a match shows the warn instead of sending`; `仍然发送 sends unchanged`;
  `second Enter sends`; `移除 deletes the spans`; `editing away the match clears the warn`.
- [ ] **Step 2: Run** `pnpm exec vitest run packages/design/test/token-like.test.ts packages/design/test/composer-token-warning.test.tsx` → FAIL.
- [ ] **Step 3: Implement** (no network, no logging; Callout is the warn line, not a box inside the
  composer box).
- [ ] **Step 4: Run** `pnpm exec vitest run packages/design apps/web && pnpm check:web-ui` → PASS.
- [ ] **Step 5: Commit** (`feat(design): warn before sending token-like text`).

### Task 16: Docs and skills

**Files:**
- Modify: `.agents/skills/writing-plugins/SKILL.md` (guide format, paths, languages, pack errors,
  `capybara-plugin guide`), `.agents/skills/writing-extensions/SKILL.md` (`ctx.setup.check`,
  `permissions.setupChecks`, the contract rules), `.agents/skills/writing-connectors/SKILL.md`
  (connector-template guides, `capybara:oauth-token-endpoint`, no client secret to plugins),
  `.agents/skills/writing-channels/SKILL.md` (channel guides, webhook-seen marker),
  `.agents/skills/writing-web-ui/SKILL.md` (`SetupGuideSection`, `GuideDocument`, `CheckRow`),
  `.agents/skills/writing-kernel-api/SKILL.md` (the `setup` domain under Platform operations)
- Modify: `docs/superpowers/specs/2026-11-08-plugin-setup-guides-design.md` (status line:
  "Superseded by 2026-11-09-setup-guides-v2-design.md")
- Modify: `AGENTS.md` "Extensions" or "Plugins and the catalog" line only if a rule is new and
  uncheckable (one clause: "a setup check never writes and never returns a secret")

- [ ] **Step 1**: write the sections; each states the rule and points at the spec section.
- [ ] **Step 2: Run** `pnpm lint && pnpm check` → PASS.
- [ ] **Step 3: Commit** (`docs: setup guides v2 in skills`).

## Wave 8

### Task 17: Visual baselines and full verification

- [ ] **Step 1**: push the branch; run the `visual-update` workflow on it (GitHub Actions →
  `visual-update` → branch `<this branch>`); it commits refreshed baselines for the channel pages,
  connector pages, the member sheet, the admin template page, `/dev/ui` GuideDocument / CheckRow
  states and the composer warning. Never render baselines locally.
- [ ] **Step 2: Review** the baseline diff images: only the expected surfaces changed.
- [ ] **Step 3: Run** `pnpm verify --full` locally (with `docker compose -f docker/compose.dev.yaml up -d`).
  Expected: all green.
- [ ] **Step 4: Manual acceptance on `pnpm dev:kernel` + `pnpm dev:web`** with a test plugin carrying
  both guides (the Task 4 fixture packed with `capybara-plugin pack`): new channel, channel detail
  with mode switch and drift after re-import with a changed code block, no drift after a prose-only
  change, connector wizard, member sheet, admin template page, an agent conversation using
  `Platform` `setup.guides` → `setup.read` → `setup.check`, a pasted `xoxb-` token warning.
- [ ] **Step 5**: open the PR for review (not merged by the implementer).

## Wave 9

### Task 18: Core release gate (maintainer)

- [ ] The maintainer merges the PR; the changesets (`plugin-sdk`, `plugin-tools`, `testing`,
  `kernel` / `capybara` image, `design`) produce the release PR; merging it publishes through
  `.github/workflows/release.yml`.
- [ ] Confirm the versions on npm: `npm view @capybara-hq/plugin-sdk version`,
  `npm view @capybara-hq/plugin-tools version`, `npm view @capybara-hq/testing version` show the
  release containing v2.

## Wave 10

### Task 19: Slack plugin migration (`capybara-hq/plugins`)

Work in a worktree of `/Users/grant/Capybara/plugins` from `origin/main` (that repo's `pnpm wt:new
feat/slack-guides-v2 --from origin/main`); follow its `writing-plugins` and `writing-extensions`
skills.

**Files:**
- Modify: root `package.json` / lockfile: bump `@capybara-hq/plugin-sdk`, `@capybara-hq/plugin-tools`,
  `@capybara-hq/testing` to the Task 18 release
- Create: `plugins/slack/guides/slack-app.md`, `plugins/slack/guides/slack-app.zh.md`,
  `plugins/slack/guides/slack-connector.md`, `plugins/slack/guides/slack-connector.zh.md` (the
  English documents verbatim from spec §5.2 and §5.3; zh translations of prose and labels with
  byte-equal code blocks)
- Delete: `plugins/slack/guides/app-manifest.socket.yaml.tmpl`,
  `plugins/slack/guides/app-manifest.webhook.yaml.tmpl`, `plugins/slack/app-manifest.connector.yaml`
- Modify: `plugins/slack/.capybara-plugin/plugin.json` (`setupGuides` v2 entries from spec §5.1;
  version bump), extension manifest `permissions.setupChecks: ["bot-token","bot-scopes","app-token"]`
- Create: `plugins/slack/src/setup-checks.ts` (the three checks; `auth.test` for `bot-token` and
  `bot-scopes` reading `x-oauth-scopes` against the manifest's bot scopes;
  `apps.connections.open` with the app token for `app-token`, never opening the socket); register
  in `plugins/slack/src/index.ts` setup
- Modify: `plugins/slack/README.md` ("Create the Slack app" and "Slack connector" shrink to a
  pointer at the in-product guides plus operator-only notes)
- Create: changeset bumping `@capybara-hq/plugin-slack` (minor)
- Test: `plugins/slack/test/guides.test.ts` (renders both guides in every mode and audience with
  `renderSetupGuide`; YAML blocks parse; `validateSetupGuide` returns no errors for en+zh),
  `plugins/slack/test/setup-checks.test.ts` (against `startFakeSlack`: token ok; revoked token →
  failing with the reinstall fix; a missing scope → failing naming it; app token ok / refused;
  hanging server honors `signal`; no token text in any reason)

- [ ] **Step 1: Failing tests** above.
- [ ] **Step 2: Run** `pnpm exec vitest run plugins/slack` → FAIL.
- [ ] **Step 3: Implement** the guides, checks, manifest and README changes.
- [ ] **Step 4: Run** `pnpm exec vitest run plugins/slack && pnpm exec capybara-plugin check plugins/slack && pnpm exec capybara-plugin guide slack-app --mode webhook --var webhookUrl=https://x.example/channels/webhook/1 plugins/slack` → PASS, rendered output reviewed.
- [ ] **Step 5: Live check** when `CAPYBARA_TEST_SLACK_*` keys are available (key file loaded only
  inside the command, never printed): `bot-token` and `bot-scopes` ok against the test workspace.
- [ ] **Step 6: Commit, push, open the PR** (`feat(slack): markdown setup guides and setup checks`).

---

## Self-review notes

- Spec coverage: format §4 → T1, T3; Slack §5 → T19; variables and rendering §6–§7 → T1, T4;
  web §7.3 → T2, T5; modes §8 → T1, T5; places §9 → T4, T6, T9 (admin page, member sheet admin
  link); checks §10 → T7, T8, T10, T11, T12; drift §11 → T1 (hash), T4, T6; Platform §12 → T10
  (status/check ops), T13; token warning §12.1 → T15; ask-an-agent → T14; security §13 → review
  checklists in T7, T10, T11 and Review Focus; migration §15 → T4, T6, T16, T19; testing §16 →
  each task; delivery order §17 → the waves.
- Route fence: every new route lands with its operation or exclusion in the same task (T4 admin
  route exclusion, T6 ack exclusion, T10 status/check ops, T13 list route op).
