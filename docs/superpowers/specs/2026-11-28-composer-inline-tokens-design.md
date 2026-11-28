# Composer inline tokens: one way to reference things, and `@` a connector to use it

Status: draft for maintainer review (2026-11-28). Builds on the composer menus spec
(`2026-11-28-composer-menus-design.md`), the @ conversations spec
(`2026-11-28-at-conversation-design.md`) and the file library spec (`2026-11-27-file-library-design.md`).
It changes parts of all three; the changes are listed under "Spec and doc changes".

## Intent

The composer mixes two looks for the same act. A skill picked with `/` is a chip that can only sit
before the text (`/invoice-scan-match ×`), while a library file, a referenced conversation and a
connector resource picked with `@` land as file-like cards in the attachment strip, away from the
sentence that explains them. The `@` menu also lists connector *resources* rather than connectors, so
`@Slack` finds things like an empty MCP UI template (`FILE @Send Message Input Form 0 B`) instead of
Slack itself. What people mean is `@Slack 发个消息给小明`, `@Github pull 一下 main`: name the
connector, use it now.

This change makes everything picked through `/` or `@` an **inline token** that stands where it was
typed, inside the sentence; keeps uploads as attachment cards; lets `@` name a connector, which the
kernel turns into model-visible English and, under tool search, loads that connector's tools; and moves
connector resources to a second level under their connector, without the unreadable ones.

## Decisions (maintainer, 2026-11-28)

1. Everything picked through `/` or `@` (skills, conversations, connectors, library files picked by
   `@`, connector resources) is an inline token with an icon (file type mark, conversation icon, the
   connector's plugin icon through the kernel icon URL with the initial as fallback, skill as today),
   placed where it was typed.
2. Files uploaded by drag, paste or ＋ 上传文件 keep the attachment cards above the text (thumbnail,
   size).
3. The text sent to the model keeps token positions: each token's place becomes an English positional
   placeholder (§3.2), with the referenced content blocks after it as the existing resolution does.
   Replay-safe: everything is written into the `user_message`.
4. The input becomes a rich-text (`contenteditable`) composer in `packages/design`; `apps/web` still
   writes no styles.
5. `@`'s first level lists connectors themselves (only those the conversation's agent can use), plus
   library files and conversations. Picking `@Slack` inserts a connector token; on send the message
   carries a connector mention, which the kernel turns into model-visible English and, if the
   connector's tools are deferred behind tool search, loads them.
6. Connector resources move to a second level (→ on the connector row); resources with no readable
   content (MCP Apps UI templates, empty) are not listed.
7. `$` as an extra trigger is not added now (Open questions).
8. The `@ 会话` defaults left open earlier: Backspace now follows the token rule (a token right before
   the caret is deleted as one unit, wherever it stands, conversations included).

## Decisions taken in this spec (beyond the list)

- **References are tokens, uploads are cards.** Project files picked with ＋ 项目文件 are references too,
  so they become tokens at the caret (they were strip chips). The strip holds only uploaded files.
- **One wire field.** The message body's `attachments`, `projectFiles` and `conversationRefs` are
  replaced by one ordered `tokens` list whose positions are marked in `text` with U+FFFC (§3.1).
  Before 0.1.0 this changes the API directly (no compatibility layer).
- **`@` first level searches no resources.** Typing after `@` matches connectors by name, library files
  and conversations; resources are searched only inside one connector's second level. Today every
  resting keystroke after `@` opens a session on every active connector of the org
  (`acrossConnectors`, `tools/connector-content.ts:217`); afterwards one drill-in opens one.
- **A `needs_config` connector is listed, disabled, with 待配置**, as the ＋ menu already shows it
  (composer menus §2); a connector whose *personal* credential is not connected is pickable (the tool
  call then returns the existing connection card, `pipeline.ts:3957`).
- **Mention-loaded tools stay loaded** from that message on, like a `ToolSearch` load, not for one turn
  only: the loaded set only grows so the tools list stays append-only and cache-stable, and earlier
  calls of those tools keep their definitions.
- **At most one skill token per message**; once one is in the draft the `/` menu's skills are disabled
  with the line 「一条消息只能使用一个技能」.
- **Inline tokens have no ×.** They are removed with Backspace / Delete or by selecting over them; the
  strip's cards keep their remove buttons.
- **`/` opens mid-sentence** (at the start or after whitespace, like `@`); commands (`/compact`) are
  offered only when the `/` is the whole draft.

