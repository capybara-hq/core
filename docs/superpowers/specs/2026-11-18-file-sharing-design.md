# File sharing and full HTML rendering

Status: draft for maintainer review (2026-11-18). Follows the file preview plugin
(capybara-hq/plugins `docs/superpowers/specs/2026-11-17-file-preview-plugin-design.md`, "project B").

## Intent

Agents produce files people want to show others: above all HTML report pages that load a chart
library from a CDN, but also spreadsheets, PDFs, documents and code. Today a file can only be seen
by the conversation's owner, inside the conversation, and HTML is shown sanitized (no scripts, no
network), so report pages that draw charts render empty.

This project lets the owner of a conversation share one file of it through a short link, with
colleagues in the org or with people outside it (customers, partners), and renders HTML fully
(scripts and CDN libraries) both in the conversation's right panel and on the share page, safely.

## Goals

- Share a single conversation file (delivered by the agent or uploaded) as a **snapshot** taken
  when the link is created, through `https://<deployment>/s/<code>` (10-character code).
- Two audiences: **internal** (signed-in members of the org) and **external** (anyone with the
  link, no sign-in).
- A share page with a top bar (file name, who shared it, expiry, download) over the file rendered
  exactly as in the right panel: HTML by the kernel's sandboxed HTML document, every other format
  by the org's file previewers (the file preview plugin and the web's built-ins), and a download
  only when nothing can preview it.
- Full HTML rendering in the right panel and the share page: scripts run, styles, scripts and fonts
  load from an allowlist of public CDNs, and the page can reach nothing else.
- Governance: external sharing is off until the super admin allows it on the platform and an org
  admin turns it on in the org; expiry bounded by a platform maximum; creators and org admins can
  revoke; every open is audited.

## Non-goals

- Sharing a whole conversation (maintainer decision).
- Creating a share from a channel (IM) conversation's chat, or by the agent through a tool. A
  bound person's channel conversations appear in their web list, so they share from the web.
- Access codes, email verification, password-protected links (maintainer chose link-only).
- Turning off download (once a page shows the content it can be saved anyway).
- A separate content origin (domain) for shared or rendered content (maintainer decision: not
  needed, see "Isolation without a second origin").
- Shares that follow the latest version of a file (maintainer chose snapshots).
- Multi-file HTML (maintainer decision): an HTML file is rendered and shared alone. Relative
  references to files next to it (`app.js`, `style.css`, `chart.png`) do not load, in the panel or
  on the share page; inline code and allowlisted CDN resources do. To steer agents toward
  self-contained reports, the `Deliver` tool's description gains one sentence ("an HTML report
  should be one self-contained file: inline its own CSS and JS, load libraries from a public CDN,
  embed images as data URLs"); a model-visible change, so it follows the replay rules
  (replay-evals skill: zero-drift fixtures before and after, a `DriftReason` if required).
- View analytics beyond the audit log; search-engine visibility.

## Anti-goals (a failure even if it works)

- Shared or rendered HTML that can read the viewer's session, call `/api`, or navigate the app.
- Links that can be guessed or enumerated.
- External sharing on by default, or possible in an org whose admin did not turn it on.
- A rendered HTML page that can send the data it shows to an arbitrary server.
- The share page and the right panel drifting apart (a format that previews in one but not the
  other).

## Facts this design builds on (origin/main, 2026-11-18)

- A conversation belongs to exactly one account (`conversations.account_id`);
  `ConversationAccess.isAccessible` only lets the owner see it. Channel conversations are per
  person: DMs belong to the sender, and in a group thread every person has their own conversation
  (`channel_threads` is unique per account). Unbound senders under the `anonymous` policy write
  into the org's anonymous guest account, which cannot sign in, so its files cannot be shared.
- Conversation files are objects under `kernel/<orgId>/`: delivered files at
  `artifacts/<conversationId>/<artifactId>`, uploads at `attachments/<id>`.
  `ConversationFiles.file(orgId, conversationId, viewer, fileId)` resolves a file id (artifact id
  or attachment id) to `{ id, name, contentType, size, objectKey }` for kernel use; for uploads,
  `storedMatches` (size + etag) must hold.
