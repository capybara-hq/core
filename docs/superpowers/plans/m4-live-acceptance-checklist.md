# M4 live platform acceptance checklist (Slack / Lark)

The second-segment acceptance of M4 (Task 20) has three parts:

1. **Dual-replica fake-platform acceptance** (automatic, runs in `pnpm test`): `packages/kernel/test/channels/m4-segment2-slack.dual.test.ts`,
   `m4-segment2-lark.dual.test.ts`.
2. **Automatic live-platform checks** (no human action needed, run when credentials are present): `plugins/slack/test/live/slack.live.test.ts`,
   `plugins/lark/test/live/lark.live.test.ts`.
3. **Manual live-platform checks** (sections 3–5 of this checklist): DM the bot, click cards, browser login, directory change events.

Every step of creating the app on the platform side and the permission (scope) tables are in `plugins/slack/README.md` and `plugins/lark/README.md`, and are not repeated here.

---

## 1. Credentials and environment variables

Credentials live in `~/.capybara-test.env` and are injected into the environment by the outer shell (the test code does not read this file). **Never print or paste the values at any time.**
A value that starts with "替换为" (placeholder text meaning "replace with") counts as unfilled.

| Variable | Required | Description |
|---|---|---|
| `CAPYBARA_TEST_LIVE_TOOLS` | Yes | Set to `1` to run the live-platform cases |
| `CAPYBARA_TEST_SLACK_APP_TOKEN` | Required for Slack | App-level token `xapp-…` (scope `connections:write`) |
| `CAPYBARA_TEST_SLACK_BOT_TOKEN` | Required for Slack | Bot token `xoxb-…` (all the bot scopes in the manifest granted, including `users:read` and `users:read.email`) |
| `CAPYBARA_TEST_SLACK_TEAM_ID` | Required for Slack | Workspace id `T…` |
| `CAPYBARA_TEST_SLACK_CHANNEL` | Optional | Test channel id (`C…`, the bot must have joined) or the DM id with the bot (`D…`); the send / receive / card cases run only when set |
| `CAPYBARA_TEST_SLACK_CLIENT_ID` / `_CLIENT_SECRET` | Optional | Client ID / Secret for Sign in with Slack; the login check runs only when set |
| `CAPYBARA_TEST_LARK_APP_ID` | Required for Lark | Enterprise self-built app App ID `cli_…` (login, bot and directory use the same app) |
| `CAPYBARA_TEST_LARK_APP_SECRET` | Required for Lark | That app's App Secret |
| `CAPYBARA_TEST_LARK_CHAT_ID` | Optional | `oc_…` of the test group (or the DM with the bot); the bot must be in it; the send / receive / card cases run only when set |
| `CAPYBARA_TEST_LARK_CHAT_TYPE` | Optional | Set to `dm` when the above is a DM (rendered as a group chat by default) |

## 2. Automatic live-platform checks

```bash
set -a; . ~/.capybara-test.env; set +a     # only injects the environment; do not cat / echo
CAPYBARA_TEST_LIVE_TOOLS=1 pnpm vitest run plugins/slack/test/live -t live
CAPYBARA_TEST_LIVE_TOOLS=1 pnpm vitest run plugins/lark/test/live -t live
```

Expected (every item should pass; cases missing an optional variable show as skipped):

| Case | Slack expectation | Lark expectation |
|---|---|---|
| verify | `tenantId` = `TEAM_ID`, `botUserId` is `U…` / `W…` | `botUserId` is `ou_…`, `tenantId` (tenant_key) is non-empty |
| long connection | `apps.connections.open` returns `wss://…`; after the plugin's `connect` connects it throws nothing for 10 seconds, has no warn / error logs and no reconnect, and returns normally after abort | Same as the left (SDK `WSClient`) |
| first page of the directory | At least one person, tenant = `TEAM_ID`, id is `U…` / `W…`, emails always unverified | At least one person, tenant matches verify, id is `ou_…` (needs the contacts permission scope to be all members) |
| send / receive and cards | A message appears in the test channel → is edited ("edited" in bold) → an approval card → the card changes to "Approved" and the buttons disappear | A message card appears in the test group → is updated → an approval card (in Chinese) → changes to "Approved" and the buttons disappear |
| login | The authorization URL is `https://slack.com/openid/connect/authorize` with scope `openid email profile`; exchanging an invalid authorization code for a token gives `invalid_code` (not `invalid_client_id` / `bad_client_secret`, meaning the client credentials are correct) | The authorization URL is `https://accounts.larksuite.com/open-apis/authen/v1/authorize`, with PKCE |

