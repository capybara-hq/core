# Account profile: a person's own name and avatar, shown wherever a person appears

Status: draft for maintainer review (2026-11-20).

## 1. Why

People cannot change how they appear. The display name is set once when the account is created
(local sign-up, invitation, or the first SSO / IM login) and afterwards only a super admin can
change it (`PATCH /api/v1/admin/accounts/:id`). People have no avatar at all: the sidebar and the me
panel draw an initial square, and most other places show only a name, or even a raw account id
(approval cards, question cards, the trajectory "by" lines).

The maintainer asked (2026-11-20) for a profile page in the personal settings where a person
changes their own name and avatar, and for the avatar to appear **everywhere a person appears**:
menus, lists, speakers, and the rest.

## 2. Decisions taken with the maintainer (2026-11-20)

| # | Decision |
|---|---|
| P1 | The profile belongs to the **account**, not to an org: one name and one avatar, shown the same in every org (approach A below). |
| P2 | Avatar sources, in order: the person's **uploaded image**; else the avatar of their **SSO / IM identity** (https only, linked to, not copied); else the **initial**. |
| P3 | Every place that shows a person shows the avatar beside the name: menus, lists and tables, pickers, conversation speakers, approvals, the inbox, audit, shares, schedules. |

## 3. Goals, non-goals, anti-goals

**Goals**

- `/account/profile`: change one's display name; upload, replace or remove one's avatar.
- One avatar resolution for the whole deployment (P2), served by one kernel route.
- One person component in the web (avatar + name) used on every person surface listed in §7.

**Non-goals**