- `object-store@1` has no copy: a snapshot is a `get` stream piped into a `put`.
- File previewers: the web asks `GET …/files/:fileId/previewers` for the org's ordered previewers;
  an extension previewer that accepts the file beats a web built-in (image, markdown, csv, tsv,
  text). Two kinds: an **embed** previewer never reads data itself (the outer page fetches the
  bytes with `host.read()` and posts them over the bridge; the file preview plugin's routes are
  all public and carry no data); a **view** previewer is rendered by the kernel
  (`GET …/files/:fileId/previews/:plugin/:previewerId`, `FilePreviewArgs` carries `accountId` and
  `conversationId`). The web built-ins read the kernel's text route (text only, truncated, no NUL
  bytes) or an inline image URL.
- A delivered file's id is one version (`artifactId`); versions are grouped by `sourcePath`.
- Embed tokens (`packages/kernel/src/ui/embed-token.ts`) are stateless HMAC tokens (300 s) whose
  claims require `accountId` and an org role; `verifyEmbedToken` re-checks membership on every
  use. The bridge always fetches a token.
- The file preview plugin claims `text/html` today (sanitized render, Rendered/Source toggle).
- `apps/web` proxies `/api/*` to the kernel on the same origin; public web pages are listed in
  `PUBLIC_PREFIXES` (`apps/web/src/lib/routes.ts`); public kernel routes are `@Public()` and
  listed in `packages/kernel/test/identity/public-routes.test.ts`.
- Platform settings live in `deployment_settings`; org settings in `orgs.settings`. The "Full
  access" pair (`devicesFullAccess` platform setting, org `fullAccess`) is the precedent for
  "super admin allows, org admin enables", including "only a person on the web may widen it"
  (`onlyNarrows` in the org-settings operation, `autoModeWidenRefused`). Its defaults differ
  (platform `allowed`, org absent = follow the platform); external sharing deliberately defaults to
  off at both levels.
- Org and conversation deletion are soft; `storage-org-purge` later deletes `kernel/<orgId>/`.
  Member removal runs `offboard` (one transaction of revocations).

## Approaches

1. **Kernel renders HTML; sharing is a kernel module** (chosen). The kernel serves HTML as a
   stand-alone document whose response CSP sandboxes it (opaque origin) and limits what it loads
   to the CDN allowlist; the right panel and the share page both iframe that document. Every other
   format goes through the existing previewers on both surfaces. One security boundary for HTML,
   one allowlist, no difference between preview and share.
2. **The file preview plugin keeps HTML and lets its scripts run.** Rejected: the plugin's embed
   holds a bridge to the host and an embed token for the plugin's routes; running agent-written
   scripts in it hands both to untrusted code. Avoiding that needs a per-plugin CSP and a
   bridge-less mode, a bigger change with a blurrier boundary.
3. **A separate content origin** (`usercontent.<domain>`) for rendered and shared files. Rejected
   by the maintainer: an extra domain and certificate for every deployment, while the CSP
   `sandbox` header gives the isolation that matters (below).

Sharing as a plugin was also considered and dropped: it needs unauthenticated routes, platform
and org switches, audit, rate limits and a public web page, all of which are the kernel's and
web's.

## Isolation without a second origin

A response carrying `Content-Security-Policy: sandbox …` without `allow-same-origin` is treated
by the browser as an opaque origin even when opened at the app's own URL, top-level or framed: it
cannot read cookies or storage of the app, its requests are cross-site (SameSite cookies are not
sent), and it cannot script its parent. The iframe that shows it also carries the `sandbox`
attribute with the same flags (defence in depth). Residual risk accepted by the maintainer: a
hostile page is still served under the app's domain (phishing look-alike); it cannot navigate the
top window (`allow-top-navigation` is never granted).

## Design

### 1. Data

New kernel table `capybara.file_shares` (migration `NNNN_file_shares.sql`):

