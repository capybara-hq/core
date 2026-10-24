---
name: writing-channels
description: Use when creating or modifying IM channel, third-party login or directory sync extensions (provides channel@1 / identity-source@1 / directory@1, e.g. plugins/slack, plugins/lark). Covers inbound event conventions (messageId / threadId / tenantId, stripping the bot @, ack only after onEvent resolves, card_action), ChannelSendError and features, the card spec (validateChannelCard, renderCardAsText), preventing @everyone and the link allowlist; long connection by default and optional webhook inbound (Channel.webhook.handle, signature and challenge, webhookBaseUrl), the gateway role, fair sharing across gateway replicas (shareSlack) and leader election; durable inbound / outbound, dedup and card re-authorization owned by the kernel; the identity source key <plugin>:<tenant>, PKCE, ID token; directory pagination and the mass-removal guard; and tests with startFakeChannelServer / startFakeSlack / startFakeLark and dual-replica.
---

# Writing channel, login and directory extensions

## What this skill covers

Creating or modifying IM channel, third-party login or directory sync extensions (provides channel@1 / identity-source@1 / directory@1, e.g. plugins/slack, plugins/lark). Covers the inbound event conventions for messageId / threadId / tenantId, stripping the bot @, handling text only, ack only after onEvent resolves, card_action eventId and card target, locale, ChannelSendError retryable / reason, features and minEditIntervalMs, returning the last id when splitting, idempotencyKey; the card spec (validateChannelCard, renderCardAsText, questionRenderableInline, button callback values); preventing @everyone and the link allowlist; long connection by default and optional webhook inbound (Channel.webhook.handle, respond / events / reject, signature and challenge in the extension, webhookBaseUrl, signFakeWebhook / signSlackWebhook / encryptLarkWebhook), the gateway role, fair sharing across gateway replicas (shareSlack) and leader election (including the supervisor stopping the old instance's long connections when an extension is disabled / upgraded), durable inbound / outbound, dedup and card action re-authorization owned by the kernel; self-managed reconnection; the identity source key <plugin>:<tenant>, PKCE, ID token; directory pagination, configured(), incomplete listings must error, the mass-removal guard; and writing tests with startFakeChannelServer / startFakeSlack / startFakeLark and dual-replica.

An IM platform is usually provided by one extension offering all three extension points, and the three share **the same identity key**:

| Extension point | Contract | Config level | Enabled per org |
|---|---|---|---|
| `channel@1` (bot) | `packages/plugin-sdk/src/channel.ts`, cards in `cards.ts` | one per **channel connection** (`connectionSchema`, created by an org admin under "Channels" in the web app) | yes (`orgScoped`) |
| `identity-source@1` (web login) | `identity.ts` | **deployment-level** (`config.deployment`, enabled through `auth.loginSources`) | no (Ruling P1) |
| `directory@1` (directory sync) | `directory.ts` | **org-level** (`config.org`) | yes (`orgScoped`) |

General extension authoring (manifest, two-level config, the multi-replica prohibitions, permission approval) is in `.agents/skills/writing-extensions`; this skill covers only what is specific to these three extension points.

Reference implementations:

- `plugins/slack`: Socket Mode, Block Kit, Sign in with Slack (OIDC, validating the ID token), `users.list` directory.
- `plugins/lark`: the Lark long connection (official SDK `WSClient`), JSON 2.0 interactive cards, OAuth authorization code + PKCE, a directory traversed by department.
- `packages/kernel/test/fixtures/plugins/fake-im`: the minimal shape (connects to `startFakeChannelServer`); read it before reading the real extensions.

The two plugins' READMEs (`plugins/slack/README.md`, `plugins/lark/README.md`) list the platform doc source and every trade-off one by one; follow that granularity when writing a new platform.

## Identity key (look at this first)

- `identities.source` = `"<plugin name>:<tenant id>"`, `external_id` = the platform user id. Login, channel inbound and directory must all derive **the same** key, so one person maps to exactly one identity row and one account (Slack: `slack:<team id>` + `U…`; Lark: `lark:<tenant_key>` + `open_id`).
- The tenant definition must be consistent in all three places: the `tenantId` returned by `verify`, the inbound `sender.tenantId`, `ExternalIdentity.tenantId`, `DirectoryMember.tenantId`. Slack uses the team id (under Enterprise Grid it is the workspace team, **not** the enterprise `E…`, otherwise the same person is split into two rows); Lark uses `tenant_key`.
- For platforms whose user ids differ per app (Lark's `open_id`): login, bot and directory must be the same app, and the extension should check this automatically as far as possible (see the Lark README).

## `channel@1`

```ts
interface Channel {
  connectionSchema: ZodTypeAny;            // use secret() for secret fields
  features: { cards: boolean; edit: boolean; threads: boolean; minEditIntervalMs?: number };
  verify(args): Promise<{ botUserId; botName; tenantId }>;
  connect(args: ChannelConnectArgs): Promise<void>;   // long connection loop
  send(args: ChannelSendArgs): Promise<{ messageId: string }>;
  update(args: ChannelSendArgs & { messageId: string }): Promise<void>;
}
```

### Conventions for inbound events (`InboundEvent`)

- **`messageId` is unique and stable within the connection** (the same when the platform redelivers): the kernel dedups by it. Slack uses `<channel>:<ts>`, Lark uses `message_id`.
- **In a group chat, `target.threadId` = the `messageId` of the thread's root message** (exactly the same string as the `messageId` when the root message came in), not some other thread id of the platform (for Lark it is the `om_…` of `root_id`, not the `omt_…` of `thread_id`). When the message is not in a thread, don't include `threadId`: the kernel uses this message's `messageId` as the thread key, and replies are delivered into the thread rooted at it, so later replies land in the same conversation. Direct messages carry none.
- **`sender.tenantId`** is the enterprise the speaker belongs to (same definition as above). For people whose tenant differs from the connection's (external contacts, other companies in a shared channel, other Slack Grid workspaces) the kernel **allows binding only**, and does not treat them as anonymous even if the connection has anonymous guests enabled.
- **`sender.displayName` / `avatarUrl`**: include them if you can get them (Slack takes the event's own `user_profile`, otherwise `users.info`; Lark uses the user info API). The lookup needs a short timeout, and if it can't be found leave it out; it must not drag past the platform's acknowledgement deadline. The kernel shows the display name on the binding confirmation page (anti-phishing), and falls back to `externalId` when absent.
- **`text` has the bot @ stripped**, and `mentionsBot` separately says whether the bot was @-mentioned; only tidy the spaces on both sides of the @, and keep newlines and indentation (code blocks must not be crushed). @-mentions of other people are replaced with a readable `@name`.
- **M4 handles text only**: attachments such as images and files are ignored, and no event is sent when a message has only attachments (for a file share with a caption, only the caption is taken).
- **Edits and recalls / deletions send no event**; messages from the bot itself and other bots are ignored.
- In group chats the extension forwards thread replies faithfully (including `mentionsBot: false`), **and the kernel currently handles only group messages that @-mention the bot** (D4), so thread follow-ups need another @.
- **`card_action`**: `messageId` = the id of the message the card is in (the same for multiple clicks on the same card); `eventId` = the platform's unique id for this click, included if you can get it (Slack `<channel>:<card ts>:<clicker>:<action_ts>`, Lark callback `header.event_id`), and the kernel dedups platform redeliveries by it; in group chats include `target.threadId` if you can get it, and when you can't, the kernel uses the thread recorded when the card was sent.
- **`target.chatType` in a card click is only a reference value**: the kernel first checks that the chat of the click matches the target recorded when the card was sent (`channel_card_messages`), then resolves the clicker and the reply using the **recorded** conversation type, chat and thread. On a mismatch it only replies "cannot handle", and neither resolves the speaker nor sends a binding link. So tampering with the conversation type in a button callback value, or forwarding the card, has no effect.
- `directory_changed`: when the platform pushes personnel changes (Slack `team_join` / `user_change`, Lark `contact.user.*_v3`), send `{ type: "directory_changed", tenantId }`, and the kernel merges them by the minute and triggers one directory sync.

### `connect` and acknowledgement (ack)

- `onEvent` is implemented by the kernel: it only dedups (`message` by `messageId`, `card_action` with an `eventId` by `eventId`, 24 hours each) and durably enqueues the event on the queue `cap-kernel-channels`, returning quickly. **Resolving means the kernel has reliably received it.**
- The extension **acknowledges to the platform only after `onEvent` resolves**; on reject **don't acknowledge** (the Lark handler rethrows and the SDK replies 500), so the platform redelivers. The extension doesn't retry `onEvent` itself, and doesn't do slow work before `onEvent` (profile lookups need a short timeout; the platform acknowledgement deadline is only a few seconds for both Slack and Lark).
- Ignored events are acknowledged directly.
- `connect` returns only when `signal` aborts. If it throws or returns early, the kernel records the connection's `last_error`, backs off exponentially (doubling from `channels.retryBaseMs`, capped at 5 minutes), and any replica retries.

### Webhook inbound (optional, `Channel.webhook`)

Inbound is a **long connection by default** (M4 shipped long connection only; since M7 a channel extension may also implement `webhook`). A connection is switched to webhook mode by an org admin (`PATCH /api/v1/orgs/:orgId/channels/:connectionId` with `{"inboundMode": "webhook"}`); this works only when the extension implements `Channel.webhook` and `channels.webhookBaseUrl` is set. The platform then calls `POST <channels.webhookBaseUrl>/channels/webhook/<connectionId>` on a **gateway** replica, and the connection gets no `connect` call.

- **`handle({ connectionId, config, request, signal })`** returns one of three results (`ChannelWebhookResult`): `respond` (answer directly, no events: the URL-verification challenge), `events` (hand `InboundEvent`s to the kernel plus the `ack` response), or `reject` with 400 / 401 / 403 (not genuine; nothing is enqueued).
- **Signature verification, decryption, the challenge handshake and timestamp replay checks are the extension's job.** The kernel knows no platform formats and puts no authentication on the route. `request.body` is the raw bytes (verify over them), `headers` are lower-cased, and `receivedAt` is the kernel's receive time for replay checks. Fail closed: anything not provably genuine is `reject`.
- **Ack only after every `onEvent` resolved.** The kernel enqueues each event like a long connection's `onEvent` and writes your `ack` only when all resolved; if any rejects (or the 10 s deadline passes) it answers 503 `channel.webhook_retry` and the platform redelivers. An empty `events` list just acks (ignored events are still acknowledged).
- **Dedupe reuses the long connection's keys**: `messageId` for messages, `eventId` for card clicks. Keep them identical in both modes, so a redelivery or a switch of mode cannot process a message twice.
- **Keep it quick**: the platform's ack deadline is a few seconds. Parse, verify and return; no slow lookups.
- **What the kernel answers itself**: 404 `channel.webhook_not_found` (unknown, disabled, not in webhook mode or extension off for the org; the same body for all), 503 `extension.unavailable` (extension not loaded on this replica), 413 above `channels.webhookMaxBodyBytes` (1 MiB), 415 for a malformed `Content-Type`, and 500 when `handle` throws. Every response carries `x-content-type-options: nosniff` and `content-security-policy: default-src 'none'`; plugin-set `set-cookie` and framing headers are dropped.
- **Deployment**: the route is served only by the `gateway` role, on the kernel HTTP port and outside `/api`; `channels.webhookBaseUrl` (public https origin) is set on `api`, which shows each connection's callback URL. See `docs/deploy/README.md`, "IM channels: inbound modes".
- **Tests**: `@capybara-hq/testing` signs requests like the platform does: `signFakeWebhook(body, secret)` (the `fake-im` extension's HMAC header `x-fake-signature`, with `fakeWebhookEvents` / `fakeWebhookChallenge` bodies), `signSlackWebhook(body, signingSecret, ts)` (`x-slack-request-timestamp` + `x-slack-signature`) and `encryptLarkWebhook(payload, encryptKey)` (AES-256-CBC body `{"encrypt": ...}`). Cover: a bad signature and a stale timestamp are rejected, the challenge is answered, no ack when `onEvent` rejects, and a redelivered event is processed once. See `plugins/slack/test/webhook.test.ts`, `plugins/lark/test/webhook.test.ts`, `packages/kernel/test/channels/webhook.test.ts` and `slack-webhook.dual.test.ts`.

### Reconnection

- If the SDK's built-in reconnection swallows errors (Slack SDK 3.1.0 turns a failure of `apps.connections.open` into an unhandled rejection; the Lark SDK silently retries on the long interval the server sends and never returns to the caller), **turn it off and write your own loop**: reconnect immediately when the platform recycles the connection normally; on connection failure or consecutive short-lived connections (under 10 seconds) back off exponentially **with jitter**; after 5 in a row, or when the platform explicitly refuses (bad credentials, `link_disabled`, over the connection limit), **throw**, so the kernel records `last_error` and takes over backoff.
- Wait with an abortable `AbortSignal.timeout` (see `pause` in `plugins/lark/src/wait.ts`); don't use `setTimeout` (`plugin-timer` of `check:extension-state`).
- When `signal` aborts, close the socket and then return; if the abort happens in the middle of connecting, also check `signal.aborted` and disconnect (otherwise the connection leaks).

### `send` / `update`

- `message.text` is Markdown, to be converted to the platform's native rich text, **not translated**. When it exceeds the platform's per-message limit, the extension splits it into several messages itself and sends them in order, **returning the id of the last one** (the kernel edits that one afterwards).
- When the new text of `update` exceeds the per-message limit and can't be made into one message -> throw a non-retryable `ChannelSendError` with `reason: "too_large"`: the kernel then `send`s the full text as a new message (split by the extension). `update` is never called on a channel with `features.edit` false; when a card's state changes the kernel sends a new card instead, the old card's buttons are still clickable, and the kernel replies "already handled".
- `features.minEditIntervalMs`: the minimum interval the platform allows between two edits of the same message; the kernel's streaming draft update interval is `max(1000, minEditIntervalMs)` (Slack 2500, Lark 1500). Higher concurrency is covered by rate-limit errors + backoff.
- `locale` (`"zh" | "en"`, the org-setting IM language): fixed wording the extension renders itself (buttons, fallback text) is chosen by it.
- `idempotencyKey` (optional): at most 40 `[A-Za-z0-9_-]` characters (the kernel actually gives 32), identical on every retry of the same logical message. Pass it through when the platform supports idempotent sending (Lark `uuid`; when split into several messages the i-th uses `<key>-<i>`), and ignore it when unsupported (Slack).
- For a channel with `features.cards` false, the kernel first falls each card back to text via `renderCardAsText(card, locale)`, joins them after the body separated by blank lines, and the message handed to the extension has no `cards` (Ruling A33, `packages/kernel/src/channels/features.ts`). The fallback text is **Markdown** (converted by the extension to native rich text, like `message.text`); model-controllable fields (approval title, input preview, question title, answer summary) are placed in inline code / fenced code blocks and won't turn into links; the extension's converter must display code content as is. An extension that declares `cards: true` receives `message.cards` and renders native cards itself; when a card can't be rendered (for example a button callback value over the limit) the extension falls back to a link or text itself.
- For a channel with `features.threads` false (the platform has no threads), the target the kernel hands the extension has no `threadId`, and replies are sent straight into the chat. Inbound events generally carry no `threadId` either (the platform has no thread to fill in); without it, each @ message in a group opens its own conversation.
- When `features.edit` is false no streaming draft is sent, only one message at finalization (see above).

### Failure classification (`ChannelSendError`)

| Situation | Throw | What the kernel does |
|---|---|---|
| rate limit, platform 5xx, network, timeout | `retryable: true`, with the platform's `retryAfterMs` | retry after backoff (with an attempt cap) |
| credentials invalid, permission revoked, app disabled | `retryable: false, reason: "auth"` | record the connection's `last_error`, stop delivery for this conversation this round |
| bot removed from the group, group dissolved, user unreachable | `reason: "target_gone"` | stop delivery for this conversation this round, not counted as a poison event |
| content rejected by the platform | `reason: "rejected"` (treated as this when no reason is given) | skip the same event after it fails 3 times, and make a best effort to reply with "please handle this on the web" |
| still over the limit after splitting / edit too long | `reason: "too_large"` | same as above; on `update`, send a new message instead |

The kernel treats other exceptions as retryable (a limited number of times). Use `isChannelSendError` to check (duck typing, not `instanceof`). The error message carries only the step and the platform error code, **not tokens, request headers or response bodies** (`cause` may attach the original error, but the original error itself must not contain credentials either, see Lark's header-free errors).

## Card spec (`cards.ts`)

`ChannelCard` is produced by the kernel, and the extension renders it in each IM's native format:

| `kind` | Content | Interaction |
|---|---|---|
| `approval` | title, tool / connector, agent, argument preview (already redacted by the kernel by key name and connection secrets, ≤500 characters), optional scopes `scopes`, `expiresAt`, `state`, `decidedBy`, `webUrl` | when `pending`, one approve button per scope + reject + web link; in other states the buttons are removed and only the state and a "details" link are shown |
| `question` | `form` (`InputForm`), `state`, `answerSummary`, `webUrl` | when `questionRenderableInline(form)` is true (exactly one enum field, single-select ≤5 / multi-select ≤10, no "other" allowed) it is answered inside the IM, otherwise only the web link is given |
| `connect` | `appName`, `url` | link button |
| `bind` | `text`, `url` | link button (the kernel sends it only in direct messages) |

- Validate the structure with `validateChannelCard(card)` (returns a list of problems); URL fields must be absolute http(s) addresses of at most 2000 characters.
- For fallback text always use `renderCardAsText(card, locale)` (Markdown, including links; model-controllable fields in code), and don't write your own; when `cards: false` is declared the kernel has already done it for you.
- A card action is resolved into `CardAction { cardKind, cardId, action, scope?, answer? }`. **Button callback value**: encode the needed information (card id, action, scope, option value) into the button itself (a compact JSON array); the extension doesn't remember the forms it sent, so any replica can parse it; when the encoding exceeds the platform limit (Slack 2000; Lark doesn't state one, take 2000) throw and give only the web link instead; parsing is **strict**: length, type, kind and scope are checked item by item, an invalid value returns null and the click is ignored (only action ids with this extension's prefix are recognized).
- The conversation type in the callback value is only a reference (see above; the kernel goes by the recorded card target); if you can, turn off interaction after a card is forwarded (Lark `enable_forward_interaction: false`).
- The response to a card click doesn't change the card: the kernel then updates the card per the new approval / question state.

## Security rules (every channel extension must do these)

- **Model text must not @ everyone or anyone**: escape the platform's control sequences when converting rich text. Slack: escape `&`, `<`, `>`, percent-encode `<`, `>`, `|` in link addresses, so the model can't write `<!channel>` / `<!here>` / `<@U…>`; Lark: turn `<` and `&` outside code into entities, backslash into `&#92;`, and split `<at` inside code, so the model can't write `<at id=all>`. Titles, argument previews, display names and fallback text in cards are escaped the same way (not just the body).
- **Link allowlist**: only turn `http(s)://` (Lark adds `mailto:`) into links; `javascript:`, platform-private protocols, images and reference-style links are shown as plain text. A card's link buttons use only http(s) addresses.
- **Credentials stay out of logs and errors**: tokens, App Secret and client secret are not written to logs, error messages or `last_error`. The kernel registers deployment-level `secret()` fields and a channel connection's secret fields for redaction, but redaction is only a backstop.
- All credentials are passed in by the kernel from config (the `config` parameter), so the extension **doesn't need `permissions.secrets`**; `permissions.network` lists fixed domains (display only, not enforced, no wildcards; when the WSS host is assigned by the platform, list the main one or none).

## What the kernel owns (extensions must not do these)

- **Long connection and leader election**: runs only on the gateway role (outbound delivery and inbound jobs stay on the worker role). Each channel connection in long-connection mode is held by only one replica at any moment (Redis lease `capk:channel-lease:<id>`, TTL `channels.leaseTtlMs` default 30s, lease renewal and scanning at `channels.scanIntervalMs` default 10s); if the holder dies, another replica takes over after the lease expires; when a connection is disabled, deleted or has its credentials rotated, the holder disconnects and reconnects with the new config. **Fair sharing**: gateway replicas heartbeat into `capk:gateway-replicas:<plugin>` (per extension, so a gateway that cannot load the extension does not count). Each scan, a replica claims connections only up to its target, `floor(runnable / live)` (the remainder goes to the lowest replica ids) plus `channels.shareSlack` (default 1); above the target it hands back one connection per scan round (the most recently connected) with a short handoff marker so it does not re-claim it. The lease alone still guarantees one holder; sharing only decides who claims, so adding gateways spreads connections but adds no throughput (work happens on the worker role). The extension's `connect` handles just one connection and doesn't decide "whether I should connect". **When an extension is disabled, uninstalled or upgraded to a new instance while running (C17)**, the kernel's `ChannelSupervisor.pluginChanged` hands back all of that extension's long connections held on this replica: it aborts the `signal` of the old instance's `connect`, waits for it to return, then releases the lease; if the extension is still there (a new instance), the next scan has any replica run leader election again for the new instance, and revoked ones no longer connect. So `connect` must respond to `signal` promptly and return, and must not swallow the abort and keep reconnecting.
- **Durable inbound and outbound**: inbound is processed in a queue (retry with backoff on failure, 5 times in total), outbound resumes delivery by conversation event sequence number (`channel_deliveries.last_seq`), after a crash another replica continues delivering without duplicates; streaming drafts, finalization and card state updates are all orchestrated by the kernel.
- **Dedup**: inbound by `messageId` / `eventId`, outbound by `idempotencyKey` and the delivered sequence number.
- **Re-authorization of card actions**: the clicker is mapped to an account by the same rules as inbound, then goes through the approval / question service's authorization (a non-approver gets only an explanatory reply; an unbound person receives a binding card in a direct message, and in a group is only told to go to a direct message).
- **Identity resolution, binding, anonymous guests, fixed wording** (i18n, by the org's `locale`).

So an extension **must not keep shared state across calls** (module-level Maps, in-process events and timers are all out, and `check:extension-state` blocks them). The only in-process caches allowed are read-only lookup caches that are "correct even if lost", created in the factory function with a size cap and expiry (for example a display name cache of 10 minutes / 1000 people, a tenant token cache until 3 minutes before expiry).

## `identity-source@1`

```ts
interface IdentitySource {
  label: { zh: string; en: string };
  authorizeUrl(args: { config; redirectUri; state; nonce; codeChallenge?; codeChallengeMethod? }): string;
  callback(args: { config; redirectUri; query; nonce; signal; codeVerifier? }): Promise<ExternalIdentity>;
}
```

- Deployment-level: `config` is `config.deployment`, and the login page shows the source only after an admin adds the extension name to `auth.loginSources`. The callback address is `<http.publicUrl>/api/v1/auth/sso/<plugin name>/callback`.
- The state, nonce and PKCE verifier are all generated by the kernel and stored in Redis (state is single-use and bound to the browser that started the login).
- **`source` must be `` `${extension name}:${tenantId}` ``**: the kernel checks it after the callback and rejects a mismatch as an identity source error (Ruling A19).
- **`externalId` must be the same kind of id as the `sender.externalId` in that platform's channel inbound** (the same app, the same definition), otherwise login and the bot can't match people.
- **`emailVerified` is true only when the platform docs explicitly say the email is verified** (Slack OIDC's `email_verified`); report false when the docs don't say (Lark login and both platforms' directories are false). It decides whether an existing account can be merged by email.
- **Use PKCE if the platform supports it**: put `codeChallenge` / `codeChallengeMethod` in the authorization address and pass `codeVerifier` when exchanging the token (Lark). If it isn't supported, ignore it and write the reason in the README (Slack OIDC doesn't declare PKCE).
- **Validate the ID token if there is one**: JWKS signature, `iss`, `aud = clientId`, not expired, `nonce` equal to the one at initiation; the userinfo's user / tenant must match the ID token. Where there is no ID token (Lark), check that the user's tenant equals the login app's tenant, and that `redirect_uri` matches strictly.
- Request only the scopes login really needs: requesting a scope the app hasn't been granted makes login fail for everyone (Lark 20027), so Lark login carries no scope (Ruling A31).
- Login only creates an account and doesn't add it to any org; merging by verified email takes effect only for the full keys `<plugin name>:<tenant>` in `auth.trustedIdentitySources`.

## `directory@1`

```ts
interface Directory {
  configured?(orgConfig: unknown): boolean;
  listMembers(args: { orgConfig; cursor?; signal }): Promise<{ members: DirectoryMember[]; next?: string }>;
}
```

- **Pagination**: each call returns one page and the next-page cursor `next`, and the last page has no `next`. The kernel gives each page a 60-second limit and a round at most 10000 pages. Put everything needed to continue in the cursor (the extension is stateless).
- **`configured(orgConfig)`** (Ruling A28): implement it when the same extension also provides channel and other extension points and the directory fields are optional in the org-level config. When it returns false, the kernel silently skips the hourly scan, `directory_changed` and the pre-removal re-check, and a manual sync returns 409 `directory.not_configured`. It must be a pure function (no requests, no throwing).
- **Throw when not configured or the credentials are wrong, and never return an empty list**: an empty list equals "everyone has left".
- **If the listing is incomplete it must fail**: any page that can't be fetched in full (insufficient permission, rate-limit waiting over budget, the department structure changing mid-sync, the tenant changing within a round, a status field unavailable for lack of permission) throws. The kernel removes people only when the whole round completes successfully; on a mid-round failure it only adds and doesn't remove. Don't "return whatever you could get on a best-effort basis".
- **Rate limiting**: within the page, retry for the wait time the platform gives, with a budget on cumulative waiting (both extensions use 30 seconds per page and at most 3 per request); beyond it throw "rate limited", and this round is treated as incomplete.
- **`active: false`** reports someone as left (Slack `deleted`, Lark `is_resigned` / `is_frozen` / `is_exited`); people who aren't formal members are not reported (Slack guests `is_restricted` / `is_ultra_restricted` aren't synced, Ruling A29; Lark inactive and not-joined people aren't reported; bots and Slackbot aren't reported). It doesn't matter if the same person appears several times; the kernel dedups by identity.
- Protections on the kernel side (the extension needn't implement them, but should know):
  - Only memberships with `memberships.source = "directory:<plugin>"` are revoked; people added manually / by invitation are never removed by sync, and the account itself is not deactivated.
  - **Mass-removal guard** (Ruling A17): in a round not triggered manually, if the planned removals exceed `max(5, 20% × the current number of directory members)`, or the list has no active members while directory members already exist, it is treated as incomplete and nothing is removed, with the audit event `org.directory.removal_blocked`; a manual sync is not subject to this limit.
  - **Changes during sync** (Ruling A32): when another `directory_changed` / sync request arrives while a round holds the lock, this round removes nobody (audit `partialReason = changed_during_sync`), and the follow-up round that runs afterwards does the removal. When a manual sync meets an occupied lock, it also records a flag and the follow-up (trigger source `changed`) completes it, so that round is still subject to A17.
  - **Exclusion list** (Ruling A20 / A24): when an admin removes someone manually or the person leaves, an exclusion record is written for every directory extension enabled for that org, and sync no longer adds the person back until someone rejoins them manually.

## Testing

The fake servers are all in `@capybara-hq/testing`:

| Fake server | Plays | Constructing inbound events |
|---|---|---|
| `startFakeChannelServer()` | a generic fake IM: NDJSON long connection, `/send` `/update` (dedup by `idempotencyKey`), OAuth (including PKCE), directory `book(key)`; counts the peak number of concurrent long connections per connection | `fakeDm`, `fakeGroupMessage`, `fakeCardAction`, `fakeDirectoryMember`; `push(connectionId, event)` |
| `startFakeSlack()` | Web API, Socket Mode (records `acks`), Sign in with Slack (RS256 ID token, `tamperNextIdToken`), `users.list`; `failNext` injects platform errors / 429 | `slackDmEvent`, `slackMentionEvent`, `slackBlockAction`, `findSlackButton` |
| `startFakeLark()` | OpenAPI, long connection (the SDK's protobuf frames, runs the real `WSClient`, records `acks`), OAuth + PKCE, department / user pagination; `failNext`, `hideUserStatus` | `larkMessageEvent`, `larkCardAction`, `findLarkButton` |

- **Extension unit tests** (`plugins/<name>/test`): call the factory function directly (such as `createSlackChannel({ apiUrl })`) against the fake server, covering: the handling and ids of each kind of inbound message, stripping the @, ack only after `onEvent` resolves (no ack on reject), reconnection and backoff, the error mapping table, splitting and `too_large`, escaping (`@channel` / `<at id=all>` injection), the link allowlist, the encoding limit and strict parsing of button callback values, the identity key and ID token tampering, directory pagination / rate-limit budget / not configured / incomplete-listing errors.
- **Dual-replica kernel acceptance** (`packages/kernel/test/channels/*.dual.test.ts`): `createDualReplicaHarness({ extensions: [MODEL_FAKE, <plugin entry path>], extensionConfig: { <plugin>: { apiUrl: fake.apiUrl, … } } })`, with the extension loaded by source path. It must prove: there is only one long connection; after killing the holder another replica takes over; a redelivered message is processed only once; streaming replies, approval card clicks, card updates and the final reply are each delivered only once. See `slack.dual.test.ts`, `lark.dual.test.ts`, `supervisor.dual.test.ts`.
- **The same identity row in all three places**: the flow of `slack-identity.dual.test.ts` and `lark-identity.dual.test.ts`: web login (through the fake authorization page, callback) -> directory sync adds the same person to the org (no new identity, no new account) -> the same person direct-messaging the bot is recognized as that account (no binding card sent). A new platform must have this case; it catches mistakes such as the tenant definition, the id kind, and app mismatch.
- Write the test extension by copying fake-im (`packages/kernel/test/fixtures/plugins/fake-im`); the first acceptance segment `m4-segment1.dual.test.ts` runs all the kernel behaviors with it.
- The second acceptance segment `m4-segment2-slack.dual.test.ts` / `m4-segment2-lark.dual.test.ts` runs the same flow once each with the real extensions. The real extensions don't carry `x-pid`; to find the replica holding the long connection use the fake platform's `socketPeerPorts()` plus `test/helpers/port-owner.ts` (looks up the process by local port).
- Real platforms: `plugins/<name>/test/live/*.live.test.ts` runs only when `CAPYBARA_TEST_LIVE_TOOLS=1` and the platform variables are all set (only checks that need no human action are run); the manual part is in `docs/superpowers/plans/m4-live-acceptance-checklist.md`.

## New channel extension checklist

1. Write the README first: the steps to create the app and the permissions (scope) table, the platform doc source and lookup date of every trade-off, acknowledgement / reconnection / rate limiting / length / error mapping, and items awaiting confirmation in real integration.
2. Manifest: `provides` the three extension points (as needed), `permissions.network`, `config.deployment` (login), `config.org` (directory; implement `configured` when the fields are optional), and put the channel connection config in `connectionSchema`.
3. Implement per the conventions above, with escaping and the link allowlist in their own file with unit tests.
4. Fake server: if the platform protocol can be fully simulated, simulate it (Lark's protobuf frames), so extension tests run the real SDK.
5. A dual-replica case for the same identity row in all three places.
6. `pnpm lint && pnpm typecheck && pnpm check && pnpm test`.