After the send / receive cases finish, **check by eye in IM**: the message format (Slack mrkdwn bold, Lark card markdown), the approval card's title / tool name /
argument preview / the layout of the two buttons, and that the buttons really disappear after the update.

Common causes of failure: Socket Mode not turned on or the app token missing `connections:write` (Slack); the long-connection subscription method not set to "使用长连接" (use long connection)
or the version not published (Lark); the bot not in the test channel / group (`not_in_channel` / 230002); the contacts permission scope not set to all members (Lark 40004).

## 3. Preparing the manual checks: run a local kernel + web

```bash
docker compose -f docker/compose.dev.yaml up -d
export CAPYBARA_PLUGINS='["@capybara-hq/plugin-model-fake","@capybara-hq/plugin-todo","@capybara-hq/plugin-slack","@capybara-hq/plugin-lark"]'
export CAPYBARA_PLUGIN_PERMISSIONS__AUTO_APPROVE=true        # for local trials only
export CAPYBARA_HTTP__TRUST_PROXY=1
export CAPYBARA_AUTH__COOKIE_SECURE=false                    # drop this line when the public address is an https tunnel
export CAPYBARA_HTTP__PUBLIC_URL=<externally reachable address of the web app>          # such as http://localhost:3000, or the https address the tunnel gives
export CAPYBARA_AUTH__LOGIN_SOURCES='["slack","lark"]'
# Deployment-level login config (values are referenced from environment variables; don't write plaintext into the command history)
export CAPYBARA_PLUGIN_CONFIG="{\"slack\":{\"clientId\":\"$CAPYBARA_TEST_SLACK_CLIENT_ID\",\"clientSecret\":\"$CAPYBARA_TEST_SLACK_CLIENT_SECRET\"},\"lark\":{\"appId\":\"$CAPYBARA_TEST_LARK_APP_ID\",\"appSecret\":\"$CAPYBARA_TEST_LARK_APP_SECRET\"}}"
pnpm capybara migrate
pnpm capybara start            # kernel :8080
pnpm dev:web                   # in another terminal, web :3000
```

- When the platform requires the login callback to be https, use a tunnel (such as `cloudflared tunnel --url http://localhost:3000`) to expose :3000 as https,
  and set `CAPYBARA_HTTP__PUBLIC_URL` to it.
- Register `<publicUrl>/api/v1/auth/sso/slack/callback` under the Slack app's **OAuth & Permissions → Redirect URLs** and
  `<publicUrl>/api/v1/auth/sso/lark/callback` under the Lark app's **安全设置 → 重定向 URL** (Security Settings → Redirect URLs).
- Open `<publicUrl>` in a browser: the setup wizard creates the admin `owner` and the org; under "Settings → Org → IM language" choose **en** (the expected text below
  is written in English).
- Create an agent: model `model-fake/fake-1`, add the todo plugin's `write` to its tools, and tighten it to require approval. When the web app does not yet support tightening, create it through the API,
  with this definition:

  ```json
  {
    "name": "Helper",
    "instructions": "Be helpful.",
    "model": { "provider": "model-fake", "model": "fake-1" },
    "tools": [{ "kind": "plugin", "plugin": "todo", "name": "write" }],
    "toolPolicies": { "todo__write": "ask" }
  }
  ```

  model-fake instructions: `echo:<text>` replies with the text as-is; `slow:<milliseconds>:<text>` streams out slowly chunk by chunk;
  `tool:todo__write:{"todos":[{"content":"Ship M4","status":"pending","activeForm":"Shipping M4"}]}` calls the write tool.
- Prepare three IM test accounts: **A** (the initiator, who also has a local account `alice`, invited into the org by the owner), **B** (another org member,
  who joins through directory sync) and **C** (used to test login and offboarding).

Do Slack and Lark each once below; the "platform differences" column lists only what differs.

## 4. Manual check steps

### 4.1 Create the connection (only one long connection)