## Facts this design builds on (origin/main 161977935, 2026-11-28)

- **Composer (design).** `ComposerInput` is a `<textarea>` (`packages/design/src/conversation/composer.tsx:75-88`).
  The skill chip is drawn outside it, before the text (`ComposerTokenChip`, `composer.tsx:431-461`,
  spec §6.16.2 "Skill chip"), which is why it can only lead. IME composition is reported to the page
  (`composer.tsx:299-308`); the menu's keys come first (`composer.tsx:569`).
- **Composer (web).** `ComposerBar` holds `text`, `attachments` (`@` resources), `skill`,
  `projectFiles`, `conversationRefs` and upload drafts as separate state
  (`apps/web/src/components/conversation/ComposerBar.tsx:482-529`). The draft identity is
  `draftKey(text, resources, files, projectFiles, conversationRefs, skill)` (`ComposerBar.tsx:119-137`),
  kept with its `clientMessageId` until the draft changes (`ComposerBar.tsx:707-708`); a failed send
  hands the whole `ComposerDraft` to the next composer (`ComposerBar.tsx:281-296`). Triggers: `/`
  only when it is the whole draft, `@` at the start or after whitespace (`triggerAt`,
  `ComposerBar.tsx:808-815`). The `@` menu lists files, conversations, then resources grouped by
  connector (`atContent`, `ComposerBar.tsx:1198-1229`); the ＋ menu's connector rows open `@` filtered
  to that connector, a `needs_config` one disabled with 待配置 (`ComposerBar.tsx:1300-1310`). The body
  sent is `{text, clientMessageId, attachments, files, projectFiles?, conversationRefs?, skill?}`
  (`ComposerBar.tsx:709-719`; `MessageInput`, `apps/web/src/lib/conversations.ts:979`).
- **Send body (kernel).** `MessageFields` (`packages/kernel/src/conversations/conversations.controller.ts:102-163`):
  `attachments` ≤ 5 (`MAX_ATTACHMENTS`, `tools/connector-content.ts:39`), `files` (uploads and library
  files alike), `projectFiles` ≤ 10, `conversationRefs` ≤ 3, `skill`. `textRule`
  (`conversations.controller.ts:166-192`): with resources, project files or conversation refs the text
  must not be empty, because their blocks follow `content[0]`. The create and send routes forward the
  fields one by one (`conversations.controller.ts:309-315`, `700-709`).
- **Resolution.** `postUserMessage` (`conversations.service.ts:1641`) loads the agent only for a model
  switch or a skill (`needsAgent`, `conversations.service.ts:1676`), then `resolveExtra`
  (`conversations.service.ts:2029-2064`, outside any transaction) reads the resources
  (`resolveAttachments`, `connector-content.ts:347-396`: block text `Attached resource "<name>"
  (<uri>) from app <connector>:` + body ≤ 50 000 chars), checks project files (`projectFileText`,
  `conversations.service.ts:373`) and reads conversation refs (`conversationRefText`). `userMessage`
  (`conversations.service.ts:2252-2285`) writes `content = [text, ...extra.blocks, ...fileBlocks]`
  with `payload.attachments` / `projectFiles` / `conversationRefs`. A library or uploaded file is a
  media block carrying its `name` (`fileContentBlock`, `files/library-files.service.ts:107-133`); an
  image reaches the model as a bare image block with no name next to it.
- **Resources listing.** `GET /orgs/:orgId/connectors/resources?query=` (`connector-content.controller.ts:49-58`)
  opens a session on every active connector of the org whose `read_resource` tool is enabled
  (`listResources`, `connector-content.ts:303-339`), regardless of the agent; it returns every listed
  resource (≤ 500) whose name / URI / description contains the query, with `mimeType` when given.
  Nothing filters UI templates (`ui://`, `text/html;profile=mcp-app`) or empty resources. The SDK's
  `listResources()` item is `{uri, name, description?, mimeType?}` (`packages/plugin-sdk/src/connector.ts:26`);
  MCP's `size` is not carried. The route is a Platform exclusion (`internal`, `platform/exclusions.ts:715`).