| column | meaning |
|---|---|
| `id` | uuid, primary key |
| `org_id` | `REFERENCES orgs(id) ON DELETE CASCADE` |
| `code` | 10 characters of `[A-Za-z0-9]` from a CSPRNG (≈59.5 bits), unique |
| `conversation_id` | `REFERENCES conversations(id) ON DELETE CASCADE` |
| `file_id` | the artifact (one version) or attachment id the current generation was copied from |
| `source_path` | for delivered files, the version group (`sourcePath`); null for uploads |
| `created_by` | owner account, `REFERENCES accounts(id) ON DELETE CASCADE` |
| `audience` | `internal` \| `external` |
| `name`, `content_type`, `size` | of the snapshot, frozen |
| `object_key` | `shares/<id>/<generation>` under `kernel/<orgId>/` |
| `generation` | int, bumped by "update to latest" |
| `expires_at` | null = never (internal only) |
| `revoked_at`, `revoked_by`, `revoke_reason` | `creator` \| `admin` \| `conversation_deleted` \| `member_offboarded` \| `creator_lost_access` |
| `created_at`, `updated_at` | |

A share is **live** when not revoked, not expired, **its creator could still open the file**
(`ConversationAccess.isAccessible(org, conversation, created_by)` holds: the account is active and
a member, the conversation and its root are not deleted, the agent is not deleted and still
visible to the creator), and, for external shares, external sharing is currently allowed for the
org. All of it is checked at open time (one query), so a disabled account, a removed agent, a
deleted root conversation or the switch turned off stop the link at once without a revoke step
per cause; when the cause goes away (switch back on) a share not expired works again. The
explicit revokes in §9 exist to free the snapshot and to show a reason in the lists.

### 2. Creating, updating, revoking

Org routes (session or API token of the person; `@OrgAction("agents.use")`, owner checked by
`ConversationAccess.isAccessible`):

- `POST /api/v1/orgs/:orgId/conversations/:id/files/:fileId/shares`
  `{ audience, expiresInDays: 1 | 7 | 30 | null }`. External requires the effective switch
  (`share.external_not_allowed` otherwise) and a non-null expiry ≤ the platform maximum
  (`share.expiry_too_long`); internal may be null (never). Defaults in the UI: external 7 days,
  internal never. A removed file (`status: removed`) cannot be shared.
  The file id may be any version shown in the panel (the owner shares what they looked at).
- `POST /api/v1/orgs/:orgId/shares/:shareId/refresh`: "update to latest": copies the newest
  available version of the same `source_path` in the conversation (uploads: the same attachment,
  so refresh is not offered for them) as a new generation under the same code (creator only).
- `DELETE /api/v1/orgs/:orgId/shares/:shareId`: revoke (creator, or org admin with
  `org.update`).
- `GET /api/v1/orgs/:orgId/conversations/:id/files/:fileId/shares`: the live and recent shares
  of one file (owner): every share of the same `source_path` in the conversation (any version), or
  of the attachment.
- `GET /api/v1/orgs/:orgId/shares?mine=1|all`: list (mine: any member; all: org admin).

Snapshot copy (intent first, multi-replica safe): the create handler streams the file's object
into `kernel/<orgId>/shares/<id>/<generation>` **before** the row is inserted (the id is generated
first), then inserts the row in a `@Transactional()` method with the `share.created` audit. If the
insert fails the object is an orphan; the daily sweep (§9) deletes objects under `shares/` with no
live row older than one hour. `refresh` writes the new generation's object first, then updates the
row (`generation`, `name`, `content_type`, `size`, `object_key`), and owes the previous object's
deletion through the outbox. Revoke updates the row and owes the object's deletion through the
outbox (`OutboxService.add`, deterministic job id `share-object-delete-<id>-<generation>`).

The copy streams; no size cap beyond what the conversation file already obeys. For uploads,
`storedMatches` must hold before copying.

### 3. Opening a share (public routes)

All under `/api/v1/s/:code` (`@Public()`, rate limited by a new named throttler `share-open`,
per IP, counting failed lookups so codes cannot be enumerated; added to `PUBLIC_ROUTES`):