| Step | Expectation |
|---|---|
| "Settings → Plugins": enable `slack` (`lark`), fill in the directory credentials in the org-level config (Slack `teamId` + `botToken`; Lark `appId` + `appSecret`) → "Sync now" | The audit shows `org.directory.synced` (`partial: false`); B and C become members (source `directory:slack` / `directory:lark`); if A is also in the directory, A would be synced as a **different** account, so first make sure A's IM account is not within the directory scope (Slack: add A to the workspace after the first sync round; Lark: A is not in the directory's visible range), or finish 4.2 before syncing |
| "Channels → New connection": pick the plugin, fill in the bot credentials, pick Helper, and choose `bind` for unbound handling | Saves successfully; the connection page shows the tenant (Slack `T…`, Lark tenant_key), the bot, the status "Connected", and an empty `last_error`; credentials only show "set" |

### 4.2 Binding (an unbound person DMs)

| Step | Expectation |
|---|---|
| A DMs the bot `hello` | Receives **Please link your Capybara account before chatting with me.** and a button that opens the web page (a Slack Block Kit link button / a Lark card button) |
| A stranger @-mentions the bot in a group | Receives only a hint to DM it (containing `direct message`), and the group gets **no** binding link |
| A clicks the button and signs in to the browser as `alice` | The confirmation page shows A's platform display name (anti-phishing) and the connection name; after clicking confirm it says the binding succeeded |
| Open the same binding link again | The link is no longer valid (single use) |
| "Settings → IM identities" | A row for the identity `slack:<T…>` / `lark:<tenant_key>` appears |

### 4.3 Streaming reply in a DM

| Step | Expectation |
|---|---|
| A DMs `slow:150:` followed by about 200 words of English | A draft appears first, then is updated **in place** several times and finally settles as the full text; throughout there is only **one** bot message (a card on Lark, an ordinary message on Slack) |
| Open this conversation under "Conversations" in the web app | The same content is visible; the conversation belongs to `alice` and the agent is Helper |

### 4.4 Approval card in a group chat

| Step | Expectation |
|---|---|
| Add the bot to the test group; A @-mentions the bot in the group and sends `tool:todo__write:{…}` (see section 3) | The bot replies with an approval card in the **thread rooted at this message**: tool name `write`, argument preview, the button **Approve once** (plus approve for the session / deny), and a link to handle it in the web app |
| B clicks **Approve once** | The thread receives **You can't handle this request.**; the card is unchanged; the approval is still pending in the web app; the tool did not run |
| A clicks **Approve once** | The card changes in place to "Approved" and the buttons disappear; the final reply (including the todo list result) then appears in the thread; in the web app the approval is approved, decided by alice |
| A clicks twice quickly (start a new approval) | Approved only once; the second click gets an "already handled" style hint or no change, and it does not run twice |

#### 4.4.1 Lark: whether a card callback is redelivered when the kernel is unavailable (still to be confirmed)

Lark's card callback (`card.action.trigger`) goes over the long connection. The plugin acks only after the kernel has accepted it, so what needs confirming is: when no client is online at the time of the click,
or the client replies with a failure, whether Lark redelivers later the way it does for message events. With only one kernel replica, do the following (with two replicas, stop one first):

1. A sends `tool:todo__write:{…}` in the group again to get a new pending approval card. Do not click it.
2. In the terminal running the kernel, press Ctrl-C to stop the kernel, and note the time **T0**. Wait until the connection page (the web app is still running) or the Lark developer console shows the long connection has dropped,
   or at least wait 10 seconds.
3. A clicks **Approve once** on this card, notes the time **T1**, and takes a screenshot of the Lark client's prompt (the toast text, such as "请求超时" (request timed out) or "出错了" (something went wrong)).
4. Within 60 seconds after T1, run `pnpm capybara start` again. Note the time **T2** when the connection page shows "Connected" again.
5. Do not click the card again. Observe for **5 minutes** from T2:
   - Whether the card changes in place to "Approved" and whether the final reply appears in the thread. If it does, note the time **T3**.
   - Search the kernel log for this card's approval id or `card_action` to see whether this click was received.