- **Which connectors an agent can use.** `ToolRegistry.forAgent` (`tools/registry.ts:660`) offers a
  connector's tools when it is live, `active`, `ready` (not `needs_config`), its connector extension
  is installed and the agent's `disabledTools` do not switch it off (`registry.ts:864-930`); tool keys
  are `mcp__<slug>__<tool>` (`tools/naming.ts:1-4`); `read_resource` is one of them (source
  `resources`). The connector icon is `GET /orgs/:orgId/connectors/:connectorId/icon`
  (`connectors.controller.ts:185`).
- **Tool search.** When on, the request carries the builtins plus the **loaded** tools; the loaded set
  is the union of `tool_result.loadedTools` in the log (`loadedToolKeys`,
  `runtime/context/build.ts:1509-1516`, used at `build.ts:1446`). The pipeline lets the model call
  only tools whose definitions the issuing request carried (`pipeline.ts:1700-1702`).
- **Skill invocation.** `payload.skill.arguments` holds the typed arguments; `content[0]` is the
  rendered skill (`conversations/events.ts:1085-1105`, `typedInvocation` `events.ts:2252`).
- **Bubble.** `userText` shows `content[0]` alone when the message has resources, project files or
  conversation refs (`apps/web/src/lib/timeline.ts:709-716`); the rest draws as chips.

## Design

### 1. Tokens

| Kind | Picked from | Icon (lead, 16) | Visible label | Copied as plain text |
|---|---|---|---|---|
| `connector` | `@` first level, ＋ 连接器 | the connector's icon (`ObjectMark` 16 from the icon URL, initial fallback) | `Slack` | `@Slack` |
| `resource` | `@` → second level | the connector's icon | `Send Message` (resource name) | `@Send Message` |
| `file` | `@` 文件, ＋ 文件库 | file type mark (§6.16.19 badge, mini) | `report.pdf` | `@report.pdf` |
| `projectFile` | ＋ 项目文件 | `file-code` | `src/app.ts` (path, start-truncated) | `@src/app.ts` |
| `conversation` | `@` 会话 | `chats` | title / 未命名会话 | `@<title>` |
| `skill` | `/` | none (as today) | `/invoice-scan-match` in mono `accent` | `/invoice-scan-match` |

- A token is one atomic inline element in the text flow. Look (design): inline-flex, height one
  prose line minus 4 (22 at `prose` 26), padding 0 `space.1`, gap `space.1`, radius `sm`, `selected`
  ground, label in the prose font `ink`, max width 16em (medium 12em, compact 10em) with an ellipsis,
  the full label in its tooltip. The skill token keeps today's `accent-tint` ground and mono `accent`
  label (an action, not a reference). A selected token (caret selection over it, or a tap) gets the
  `accent` 1px outline.
- **Refused** (after a send refusal, §3.4): 1px `fail` border, `fail` label, `circle-alert` lead in
  place of the icon. The composer shows one fail Callout line at the top of the frame (where the token
  warning stands): 「<label> 不能使用：<reason>」 with 「移除」, which removes the refused tokens.
- Accessible name: `<kind>: <label>` (「连接器：Slack」 / "Connector: Slack"); refused adds 「，不可用」
  / ", unavailable" and is described by the reason.

### 2. The editor (design: `ComposerEditor`, replacing `ComposerInput`)

A `contenteditable` element owned by `packages/design`, with a model the component keeps: an ordered
list of segments, each a text run or a token (`{kind, id, label, icon?, state?}`). The DOM is rendered
from the model; tokens are `contenteditable="false"` spans. The page (`ComposerBar`) passes and
receives segments only (`value: Segment[]`, `onChange(segments, caret)`), never DOM. The editor uses
`beforeinput` for every edit it performs itself and lets the browser edit text runs during an IME
composition, reading the result at `compositionend`.

Behaviour contract (each line is a test, §8):

- **IME.** During a composition (`compositionstart` … `compositionend`, or `isComposing`) no trigger
  opens a menu, the query does not change, ↵ never picks or sends and no token is committed; at
  `compositionend` the committed text is read and a trigger it contains opens the menu as typed. A
  composition never spans a token: the caret is never placed inside one, and a composition that starts
  next to a token edits only the neighbouring text run. A full-width `＠` committed by an IME is not a
  trigger (only `@`); Shift+2 committed directly types `@` as today.
- **Caret.** ← / → step over a token in one move; Shift+← / → extend the selection over it as a unit;
  ↑ / ↓ move by line as the browser does. A click on a token selects it; a click in text places the
  caret. The caret is never inside a token.
