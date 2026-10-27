---
name: writing-extension-ui
description: 'Use when adding UI to an extension (an inline card, a properties section or a right panel on the conversation page, a file previewer, or an org page under the "Extensions" menu): the places panel / section / inline / page / file-preview, icons, open targets and ToolResult.card; choosing between a rendered schema view and an embed iframe; the manifest ui contribution and permissions.ui.views / embeds (an embed blocks loading and is sensitive), the perm-ui check; ctx.ui.view / action / invalidate (signal, timeout, error codes); UiView blocks and UI_LIMITS; the bilingual ToolResult.display summary; embed tokens (verifyEmbedToken, not accepted by /api), the /plugin-ui proxy (header allowlist, CSP sandbox), the message bridge (init, navigate rules), SSE via ctx.bus with req.signal; reference plugins/todo, plugins/example-board, and how to write tests.'
---

# Writing extension UI

**Where this goes after the repository split** (phase A3b, spec §6.2): the official plugins move to `capybara-hq/plugins` and the author half of this skill moves with them; author tooling is `capybara-plugin pack | check` (`@capybara-hq/plugin-tools`, `.agents/skills/writing-plugins` "Toolchain"; in core `pnpm pack-plugin` and `pnpm check`). **Stays in core**: the web host (tabs, the "Extensions" menu, the `/plugin-ui` proxy and CSP, the message bridge's host side), embed token issuing and `verifyEmbedToken`, view rendering and `UI_LIMITS`; tested on the `fake-tools-ui` and `fake-embed` extensions of `@capybara-hq/testing`. Moves: the manifest and `ctx.ui` rules as an author uses them and the plugin tests of `todo` and `example-board`.

## What this skill covers

Adding UI to an extension (a tab on the right of the conversation page, or an org page under the top-bar "Extensions" menu): how to choose between the two tiers (rendered schema view / embed iframe); the manifest ui contribution (place, kind, an embed's path under /ui/ and declared as GET) and permissions.ui.views / embeds, a view does not block loading while an embed does and is a sensitive item, the perm-ui check; ctx.ui.view / action / invalidate (respond to signal, 5 second timeout, error codes, web refresh coalescing); UiView blocks and UI_LIMITS (text is shown as plain text in M4, images accept only http(s), actionId is unique, danger buttons, use Object.hasOwn for table cells); the bilingual summary in ToolResult.display for tool results; embed tokens (300 seconds, valid only for their own extension, verifyEmbedToken checks enablement, not accepted by /api), the /plugin-ui proxy (header allowlist, private / no-store, forwards only embed tokens, CSP sandbox), the message bridge (init sent only on the first load, no navigation before load, remount limit, History API, navigate rules), static pages carry no data, SSE subscribes to ctx.bus per request with req.signal; reference plugins/todo, plugins/example-board, and how to write tests.

For general extension authoring (manifest, permission approval, ctx, multi-replica prohibitions, dual-replica tests) see `.agents/skills/writing-extensions`, and for tools themselves see `.agents/skills/writing-tools`; this skill covers only the UI. The design basis is `docs/superpowers/specs/2026-10-21-chat-panel-plugin-ui-design.md`. Reference implementations:

- Tier 1 (rendered schema view): `plugins/todo`, views `tasks-panel` / `tasks-section` / `tasks-card` (and the alias `tasks`); `todo__write` returns `card` and calls `invalidate` after writing.
- Tier 2 (embed): `plugins/example-board`, org page `board` and conversation panel `board-conv` (still declared with the old `place: "conversation"`), icon `layout-grid`, with live SSE refresh.

## How to choose between the two tiers

| | Tier 1: rendered schema (`kind: "view"`) | Tier 2: embed (`kind: "embed"`) |
|---|---|---|
| What the extension provides | `render()` returns a `UiView` (a list of blocks), drawn by the web app with design system components | A full page of HTML / JS served by extension routes, placed in a sandboxed iframe |
| Styles and code | The extension cannot write styles or run code | The page is responsible for itself and can use the `--cb-*` design tokens sent by the outer page |
| Interaction | Buttons and forms call back into `ctx.ui.action` | Anything (drag and drop, multi-user collaboration, complex forms) |
| Refresh | `ctx.ui.invalidate` -> the web app re-fetches the view | The extension opens its own SSE / long polling |
| Approval | Recorded in the snapshot, **does not block loading** | **Blocks loading**, needs approval, a sensitive item |

**Use tier 1 whenever you can**: lists, progress, key-values, tables, simple charts, a few buttons or one form are all covered, and there is no new security surface. Only things the blocks cannot draw (kanban drag and drop, real-time multi-user editing, workflow canvases) should use an embed.

Both tiers can be placed in the same positions: `panel` / `section` / `inline` on the conversation page (below; the old `place: "conversation"` means `panel`); `place: "page"` is an org page in the top-bar "Extensions" menu, route `/p/<plugin>/<id>`. A contribution appears only in **orgs where this extension is enabled**; kind view also requires that the extension actually registered a render with `ctx.ui.view`.

**Roles (Ruling A38)**: contributions with `place: "page"` (view and embed) are given only to org roles **member and above**. A guest's contribution list has no org pages; when a guest fetches an org page view, runs its actions, mints an embed token for an org page, or connects to the org-level refresh stream, the answer is always 404 `ui.not_found` (the same as if it did not exist). Contributions with `place: "conversation"` are given as usual to any role that can access the conversation (a guest also uses shared agents). The extension can read `role` (`owner` / `admin` / `member` / `guest`) in `UiRenderArgs` / `UiActionArgs` / `EmbedClaims` and can tighten further on it (for example, only member and above may change data); but it does not need to block guests from org pages itself, the kernel already does.

## Conversation page places (UI refresh B)

> The kernel and SDK side is built (Tasks 11–12). The web page that shows sections, inline cards
> and the title-bar panel icons arrives with UI refresh B Tasks 18–20; until then the web shows
> `panel` contributions as right-side tabs.

The conversation page (design spec §5.4, §6.16; UI refresh spec §5.3) has three extension slots. `UiPlace` is `"panel" | "section" | "inline" | "page" | "file-preview"`, plus the old `"conversation"`:

| Place | Where | Notes |
|---|---|---|
| `panel` | A right panel opened from the extension's icon in the conversation title bar | Full height, one at a time; the old `place: "conversation"` means `panel` and keeps working unchanged (the registry normalizes it; API output carries `legacyPlace: "conversation"`) |
| `section` | A section of the properties panel (under Context) | Rendered `dense`; a `badge` shows as the section's value (todo's "1 / 3") |
| `inline` | An inline card in the stream | **Hangs off a tool result**: the tool returns `card: { view: "<inline view id>", key? }` in its `ToolResult` (display only, recorded as `tool_result.card: { plugin, view, key? }`, never in the model's context). An unknown view id is dropped with a warning and the result still succeeds. Extensions cannot write card events into the log themselves |
| `page` | An org page under "Extensions" | Unchanged |
| `file-preview` | An embed previewer of `file-preview@1` (below) | Embed only |

- **Icon**: a contribution may set `icon` from `UI_ICONS` (`list-checks`, `layout-grid`, `file`, `chart`, `calendar`, `users`, `bot`, `book`, `message-square`, `puzzle`); the default is `puzzle` (drawn as the design `extension` icon). The title-bar button uses it, so pick one per panel.
- **Open targets**: `UiOpen = { contribution, item? }`, where `contribution` is a `panel` of the same extension. A view may carry `open` (the ⤢ in an inline card's title row and the section header); checklist items and keyValue items may carry `open` and `id`; a table block carries a parallel `open?: (UiOpen | null)[]` (never a `_open` key in a row). Clicking opens that panel scrolled to the block or item whose `id` equals `item`; `render` receives it as `UiRenderArgs.item`, and an inline card's render receives `card: { callId, key? }`.
- **Access**: `section` and `inline` views follow the conversation rule (anyone who can read the conversation, guests included); `page` stays member and above.
- **Not enabled, not shown**: in an org where the extension is not enabled its icon, sections and cards don't appear. A failing block shows "Failed to load · Retry" in that block only (10 s timeout on the conversation page); the stream keeps going.
- **Aliases**: `aliasOf: "<id>"` keeps a retired id answering as another contribution of the same extension and kind (it is not listed, has no `ctx.ui.view` of its own, but stays in `permissions.ui`). Refresh it too while it lives (todo invalidates `tasks` with the rest).
- **Kernel**: the contributions list normalizes the place (`legacyPlace: "conversation"` where it applied) and always carries `icon`; aliases and `file-preview` embeds are not listed. The views route takes `?item=` (→ `args.item`) and `?callId=&key=` (→ `args.card`; `key` needs `callId`; served only for an `inline` view when a `tool_result` of that conversation recorded the same card, plugin, view or its alias target and key, else 404 `ui.not_found`). The pipeline keeps a plugin tool's `card` only when it names an `inline` contribution of the same extension (`ToolPipelineDeps.inlineViews`), otherwise it warns and drops it.
- Reference: `plugins/todo` validates all three (views `tasks-panel` `panel` with icon `list-checks`, `tasks-section` `section` whose items open the panel, `tasks-card` `inline` returned by `todo__write` as `card`; the old `tasks` id stays an alias of `tasks-panel` for one release). `plugins/example-board` is an embed `panel` with icon `layout-grid`.

### File previewers (`file-preview@1`)

Previewing a file output in the right panel is the extension point `file-preview@1` (org scoped, several providers). A provider lists `previewers`, each with an `id` (`[a-z0-9-]{1,40}`), a bilingual `title`, `accepts: { mimeTypes?, extensions? }` (at least one; `image/*` allowed; extensions match case-insensitively), `maxBytes` (≤ `FILE_PREVIEW_MAX_BYTES`, 20 MB) and exactly one of `render(args) => UiView` or `embed: <id of a ui contribution { kind: "embed", place: "file-preview" }>`. The extension never gets a storage key or a URL: `render` reads the bytes through `args.read()`, a read grant for that one file in that conversation, valid only during the call; an embed gets them through the message bridge (`type: "file"` after `init`). An org admin orders and disables previewers; an accepting extension previewer wins over the built-in ones (image, text, Markdown, CSV / TSV), and the person can switch in the panel header. A slow or failing previewer affects only the panel and falls back to the file card with Download.

- **Validated at `ctx.provide`**: an invalid provider (`validateFilePreviewProvider`), or an `embed` that names no ui contribution `{ kind: "embed", place: "file-preview" }` of the same extension, fails `setup`.
- **Kernel routes** (`packages/kernel/src/files/previewers.controller.ts`): `GET /api/v1/orgs/:orgId/conversations/:id/files/:fileId/previewers` → `{ previewers: { plugin, id, title, kind }[] }` (the viewer must read the conversation); `GET …/files/:fileId/previews/:plugin/:previewerId?locale=` → `{ view }` (10 s → 504 `ui.timeout`, a throw, including a rejected `read()`, → 502 `ui.render_failed`, an invalid view → 502 `ui.invalid_view`); `GET | PUT /api/v1/orgs/:orgId/file-previewers` (`org.extensions.manage`) → `{ items }`, the org order (`capybara.file_previewers`: listed items first, the rest in provider order). The settings page section is `apps/web/src/components/FilePreviewersSection.tsx`.
- **Embed previewers**: the web asks the existing embed-token route with `{ conversationId, fileId }`; the kernel issues it only when an enabled previewer of that extension with `embed: <contribution>` takes that file, and the claims carry `fileId`. `createEmbedBridge({ file })` posts the file once after `init` (again only to a remounted document).
- **Tests**: `packages/plugin-sdk/test/file-preview.test.ts`, `packages/kernel/test/files/previewers.http.test.ts` (fake provider `test/fixtures/plugins/preview-fake`), `apps/web/test/previewers.test.tsx`.

## Manifest

```ts
defineExtension({
  name: "todo",
  ui: [
    { id: "tasks-panel", title, place: "panel", kind: "view", icon: "list-checks" },
    { id: "tasks-section", title, place: "section", kind: "view", icon: "list-checks" },
    { id: "tasks-card", title, place: "inline", kind: "view", icon: "list-checks" },
    { id: "tasks", title, place: "conversation", kind: "view", aliasOf: "tasks-panel" },
  ],
  permissions: {
    tools: ["write"],
    ui: { views: ["tasks-panel", "tasks-section", "tasks-card", "tasks"] },
  },
  // ...
});

defineExtension({
  name: "example-board",
  ui: [
    { id: "board", title: { zh: "看板", en: "Board" }, place: "page", kind: "embed", path: "/ui/board" },
    { id: "board-conv", title: { zh: "看板", en: "Board" }, place: "conversation", kind: "embed", path: "/ui/board-conv" },
  ],
  permissions: {
    http: [{ method: "GET", path: "/ui/board" }, { method: "GET", path: "/ui/board-conv" }, /* data routes are also under /ui/ */],
    ui: { embeds: ["board", "board-conv"] },
  },
});
```

- A contribution `id` matches `^[a-z][a-z0-9-]{0,39}$` and is unique within the extension; both the zh and en parts of `title` must be non-empty and <= 100 characters.
- `path` is allowed only on embeds: it starts with `/ui/` and is declared as `GET <path>` in `permissions.http`. All routes an embed uses (page, scripts, data, SSE) must be under `/ui/`; the web proxy forwards only there.
- **Two-way cross-check** (`defineExtension` -> `validateUiContributions`, which the kernel also runs when loading): the id of a kind view must be listed in `permissions.ui.views`, and that of a kind embed in `permissions.ui.embeds`; conversely every id in `permissions.ui` must have a contribution of the same kind. The same id cannot be listed on both sides.
- **Approval**: the permission keys are `ui.view:<id>` and `ui.embed:<id>`.
  - `ui.view:*` is recorded in the snapshot and visible when admins review, but **never blocks loading**: when an extension upgrade adds only views it loads as usual and the kernel merges them into the snapshot (no audit entry, one info log `plugin ui views merged into the permission snapshot`); `capybara extensions approve` also answers "no approval needed" for such an upgrade. The reason is that a view only hands the extension's existing data to our components and adds no new extension point. Exception: a brand-new extension (no snapshot yet) needs approval even if it has only views.
  - `ui.embed:*` blocks loading like any other newly added permission, waits for `capybara extensions approve`, and is a **sensitive item**: `capybara extensions review` / `approve` mark it with `  (sensitive)` after it, and the `ui` group on the org enablement page is highlighted. There is only one definition of sensitive (`isSensitivePermissionKey` in `permission-view.ts`).
- **Static check `perm-ui`** (`pnpm check:extension-permissions`): the id of `ctx.ui.view(id)` / `ctx.ui.action(id)` must be in `permissions.ui.views` (action is also checked against views; embeds do not go through action). Write the id as a string literal or a same-file const; dynamic values and aliasing `ctx.ui` both report "Cannot statically confirm", and for ones truly only known at runtime use the exemption `// capybara:allow-dynamic-permission <reason>`; an outright undeclared id cannot be exempted. When passing `ctx.ui` to another function, pass a wrapper (todo's `{ invalidate: (t) => ctx.ui.invalidate(t) }`) so the check can see the usage.

## Tier 1: `ctx.ui`

```ts
setup(ctx) {
  ctx.ui.view("tasks", async ({ orgId, accountId, conversationId, locale, signal }) =>
    tasksView(conversationId === undefined ? [] : await readTodos(ctx.db, conversationId)),
  );
  ctx.ui.action("tasks", async ({ actionId, payload, answer, signal }) => {
    // ...
    return { toast: { zh: "已清空", en: "Cleared" } }; // or { view: newView }, or {}
  });
}
// when the data changes:
await ctx.ui.invalidate({ orgId, conversationId, contribution: "tasks" }).catch(() => {});
```

- `view` / `action` can be called only in `setup` (sealed when setup ends), and the id must be in `permissions.ui.views`, otherwise `ExtensionPermissionError` is thrown and an out-of-scope audit entry is written; registering the same id twice throws.
- The identities in the arguments (`orgId`, `accountId`, `role`, `conversationId`) are given by the kernel after authentication: a conversation view has already verified that the caller can access this conversation, and the extension never gets the user's session credentials. Org pages (place page) are not passed `conversationId`. `locale` is the web app's current language (`zh` / `en`, default `en`), and text in the view is produced according to it.
- **5 second timeout; both `render` and `action` must respond to `signal`**: pass it to queries and external requests (`fetch(url, { signal })`) and give up as soon as it aborts. After a timeout the user sees a failure and may retry, so a write in an `action` in particular must not keep running to completion after the timeout.
- A failure affects only that one tab (it shows the error and "Retry"); the conversation keeps streaming as usual; the kernel logs a warning and writes nothing to the conversation log. Error codes:

  | Code | Status | When |
  |---|---|---|
  | `ui.not_found` | 404 | extension not enabled / not loaded, contribution does not exist, an embed fetched as a view, the view has no action, the conversation is not accessible (someone else's, nonexistent, another org's, id is not a UUID) |
  | `ui.render_failed` | 502 | `render` threw (the extension's exception message is not echoed) |
  | `ui.action_failed` | 502 | `action` threw |
  | `ui.invalid_view` | 502 | the returned view or toast is invalid |
  | `ui.timeout` | 504 | over 5 seconds (`signal` has been aborted) |
  | `validation_failed` | 400 | a conversation view lacks `conversationId`, an org page carries one, the action request body is over the limit |

- Action request body: `actionId` 1-200 characters; `payload` <= `UI_LIMITS.payloadBytes` in UTF-8 bytes of its JSON; the number of keys and the multi-select length of a form `answer` <= `UI_LIMITS.tableRows`, a single text <= `UI_LIMITS.textChars`. When `{ view }` is returned the web app replaces the view directly (the badge is updated together), and for `{ toast }` it shows `toast[locale]`.
- **`invalidate({ orgId, conversationId?, contribution })`**: `contribution` is an id in the manifest `ui` (view or embed both work), and `conversationId` must be a conversation UUID. With a conversation it is sent to the conversation topic, and the conversation SSE receives `event: ui` `{"plugin","contribution"}`; without one it is sent to the org topic, and the org-level SSE `GET /api/v1/orgs/:orgId/ui/stream` receives it. It crosses replicas through the Redis bus, and the extension needs to do nothing. The kernel first checks the target with one query: this extension is enabled in `orgId`, and when a conversation is given it belongs to `orgId`; if not satisfied it is silently dropped (only a debug log, no error). It is only a "go fetch again" hint, and authorization happens when the view is fetched; a refresh failure should not affect business writes, hence `.catch(() => {})`.
- **Web refresh coalescing**: each view has at most one request in flight at a time; refreshes that arrive in flight, however many, produce just one re-fetch after it completes; the old view is kept during the re-fetch, with no flash back to loading; after the event stream reconnects, all views are re-fetched once (frames may have been missed during the disconnection). So you can call invalidate on every write without throttling yourself.

## Tier 1: `UiView` blocks and limits

The types and `validateUiView` are in `packages/plugin-sdk/src/ui.ts`; the kernel validates every `render` / `action` return one by one, and an invalid one is handled as `ui.invalid_view`.

| Block | Fields | How the web app draws it |
|---|---|---|
| `heading` | `text` (non-empty) | small heading |
| `text` | `markdown` | **Shown in M4 as plain text with line breaks** (Ruling A36): Markdown is not rendered, links are not clickable, raw HTML is treated as text. The field is still named `markdown` and validation still requires links to be absolute http(s) addresses (defense in depth); it will be upgraded when a Markdown component exists |
| `checklist` | `items[{ text, status: pending / in_progress / completed }]` | a checklist; the `in_progress` item is highlighted, `completed` is struck through |
| `keyValue` | `items[{ label, value }]` | key-value table |
| `table` | `columns[{ key, label }]`, `rows[Record<key, string>]` | data table. Column keys cannot repeat; a row cannot have undeclared columns, but may omit columns |
| `code` | `language?`, `text` | monospace code block |
| `image` | `url`, `alt` | **Absolute http(s) addresses only** (<= 2000 characters, Ruling A34); a relative address under the extension's own routes is rejected |
| `chart` | `kind: bar / line`, `series[{ label, value }]` | bar chart / line chart; `value` must be a finite number |
| `actions` | `buttons[{ actionId, label, payload?, danger? }]` (non-empty) | a group of buttons, calling back into `ctx.ui.action` |
| `form` | `form: InputForm`, `actionId`, `submitLabel` | reuses the form fields of `ask_user`; submitting goes through `action` (with `answer`); it does not submit while a required field is empty |

A view may carry a `badge` (<= 32 characters), shown on the tab, such as todo's "2/4".

- **Limits `UI_LIMITS`**: `blocks` 50; `tableRows` 200 (also the cap on the number of keyValue items, table columns, chart points and buttons); `checklistItems` 100; `textChars` 20000 (the total of all text in the whole view; a form counts by JSON length); `payloadBytes` 2000 (the JSON byte count of a single button `payload`; one that cannot be serialized is also an error). Going over makes the whole view invalid, so truncate yourself and give text such as "N more items".
- **`actionId` is unique across the whole view** (buttons and forms counted together); the action callback uses it to tell sources apart.
- **Danger buttons** `danger: true`: the web app first shows `DangerConfirm` and requires the user to type the button text before running. Mark every delete, clear and irreversible operation. Buttons in a view are never primary buttons (the only primary action on a page is "Send").
- **Use `Object.hasOwn(row, key)` for table cells**, not `row[key]` or `key in row`: a column key may be `constructor` or `toString` and would pick up values from the prototype chain. Follow the same rule when you write your own rendering (such as future IM cards).
- Text in a view is for people: produce Chinese or English according to `locale`. It does not enter the model context.

## The display summary for tool results, `ToolResult.display`

A tool (extension tools and builtin tools) can return in its result a sentence meant only for people, and the tool-call line in the conversation stream shows it instead of the raw input JSON:

```ts
return {
  content: [{ type: "text", text: renderTodos(todos) }],
  display: { summary: { zh: `更新任务清单（${n} 项）`, en: `Updated task list (${n} items)` } },
};
```

- Give both Chinese and English, each <= 200 code points (`validateToolDisplay`); an invalid one is dropped by the kernel with a warning logged, and the result is written as usual.
- The summary goes into the log with the `tool_result` event, so reloading the page restores it; it **does not enter the model context**, and neither rebuilding the model request nor generating compaction records uses it, so anything the model needs must be written in `content`.
- Without a summary (connector tools' are never trusted), the web app falls back to "tool name + the first two fields of the input". Details are in `.agents/skills/writing-tools`.

## Tier 2: embeds

The extension's own page is placed in the web app's sandboxed iframe (`sandbox="allow-scripts allow-forms"`, without `allow-same-origin`, so it has an opaque origin) and cannot read the outer page or cookies. `apps/web` renders the iframe only through the design system's `EmbedFrame` (the `web-ui-iframe` rule of `check:web-ui`).

### Embed tokens

- The web app calls `POST /api/v1/orgs/:orgId/ui/embeds/:plugin/:id/token` (a conversation embed carries `{ conversationId }`) and gets `{ token, src, expiresAt, expiresIn }`; `src` is `/plugin-ui/<plugin>/<path with the leading /ui/ removed>`, such as `/plugin-ui/example-board/board`. At signing time the kernel has already verified that the extension is enabled, the contribution is an embed, and the caller can access this conversation.
- A token is `base64url(claims).base64url(HMAC)`, **stateless** (not stored in the DB or Redis), verified by every replica with the same master key; valid for 300 seconds (`EMBED_TOKEN_TTL_SECONDS`, tolerating 30 seconds of clock skew); after a master key rotation, tokens signed by the previous key remain valid until they expire. The claims are `EmbedClaims`: `plugin`, `orgId`, `accountId`, `role`, `conversationId?`, `contribution`, `exp` (`role` is written at signing and checked at verification to be one of the four roles).
- **Every data route of the extension first does `await ctx.ui.verifyEmbedToken(token)`** and returns 401 if it returns null. It accepts only tokens signed for **this extension** (a token signed for another extension is always null), and each time uses one PG query to confirm that this extension is still enabled in `claims.orgId`, the org is not deleted, and the account is active and still a member of that org (Ruling A37, not cached): after an org disables the extension, a member leaves, or an account is disabled, already-issued tokens become invalid immediately, and after re-enabling the unexpired ones work again. The returned `role` is the role at verification time; an org-page token also returns null after the caller is demoted to guest. Take the org, account and conversation only from the returned claims, and trust no parameter in the request. A conversation token must scope data by `conversationId`; an org token (no conversation) must not see data inside conversations (example-board's `scoped()`).
- **The kernel's `/api` does not accept embed tokens**: the auth guard treats a Bearer only as an API token (`cap_pat_` / `cap_svc_`) lookup, and an embed token is always 401 `auth.required`. The worst outcome of a leaked token is calling **this extension's** data routes as that user within 300 seconds.

### The `/plugin-ui` same-origin proxy

The web app's `/plugin-ui/<plugin>/<rest>` is forwarded to the kernel's `/plugins/<plugin>/ui/<rest>` (`apps/web/src/lib/plugin-ui-proxy.ts`):

- Only GET / POST pass (OPTIONS answers 204 for preflight); a non-conforming extension name or path segment (empty segment, `.` / `..`, containing `/`, `\` or control characters after decoding) is a 404 without forwarding. An undeclared route gets 404 from the kernel.
- **Request header allowlist**: `accept`, `accept-language`, `cache-control`, `content-type`, `if-modified-since`, `if-none-match`, `last-event-id`, plus the trusted `x-forwarded-for`. Cookies and the CSRF header are not forwarded. **`Authorization` is forwarded only as a Bearer in the embed-token shape** (`Bearer <base64url>.<base64url>`, not starting with `cap_`), so API tokens and Basic never reach the extension.
- **Response header allowlist**: `content-type`, `cache-control`, `etag`, `last-modified`, `expires`, `vary`, `content-language`, `x-accel-buffering`, `retry-after`; other headers such as `Set-Cookie`, `Clear-Site-Data`, HSTS, NEL and `Link` are dropped. A 3xx `Location` is kept only if it is still under `/plugin-ui/<this plugin>/` and unchanged after normalization.
- **Caching can only be private**: if this request forwarded a token it is always `no-store`; without a token, the extension's Cache-Control has `public` / `s-maxage` / `proxy-revalidate` removed and `private` prepended; if none is given it is `no-store`.
- Every response gets the same security headers: CSP (`default-src 'self'`, scripts and styles allow `'unsafe-inline'`, `connect-src 'self'`, `frame-ancestors 'self'`, `base-uri 'none'`, `object-src` / `frame-src` / `worker-src 'none'`, and the critical **`sandbox allow-scripts allow-forms`**: a page opened directly at top level is also an opaque origin and cannot call `/api` same-origin with the user's cookies), `nosniff`, `Referrer-Policy: no-referrer`, `Access-Control-Allow-Origin: *` (without `Allow-Credentials`).
- The request body limit is the same as `/api` (413 when exceeded), an unreachable upstream is 502, and the response body is streamed through (SSE works).
- So always use **relative addresses** in the page (`fetch("cards")`, `<script src="board.js">`); external resources are blocked by the CSP.

### The message bridge (`postMessage`, protocol `capybara-embed/1`)

- **Outer -> iframe**:
  - `init` (token, `locale`, `theme`, the `--cb-*` design tokens (at most 300, each value <= 200 characters), `context: { orgId, conversationId? }`) is **sent only on the iframe's first `load`**; if the token arrives late, wait until it arrives and then send.
  - `token`: renewal, scheduled after a token is obtained at `max(30 seconds, expiresIn - 60 seconds)` (not relative to the browser clock); on failure retry after 10 seconds and show a warning line in the tab.
  - `theme`: sent when the outer theme switches.
- **A second `load` of the iframe is taken as having left the extension page** (whole-page navigation, a navigation caused by a form submit, assigning to `location`): the outer page sends it no more messages and handles none of its messages, and remounts the iframe at the original `src`; at most 3 remounts within 10 seconds, beyond that it stops and shows an error until the user clicks "Retry". So:
  - **Use the History API for multiple pages** (`history.pushState` plus a front-end router), not whole-page navigation.
  - **The page must not navigate before `load`**: the outer page sees only the `load` event and cannot tell which document it is for, so `init` (with the token) goes to the first document that fires `load`. Do not redirect during loading, and do not use `location.replace` or `<meta http-equiv="refresh">`; route-level redirects may only stay under this extension's `/plugin-ui/<plugin>/`.
- **iframe -> outer**, using `window.parent.postMessage(msg, "*")` (an opaque origin cannot specify a targetOrigin); the outer page first checks that the source is this iframe, then validates with `parseEmbedChildMessage`, and ignores what it does not recognize:
  - `resize { height }`: 0-10000, which the outer page clamps to 120-4000 pixels.
  - `navigate { path }`: only an in-site path (such as `/chat/<id>`): a single leading `/`, no `//`, backslash or control characters anywhere; no `.` / `..` segments in the path part (including `%2e` encoding), no `%2f` / `%5c` / `%00`-`%1f` / `%7f`; identical to the original after URL normalization; <= 2000 characters. Non-ASCII characters are first passed through `encodeURIComponent`. The SDK and the web app validate verbatim identically, sharing the test vectors `tools/fixtures/embed-navigate-vectors.json`.
  - `toast { text }`: non-empty, <= 500 characters, shown as plain text.
- The outer implementation is in `apps/web/src/lib/embed-bridge.ts` and `components/chat-panel/EmbedTab.tsx`; extensions need not care about it and only follow the rules above.

### Pages and data

- **Static pages and scripts carry no data** and may skip token verification (an iframe navigating by `src` cannot carry an `Authorization` header, and the token is given only by `init`); data is given only through routes that verify the token. Do not put the token in the URL query string (it would enter logs and browser history).
- Build the DOM with `textContent`; data does not go through `innerHTML`. For styles use `var(--cb-*, fallback)`, written to `:root` on `init` / `theme`.
- **Real-time refresh goes through `ctx.bus`, subscribed per request**: in an SSE route `await ctx.bus.subscribe(topic, ...)`, and unsubscribe when `req.signal` aborts (the client disconnects) or in the `ReadableStream` `cancel`; end the stream proactively at the token's `exp`, and the page reconnects with the renewed token, so permissions expire with the token. Heartbeats use `AbortSignal.timeout` as a wait within this request, not a timer; do not keep a module-level subscription table. The page reads the stream with `fetch` (`EventSource` cannot carry an `Authorization` header). The writer calls `ctx.bus.publish` once and the streams on all other replicas receive it.
- `req.signal` aborts only if the client disconnects before the response has been fully written; it does not abort after a normal finish.

## Writing tests

- **Pure functions**: unit-test the view function (todo's `tasksView`) and assert `validateUiView` returns empty; for a tool handler inject a fake `ui` (`{ invalidate: async (t) => void calls.push(t) }`) and assert the call arguments; see `plugins/todo/test/todo.test.ts`.
- **Kernel API (single-replica `createKernel`)**: `packages/kernel/test/ui/views.http.test.ts` (success, 502, 504, invalid view, someone else's conversation 404, not enabled 404, service token 403) and `embed.http.test.ts` (signing 401 / 403 / 404 / 400, a token calling `/api` 401, another extension's token 401, cross-org / cross-conversation isolation, 401 after disabling). The test extension `test/fixtures/plugins/ui-probe` covers the various failures, and its route `POST /invalidate` can trigger a refresh from a chosen replica.
- **Permissions**: `packages/kernel/test/ui/permissions.test.ts` (`planApprovals`, host upgrades adding views / embeds, fixtures `ui-a` -> `ui-a-view` -> `ui-a-embed`); for the CLI's `(sensitive)` marker see `apps/capybara/test/plugins.test.ts`.
- **Dual-replica**: `packages/kernel/test/ui/ui-stream.dual.test.ts`, `embed.dual.test.ts` and the acceptance test `m4-segment3.dual.test.ts`. For SSE use `openSse(url, headers)` from `test/helpers/sse.ts` to connect straight to one replica's port (`replicaOf(res)` confirms where it landed), `until(pred)` to wait for frames, and `uiFrames(messages)` to extract the data of `event: ui`. For cross-replica refresh assertions open streams on **both** replicas (which replica a tool runs on is not certain); for unsubscription assert with Redis `PUBSUB CHANNELS` that no subscription is left over.
- **Web**: `apps/web/test/chat-panel.test.tsx` (tabs, failure retry, the embed tab's sandbox / init / ignoring other windows), `embed-bridge.test.tsx`, `plugin-ui-proxy.test.ts`; end-to-end `e2e/embed-board.spec.ts`.