- Per-org names or avatars (approach C).
- Copying SSO avatars into the object store (approach B; a follow-up if intranet deployments
  cannot reach the IdP's image host).
- Animal presets for people (§5.2).
- Changing email, password flows, or anything about identities.
- Avatars for the senders inside an anonymous-guest IM conversation (they all share the guest
  account; their IM name stays text, as today).
- Showing the person on the public share page (`/s/:code`): the viewer may be anonymous; it keeps
  the name text it shows today (my call).

**Anti-goals** (it would be a failure even if it works)

- A person can no longer tell a person from an agent at a glance.
- A person's avatar becomes model-visible or changes replay.
- An avatar URL lets someone outside the person's orgs fetch the image, or leaks a presigned URL
  that outlives a few minutes.

## 4. Approaches

- **A (picked): account-level profile, agent-avatar mechanics.** Name and avatar on the account;
  uploads through a presigned flow into the deployment prefix; SSO avatar as an https fallback
  redirect; every person shape carries an avatar URL; one web component. Trade-off: where the
  server's viewers cannot reach the IdP image host, the SSO fallback fails and the initial shows.
- **B: A plus copying the SSO avatar into the object store at login.** Works on intranets and keeps
  viewers off the IdP's servers, but adds a fetch at login, its failures and retries. Deferred.
- **C: per-org profiles.** Different name and avatar per org; an org dimension on every read and
  write. No need today.

The maintainer picked A on the recommendation (2026-11-20).

## 5. Design

### 5.1 Data

- `capybara.accounts` gains `avatar jsonb NULL`: `null` (no own avatar) or
  `{ "kind": "upload", "uploadId": "<id>" }`. Expand-only migration.
- Account avatar uploads cannot use `capybara.attachments` (it requires an `org_id`; an account has
  no single org). A new table `capybara.account_avatar_uploads`:
  `id text PK, account_id text NOT NULL REFERENCES accounts ON DELETE CASCADE, storage_key text NOT
  NULL, content_type text NOT NULL, size bigint, status ('pending' | 'ready'), expires_at
  timestamptz NULL, created_at timestamptz NOT NULL DEFAULT now()`.
- Objects live under the deployment prefix: `deployment/account-avatars/<accountId>/<uploadId>`
  (`StorageService.deployment()`; kernel-added prefix, as the object-storage rules require).
- The SSO avatar is read from the identity rows (`identities.profile.avatarUrl`, refreshed on every
  login already): the most recently updated non-local identity with an `https:` `avatarUrl`.
  Nothing new is stored for it.
- The display name stays `accounts.display_name`: trimmed, 1–64 characters (my call, builder
  check Q3), checked only on the two PATCH routes (`/me/profile`, `/admin/accounts/:id`) and only
  when the name is being changed: a request that resends an unchanged name, or changes only the
  avatar, passes even when an old name is longer. Account creation paths (local sign-up,
  invitations, SSO / IM / directory) are not changed; the UI ellipsizes long names everywhere.

### 5.2 Look (my calls)

- People get **no animal presets**. The design spec reserves the animal palettes for agents
  (spec §3), and keeping people to photos and initials is what keeps a person and an agent apart
  at a glance (anti-goal 1).
- A person's avatar is a **circle**; an agent's stays the rounded square. The `Avatar` component
  gets `shape: "square" | "circle"` (default square); the person component always passes circle.
  The initial of a person uses the existing `selected` ground and `muted` ink, like the sidebar
  today.
- Sizes are the existing `AVATAR_SIZES`; each surface in §7 names its size.

### 5.3 Kernel API

All new routes follow writing-kernel-api (DTOs via `createZodDto`, `@Transactional()` writes,
audit rows).

- `POST /api/v1/me/avatar/uploads` `{ contentType, size }` → `{ uploadId, url, headers }`: a
  presigned PUT, png / jpeg / webp, at most 2 MB (the agent-avatar limits), expiry 24 h. When no
  object store is configured it answers `storage.unavailable` and the page says so.
- `PATCH /api/v1/me/profile` `{ displayName?, avatar?: { kind: "upload", uploadId } | null }`:
  - `avatar` upload: the upload must be the caller's, `ready` after a HEAD check of the object
    (size and type re-checked against the store); it is bound (`expires_at = null`) and every other
    upload of the account gets `expires_at = now()`.
  - `avatar: null`: removes the own avatar (the SSO fallback or the initial shows); the old upload
    expires.
  - Audit `account.profile_updated` with the changed fields (never the image), actor = the account.
  - Returns the updated `Account` (with `avatarUrl`, below).
- `GET /api/v1/accounts/:accountId/avatar`: 302 to a presigned GET (5 min, `inline`,
  `responseContentType` from the row) for an upload, or 302 to the SSO `https:` URL; 404 when the
  person has no image avatar. `cache-control: private, max-age=60`. **Who may read:** the account
  itself, a super admin, or anyone who shares an active membership in some org with that account;
  everyone else gets 404 (no existence leak). Not reachable with embed tokens.
- **Every person shape gains `avatarUrl: string | null`**: `/api/v1/accounts/<id>/avatar?v=<ver>`
  when the person has an image avatar (own or SSO), else `null`. `<ver>` is a short hash of the
  avatar value (upload id or SSO URL), so a change busts browser caches. `null` means "draw the
  initial" without a request. Built by one kernel helper (`accountAvatarUrl(row)`), used by:
  `Account` (`/me`, admin accounts), org and admin member rows, audit `actor`, shares `createdBy`,
  admin agents owner, admin connectors creator, catalog-request and skill-change requesters,
  schedule `pausedBy`, device setting-change `by`. Each of these joins already reads
  `accounts.display_name`; the helper adds `avatar` and the SSO lookup to the same query.
- **Responses that carry only an account id** (approvals `decidedBy`, questions `answeredBy`,
  `run_aborted.byAccountId`, schedules `accountId`, background tasks `triggerAccountId`,
  conversations `accountId` where a viewer other than the owner sees it) **gain a person shape**
  `{ id, name, avatarUrl }` next to the id (my call, builder check Q1). The members list cannot
  carry this: it needs the `member` role (`org.members.read`), so guests (the IM users who answer
  approval and question cards) and super admins outside the org or in the cross-org admin inbox
  would see nobody. Putting the person into the response the viewer can already read keeps the
  access rules where they are and adds no new lookup route. The web stops resolving ids through
  `useMemberNames` for these surfaces; an id whose account is gone shows "已离开的成员" with the
  initial.
- **Platform tool** (the Platform parity rule; my call, builder check Q2): `PATCH /me/profile`,
  the upload and the image routes are exclusions. The profile write is `human-only`, like every
  other `/me` write (password, tokens, current org): an agent does not rename a person or change
  their face. The upload and image routes mirror the agent-avatar exclusions' reasons. If the
  platform-web-parity line later turns `/me` writes into operations, this route goes with them.
- The admin route `PATCH /admin/accounts/:id` keeps changing names; it does not set avatars (my
  call: a super admin removing an offensive image is a follow-up if ever needed).
- Upload cleanup: the hourly attachment cleanup sweep (`@LockedCron`, `WorkerModule`) also deletes
  expired, unbound `account_avatar_uploads` rows and their objects, the same way it does for
  attachments. Deleting an account cascades the rows; its objects are swept by the same job via a
  deletion owed through the outbox (builder's choice of exact shape, following the attachments
  precedent).

### 5.4 Model visibility and replay

The avatar is display data and never enters the event log or any prompt. The name already enters
the log as the `sender` snapshot of each user message; a renamed person's later messages carry the
new name in their own snapshot, earlier events keep theirs. No `DriftReason`, no change to request
building.

### 5.5 Web

- **`/account/profile` (个人资料)**, first entry of the account nav (`useAccountNav`), and the
  account's home (`ACCOUNT_HOME`) moves there (my call). SettingsPage with one FormSection:
  - the avatar at 64 with 上传 / 更换 and 移除 actions; the file is cropped to a square in the
    browser before upload (reuse the agent avatar crop); when the avatar shown is the SSO one, a
    `muted` line says it comes from the linked identity (e.g. "来自飞书");
  - 名称, a text field, saved with the section's save button.
  - Thin `page.tsx` + client `view.tsx`; reads through `meQuery`; writes with `useAppMutation`,
    invalidating `me` and the members queries.
- **`PersonName`** (design, new): `{ name, avatarUrl, size: 16 | 24, secondary? }` draws the circle
  avatar and the name on one line, ellipsized. Tables, cards and lines use it instead of bare name
  text. The sidebar account row and the me panel switch from their own initial span to `Avatar`
  with `shape="circle"`.
- Surfaces that print a raw account id today (approval and question cards, trajectory lines) read
  the person shape now in their responses (§5.3) and show the person. Surfaces that only list org
  members for a member-role viewer (owner pickers, schedules list) keep reading the members list,
  which now carries `avatarUrl`.
- Design spec §6.30 (Avatar) gains the person variant (circle, no presets) and the new component's
  section with its states; the reference set gains a person row.

### 5.6 i18n

New keys in zh and en for the page, its actions, the SSO line, the size / type errors and
"已离开的成员". zh says 个人资料 / 头像 / 名称.

## 6. Conversation speaker

A web conversation belongs to one person, so the user bubbles show no sender today. Under P3 the
user bubble shows its **author's avatar (24)** at its side (my call) in the conversation page and
in the trajectory viewer; the trajectory viewer also shows the author's name, since its reader is
usually not the author. These are the only two views that render bubbles (shares are snapshots of
files, and the public share page is out, §3). The author is
`user_message.payload.authorAccountId`; the conversation and trajectory responses carry the person
shape for it (§5.3). Messages of a parent
agent keep their current sender treatment. Anonymous-guest IM conversations show the guest initial
and the IM name text, as today.

## 7. Surfaces (sizes are my call)

| Surface | Today | After |
|---|---|---|
| Sidebar account row, me panel | initial square | circle `Avatar` 24 / 40 |
| Org chooser, new-conversation greeting | name | unchanged (greeting is text; chooser shows the current org) |
| Members table (settings, admin org) | name | `PersonName` 24 |
| Admin accounts table | name | `PersonName` 24 |
| Owner pickers (reassign, agent basics, from-template, admin agent) | name | option with `PersonName` 16 |
| Agent owner (agent list, admin agents list and page) | name | `PersonName` 16 |
| Audit actor | name / email | `PersonName` 16 |
| Shares table | name | `PersonName` 16 |
| Admin connectors creator | name | `PersonName` 16 |
| Inbox / admin inbox / pending plugins requester | name | `PersonName` 16 |
| Schedules creator (settings list, schedule page, calendar) | name | `PersonName` 16 (calendar chips: avatar only, name in the tooltip) |
| Approval card, question card | "你" / "系统" / raw id | `PersonName` 16 ("你" for the viewer) |
| Trajectory "by", thread "stopped by" / "waits for" | raw id / name | `PersonName` 16 |
| Device setting-change history | name | `PersonName` 16 |
| Conversation user bubble | nothing | §6 |

A surface the builder finds that is not in the table follows the same rule: avatar 16 beside the
name in lines and cells, 24 in rows that lead with the person.

## 8. Left to the builder

- How the web learns the shown avatar is the SSO one (for the page's "来自飞书" line).
- What "shares an active membership" means in SQL (memberships carry no status column today).

- Column vs. 1:1 table details within §5.1's constraints; index choices.
- The exact sweep and outbox shape for avatar object deletion, following the attachments code.
- Component internals, CSS, and the exact zh / en copy (reviewed in the PR).
- Order of the surface migration across PRs.

## AGENTS.md rules touched

- **Multi-replica discipline.** No process state; writes in `@Transactional()` methods; upload
  objects are written before their row is bound (intent first: the upload row exists before the
  PUT); object deletions are owed through the outbox or swept by the existing `@LockedCron` under
  `WorkerModule`.
- **Migrations.** One expand-only migration in schema `capybara`: a nullable column and a new
  table, `IF NOT EXISTS`.
- **Object storage.** Keys under the kernel-added `deployment/` prefix; presigned upload size
  enforced by the store; image served by 302 to a short presigned URL, never proxied.
- **Kernel.** New routes are standard Nest (DTOs, explicit `@Inject`), error codes registered.
- **Platform tool.** `PATCH /me/profile` is a `human-only` exclusion like the other `/me` writes; the
  two image routes get exclusions with reasons, mirroring the agent-avatar exclusions.
- **Web UI.** New page = SettingsPage + design components; reads via `defineQuery`, writes via
  `useAppMutation`; the new component and the Avatar shape go into the design spec first.
- **Language.** UI text through i18n in zh and en; zh copy uses 个人资料 / 头像 / 名称.
- **Runtime and replay.** Not touched: the avatar is never model-visible (§5.4).
- **SDK public API.** Not touched: no extension sees avatars.