- **Deleting.** Backspace with the caret right after a token deletes the token (one unit, one undo
  step); Delete with the caret right before one deletes it; ⌥/Ctrl+Backspace deletes the previous word
  or the previous token, whichever is nearer. A selection over tokens deletes them with the text.
  This replaces the skill chip's "Backspace at the start removes the chip" and settles the @
  conversations default (decision 8).
- **Undo / redo.** The editor keeps its own history (the browser's breaks on DOM rendering): ⌘Z /
  Ctrl+Z, ⇧⌘Z / Ctrl+Y and `beforeinput` `historyUndo` / `historyRedo`. A step ends at a token insert
  or delete, a paste, a caret jump, a menu pick and a 1 s pause in typing; an IME composition is one
  step. The history keeps 100 steps and is cleared on send. A page's `ComposerControl.replace` (quick
  actions) stays one undoable step.
- **Paste.** Plain text only (`text/plain`; HTML and other types are ignored, files go to the upload
  strip as today). Pasted text never becomes tokens, even `@Slack` or `/skill`, and never opens a
  menu; line breaks are kept; U+FFFC and other format characters (`Cf`) are stripped. The token
  warning still runs on paste.
- **Copy / cut.** A selection is written as `text/plain` with each token as its plain form (table
  above); nothing else (no custom type, so a paste back is text, by the paste rule).
- **Drafts.** `ComposerDraft` becomes `{segments, skill, files (uploads), id?, refused?}`; `refused`
  names refused tokens by `(kind, id)` with their reason. A failed send restores the segments with the
  refused tokens marked; the new conversation's layout switch and the first-message attempt carry it as
  today (`first-message-attempt.ts`).
- **Draft identity.** `draftKey` becomes the JSON of `[segments as [text | [kind, id]], upload ids,
  skill]`: moving a token, adding one or editing text is a new message (new `clientMessageId`);
  re-rendering a label (a title fetched later) is not.
- **Mobile keyboards.** `autocapitalize="sentences"`, `autocorrect` and predictive text on; tokens are
  atomic for the keyboard too (the editor ends a composition that would cross one). On touch a tap on
  a token selects it and the keyboard's delete removes it. ↵ on a soft keyboard is a newline as today;
  send is the button.
- **Screen readers.** The editor is `role="textbox"` `aria-multiline="true"` and, while the page passes
  `menu`, the combobox of §6.16.2 (`aria-expanded`, `aria-controls`, `aria-activedescendant`); each
  token is `role="img"` with its accessible name (§1), so reading the line says
  「给 连接器：Slack 发消息」. Inserting a token announces nothing extra (the name is read in place).
- **Growth and placeholder.** One line when empty, grows to 8 lines then scrolls, as the textarea did;
  the placeholder and the skill's argument hint (faint ghost text after the skill token while nothing
  follows it) as today.
- **Form participation.** No hidden textarea; the editor exposes `value` / `focus()` / `insertToken()`
  / `replace()` through its ref so `ComposerControl` keeps working.

### 3. Message contract (kernel)

#### 3.1 Body

`MessageFields` (send, create's `message`, first-message):

```ts
text: z.string().max(100_000),            // U+FFFC marks each token, in order
tokens: z.array(Token).max(MAX_TOKENS),   // MAX_TOKENS = 20
files: z.array(z.uuid()).max(100),        // uploads only (the cards)
skill: { name } | undefined,              // the skill token; not in `tokens`, no U+FFFC
// removed: attachments, projectFiles, conversationRefs

Token =
  | { type: "connector", connectorId: uuid }
  | { type: "resource", connectorId: uuid, uri: string(1..2000) }
  | { type: "file", id: uuid }
  | { type: "projectFile", path: string(1..4096) }
  | { type: "conversation", id: string(1..100) }
```

- The number of U+FFFC in `text` must equal `tokens.length`, else 400 `validation_failed` (「Each
  token needs one U+FFFC marker in text, in order」). The web never lets a U+FFFC into a text run.
- Per kind: `connector` ≤ 3 (`MAX_CONNECTOR_MENTIONS`), `resource` ≤ 5 (`MAX_ATTACHMENTS`),
  `projectFile` ≤ 10, `conversation` ≤ 3; `file` tokens plus `files` ≤ `attachments.maxPerMessage`.
  The same entity may appear more than once in the text (its placeholder at each place, its block
  once, counted once).
- `textRule`: text may be empty only with a skill, or with uploads and no tokens (a token always
  renders a placeholder, so `content[0]` is never empty when blocks follow).
- The skill token: the web removes it from the text (collapsing the whitespace at the seam) and sends
  `skill`; the rest is the skill's arguments, which may contain other tokens.
- The internal `UserMessageInput` keeps resolved arrays; the queue (kernel-internal) takes no tokens,
  as it takes no project files today.

#### 3.2 Placeholders (model-visible, English)

Each U+FFFC is replaced by its token's placeholder in `content[0]` (and so in the skill's rendered
arguments):