- `GET /api/v1/s/:code` → `{ name, contentType, size, sharedBy: displayName, expiresAt,
  audience, render: "html" | "previewers" | "download", previewers: [...] }`.
  Unknown, revoked, expired: one answer, 404 `share.not_found` (no difference leaked).
  Internal: the request must carry a session of an active member of the org, else 401
  `share.sign_in_required` (not a member: 404, as if it did not exist).
- `GET /api/v1/s/:code/content` → the snapshot bytes, always `content-type:
  application/octet-stream`, `x-content-type-options: nosniff`, `content-security-policy:
  sandbox; default-src 'none'`, `cache-control: private, no-store`; with `?download=1`,
  `content-disposition: attachment; filename*=…`. This is what the share page's `host.read()`
  and download button use. (Bytes are streamed by the kernel, never a presigned URL on the app
  origin.)
- `GET /api/v1/s/:code/text` and `GET /api/v1/s/:code/inline` → the share equivalents of the
  panel's text route and inline image URL, with the same checks and headers, so the web built-ins
  (markdown, csv, tsv, text, image) render on the share page unchanged.
- `POST /api/v1/s/:code/embed-token/:plugin/:previewerId` → a share-scoped embed token for an
  embed previewer (§7).
- `GET /api/v1/s/:code/previews/:plugin/:previewerId` → a view previewer rendered by the kernel
  for the snapshot (§7).
- `GET /api/v1/s/:code/html` → redirect to the HTML document (§4) with a fresh document token.

Each successful metadata read writes `share.opened` (actor: the account for internal, null for
external; detail: share id, audience), at most once per share and viewer (account or IP hash)
per 10 minutes (dedupe key in Redis with a TTL).

### 4. The HTML document

`GET /api/v1/html/:token` (`@Public()`; the token is the authority) serves an HTML file as a
stand-alone document. The token is a stateless HMAC (keyring, HKDF info `capybara-html/1`,
TTL 5 minutes, used only to load the document) with claims either
`{ kind: "file", orgId, conversationId, fileId, accountId }` (right panel; `fileId` is one
version; issued by
`POST /api/v1/orgs/:orgId/conversations/:id/files/:fileId/html-token`, owner only, re-checked on
use) or `{ kind: "share", shareId, generation }` (share page; re-checked live on use).
HTML larger than `FILE_PREVIEW_MAX_BYTES` (20 MiB) is not rendered (the UI offers download).

Response headers:

```
content-type: text/html; charset=utf-8          (bytes as stored; charset from the file if given)
content-security-policy: sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox;
  default-src 'none';
  script-src 'unsafe-inline' 'unsafe-eval' <allowlist>;
  style-src 'unsafe-inline' <allowlist>;
  font-src data: <allowlist>;
  img-src data: blob: <allowlist>;  media-src data: blob:;
  connect-src 'none';  frame-src 'none';  worker-src 'none';
  form-action 'none';  base-uri 'none';
  frame-ancestors 'self'
x-content-type-options: nosniff
referrer-policy: no-referrer
cache-control: private, no-store
x-robots-tag: noindex
```

- `connect-src 'none'` and images only from the allowlist block the obvious exfiltration channels
  (fetch, XHR, WebSocket, beacons, pixels on arbitrary hosts). Residual: a script can still encode
  data into the URL of a resource it loads from an allowlisted CDN; the CDN operators see that,
  not an attacker, unless an allowlisted CDN exposes request logs. Accepted.
- Links open in a new tab (`allow-popups` + escape: the new tab is a normal page, not sandboxed);
  the document cannot navigate the app (`allow-top-navigation` never granted).
- The iframe element in the web also carries `sandbox="allow-scripts allow-popups
  allow-popups-to-escape-sandbox"` and `referrerpolicy="no-referrer"`.

**CDN allowlist**: platform setting `htmlRenderCdnAllowlist` (super admin, `deployment_settings`),
a list of `https://` origins (scheme + host, optional port; no paths, no wildcards), default
`https://cdnjs.cloudflare.com`, `https://cdn.jsdelivr.net`, `https://unpkg.com`,
`https://fonts.googleapis.com`, `https://fonts.gstatic.com`. Changes apply to the next document
load. No org level.