6. Deciding the result:
   - **It is redelivered**: within 5 minutes the card is handled, and only once (in the web app the approval's decider is alice, and todo ran only once). Note T3 − T2.
   - **It is not redelivered (the click is lost)**: after 5 minutes the card is still pending and the log has no record of this click. Then click **Approve once** again and confirm that this one
     can approve normally.
7. When the click is lost, record in the report:
   - T0, T1, T2, and the downtime (T2 − T0);
   - the Lark client's prompt from step 3 (with a screenshot);
   - whether the log has this click;
   - whether the second click succeeded, and whether anything ran twice (whether todo ran only once);
   - whether the original click arrived late after the second click (a second card_action appears in the log; the kernel should reply "already handled" and must not run it again).

   This conclusion decides how the README's "whether Lark redelivers after a card callback replies with a failure" is worded: if it does not redeliver, the README's "Behavior" section must say that "card clicks made
   while the kernel is unavailable are lost and need to be clicked again".

### 4.5 Kill a replica and take over (optional, needs two kernel replicas)

| Step | Expectation |
|---|---|
| Start another kernel replica (same PG / Redis, another port, such as `CAPYBARA_HTTP__PORT=8081 pnpm capybara start`) | The platform side still has only one long connection (the connection page status is unchanged) |
| `kill -9` the replica that holds the long connection (see which replica's log shows the connection being established; or try them in turn) | Within about one lease period (30 seconds by default) the other replica takes over, and the connection page still shows "Connected" |
| After takeover A DMs `echo:after takeover` | Receives only one reply `after takeover`; earlier messages are not replied to again |

### 4.6 Web login

| Step | Expectation |
|---|---|
| Sign out of the web app and on the login page click "Sign in with Slack / Lark", authorizing as **A** | Returns to the login page with a notice that the identity is not verified (`sso.identity_not_verified`): an identity bound through IM cannot sign in directly (Ruling A18) |
| Sign in to the web app as `alice`, click "Verify" on that identity under "Settings → IM identities", and go through one platform authorization | Returns to the web app, still `alice`; then sign out, sign in with the platform again and authorize as A → goes straight into the `alice` account |
| Sign out and sign in with the platform, authorizing as **C** | Enters C's account (the same account already created by the directory sync in 4.1, with no second one created; "Settings → IM identities" has only one row); during Slack login the browser's address is `slack.com/openid/connect/authorize`, and for Lark it is `accounts.larksuite.com/...` with `code_challenge` |
| Click "Cancel / Deny" on the platform authorization page | Returns to the login page and shows login failed; no account is created |

### 4.7 Directory change events (joining and offboarding)

| Step | Expectation |
|---|---|
| Add a member D on the platform (Slack: invite them into the workspace, triggering `team_join`; Lark: create a user in the directory and activate them, triggering `contact.user.created_v3`) | Within 1 minute the audit shows one `org.directory.synced`, with trigger source `changed` and `added: 1`; D becomes an org member (source `directory:*`) |
| Change D's name (`user_change` / `contact.user.updated_v3`) | Triggers another sync (`changed`), with `added: 0` and `removed: 0` |
| Deactivate D (Slack: Deactivate account; Lark: set to resigned) | In the next sync round (triggered by the change event, or "Sync now") `removed: 1`; the audit shows `org.member.offboarded` (`reason: directory`); D's web session is revoked (refreshing the page goes back to the login page) |
| D (if they can still send messages), or before deactivation, DMs the bot again | After deactivation the bot replies that they are not an org member (containing `not a member`), and the agent does not run as them |
| Manually "Remove" a member E who was added by directory sync, then "Sync now" | E is not added back (exclusion list, Ruling A20) |

### 4.8 Wrap-up

- Check the kernel log throughout: no token / App Secret is printed (only "set" or masked values appear).
- The connection page `last_error` is empty; on the platform side (the Slack app's Socket Mode page / the long-connection status in the Lark developer console) there is only one connection.
- Disable the connection: after "Disable" on the connection page, the platform-side connection drops quickly (within one scan period); the bot no longer replies.

## 5. Record the results

Record the result of each step (pass / fail + what was observed) in the Task 20 report or the PR description, especially the items the README marks as "still to be confirmed in live platform testing":

- Whether Lark redelivers after a card callback replies with a failure;
- How Lark JSON 2.0 cards (multi-select form, button layout) actually render;
- Lark's long-connection WSS host name (whether it needs to be added to `permissions.network`);
- The return-code types of the Lark v2 token API, and the stability of recursive department pagination;
- Slack Socket Mode reconnecting in a real workspace (Slack recycles the connection about every few hours; leave it open for a long time and observe an immediate reconnect after `refresh_requested`)
  and its rate-limit behavior.