| Kind | Placeholder |
|---|---|
| connector | `[connector: Slack]` |
| resource | `[resource: Send Message from Slack]` |
| file | `[file: report.pdf]` |
| projectFile | `[project file: src/app.ts]` |
| conversation | `[conversation: Pricing for the EU plan]` (untitled: `[conversation: Untitled conversation]`) |

- A label is the name at send time with control characters and line breaks folded to a space, `[` and
  `]` replaced by `(` and `)`, trimmed, at most 80 code points (then `…`).
- When two different entities of one kind in a message would get the same label, the second gets
  ` (2)`, the third ` (3)`, in text order, in the placeholder and in its block head.
- `「@Slack 给小明发消息」` is sent as `[connector: Slack] 给小明发消息`.

#### 3.3 Blocks after `content[0]`

Order (kept from today, the new kinds appended inside it so the classifier's indices do not move):
resources, project files, conversations, **connector mentions**, **file tokens**, uploads.

- **Resource:** today's block with the placeholder first:
  `[resource: Send Message from Slack] Attached resource "Send Message" (<uri>) from the connector Slack:\n\n<body>`.
- **Project file:** `[project file: src/app.ts] Referenced project file: src/app.ts (in the project root <root>; read it with Read when needed).`
- **Conversation:** the @ conversations block unchanged, with `[conversation: <label>]` as its first line.
- **Connector mention** (new, `connectorMentionText`):

  ```
  [connector: Slack] The person named the connector "Slack" for this message. Its tools are named mcp__slack__<tool>.
  ```

  followed by one sentence decided at send time from the agent's resolved tools (`forAgent`):
  tool search on and the connector offers ≤ 20 tools → `Its <n> tools are loaded from this message on.`;
  tool search on and more → `It has <n> tools; load the ones this message needs with ToolSearch.`;
  tool search off → nothing (every tool is already in the request). The text states the mechanism
  only (no instruction about what to do with Slack).
- **File token:** a text block `[file: report.pdf]` immediately before the file's media block, so an
  image (sent bare) is tied to its place in the sentence. Uploads keep today's blocks with no label.

#### 3.4 Validation and refusals

All resolved in `resolveExtra` (outside the transaction, after the `clientMessageId` retry check, as
the sender, under the request's org scope); any refusal writes nothing. `needsAgent` becomes true with
connector or resource tokens.

- **Connector:** the agent's `forAgent` tools must include at least one tool of that connector
  (`source.connectorId`). Otherwise `conversation.connector_unavailable` (422,
  `details: [{connectorId, reason}]`), `reason`: `not_found` (deleted, disabled, another org),
  `needs_config`, `not_offered` (the agent switches it off, none of its tools is enabled, or its
  connector extension is not installed). A missing personal credential is not a refusal.
- **Resource:** today's checks (`connector.not_found`, `connector.resources_disabled`) plus the
  agent check (its `read_resource` tool must be offered: `connector.resources_disabled`), plus new
  `connector.resource_unreadable` (422, `details: [{connectorId, uri, reason: "ui_template" | "empty"}]`):
  a UI template (§5) or a body that is empty after trimming.
- **File, project file, conversation:** unchanged codes (`file.*`, `conversation.project_file_unavailable`,
  `device.path_outside_project`, `conversation.reference_unavailable`, `conversation.reference_self`).
- The web maps each code's details to the token by `(kind, id)` and marks it refused (§1).
- New error codes are registered in `errors.ts` with zh / en copy (§7).

#### 3.5 Logged payload

`user_message.payload` gains:

- `inline: [{kind, start, end, label, ref}]`: where each token's placeholder stands (UTF-16 offsets
  into `content[0]`, or into `skill.arguments` for an invocation), its label and its reference
  (`{connectorId}`, `{connectorId, uri}`, `{fileId}`, `{path}`, `{id}`). **Display only**: request
  building never reads it.
- `connectorMentions: [{connectorId, slug, name, toolCount, loadedTools: string[]}]`: `loadedTools`
  are the connector's tool keys loaded by the mention (empty when tool search was off or the
  connector has more than 20 tools).