### 5. Right panel

- HTML becomes a web built-in that wins over extension previewers: the panel requests an HTML
  token and iframes `/api/v1/html/<token>` (sandbox attribute as above), with a Rendered / Source
  toggle (Source = the existing text built-in).
- The file preview plugin drops its `html` previewer (plugins repo; rc bump, README); until the
  deployment upgrades the plugin, the built-in winning keeps behaviour correct.
- Every file in the panel gets a **Share** action (owner, not for removed files): a dialog with
  audience (Internal / External; External disabled with the reason when not allowed), expiry
  (choices bounded by the maximum), then the link with Copy. A shared file shows a marker; the
  dialog lists the file's live shares with Copy, Update to latest and Revoke.

### 6. Share page (`apps/web`, `/s/[code]`)

Public prefix `/s` (added to `PUBLIC_PREFIXES`); a page template from `@capybara-hq/design`
(no styles in apps/web), `noindex`, `referrer-policy: no-referrer`.

```
┌──────────────────────────────────────────────────────────────┐
│ 季度报告.html   Shared by 张三 · expires 2026-11-25   [Download] │
├──────────────────────────────────────────────────────────────┤
│                    file rendered full width                   │
└──────────────────────────────────────────────────────────────┘
```

- `render: "html"` → iframe of the HTML document (via `/api/v1/s/:code/html`).
- `render: "previewers"` → the first previewer in the org's order, chosen by the same rule as the
  panel: a view previewer (kernel-rendered through the share route), the `file.preview` embed with
  `host.read()` = `/api/v1/s/:code/content` and the share-scoped embed token, or a web built-in
  reading the share text / inline routes. The same components as the right panel with a share
  data source, so formats never drift.
- `render: "download"` → file card with Download.
- Internal link without a session → sign in, then back to the link. Not found / revoked / expired
  → one "This link is invalid or has expired" page.
- The page loads no workspace data (no org navigation, no conversation list).

### 7. Previewers for a share (SDK)

- **Embed previewers.** `EmbedClaims` gains a third scope, `share`: `{ plugin, scope: "share",
  shareId, generation, contribution, exp }`, no account and no role. `parseClaims`,
  `verifyEmbedToken` and plugin route access accept it only for the `file.preview` slot, check the
  share is live on every use and that the plugin is enabled in the share's org; an extension sees
  `ctx` calls for such a token as an org call for the share's org with no actor. Like every embed
  token it is never valid for `/api`.
- **View previewers.** `FilePreviewArgs` becomes a union: the conversation variant as today, or a
  share variant `{ source: "share", orgId, shareId, file }` without `accountId` and
  `conversationId`; the kernel reads the snapshot for it. A previewer that needs the conversation
  declines the share variant (the share page then falls to the next previewer, as the panel does
  when a previewer declines).
- Both are SDK public API changes (`pnpm gen:sdk-api`, changeset on `@capybara-hq/plugin-sdk`).

### 8. Governance

- Platform setting `externalSharing: "allow" | "deny"` (default `deny`) and
  `shareMaxExpiryDays` (default 30, 1..365), in the super admin settings page; env / file values
  read-only in the console as for `devicesFullAccess`.
- Org setting `externalSharing: "on" | "off"` (absent = off), in org settings; setting `on` while
  the platform denies → 400 `org.external_sharing_not_allowed`. The org page explains when the
  platform does not allow it.
- Widening is a person's act, as for Full access: through the Platform tool or an API token both
  switches can only be turned off (extend the org-settings operation's `onlyNarrows` and the
  admin-settings widen check); turning them on needs a person on the web.
- Org admins: a **Shares** page under org settings (all live shares: file, conversation owner,
  audience, expiry, last opened; Revoke). Members: their shares under personal settings, same
  columns.
- Audit actions: `share.created`, `share.refreshed`, `share.revoked`, `share.opened` (new, added
  to `AUDIT_ACTION_KEYS` with zh / en messages); switch changes are recorded by the existing
  `org.settings_updated` and deployment settings audits.

