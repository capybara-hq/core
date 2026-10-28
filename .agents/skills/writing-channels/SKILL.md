---
name: writing-channels
description: 'Use when changing the kernel side of channel@1 / identity-source@1 / directory@1 (packages/kernel/src/channels, the SSO login flow, directory sync) or their SDK contracts: the identity key <plugin>:<tenant>, the inbound conventions the kernel relies on (messageId / threadId / tenantId, the stripped bot @, commands and skill invocations, ack only after onEvent resolves, card_action and card re-authorization), webhook inbound (the gateway route, dedupe, channel.webhook_retry, webhookBaseUrl), the gateway role, leader election and fair sharing (shareSlack), durable inbound / outbound queues, ChannelSendError and features, the card spec (validateChannelCard, renderCardAsText), sub-agent cards, the identity-source checks (state, nonce, PKCE, source), the directory sync guards, and kernel tests with fake-im, startFakeChannelServer / startFakeSlack / startFakeLark and dual-replica. To write a channel extension (slack, lark) see writing-channels in capybara-hq/plugins.'
---

# Channels, login and directory: the kernel side

This skill covers what core owns: the three contracts as the kernel relies on them, the gateway role, leader election and sharing, durable inbound / outbound queues, dedupe and card re-authorization, the webhook route, the identity-source login flow and the directory sync guards, plus the fake platforms (`startFakeSlack`, `startFakeLark`, `startFakeChannelServer`) and the `fake-im` extension in `@capybara-hq/testing` that test them. **Writing a channel, login or directory extension** (reconnection loops, native rich text and escaping, button encoding, platform-specific rules, README, its tests and the checklist) is in [writing-channels in capybara-hq/plugins](https://github.com/capybara-hq/plugins/tree/main/.agents/skills/writing-channels).

An IM platform is usually provided by one extension offering all three extension points, and the three share **the same identity key**:

| Extension point | Contract | Config level | Enabled per org |
|---|---|---|---|
| `channel@1` (bot) | `packages/plugin-sdk/src/channel.ts`, cards in `cards.ts` | one per **channel connection** (`connectionSchema`, created by an org admin under "Channels" in the web app) | yes (`orgScoped`) |
| `identity-source@1` (web login) | `identity.ts` | **deployment-level** (`config.deployment`, enabled through `auth.loginSources`) | no (Ruling P1) |
| `directory@1` (directory sync) | `directory.ts` | **org-level** (`config.org`) | yes (`orgScoped`) |

For the extension host (manifest, two-level config, the multi-replica prohibitions, permission approval) see `.agents/skills/writing-extensions`.

Implementations:

- `packages/testing/fixtures/extensions/fake-im`: the minimal shape of all three points plus a tool (connects to `startFakeChannelServer`); core's kernel tests run on it and on the small fixtures `packages/kernel/test/fixtures/plugins/chan-*` / `dir-*`.
- The official [`slack`](https://github.com/capybara-hq/plugins/tree/main/plugins/slack) (Socket Mode, Block Kit, Sign in with Slack, `users.list` directory) and [`lark`](https://github.com/capybara-hq/plugins/tree/main/plugins/lark) (the Lark long connection, JSON 2.0 cards, OAuth + PKCE, a directory traversed by department) plugins in capybara-hq/plugins. A kernel change that alters what an extension receives or must answer needs their tests run there too.

## Identity key (look at this first)

- `identities.source` = `"<plugin name>:<tenant id>"`, `external_id` = the platform user id. Login, channel inbound and directory must all derive **the same** key, so one person maps to exactly one identity row and one account (Slack: `slack:<team id>` + `U…`; Lark: `lark:<tenant_key>` + `open_id`).
- The tenant definition must be consistent in all three places: the `tenantId` returned by `verify`, the inbound `sender.tenantId`, `ExternalIdentity.tenantId`, `DirectoryMember.tenantId`. Slack uses the team id (under Enterprise Grid it is the workspace team, **not** the enterprise `E…`, otherwise the same person is split into two rows); Lark uses `tenant_key`.
- For platforms whose user ids differ per app (Lark's `open_id`): login, bot and directory must be the same app, and the extension should check this automatically as far as possible (see the `lark` plugin's README).

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
- **Commands in the text are the kernel's** (do not parse them in the extension): a direct message `/new` starts a new conversation; otherwise a text that, with the bot @ stripped, starts with `/name args` (`/<plugin>:<name>` too; lowercase name, then a space or the end) and names a skill the bound person may invoke on the connection's agent is posted as a skill invocation (phase D, `channels/inbound.ts`, the same `postUserMessage` path as the web: `skill.not_invocable` or `validation_failed` posts the text as typed, so a message is never lost; `/new` stays reserved in direct messages; `/etc/hosts` is plain text). So keep the leading `/` exactly where the person typed it when stripping the @. A forked skill's sub-agent approvals use phase C's cards; the parent's answer is posted to the thread as usual. No menu or autocomplete in IM. **Slack**: the client treats a message starting with `/` as a Slack slash command, so invocation works after a mention (`@bot /fix-issue 12`); whether a direct message `/fix-issue 12` reaches the bot is on the live checklist (registering app slash commands is a later option). Lark passes the text through. Tests: `packages/kernel/test/channels/inbound-skills.test.ts`.
- **M4 handles text only**: attachments such as images and files are ignored, and no event is sent when a message has only attachments (for a file share with a caption, only the caption is taken).
- **Edits and recalls / deletions send no event**; messages from the bot itself and other bots are ignored.
- In group chats the extension forwards thread replies faithfully (including `mentionsBot: false`), **and the kernel currently handles only group messages that @-mention the bot** (D4), so thread follow-ups need another @.
- **`card_action`**: `messageId` = the id of the message the card is in (the same for multiple clicks on the same card); `eventId` = the platform's unique id for this click, included if you can get it (Slack `<channel>:<card ts>:<clicker>:<action_ts>`, Lark callback `header.event_id`), and the kernel dedups platform redeliveries by it; in group chats include `target.threadId` if you can get it, and when you can't, the kernel uses the thread recorded when the card was sent.
- **`target.chatType` in a card click is only a reference value**: the kernel first checks that the chat of the click matches the target recorded when the card was sent (`channel_card_messages`), then resolves the clicker and the reply using the **recorded** conversation type, chat and thread. On a mismatch it only replies "cannot handle", and neither resolves the speaker nor sends a binding link. So tampering with the conversation type in a button callback value, or forwarding the card, has no effect.
- `directory_changed`: when the platform pushes personnel changes (Slack `team_join` / `user_change`, Lark `contact.user.*_v3`), send `{ type: "directory_changed", tenantId }`, and the kernel merges them by the minute and triggers one directory sync.

### `connect` and acknowledgement (ack)

- `onEvent` is implemented by the kernel: it only dedups (`message` by `messageId`, `card_action` with an `eventId` by `eventId`, 24 hours each) and durably enqueues the event on the queue `cap-kernel-channels`, returning quickly. **Resolving means the kernel has reliably received it.**
- The extension **acknowledges to the platform only after `onEvent` resolves**; on reject **don't acknowledge** (e.g. the handler rethrows so the platform SDK replies 500), so the platform redelivers. The extension doesn't retry `onEvent` itself, and doesn't do slow work before `onEvent` (profile lookups need a short timeout; the platform acknowledgement deadline is only a few seconds for both Slack and Lark).
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
- **Tests**: `@capybara-hq/testing` signs requests like the platform does: `signFakeWebhook(body, secret)` (the `fake-im` extension's HMAC header `x-fake-signature`, with `fakeWebhookEvents` / `fakeWebhookChallenge` bodies), `signSlackWebhook(body, signingSecret, ts)` (`x-slack-request-timestamp` + `x-slack-signature`) and `encryptLarkWebhook(payload, encryptKey)` (AES-256-CBC body `{"encrypt": ...}`). Cover: a bad signature and a stale timestamp are rejected, the challenge is answered, no ack when `onEvent` rejects, and a redelivered event is processed once. Kernel side: `packages/kernel/test/channels/webhook.test.ts` and `webhook.dual.test.ts` (on `fake-im`).

### Reconnection

The extension owns its reconnection loop inside `connect` (turning off SDK reconnection that swallows errors, backoff with jitter, abortable waits; see the plugins repository's skill). What the kernel needs: `connect` throws after repeated failures or an explicit refusal (so the kernel records `last_error` and takes over backoff), never uses `setTimeout` (`plugin-timer` of `check:extension-state`), and closes its socket and returns promptly when `signal` aborts.

### `send` / `update`

- `message.text` is Markdown, to be converted to the platform's native rich text, **not translated**. When it exceeds the platform's per-message limit, the extension splits it into several messages itself and sends them in order, **returning the id of the last one** (the kernel edits that one afterwards).
- When the new text of `update` exceeds the per-message limit and can't be made into one message -> throw a non-retryable `ChannelSendError` with `reason: "too_large"`: the kernel then `send`s the full text as a new message (split by the extension). `update` is never called on a channel with `features.edit` false; when a card's state changes the kernel sends a new card instead, the old card's buttons are still clickable, and the kernel replies "already handled".
- `features.minEditIntervalMs`: the minimum interval the platform allows between two edits of the same message; the kernel's streaming draft update interval is `max(1000, minEditIntervalMs)` (Slack 2500, Lark 1500). Higher concurrency is covered by rate-limit errors + backoff.
- `locale` (`"zh" | "en"`, the org-setting IM language): fixed wording the extension renders itself (buttons, fallback text) is chosen by it.
- `idempotencyKey` (optional): at most 40 `[A-Za-z0-9_-]` characters (the kernel actually gives 32), identical on every retry of the same logical message. Pass it through when the platform supports idempotent sending (e.g. Lark `uuid`; when split into several messages the i-th uses `<key>-<i>`), and ignore it when unsupported (Slack).
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

The kernel treats other exceptions as retryable (a limited number of times). Use `isChannelSendError` to check (duck typing, not `instanceof`). The error message carries only the step and the platform error code, **not tokens, request headers or response bodies** (`cause` may attach the original error, but the original error itself must not contain credentials either).

### Sub-agents' approvals and questions in a channel thread (phase C)

A sub-agent runs in a child conversation that has no channel binding. When it waits for a person, the
kernel appends `subagent_waiting` to the **parent** conversation, and the outbound renders it as the
same approval or question card it renders for `approval_requested` / `question_asked` (looked up by
approval or question id), posted in the parent's thread; acting on it there resumes the child, then
the parent. Cards are refreshed when the child finishes (on the parent's `subagent_finished`), not
at the moment of a decision made elsewhere, so a second click meanwhile gets "already handled". A
`connect` wait is not a card in IM: the child's result already tells the parent's model. Nothing
changes for channel extensions: these are ordinary cards (`kind` approval / question) through
`send` / `update`.

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

## Security rules every channel extension follows

The kernel hands model-controllable text to extensions and relies on them for these (the platform-specific escaping is in the plugins repository's skill):

- **Model text must not @ everyone or anyone**: the extension escapes the platform's control sequences (`<!channel>`, `<at id=all>` and the like) in the body and in every card field.
- **Link allowlist**: only `http(s)://` (and, where the platform has it, `mailto:`) become links; a card's link buttons use only http(s) addresses.
- **Credentials stay out of logs and errors** (`last_error` included). The kernel registers deployment-level `secret()` fields and a channel connection's secret fields for redaction, but redaction is only a backstop.
- All credentials are passed in by the kernel from config, so a channel extension **doesn't need `permissions.secrets`**.

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
- **`emailVerified` is true only when the platform docs explicitly say the email is verified** (Slack OIDC's `email_verified`); report false when the docs don't say. It decides whether an existing account can be merged by email.
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
- **Rate limiting**: within the page, retry for the wait time the platform gives, with a budget on cumulative waiting (the official extensions use 30 seconds per page and at most 3 per request); beyond it throw "rate limited", and this round is treated as incomplete.
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

- **Kernel tests** run on `fake-im` and the small fixtures: inbound and dedupe (`packages/kernel/test/channels/inbound*.test.ts`), outbound (`outbound.test.ts`, `outbound.dual.test.ts`), features and card fallback (`features.test.ts`, `cards.test.ts`), sub-agent cards (`subagent-cards.test.ts`), the supervisor, roles and sharing (`supervisor*.test.ts`, `supervisor*.dual.test.ts`), webhooks (`webhook*.test.ts`). The first acceptance segment `m4-segment1.dual.test.ts` runs every kernel behaviour with `fake-im` through `createDualReplicaHarness`: one long connection only, takeover after killing the holder, a redelivered message processed once, streaming replies / approval card clicks / card updates / the final reply each delivered once, and the same identity row from web login, directory sync and a direct message.
- **The official extensions' tests** (unit, dual-replica through a real kernel, same identity row, live platforms) live in capybara-hq/plugins and use `startFakeSlack` / `startFakeLark`, the webhook signers and `socketPeerPorts()` + `pidOwningLocalPort` from `@capybara-hq/testing`; changing those helpers changes their tests. The manual live part is in `docs/superpowers/plans/m4-live-acceptance-checklist.md`.
- A new fake extension for a kernel test: copy `fake-im` (`packages/testing/fixtures/extensions/fake-im`; its `src/index.ts` exports `makeFakeImChannel`, `fakeImIdentitySource`, `fakeImDirectory` for test extensions that need one part).
