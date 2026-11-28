# Composer inline tokens Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task, layered with `wave-planned-subagent-development` (wave table at the end). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Everything picked through `/` or `@` becomes an inline token in a Lexical composer; the message carries one ordered `tokens` list marked in `text` with U+FFFC; `@` names a connector, which the kernel turns into English placeholders and, under tool search, loads its tools; resources move to a per-connector second level.

**Architecture:** Kernel first and additive: a pure `inline-tokens` module (labels, placeholders, mention text), then `tokens` accepted beside the old fields with resolution, refusals, `[file: …]` lines and the `inline` / `connectorMentions` payload, then the loaded-tool set reading mentions. Design builds `ComposerEditor` (Lexical, standalone), the menu drill-in and bubble tokens as additive components. One switch PR then moves `ComposerBox` onto the editor, rewrites `ComposerBar` to segments, draws bubbles from `payload.inline`, and removes `attachments` / `projectFiles` / `conversationRefs` from the body and the old resources listing shape.

**Tech Stack:** NestJS + Fastify kernel (zod, `createZodDto`), Lexical 0.53.0 in `packages/design`, Next web app (TanStack Query, next-intl), vitest (unit / integration / jsdom), Playwright Chromium + WebKit on `/dev/ui`.

**Spec:** `docs/superpowers/specs/2026-11-28-composer-inline-tokens-design.md` (approved 2026-11-28, PR #1061). Visual reference: the maintainer's demo (`inline-tokens-demo.html`, handed to UI implementers by path).

## Global Constraints

- Lexical pinned exactly in `packages/design/package.json` only: `lexical@0.53.0`, `@lexical/react@0.53.0`, `@lexical/plain-text@0.53.0`, `@lexical/history@0.53.0`; no `yjs`. Imports only through subpath entries (`@lexical/react/LexicalComposer` etc.), never the `@lexical/react` barrel. `apps/web` and `plugin-client` import nothing from `lexical` / `@lexical/*`.
- Marker: U+FFFC (`"￼"`); the count in `text` must equal `tokens.length`, else 400 `validation_failed` with message `Each token needs one U+FFFC marker in text, in order`.
- Limits: `MAX_TOKENS = 20`; `connector` ≤ 3 (`MAX_CONNECTOR_MENTIONS`), `resource` ≤ 5 (`MAX_ATTACHMENTS`), `projectFile` ≤ 10 (`MAX_PROJECT_FILES`), `conversation` ≤ 3 (`MAX_CONVERSATION_REFS`), `file` tokens + `files` ≤ `attachments.maxPerMessage`; a repeated entity counts once.
- Placeholders (verbatim): `[connector: <label>]`, `[resource: <label> from <connector label>]`, `[file: <label>]`, `[project file: <label>]`, `[conversation: <label>]`, untitled conversation label `Untitled conversation`.
- Label: control characters and line breaks → one space, `[`→`(`, `]`→`)`, trimmed, at most 80 code points then `…`; a second different entity of one kind with the same label gets ` (2)`, the third ` (3)`, in text order (uploads numbered after file tokens).
- Mention text (verbatim): `[connector: <label>] The person named the connector "<name>" for this message. Its tools are named mcp__<slug>__<tool>.` then, tool search on and ≤ 20 tools: ` Its <n> tools are loaded from this message on.`; on and more: ` It has <n> tools; load the ones this message needs with ToolSearch.`; off: nothing.
- Block order after `content[0]`: resources, project files, conversations, connector mentions, file tokens, uploads; each file media block preceded by a text block `[file: <label>]`.
- Resources listing: at most 200; not listed: `mimeType` equal to `text/html;profile=mcp-app` (case-insensitive, spaces removed), URI scheme `ui:`, `size === 0`.
- New error codes: `conversation.connector_unavailable` 422 (`details: [{connectorId, reason: "not_found" | "needs_config" | "not_offered"}]`), `connector.resource_unreadable` 422 (`details: [{connectorId, uri, reason: "ui_template" | "empty"}]`).
- Token look: inline-flex, padding 0 `space.1`, gap `space.1`, radius `sm`, `selected` ground, prose font `ink` same size; max width 16em / 12em (medium) / 10em (compact); box height = line height − 4 (compact − 2), `vertical-align: top`, block margin half the difference (2, compact 1); no pixel `vertical-align` offset; selected → `accent` 1px outline; skill token `accent-tint` ground, mono `accent` label; refused → 1px `fail` border, `fail` label, `circle-alert` lead.
- Copy: spec §7 table verbatim (zh / en); zh uses 智能体 / 平台, never 企业 or the Latin `agent`.
- Model-visible text English; `payload.inline` is display only: request building never reads it.
- Replay: no new `DriftReason`; zero-drift fixtures (`packages/kernel/test/evals/reconstruct.test.ts`) run before and after each request-building change.
- Kernel conventions: `createZodDto`, explicit `@Inject`, error codes registered in `errors.ts` with zh / en copy in `apps/web/messages/{zh,en}.json` under `errors`.
- New unit tests join `packages/kernel/test/unit-tests.json` in the same commit.
- Comments, identifiers and commits in English; Conventional Commits, body ≤ 100 chars/line, trailer `Co-Authored-By: Capybara <noreply@capybarahq.com>`.
- Changesets: `@capybara-hq/plugin-sdk` (the `size` field, `pnpm gen:sdk-api`), `@capybara-hq/kernel`, `@capybara-hq/capybara` (web).
- Before each push: `pnpm verify --fast` plus `pnpm exec vitest run <changed tests>` from the worktree root. Visual baselines and reference images only through the `visual-update` / `reference-update` workflows.

## Review Focus

1. **Rich paste carrying U+FFFC or other `Cf` characters** (from a web page, Word, or a Capybara bubble) must arrive as plain text with no token and no stray marker, so the send never fails the marker count: T4 test `paste strips U+FFFC and format characters` and T9b test `pasted text with U+FFFC sends a matching marker count`.
2. **A connector deleted, switched off or set to `needs_config` between the menu load and the send** must refuse the send with nothing written, mark that token refused and keep the draft: T7 test `connector refused after deletion writes nothing` and T9b test `refusal marks the token and shows the Callout`.
3. **A Chinese IME composing text that contains `@` or `/`** (Sogou, macOS Pinyin) must not open a menu or send on ↵ until commit, then open the menu from the committed text: T4 Playwright `IME composition holds triggers and Enter` (Chromium + WebKit).
4. **A skill invocation whose arguments contain tokens** must put placeholders into the rendered skill and `inline` offsets into `skill.arguments`, and the bubble must draw the skill chip first then the tokens: T7 test `skill arguments carry placeholders and inline offsets`, T9b test `bubble draws skill chip then argument tokens`.
5. **An upload-only message**, whose `content[0]` is now a `[file: …]` line, must show no text in the bubble, and older messages (text then a bare media block) must keep their text: T9b test `personText skips a leading file line and keeps old messages`.

---

## File Structure

Kernel (`packages/kernel/src`):
- `conversations/inline-tokens.ts` (create, T2): pure; token types, label folding, collision numbering, placeholder and mention text, U+FFFC rendering with offsets.
- `conversations/conversations.controller.ts`, `conversations/conversations.service.ts`, `conversations/events.ts`, `files/library-files.service.ts`, `errors.ts` (T7, T9b).
- `tools/connector-content.ts`, `tools/connector-content.controller.ts`, `platform/exclusions.ts` (T1, T3, T9b).
- `tools/mentionable-connectors.ts` (create, T3) + route in `agents/agents.controller.ts`.
- `runtime/context/build.ts` (T8).
- SDK: `packages/plugin-sdk/src/connector.ts`, API report (T1).

Design (`packages/design/src`):
- `conversation/composer-editor/` (create, T4): `editor.tsx` (`ComposerEditor`), `token-node.tsx` (`TokenNode`, `$createTokenNode`), `segments.ts` (segments ⇄ editor state, plain forms), `commands.ts` (paste / copy / cut / keys / IME guard), `token.tsx` (`InlineToken`, the presentational token shared with the bubble), `index.ts`.
- `styles/composer-editor.css` (create, T4), `styles/composer-menu.css`, `styles/conversation.css`.
- `conversation/composer-menu.tsx` (T5), `conversation/bubble.tsx` (T6), `conversation/composer.tsx` (T9a), `display/attachments.tsx` (T5, strip centring), `i18n.ts` (T4 token keys, T5 menu keys).
- Reference blocks under `src/reference/` for the editor, menu drill-in and bubble tokens.

Web (`apps/web/src`, T9b): `components/conversation/ComposerBar.tsx`, `first-message-attempt.ts`, `NewConversation.tsx`, `ConversationView.tsx`, `Thread.tsx`, `lib/conversations.ts`, `lib/timeline.ts`, `lib/queries/*` (the two new `defineQuery`s), `messages/{zh,en}.json`; `visual/composer-editor.interaction.spec.ts` + `playwright.visual.config.ts` (T4).

Docs (T10): `docs/design/spec.md` §6.11, §6.16.2, §6.16.6, §6.16.21, §6.16.30; the composer menus, @ conversations and file library specs; skills `writing-web-ui`, `writing-connectors` (T1), `writing-tools` and `replay-evals` (T8).

Plugins repo (T11): `plugins/connector-mcp` passes `size`.

---

### Task T1: SDK `size` and the per-connector resources listing (kernel, normal)

**Files:**
- Modify: `packages/plugin-sdk/src/connector.ts:26` (resource item), SDK API report via `pnpm gen:sdk-api`, `.changeset/*.md` (plugin-sdk patch, kernel patch)
- Modify: `packages/kernel/src/tools/connector-content.ts` (`listResources`), `tools/connector-content.controller.ts` (`ConnectorResourcesQuery`), `platform/exclusions.ts:715` (reason names the second level)
- Modify: `.agents/skills/writing-connectors/SKILL.md` (listing filter, `size`)
- Test: `packages/kernel/test/tools/connector-resources-listing.test.ts` (integration, fake-connector) and `packages/kernel/test/tools/resource-filter.unit.test.ts` (add to `unit-tests.json`)

**Interfaces:**
- Produces: SDK `ConnectorResource = { uri: string; name: string; description?: string; mimeType?: string; size?: number }`.
- Produces: `export function listableResource(r: ConnectorResource): boolean` and `export function isUiTemplate(r: { uri: string; mimeType?: string }): boolean` in `tools/connector-content.ts` (T7 uses `isUiTemplate`).
- Produces: `listResources(orgId, accountId, { connectorId?: string; query?: string })`. With `connectorId`: one session on that connector, refuses one not active or with `read_resource` off (`connector.resources_disabled`), at most 200. Without it: today's behaviour (kept only until T9b makes `connectorId` required; T9b deletes that branch).

- [ ] **Step 1: Unit tests** `isUiTemplate` true for `ui://x`, `UI://x`, mimeType `text/html; profile=mcp-app` and `TEXT/HTML;PROFILE=MCP-APP`; false for `text/html`, `https://ui.example`. `listableResource` false for `size: 0`, true for `size` absent or 12.
- [ ] **Step 2: Integration tests** `resources route with connectorId opens one session` (a second connector's fake records no `listResources` call), `filters UI templates and empty resources`, `caps at 200`, `refuses a connector whose read_resource is off` (409 `connector.resources_disabled`), `refuses a connector of another org` (404 `connector.not_found`).
- [ ] **Step 3: Run, expect FAIL.** `pnpm exec vitest run packages/kernel/test/tools/resource-filter.unit.test.ts packages/kernel/test/tools/connector-resources-listing.test.ts`
- [ ] **Step 4: Implement**; SDK field + `pnpm gen:sdk-api`; changeset.
- [ ] **Step 5: Run tests, `pnpm check:sdk-api`, `pnpm check:platform-ops`; expect PASS.**
- [ ] **Step 6: Commit** `feat(kernel): list one connector's readable resources`.

### Task T2: The pure inline-tokens module (kernel, normal)

**Files:**
- Create: `packages/kernel/src/conversations/inline-tokens.ts`
- Test: `packages/kernel/test/conversations/inline-tokens.unit.test.ts` (add to `unit-tests.json`)

**Interfaces:**
- Produces:
  ```ts
  export const TOKEN_MARKER = "￼";
  export const MAX_TOKENS = 20;
  export const MAX_CONNECTOR_MENTIONS = 3;
  export const MENTION_LOAD_MAX_TOOLS = 20;
  export type MessageToken =
    | { type: "connector"; connectorId: string }
    | { type: "resource"; connectorId: string; uri: string }
    | { type: "file"; id: string }
    | { type: "projectFile"; path: string }
    | { type: "conversation"; id: string };
  export type InlineRef = { connectorId: string } | { connectorId: string; uri: string } | { fileId: string } | { path: string } | { id: string };
  export type InlineEntry = { kind: MessageToken["type"]; start: number; end: number; label: string; ref: InlineRef };
  export function countMarkers(text: string): number;
  export function tokenEntityKey(t: MessageToken): string;          // "connector:<id>", "resource:<id>:<uri>", "file:<id>", "projectFile:<normalized path>", "conversation:<id>"
  export function foldLabel(raw: string): string;                     // Global Constraints rule
  export function numberLabels(items: { key: string; label: string }[]): Map<string, string>; // key → numbered label, first-seen order
  export function placeholder(kind: MessageToken["type"], label: string, connectorLabel?: string): string;
  export function renderInline(text: string, tokens: readonly MessageToken[], labelOf: (t: MessageToken) => string, connectorLabelOf: (connectorId: string) => string): { text: string; inline: InlineEntry[] };
  export function connectorMentionText(m: { label: string; name: string; slug: string; toolCount: number; toolSearch: boolean }): string;
  export function fileLine(label: string): string;                   // "[file: <label>]"
  ```
  `renderInline` offsets are UTF-16 indices into the returned text and point at the whole placeholder.

- [ ] **Step 1: Write failing tests** with these exact cases:
  - `foldLabel("a\nb\u0007c")` → `"a b c"`; `foldLabel("[x]")` → `"(x)"`; `foldLabel("  y  ")` → `"y"`; 81 `"字"` → 80 `"字"` + `"…"`; an emoji string counts code points, not UTF-16 units.
  - `numberLabels([{key:"file:1",label:"a.png"},{key:"file:2",label:"a.png"},{key:"file:1",label:"a.png"},{key:"file:3",label:"a.png"}])` → `file:1→"a.png"`, `file:2→"a.png (2)"`, `file:3→"a.png (3)"`.
  - `renderInline("￼ 给小明发消息", [{type:"connector",connectorId:"c"}], () => "Slack", () => "Slack")` → text `"[connector: Slack] 给小明发消息"`, inline `[{kind:"connector",start:0,end:18,label:"Slack",ref:{connectorId:"c"}}]`.
  - resource placeholder `"[resource: Send Message from Slack]"`; conversation untitled label passes through as `"Untitled conversation"`.
  - `connectorMentionText` three variants match Global Constraints verbatim (`toolCount` 7 on → `Its 7 tools are loaded from this message on.`; 31 on → `It has 31 tools; load the ones this message needs with ToolSearch.`; off → no second sentence).
- [ ] **Step 2: Run, expect FAIL** (`pnpm exec vitest run packages/kernel/test/conversations/inline-tokens.unit.test.ts`).
- [ ] **Step 3: Implement** (no Nest, no db imports).
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** `feat(kernel): inline token labels and placeholders`.

### Task T3: `GET /orgs/:orgId/agents/:agentId/mentionable-connectors` (kernel, high)

**Files:**
- Create: `packages/kernel/src/tools/mentionable-connectors.ts` (`MentionableConnectorsService`, `@Injectable`, provided in the tools module)
- Modify: `packages/kernel/src/agents/agents.controller.ts` (route, `@OrgAction("agents.use")`, human principal only via `requireUser`), `platform/exclusions.ts` (exclusion, reason `internal`: feeds the web input box; an agent already has its connectors' tools)
- Test: `packages/kernel/test/agents/mentionable-connectors.test.ts` (integration)

**Interfaces:**
- Produces: `MentionableConnectorsService.list(orgId: string, accountId: string, agentId: string): Promise<{ connectors: MentionableConnector[] }>` with
  `MentionableConnector = { id; slug; name; description?: string; icon: string | null; state: "ready" | "needs_config"; credential: "connected" | "missing" | "none"; toolCount: number; resources: boolean }`. `icon` is the kernel icon URL (`/api/v1/orgs/:orgId/connectors/:id/icon`) or null; `toolCount` counts the agent's offered tools of that connector (`forAgent`, conversation source `web`); `resources` = its `read_resource` is offered. Live, active connectors with ≥ 1 offered tool plus `needs_config` ones (`toolCount` 0). No session opened.
- Produces: a helper reused by T7: `connectorToolsFor(tools: readonly ResolvedTool[], connectorId: string): ResolvedTool[]` (exported from the same file).

- [ ] **Step 1: Failing tests** `lists connectors the agent can use` (two connectors, the agent's `disabledTools` switches one off → absent), `shows needs_config disabled` (state `needs_config`, toolCount 0), `credential missing for a personal OAuth connector not connected`, `guest may list` (`agents.use`), `service token refused` (403), `another org's agent is not found` (404), `no connector session opened` (fake-connector records no call).
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement**; `pnpm check:platform-ops` passes with the exclusion.
- [ ] **Step 4: Run tests and `platform-parity.test.ts`, expect PASS.**
- [ ] **Step 5: Commit** `feat(kernel): list an agent's mentionable connectors`.

### Task T4: `ComposerEditor` on Lexical (design, high judgment)

**Files:**
- Modify: `packages/design/package.json` (four pinned deps), `pnpm-lock.yaml`
- Create: `packages/design/src/conversation/composer-editor/{editor.tsx,token-node.tsx,segments.ts,commands.ts,token.tsx,index.ts}`, `packages/design/src/styles/composer-editor.css` (import from `styles/index.css`)
- Modify: `packages/design/src/conversation/index.ts` (exports), `packages/design/src/i18n.ts` (`composer.token.*`, `composer.refused`, `composer.refusedRemove`), a reference block `composer-editor` (states: empty, tokens mid-sentence, selected token, refused token, skill token with hint, compact)
- Modify: `apps/web/playwright.visual.config.ts` (a `webkit` project with `testMatch: /composer-editor\.interaction\.spec\.ts$/`, `devices["Desktop Safari"]`)
- Test: `packages/design/test/composer-editor.test.tsx` (jsdom), `apps/web/visual/composer-editor.interaction.spec.ts` (Chromium + WebKit, on `/dev/ui/reference/composer-editor`)

**Interfaces:**
- Produces (exported from `@capybara-hq/design`):
  ```ts
  export type ComposerTokenKind = "connector" | "resource" | "file" | "projectFile" | "conversation" | "skill";
  export type ComposerTokenData = { kind: ComposerTokenKind; id: string; label: string; icon?: { src?: string; initial?: string; name?: IconName; fileType?: string }; state?: "refused"; reason?: string };
  export type ComposerSegment = string | ComposerTokenData;          // adjacent strings never; "" never
  export type ComposerEditorHandle = { value(): ComposerSegment[]; focus(): void; insertToken(t: ComposerTokenData, replaceQuery?: { trigger: "@" | "/"; length: number }): void; replace(segments: ComposerSegment[]): void; clear(): void };
  export type ComposerEditorProps = {
    segments: ComposerSegment[]; onChange(segments: ComposerSegment[]): void;
    placeholder: string; hint?: string;                               // hint: ghost text after a lone skill token
    onTrigger?(t: { trigger: "@" | "/"; query: string; atStart: boolean } | null): void; // null: no open trigger at the caret
    onKeyDown?(e: KeyboardEvent): boolean;                            // menu keys first; true stops the editor's handling
    onPasteFiles?(files: File[]): void; onPasteText?(text: string): void; // token warning hook
    onSubmit(): void;                                                  // ↵ without Shift, not composing, fine pointer
    combobox?: ComposerMenuCombobox; autoFocus?: boolean; disabled?: boolean;
  };
  export const ComposerEditor: ForwardRefExoticComponent<ComposerEditorProps & RefAttributes<ComposerEditorHandle>>;
  export function InlineToken(p: { token: ComposerTokenData; selected?: boolean }): JSX.Element; // presentational, used by TokenNode and the bubble
  export function segmentsPlainText(s: ComposerSegment[]): string;    // plain forms of spec §1 table
  ```
  `TokenNode` JSON: `{ type: "cap-token", version: 1, kind, id, label, icon?, state? }`. `replace` and a menu pick are one history step each; `clear()` also clears history.

- [ ] **Step 1: jsdom failing tests** (`composer-editor.test.tsx`): `TokenNode round-trips JSON`; `segments in = segments out` for `["给 ", slack, " 发消息"]`; `paste strips U+FFFC and format characters` (`"a￼b​c"` → `"abc"`, no token, no trigger opened); `paste of "@Slack" stays text`; `copy writes plain forms only` (clipboard `text/plain` = `"给 @Slack 发消息"`, no `text/html`); `insertToken replaces the query` (`"hi @sl"` + slack → `["hi ", slack, " "]` with caret after); `Backspace after a token removes it`; `undo restores a removed token in one step`; `replace is one undo step`; `token accessible name` (`role="img"`, name `连接器：Slack`; refused `连接器：Slack，不可用`); `combobox attributes pass through` (`role="textbox"`, `aria-multiline="true"`, `aria-expanded`, `aria-controls`, `aria-activedescendant`); `onTrigger reports @ mid-sentence and / mid-sentence`; `full-width ＠ is not a trigger`.
- [ ] **Step 2: Playwright failing tests** (`composer-editor.interaction.spec.ts`, both projects): `arrow keys step over a token`, `Shift+Arrow selects a token as a unit`, `click selects a token (accent outline)`, `Delete before a token removes it`, `word delete removes the previous token`, `IME composition holds triggers and Enter` (CDP `Input.imeSetComposition` on Chromium; on WebKit dispatch `compositionstart` / `compositionupdate` / `compositionend` with `insertText`), `token centring` (the token label's glyph box centre equals the neighbouring text's within 1 px, at 1280 and 390 wide), `grows to 8 lines then scrolls`.
- [ ] **Step 3: Run, expect FAIL** (`pnpm exec vitest run packages/design/test/composer-editor.test.tsx`; `CAPYBARA_VISUAL_PORT=3107 pnpm --filter @capybara-hq/web visual -- composer-editor.interaction`).
- [ ] **Step 4: Implement.** `LexicalComposer` + `PlainTextPlugin` + `HistoryPlugin` + `ContentEditable` (`autocapitalize="sentences"`); `TokenNode extends DecoratorNode` (`isInline() true`, `isKeyboardSelectable() true`); `PASTE_COMMAND`, `COPY_COMMAND`, `CUT_COMMAND`, `KEY_ENTER_COMMAND`, `KEY_ARROW_*_COMMAND` at `COMMAND_PRIORITY_HIGH`, each returning early while `editor.isComposing()`; trigger detection in `registerUpdateListener` from the text before the caret (start or after whitespace, ASCII `@` or `/`). CSS per Global Constraints; the Lexical theme maps class names only. Read the demo for the look.
- [ ] **Step 5: Run tests, `pnpm check:web-ui`, `pnpm --filter @capybara-hq/design exec tsc -b`; expect PASS.**
- [ ] **Step 6: Commit** `feat(design): Lexical composer editor with inline tokens`.

### Task T5: Menu drill-in, connector rows, one-skill line, strip centring (design, normal)

**Files:**
- Modify: `packages/design/src/conversation/composer-menu.tsx`, `styles/composer-menu.css`, `display/attachments.tsx` (+ its CSS: `align-items: center`), `i18n.ts` (`composerMenu.*` keys of spec §7; remove `composerMenu.resources`), the `composer-menu` reference block (connector rows, drill head, compact drill-in, disabled skills with the one-skill line)
- Test: `packages/design/test/composer-menu.test.tsx`, `packages/design/test/attachments.test.tsx`

**Interfaces:**
- Produces on `ComposerMenuItem`: `drill?: { label: string; onDrill(): void }` (trailing → button `composer-menu-drill`; the → key on the active item calls it); on `ComposerMenuProps`: `level?: { title: string; onBack(): void }` (head 「‹ <title>」 with a 返回 button; ← and Backspace with an empty query call `onBack` and report handled). Footer text supplied by the caller; the menu adds `→ 资源` hints at expanded when any item has `drill`.
- Compact: `level` renders as the bottom sheet's in-sheet drill-in with the search field; the row's drill button is the whole trailing `touch.hit` area.

- [ ] **Step 1: Failing tests** `drill button opens the second level`, `ArrowRight on a drillable row drills`, `ArrowLeft and Backspace on empty query go back`, `Backspace with a query does not go back`, `compact renders the drill-in in the sheet`, `disabled skill rows show the one-skill line`, `strip centres a file card beside a thumbnail` (CSS rule read as `browser-review-polish.test.tsx` does).
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run tests and `pnpm check:web-ui`, `pnpm check:i18n`; expect PASS.**
- [ ] **Step 5: Commit** `feat(design): composer menu drill-in and connector rows`.

### Task T6: Bubble tokens (design, normal)

**Files:**
- Modify: `packages/design/src/conversation/bubble.tsx`, `styles/conversation.css`, bubble reference block (text with tokens; skill chip then argument tokens)
- Test: `packages/design/test/chat.test.tsx` (or the bubble test it holds)

**Interfaces:**
- Consumes: `InlineToken`, `ComposerTokenData` (T4).
- Produces: `UserBubbleProps.segments?: ComposerSegment[]` (when given, drawn instead of `text`, tokens as `InlineToken` read-only, text runs through the same prose renderer as `text`); `BubbleSkill` stays first.

- [ ] **Step 1: Failing tests** `bubble draws tokens inline`, `skill chip precedes argument tokens`, `token names read in line order`.
- [ ] **Step 2–4: Run FAIL, implement, run PASS** (`pnpm exec vitest run packages/design/test/chat.test.tsx`).
- [ ] **Step 5: Commit** `feat(design): inline tokens in the user bubble`.

### Task T7: `tokens` on the message body, resolution, refusals, payload (kernel, high)

**Files:**
- Modify: `packages/kernel/src/conversations/conversations.controller.ts` (`MessageFields.tokens`, marker count and per-kind refine, `textRule`, create / send / first-message forwarding), `conversations.service.ts` (`UserMessageInput.tokens`, `needsAgent`, `resolveExtra`, `userMessage`, file lines in `postIn`), `conversations/events.ts` (`user_message.payload.inline`, `connectorMentions`), `files/library-files.service.ts` (`labelsFor`), `tools/connector-content.ts` (`resolveAttachments`: the agent check, `resource_unreadable`, block head), `errors.ts` (two codes), `apps/web/messages/{zh,en}.json` (error copy, spec §7 `errors.*` rows; the web reads `details[].reason`)
- Test: `packages/kernel/test/conversations/inline-tokens-send.test.ts` (integration), extend `project-files-send.test.ts`, `conversation-refs-send.test.ts`, `packages/kernel/test/sandbox/review-classifier.test.ts`

**Interfaces:**
- Consumes: T2 module; T1 `isUiTemplate`; T3 `connectorToolsFor`.
- Produces: body `tokens?: MessageToken[]` (old `attachments` / `projectFiles` / `conversationRefs` still accepted until T9b; a body with both `tokens` and any old field → 400). `UserMessageInput.tokens?: MessageToken[]`. `ResolvedExtra` gains `text: string` (content[0] with placeholders, or the skill arguments with placeholders), `inline: InlineEntry[]`, `connectorMentions: ConnectorMention[]`, `fileTokenIds: string[]`, `fileLabels: Map<string, string>`.
- Produces: log payload `connectorMentions?: { connectorId: string; slug: string; name: string; toolCount: number; loadedTools: string[] }[]` and `inline?: InlineEntry[]` (zod in `events.ts`; T8 reads `connectorMentions`).
- `LibraryFilesService.labelsFor(orgId: string, accountId: string, ids: string[]): Promise<Map<string, string>>`: names readable by the sender, read-only, outside the transaction; unknown ids are left for `attachForMessage` to refuse with today's codes.

- [ ] **Step 1: Zero-drift baseline.** `pnpm exec vitest run packages/kernel/test/evals/reconstruct.test.ts` → PASS; record it in the report.
- [ ] **Step 2: Failing integration tests** (`inline-tokens-send.test.ts`), each asserting the written `content` and payload or the refusal and that no event was written:
  - `marker count mismatch is 400` (`"a ￼"` with 0 and 2 tokens); `per-kind limits` (4 connectors → 400; 21 tokens → 400); `same entity twice counts once`.
  - `connector token renders placeholder and mention block` (`content[0] = "[connector: Slack] 给小明发消息"`, mention block text verbatim for tool search off).
  - `mention under tool search with 20 or fewer tools loads them` (`payload.connectorMentions[0].loadedTools` = the connector's offered keys; text ends `Its 2 tools are loaded from this message on.`), `more than 20 tools loads none` (fake connector with 21 tools; text ends `load the ones this message needs with ToolSearch.`; `loadedTools: []`).
  - `connector refused: not_found / needs_config / not_offered` (422 `conversation.connector_unavailable` with `details[0].reason`), `personal credential missing is accepted`, `connector refused after deletion writes nothing`.
  - `resource ui_template and empty refused` (422 `connector.resource_unreadable`), `resource refused when the agent does not offer read_resource` (`connector.resources_disabled`), resource block head `[resource: Send Message from Slack] Attached resource "Send Message" (<uri>) from the connector Slack:`.
  - `file token and uploads get file lines with shared numbering` (file token `a.png` + upload `a.png` → `[file: a.png]` in text, blocks `[file: a.png]`, media, `[file: a.png (2)]`, media), `upload-only message starts with a file line`.
  - `block order` (one of each kind: resources, project files, conversations, mentions, file tokens, uploads) and `inline offsets point at placeholders` (`content[0].text.slice(start, end)` equals each placeholder).
  - `skill arguments carry placeholders and inline offsets` (`payload.skill.arguments` contains `[connector: Slack]`, `inline` offsets index into it).
  - `retry with the same clientMessageId reads nothing` (fake connector records no extra `listResources` / `readResource`, `forAgent` not called a second time: assert via the fake's call log).
  - classifier: `review classifier still reads content[0] and project file lines` (adapt the existing indices test to a tokens body).
- [ ] **Step 3: Run, expect FAIL** (`pnpm exec vitest run packages/kernel/test/conversations/inline-tokens-send.test.ts`).
- [ ] **Step 4: Implement.** In `resolveExtra` (after the retry check, outside the transaction, under the request's org scope): split tokens by kind (dedupe by `tokenEntityKey`), resolve resources / project files / conversations with today's functions, connectors with one `forAgent` call (the conversation's agent, source and `sandboxConversationId` as the runtime uses them), file labels with `labelsFor`; number labels per kind in text order; `renderInline`; build mention blocks with `connectorMentionText`. In `postIn` interleave `fileLine(label)` before each media block returned by `attachForMessage` (file tokens first, then uploads, numbered after file tokens). `needsAgent` also true with connector or resource tokens.
- [ ] **Step 5: Run the new and extended tests, then reconstruct again; expect PASS, zero drift.**
- [ ] **Step 6: Commit** `feat(kernel): inline tokens and connector mentions in messages`.

### Task T8: Mention-loaded tools and replay (kernel, high)

**Files:**
- Modify: `packages/kernel/src/runtime/context/build.ts:1509` (`loadedToolKeys`)
- Modify: `.agents/skills/replay-evals/SKILL.md` ("Connector mentions", "Inline tokens"), `.agents/skills/writing-tools/SKILL.md` (`ToolSearch` loaded set has two sources)
- Test: `packages/kernel/test/runtime/loaded-tool-keys.unit.test.ts` (add to `unit-tests.json`), `packages/kernel/test/evals/reconstruct.test.ts` (two cases), `packages/kernel/test/runtime/mention-tools.test.ts` (integration)

**Interfaces:**
- Consumes: `user_message.payload.connectorMentions[].loadedTools` (T7).
- Produces: `loadedToolKeys(events)` = union in seq order of `tool_result.loadedTools` and `user_message.payload.connectorMentions[].loadedTools`.

- [ ] **Step 1: Zero-drift baseline** (reconstruct PASS).
- [ ] **Step 2: Failing tests**: unit `mentions add loaded keys in log order` (user_message mention `[a,b]` at seq 2, tool_result `[b,c]` at seq 4 → `[a,b,c]`); integration `next request carries mention-loaded tools` (model-fake records the request after a mention under tool search: tool names include `mcp__<slug>__<tool>`), `mention-loaded tools stay loaded on later turns`; reconstruct `connector mention loads tools` and `inline tokens` (placeholders + file token labels) at zero drift.
- [ ] **Step 3: Run, expect FAIL.**
- [ ] **Step 4: Implement.**
- [ ] **Step 5: Run all three plus reconstruct; expect PASS, zero drift.**
- [ ] **Step 6: Commit** `feat(kernel): connector mentions load their tools`.

### Task T9a: `ComposerBox` on the editor (design, normal; same branch as T9b)

**Files:**
- Modify: `packages/design/src/conversation/composer.tsx` (`ComposerInput` and `ComposerTokenChip` removed; `ComposerBox` takes `segments` / `onChange(segments)` / `editorRef?: Ref<ComposerEditorHandle>` / `onTrigger` / `onPasteFiles` in place of `value` / `onChange(string)` / `textareaRef` / `onPaste` / composition callbacks / `token`; the skill token is the first segment; `refused?: { label: string; reason: string; onRemove(): void }` draws the fail Callout line where the token warning stands), `menu.onKeyDown` typed on `KeyboardEvent`; the composer reference blocks and catalog; `packages/design/test/composer*.test.tsx`
- Test: update `composer.test.tsx`, `composer-token-warning.test.tsx`, `composer-suggestion.test.tsx`, `composer-phone.test.tsx`; new `refused Callout removes refused tokens`.

**Interfaces:**
- Consumes: T4 `ComposerEditor`, T5 menu props.
- Produces: the new `ComposerBoxProps` above (T9b's only design surface).

- [ ] **Step 1: Update the composer tests to segments; add the refused test; run, expect FAIL.**
- [ ] **Step 2: Implement; keep the token warning on typed and pasted text (`onPasteText`).**
- [ ] **Step 3: Run `pnpm exec vitest run packages/design/test` and `pnpm check:web-ui`; expect PASS.**
- [ ] **Step 4: Commit** `feat(design): composer box on the inline token editor`.

### Task T9b: The web switch and the old fields' removal (web + kernel, high judgment)

**Files:**
- Modify: `apps/web/src/components/conversation/ComposerBar.tsx` (segments state; `draftKey` = JSON of `[segments as [text | [kind, id]], upload ids, skill]`; `/` at start or after whitespace, commands only when `/` is the whole draft; skills disabled with 「一条消息只能使用一个技能」 once a skill token exists; `@` first level 连接器 ≤ 6 / 文件 ≤ 8 / 会话 ≤ 5, connector rows with `drill` when `resources`; second level from the per-connector resources query; ＋ menu: no 连接器资源, connector rows insert a token, → drills; ＋ 项目文件 inserts tokens at the caret; send body `{text with U+FFFC, tokens, files: uploadIds, skill?}` with the skill token removed and the seam whitespace collapsed; refusal codes mapped to tokens by `(kind, id)`; `ComposerControl.fill` → `replace`), `first-message-attempt.ts` (`ComposerDraft = { segments, skill, files, id?, refused? }`), `NewConversation.tsx`, `ConversationView.tsx`, `Thread.tsx`, `lib/conversations.ts` (`MessageInput`), `lib/timeline.ts` (`personText`, bubble `segments` from `payload.inline`), `lib/queries/*` (`mentionableConnectorsQuery(orgId, agentId)`, `connectorResourcesQuery(orgId, connectorId, query)`), `apps/web/messages/{zh,en}.json` (web copy; remove `composerMenu.resources`)
- Modify (kernel removal): `conversations.controller.ts` (drop `attachments` / `projectFiles` / `conversationRefs` from `MessageFields`, `textRule` per spec §3.1), `tools/connector-content.controller.ts` + `connector-content.ts` (`connectorId` required; the all-connectors branch deleted), their tests moved to tokens bodies
- Test: `apps/web/test/inline-tokens.test.tsx` (new), update `at-conversations.test.tsx`, `project-files.test.tsx`, `timeline.test.ts`, `first-message-attempt.test.ts`; kernel tests already on tokens

**Interfaces:**
- Consumes: T9a `ComposerBoxProps`, T3 route, T1 route, T6 `segments`, T7 payload.
- Produces: `personText(payload)`: `content[0].text` unless `content[1]` is a media block and `content[0].text` matches `/^\[file: .*\]$/` (then `""`); bubble segments rebuilt from `personText` and `payload.inline` (each entry → token with its kind, ref and label; skill invocations use `skill.arguments`).

- [ ] **Step 1: First-load baseline.** In a scratch worktree of origin/main: `pnpm --filter @capybara-hq/web build`, record `/`'s First Load JS (or, if Next prints none, the gzip sum of the chunks `/` loads per `.next/app-build-manifest.json`).
- [ ] **Step 2: Failing web tests** (`inline-tokens.test.tsx`): `@Slack inserts a token mid-sentence and sends U+FFFC + tokens` (body `text = "给 ￼ 发消息"`, `tokens = [{type:"connector",connectorId}]`); `project file picks insert tokens`; `uploads stay cards`; `draft identity changes on token move, not on label refresh`; `refusal marks the token and shows the Callout` (422 `conversation.connector_unavailable` → token refused, 「Slack 不能使用：这个智能体不能使用它」, 移除 removes it); `restore after a failed send`; `first-message attempt carries segments`; `second skill disabled`; `pasted text with U+FFFC sends a matching marker count`; `bubble draws skill chip then argument tokens`; `personText skips a leading file line and keeps old messages`.
- [ ] **Step 3: Run, expect FAIL** (`pnpm exec vitest run apps/web/test/inline-tokens.test.tsx`).
- [ ] **Step 4: Implement web; then remove the old body fields and the resources branch in the kernel; move kernel tests to tokens bodies.**
- [ ] **Step 5: Run web tests, the touched kernel tests, reconstruct (zero drift), `pnpm check:web-ui`, `pnpm check:i18n`, `pnpm check:platform-ops`; expect PASS.**
- [ ] **Step 6: First-load after.** Build again, record `/`'s First Load JS; put before / after in the PR description. If the growth exceeds the spec's 75 KB gzip estimate by more than 20 %, raise it as a maintainer decision (split the editor chunk behind the frame) instead of deciding alone.
- [ ] **Step 7: Commit** `feat(web): inline tokens in the composer and the bubble` (kernel removal in its own commit `feat(kernel)!: drop attachments, projectFiles and conversationRefs from messages`).

### Task T10: Spec and doc changes (docs, normal)

**Files:** `docs/design/spec.md` (§6.11 composer keys; §6.16.2 editor, tokens, centring, skill token, refusal line; §6.16.6 bubble tokens from `payload.inline`; §6.16.21 uploads only, items centred; §6.16.30 connectors group, drill, footer), `docs/superpowers/specs/2026-11-28-composer-menus-design.md` (§2, §4, §5), `2026-11-28-at-conversation-design.md` (§1, §3), `2026-11-27-file-library-design.md`, `.agents/skills/writing-web-ui/SKILL.md` (composer editor and tokens).

- [ ] **Step 1: Edit each section to match the spec's "Spec and doc changes".**
- [ ] **Step 2: `pnpm check` (design spec parser, agent docs) passes.**
- [ ] **Step 3: Commit** `docs: composer inline tokens across specs and skills`.

### Task T11: connector-mcp passes `size` (plugins repo, normal; after the SDK release)

**Files:** `/Users/grant/Capybara/plugins/plugins/connector-mcp/src/*` (the `listResources` mapping), its test, a changeset; the plugins repo's SDK pin to the released version with `size`.

- [ ] **Step 1: Failing test** `listResources passes size through` (fake MCP server resource with `size: 0` and `size: 12`).
- [ ] **Step 2–4: Run FAIL, implement, run PASS** (plugins repo `pnpm verify --fast`).
- [ ] **Step 5: Commit** `feat(connector-mcp): pass resource size`; PR in `capybara-hq/plugins`.

---

## Execution plan (waves)

| Task | Depends on (interfaces) | Files / areas | Risk | Wave | Review |
|---|---|---|---|---|---|
| T1 | — | plugin-sdk connector, connector-content, exclusions | normal | 1 | batched (W1 kernel) |
| T2 | — | conversations/inline-tokens.ts | normal | 1 | batched (W1 kernel) |
| T4 | — | design composer-editor, i18n token keys, visual config | normal (judgment-heavy, most capable implementer) | 1 | alone, most capable |
| T5 | — | design composer-menu, attachments, i18n menu keys | normal | 1 | batched (W1 design) |
| T3 | T1 (exclusions file) | mentionable-connectors, agents controller, exclusions | high (route auth, cross-tenant) | 2 | alone, most capable |
| T6 | T4 `InlineToken` | design bubble | normal | 2 | batched (W2) |
| T7 | T2, T1 `isUiTemplate`, T3 `connectorToolsFor` | conversations controller / service / events, library files, errors, web errors copy | high (kernel contract, replay) | 3 | alone, most capable |
| T8 | T7 payload | runtime build, replay / tools skills | high (replay) | 4 | alone, most capable |
| T9a | T4, T5 | design composer.tsx | normal | 4 | batched with T9b |
| T10 | — (text only) | docs/design/spec.md, three specs, writing-web-ui | normal | 4 | batched (W4) |
| T9b | T9a, T3, T6, T7, T1 | apps/web conversation + lib, kernel removal | high judgment | 5 | alone, most capable |
| T11 | T1 released | plugins repo | normal | after release | mid |

T4 and T5 both touch `i18n.ts` in separate regions; they run in separate worktrees and merge through git. T3 waits for T1 because both edit `platform/exclusions.ts`. T7 waits for T3's `connectorToolsFor`.

## Pull requests (merge order)

1. Plan (this document).
2. `feat/inline-tokens-resources` — T1.
3. `feat/inline-tokens-editor` — T4.
4. `feat/inline-tokens-menu-bubble` — T5 + T6.
5. `feat/inline-tokens-mentionable` — T3.
6. `feat/inline-tokens-contract` — T2 + T7 (kernel accepts `tokens` beside the old fields).
7. `feat/inline-tokens-loading` — T8.
8. `feat/inline-tokens-switch` — T9a + T9b + T10 (web switch, old fields removed); merged last.
9. Plugins: `feat/connector-mcp-resource-size` — T11, after the plugin-sdk release carrying `size`.

Each PR branches from origin/main (merging the branches it needs while they are unmerged) and links #1060.