`attachments`, `projectFiles`, `conversationRefs` stay as they are (they name the blocks).

#### 3.6 Tool loading and replay

- `loadedToolKeys` (`build.ts:1509`) becomes the union of `tool_result.loadedTools` **and**
  `user_message.payload.connectorMentions[].loadedTools`, in log order. A keyed tool not offered at a
  step is ignored, as today. The message is absorbed before the step's request is built, so the tools
  are in the first request after it (a mid-run message: the next step); the pipeline's sent-tools
  check (`pipeline.ts:1700`) needs no change.
- Replay: every model-visible change is in the log (`content` blocks, `loadedTools` in the payload);
  request building reads no PG, config or clock for it. No new `DriftReason`: nothing here can differ
  between the recording and a reconstruction that the existing reasons do not already cover (a
  candidate with another tool set is `tools_changed` / `tool_spec_missing`). Zero-drift fixtures run
  before and after; `reconstruct.test.ts` gains the case "connector mention loads tools" and
  "inline tokens" (placeholders + file token labels).
- The command review's classifier keeps reading `content[0]` (now with placeholders, still the
  person's sentence) and the project file lines; the new blocks come after them.

### 4. `@` menu: connectors first, resources second

- **First level** groups, in order: 连接器 (≤ 6 rows), 文件 (≤ 8, the file library as today), 会话
  (≤ 5, as the @ conversations spec). Rows of 连接器: the connector's icon, its name, its description
  as the line (or 「需要连接你的账号」 / "Connect your account first" when a personal credential is
  missing), a 待配置 badge and disabled for `needs_config`, and a trailing → (`composer-menu-drill`,
  「查看 Slack 的资源」 / "Browse Slack resources") when it offers `read_resource`. ↵ / click on the row
  inserts the connector token; → (key or button) opens the second level.
- Data: new route `GET /orgs/:orgId/agents/:agentId/mentionable-connectors` (`agents.use`, human
  principal) → `{connectors: [{id, slug, name, description?, icon: string | null, state: "ready" |
  "needs_config", credential: "connected" | "missing" | "none", toolCount, resources: boolean}]}`:
  the org's live, active connectors of which `forAgent` offers the agent at least one tool, plus the
  `needs_config` ones (shown disabled); no session is opened. The web filters by the query
  (`commandScore`, client side) through a `defineQuery` cached per agent.
- **Second level** (state `at-resources`): the menu head shows 「‹ Slack · 资源」 (a back button,
  「返回」 / "Back"); the text after `@` that named the connector is cleared (the `@` stays) and
  further typing filters resources. ← or Backspace on an empty query goes back (Backspace then does
  not delete the `@`). Rows: the connector's icon, the resource name, its description or URI as the
  line. ↵ inserts a resource token. Compact: the bottom sheet's in-sheet drill-in (§6.59) with the
  search field.
- ＋ menu: the 添加 group loses 连接器资源 (resources are reached through their connector); a 连接器
  group row inserts the connector token, its → opens the resources.
- Footer (841 up): 「@ 连接器、文件与会话 · / 技能与命令 · ↑↓ 选择 · → 资源 · ↵ 使用 · esc 关闭」.

### 5. Resources listing (kernel)