### 9. Lifecycle

- Conversation deleted → its shares revoked (`conversation_deleted`) in the same transaction.
- Member offboarded (removed or left) → their shares revoked (`member_offboarded`), one more step
  in `offboard`.
- Other causes (account disabled, agent deleted or hidden, root conversation deleted) stop the
  link through the live check (§1); the daily sweep revokes such shares (`creator_lost_access`,
  added to the reasons) so their snapshots are freed.
- Org soft-deleted → lookups filter `orgs.deleted_at IS NULL`; objects go with
  `storage-org-purge`.
- Daily `@LockedCron` sweep (WorkerModule): deletes objects of shares expired or revoked more
  than 7 days ago (rows kept for the audit trail and the lists' "recent" section, `object_key`
  cleared) and orphan objects under `shares/` older than one hour with no row.

### 10. Platform tool

- Operations: list shares (`GET …/shares`), revoke (`DELETE …/shares/:shareId`).
- Exclusions: creating and refreshing (`human-only`: publishing outside the org is a person's
  act), the HTML token route (`transport`), every `/api/v1/s/*` route (content, text, inline,
  previews, embed token, html) and `/api/v1/html/*` (`transport`, public).

## Errors

`share.not_found`, `share.sign_in_required`, `share.external_not_allowed`,
`share.expiry_too_long`, `share.file_unavailable` (removed or upload mismatch),
`org.external_sharing_not_allowed`; each registered with an actionable message, zh / en in the web.

## Tests (outline)

- Kernel integration: create/refresh/revoke rules (owner only, switches, expiry bound, removed
  file), open rules (internal needs member, external anonymous, unknown/expired/revoked all 404,
  switch off stops external), content headers, HTML headers and token checks (expired token,
  revoked share, wrong generation), offboarding and conversation deletion revoke, audit dedupe.
- Throttler: repeated misses from one IP are refused.
- Embed: share-scoped token accepted only for `file.preview`, refused after revoke, never for
  `/api`.
- Multi-replica: snapshot written before the row, orphan sweep, outbox deletions idempotent.
- Web: share dialog states (external disabled with reason), share page per render kind, invalid
  link page; e2e (Chromium + WebKit headless): an HTML report loading a chart library from an
  allowlisted CDN renders in the panel and on an external share; a fetch to another host is
  blocked; the document cannot read `document.cookie` of the app.
- Plugins repo: file-preview no longer claims HTML.

## Left to the builder

- Exact page template and component choices (per the writing-web-ui skill), copy wording.
- Whether the embed host on the share page reuses `ExtensionSlot` as is or a share-mode variant.
- The migration number, error message wording, throttler limits (suggested: 30 misses per IP per
  10 minutes).

## AGENTS.md rules touched

- **Multi-replica discipline.** Followed: snapshot object written before its row (intent first),
  object deletions owed through the outbox with deterministic job ids, the sweep is a
  `@LockedCron` under `WorkerModule`, the open dedupe lives in Redis with a TTL, tokens are
  stateless.
- **Migrations.** One new expand-only table in schema `capybara`.
- **Web UI.** A new public page `/s/[code]` built from design components and a page template;
  every read a `defineQuery`, every write `useAppMutation`; `PUBLIC_PREFIXES` gains `/s`.
- **Extension UI: embed tokens never valid for `/api`.** Kept; a new `share` scope for
  `file.preview` only.
- **SDK public API.** `EmbedClaims` changes: `pnpm gen:sdk-api` and a changeset bumping
  `@capybara-hq/plugin-sdk`.
- **Platform tool.** Two operations and the exclusions listed in §10.
- **Language / i18n.** New UI text in zh and en; zh uses 平台 / 超级管理员 / 智能体.
- **Kernel.** New module with `@Injectable` providers, DTOs via `createZodDto`, errors registered.
- New area rule to add to AGENTS.md: "**File sharing:** a share is a snapshot; external links
  need the platform and org switches; shared and rendered HTML is served only with the sandbox
  CSP and the CDN allowlist, never from a presigned URL on the app origin."