- `GET /orgs/:orgId/connectors/resources` takes a required `connectorId` (uuid) and the optional
  `query`; it opens one session (that connector, the sender's credential), refuses one not active or
  whose `read_resource` is off (`connector.resources_disabled`), and lists at most 200.
- Not listed: a resource whose `mimeType`, compared case-insensitively without spaces, is
  `text/html;profile=mcp-app`, or whose URI scheme is `ui:`; a resource whose `size` is 0.
- SDK: `listResources()` items gain the optional `size?: number` (MCP `Resource.size`): a public SDK
  API change (`pnpm gen:sdk-api`, changeset on `@capybara-hq/plugin-sdk`); `connector-mcp` passes it
  through (plugins repository follow-up). Without `size` a resource is listed and an empty body is
  refused at send (§3.4).
- Platform: the route stays an exclusion (`internal`); its reason is updated to name the second level.

### 6. Size classes

| | compact (< 600) | medium (600–840) | expanded (≥ 841) |
|---|---|---|---|
| Editor | inside the pill, mobile type; tokens max 10em, icon 14 | tokens max 12em | tokens max 16em |
| `@` menu | bottom sheet with search; second level as in-sheet drill-in; → is the whole row's trailing button `touch.hit` | anchored; → button on the row | anchored; → button, key hints with `→ 资源` |
| Attachment strip | uploads only, thumbnails and cards as today | same | same |
| Refusal | Callout line above the editor, buttons under the sentence | line, buttons at the end | line, buttons at the end |

The adaptation lives in `ComposerEditor`, `ComposerMenu` and the attachment strip; `apps/web` passes
data only and never reads the size class.

### 7. Copy (zh / en)

| Key | zh | en |
|---|---|---|
| composerMenu.connectorsGroup | 连接器 | Connectors |
| composerMenu.drill | 查看 {name} 的资源 | Browse {name} resources |
| composerMenu.resourcesHead | {name} · 资源 | {name} · Resources |
| composerMenu.back | 返回 | Back |
| composerMenu.connectYourAccount | 需要连接你的账号 | Connect your account first |
| composerMenu.noResources | {name} 没有可引用的资源 | {name} has no resources to reference |
| composerMenu.oneSkill | 一条消息只能使用一个技能 | One skill per message |
| composerMenu.atSheetTitle | 连接器、文件与会话 | Connectors, files and conversations |
| composerMenu.footAt | @ 连接器、文件与会话 | @ Connectors, files and conversations |
| composerMenu.footDrill | → 资源 | → Resources |
| composer.token.connector | 连接器：{name} | Connector: {name} |
| composer.token.resource | 资源：{name} | Resource: {name} |
| composer.token.file | 文件：{name} | File: {name} |
| composer.token.projectFile | 项目文件：{name} | Project file: {name} |
| composer.token.conversation | 会话：{name} | Conversation: {name} |
| composer.token.skill | 技能：{name} | Skill: {name} |
| composer.token.unavailable | {name}，不可用 | {name}, unavailable |
| composer.refused | {name} 不能使用：{reason} | {name} can't be used: {reason} |
| composer.refusedRemove | 移除 | Remove |
| errors.conversation.connector_unavailable.not_found | 这个连接器已不存在或已停用 | This connector no longer exists or is turned off |
| errors.conversation.connector_unavailable.needs_config | 需要管理员先完成配置 | An admin needs to finish setting it up |
| errors.conversation.connector_unavailable.not_offered | 这个智能体不能使用它 | This agent can't use it |
| errors.connector.resource_unreadable.ui_template | 这是界面模板，没有可读内容 | It is a UI template with nothing to read |
| errors.connector.resource_unreadable.empty | 这个资源是空的 | This resource is empty |

Removed: `composerMenu.resources` (＋ 连接器资源), the skill chip's 「移除 /name」.

## Not in this change

- `$` as a trigger (Open questions).
- Tokens in IM channel messages, scheduled task prompts or the queue.
- Rich text beyond tokens (no bold, lists or links in the composer).
- Showing the skill token at its typed position in the bubble: the bubble keeps the skill chip first,
  then the arguments with their tokens.

## Spec and doc changes

- Composer menus spec §2 (＋: no 连接器资源; connector rows insert a token), §4 (`@` groups, no
  resources at the first level, the second level), §5 (project files become tokens; `projectFiles`
  folds into `tokens`).
- @ conversations spec §1 (the field becomes a `conversation` token), §3 (an inline token, not a
  strip chip; Backspace by the token rule).
- File library spec: a file picked by `@` is a token; uploads stay cards.
- `docs/design/spec.md`: §6.16.2 (the editor, tokens, skill chip replaced, refusal line), §6.16.21
  (uploads only; conversation states move to the token), §6.16.30 (connectors group, drill, footer),
  §6.16.6 (bubble draws tokens from `payload.inline`), §6.11 composer keys; reference blocks, catalog,
  baselines through `visual-update`.
- replay-evals skill: "Connector mentions" (loaded set includes `connectorMentions[].loadedTools`) and
  "Inline tokens" (placeholders, display-only `inline`).
- writing-web-ui skill (composer editor and tokens), writing-connectors skill (resources listing
  filter, `size`), writing-tools skill (`ToolSearch` loaded set).

## Tests (outline)

- **Design (jsdom + Playwright Chromium / WebKit for IME and caret):** `ComposerEditor` caret over
  tokens, Backspace / Delete / word delete, selection over tokens, undo / redo steps, paste as plain
  text (no tokens, U+FFFC stripped), copy plain forms, IME (`compositionstart` holds triggers, ↵
  during composition neither picks nor sends, commit opens the menu), combobox aria, token names,
  refused look, size classes; `ComposerMenu` connector rows with →, second level and back, compact
  drill-in.
- **Web:** `@Slack` inserts a token mid-sentence and sends `text` with U+FFFC + `tokens`; ＋ 项目文件
  inserts tokens; uploads stay cards; draft identity changes on token move, not on label refresh; a
  refusal marks the token and shows the Callout with 移除; restore after a failed send and through the
  first-message attempt; bubble draws tokens from `payload.inline`; second `skill` disabled.
- **Kernel:** marker count mismatch → 400; per-kind limits; placeholders and label folding and
  `(2)` collisions; block order and indices (classifier unchanged); connector refusals
  (`not_found`, `needs_config`, `not_offered`) and personal credential missing accepted; mention text
  for tool search on ≤ 20, on > 20, off; `loadedTools` recorded and the next request carries them;
  resource `ui_template` / `empty` refusals; resources route requires `connectorId`, filters UI
  templates and `size: 0`; mentionable-connectors route (agent `disabledTools`, `needs_config` shown,
  guests); retry with the same `clientMessageId` reads nothing; `reconstruct.test.ts` zero drift
  before and after plus the two new cases.
- **Platform parity:** the new route's exclusion, the changed body schema.
- **Checks:** `check:sdk-api` (the `size` field), `check:i18n`, `check:web-ui`.

## AGENTS.md rules touched

- **Web UI.** `ComposerEditor`, tokens and the menu's drill-in are design components with reference
  blocks and states; `apps/web` passes segments and data through `defineQuery` / `useAppMutation`,
  writes no styles; no box in a box (tokens are inline marks, the refusal is a Callout line).
- **Mobile and shells.** The editor, tokens and menu adapt by size class inside `packages/design`;
  compact uses the bottom sheet's drill-in; touch taps never focus the composer from a sheet.
- **Runtime and replay.** Placeholders, labels and the connector mention text are written into the
  `user_message` at send; the mention's loaded tools are logged in its payload and read into the loaded
  set from the log; no new `DriftReason` (argued in §3.6); zero-drift fixtures before and after.
- **Tools.** `ToolSearch`'s loaded set gains a second source (mentions); keys keep no dots.
- **Connectors.** The resources listing becomes per connector and drops UI templates and empty
  resources; reads stay with the sender's credential.
- **Platform tool.** The new `mentionable-connectors` route is an exclusion (`internal`, like the
  resources and prompts routes: it feeds the web input box; an agent already has its connectors'
  tools); the send routes stay exclusions, so the body change touches no operation.
- **Public API reports.** `listResources()` gains `size?` (SDK report + changeset).
- **Kernel.** `createZodDto` body, explicit `@Inject`, new error codes registered with zh / en.
- **Before 0.1.0.** `attachments` / `projectFiles` / `conversationRefs` leave the body without a
  compatibility layer.
- **Language / i18n.** Model-visible text English; new UI copy zh / en with 智能体.

## Open questions

1. **`$` trigger.** Add `$` (e.g. for skills or variables, as some tools do) as an extra trigger? Not
   now (decision 7).
2. **Editor engine.** This spec builds a thin own editor on `contenteditable` + `beforeinput`. If the
   Android keyboard tests (Gboard / Sogou composition across tokens) prove it fragile, adopt Lexical
   (MIT) inside `packages/design` instead; the contract in §2 stays.
3. **Big connectors.** A connector with more than 20 tools loads none and points to `ToolSearch`.
   Alternative: load the 20 best matches of the message text (deterministic `ToolSearch` scoring over
   that connector's tools).
4. **Mention lifetime.** Mention-loaded tools stay loaded for the rest of the conversation (cache and
   history reasons). Confirm, or prefer an explicit unload at a compaction boundary.
5. **Labels on uploads.** Uploaded images still reach the model unlabeled; give uploads a
   `[file: <name>]` line too, for symmetry?
6. **Skill position in the bubble.** Keep the skill chip first in the bubble, or record its typed
   offset and draw it in place?
