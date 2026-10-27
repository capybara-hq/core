# 0.1.0 manual acceptance checklist (maintainer)

This is the hands-on acceptance run for the first release (0.1.0): one pass through everything that is
built, on a real stack, with real keys. Automated tests (`pnpm test`, the web e2e, dual-replica tests)
already cover the logic on fakes; this checklist is about what only a person with real accounts can
see: real models, real IM platforms, real sandboxes, real marketplaces, and whether the product feels
right.

How to use it:

- Work top to bottom. Section 1 sets up what later sections use (keys, stack, plugins), and the areas
  in section 2 are ordered so each one leaves behind what the next needs (an org, an agent, a skill, a
  connector, a sandbox).
- Each item is a step, then **Expect:** what you should see. Tick it, or note what you saw in
  "Results" at the end.
- Keys and tokens live in `~/.capybara-test.env` (outside the repo) and go into the environment of one
  command only. **Never print, `cat` or paste their values** into a file, issue or chat.
- A transient network error (for example `ECONNRESET`) is rerun once before it counts as a failure.
- Section 3 covers work still on branches (UI refresh B, phase D): run it after those merge.
- Section 4 lists known gaps that are **not** bugs. Check it before reporting.

Related checklists, folded in here or linked where a step needs their detail:
[m4](m4-live-acceptance-checklist.md) (Slack / Lark),
[m5](m5-live-acceptance-checklist.md) (sandboxes, media, skills),
[m6](m6-live-acceptance-checklist.md) (evals, npm, marketplaces, Nacos, multi-host),
[m7](m7-live-acceptance-checklist.md) (the release gate: npm, ghcr, clean-host compose),
[phase C](phase-c-live-acceptance-checklist.md) (sub-agents with the real superpowers).
Section 5 maps which of their sections this run replaces.

## 0. State of `main` on 2026-10-27

- Nothing is on npm or ghcr.io yet: the first publish is a manual dispatch (m7 §2). So before the
  release, **build the images locally** (§1.4) and install plugins from **packed tgz files** (§1.3),
  not by npm name. After the release, repeat the clean-host part (m7 §3–§5) with the published images.
- The official marketplace is off (`marketplaces.official.enabled: false`) and its repository is not
  published (ecosystem phase A3b). Use enterprise marketplaces, git imports and uploads.
- On branches: UI refresh B (`feat/ui-refresh-b`: the new conversation page, queue, titles, model
  switching, file previews, extension slots) and phase D (`feat/ecosystem-phase-d`: manual skills via
  `/`). Section 2 tests today's conversation page; section 3 retests it after B.

---

## 1. Prerequisites

### 1.1 Keys, accounts and services to prepare

Put each secret in `~/.capybara-test.env` under the `CAPYBARA_TEST_*` name in the last column (the
names the live tests read), then hand them to the kernel through the admin console or a
`compose.override.yaml` (§1.4). Nothing below is required for every section; each area says what it
needs.

| What | Used in | Where it goes in the product | Live-test variable |
|---|---|---|---|
| Anthropic API key | models, media, sub-agents, evals | Admin → Extensions → `anthropic` → config `apiKey` (or `CAPYBARA_EXTENSION_CONFIG__ANTHROPIC__API_KEY`) | `CAPYBARA_TEST_ANTHROPIC_API_KEY` |
| OpenAI API key and a model id | models, media | `openai` config `apiKey`, `models[]` | `CAPYBARA_TEST_OPENAI_API_KEY`, `CAPYBARA_TEST_OPENAI_MODEL` |
| An OpenAI-compatible endpoint (DeepSeek, Qwen or Ark): base URL, key, model, dialect | models (bootstrap `openai-compatible`), a model without vision | `openai-compatible` config `endpoints[]`, `apiKeys.<endpoint>` | `CAPYBARA_TEST_OAICOMPAT_BASE_URL` / `_API_KEY` / `_MODEL` / `_DIALECT` (`_VISION=1`, `_DOCUMENTS=1` when the model takes them) |
| A cheap second model | `subagent_fast`, the eval judge (`eval` purpose) | Admin → Models (purposes) | reuse one of the above |
| E2B API key and a template built from `plugins/sandbox-docker/image/Dockerfile` (see `plugins/sandbox-e2b/README.md` "Template") | sandboxes | `sandbox-e2b` config `apiKey`, `template` | `CAPYBARA_TEST_E2B_API_KEY`, `CAPYBARA_TEST_E2B_TEMPLATE` (self-hosted: `_E2B_API_URL`, `_E2B_DOMAIN`) |
| Docker (Desktop is fine; a Linux host for gVisor `runsc` and native amd64) | sandboxes, compose | — | `CAPYBARA_TEST_NO_DOCKER=1` skips Docker tests |
| Slack app (Socket Mode on): app token `xapp-…` (`connections:write`), bot token `xoxb-…`, team id, signing secret (webhook mode), client id / secret (Sign in with Slack); a test channel | channels, login, directory | connection credentials (Channels → New); deployment config `clientId` / `clientSecret`; org config `teamId` / `botToken` | `CAPYBARA_TEST_SLACK_APP_TOKEN` / `_BOT_TOKEN` / `_TEAM_ID` / `_CHANNEL` / `_CLIENT_ID` / `_CLIENT_SECRET` |
| Lark enterprise self-built app: app id / secret, encrypt key and verification token (webhook mode); a test group | channels, login, directory | connection credentials; deployment config `appId` / `appSecret` | `CAPYBARA_TEST_LARK_APP_ID` / `_APP_SECRET` / `_CHAT_ID` / `_CHAT_TYPE` |
| Three IM test people (A: also a local account; B: another member; C: login and offboarding) | channels | — | — |
| MCP servers: DeepWiki (`https://mcp.deepwiki.com/mcp`, public, no key); GitHub MCP with a PAT and a scratch repo; any MCP server with OAuth (authorization code) you can use | connectors | Connectors → Install | `CAPYBARA_TEST_LIVE_TOOLS=1`, `CAPYBARA_TEST_GITHUB_MCP_TOKEN`, `CAPYBARA_TEST_GITHUB_REPO` |
| OpenAPI: Petstore (`https://petstore3.swagger.io/api/v3/openapi.json`, public) | connectors | Connectors → Install | `CAPYBARA_TEST_LIVE_TOOLS=1` |
| S3: the bundled SeaweedFS needs nothing; optional external S3 (AWS / MinIO / OSS / TOS) with CORS for the web origin | object storage | `object-store-s3` config | `CAPYBARA_TEST_S3_IMAGE` (test image only) |
| An HTTP(S) proxy reachable from the kernel (your local proxy client) | GitHub marketplaces and git imports | `net.httpsProxy` (`CAPYBARA_NET__HTTPS_PROXY`) | `CAPYBARA_TEST_HTTPS_PROXY` |
| A public HTTPS tunnel to the web port (e.g. `cloudflared tunnel --url http://localhost:3000`) | SSO callbacks that need https, OAuth connectors, webhook inbound | `CAPYBARA_PUBLIC_URL` / `http.publicUrl`, `channels.webhookBaseUrl` | — |
| Optional: private npm registry and token; Nacos; a second host | m6 §3, §5, §7 | `packages.npmRegistry` / `packages.npmToken`; `CAPYBARA_CONFIG_SOURCE=nacos` | `CAPYBARA_TEST_NPM_*`, `CAPYBARA_TEST_NACOS_*`, `CAPYBARA_TEST_HOSTS` (names drafted in m6, not read by code) |

Inject keys into one command only:

```bash
( set -a; . ~/.capybara-test.env; set +a; <command> )
```

### 1.2 The proxy and fake-IP DNS (GitHub on your machine)

Your machine's proxy client answers DNS with fake addresses in `198.18.0.0/15`. The kernel's download
guard (`packages/kernel/src/net`) refuses private addresses, so **every** marketplace, git and archive
download fails with a private-address error unless:

- [ ] `net.httpsProxy` is set to your proxy (`CAPYBARA_NET__HTTPS_PROXY=http://127.0.0.1:<port>` for a
  local kernel; from compose containers on Docker Desktop use `http://host.docker.internal:<port>` and
  let the proxy accept connections from the Docker network). With a proxy the kernel does not resolve
  the target itself; the proxy does.
- [ ] Or list each host by name in `marketplaces.allowPrivateHosts` (e.g.
  `CAPYBARA_MARKETPLACES__ALLOW_PRIVATE_HOSTS='["github.com","codeload.github.com"]'`).
- Not affected: npm registry downloads (`packages.npmRegistry` is trusted as configured and does not
  use the proxy), model provider calls, sandbox egress.

Expect: with the proxy set, adding `obra/superpowers` as a marketplace (§2.13) refreshes; without it,
the refresh fails naming a private address. Try both once.

### 1.3 Build the plugin packages

From the repository root (a checkout of `main`, `pnpm install` done, `pnpm doctor:env` green):

- [ ] `pnpm pack-plugins` packs every official plugin into `artifacts/plugins/*.tgz`.
- [ ] `pnpm pack-plugin packages/kernel/test/fixtures/plugins/hooks-probe` packs the hooks test
  extension (`capybara-hq-test-plugin-hooks-probe-0.1.0.tgz`) for §2.18.
- [ ] Local dev only: `pnpm pack-bootstrap` packs the two bootstrap plugins into `artifacts/bootstrap/`
  and checks them against `packages/kernel/bootstrap.json`.

Expect: one tgz per plugin; `pnpm check:bootstrap` passes.

### 1.4 Stack A (main path): Docker Compose, images built locally

Follows [docs/deploy/README.md](../../deploy/README.md) "First start", with locally built images
because ghcr.io has none yet.

- [ ] `cd docker`, create `.env` with the five generated values exactly as in the deploy README (the
  `grep -vE … > .env` block), and add `CAPYBARA_IMAGE_PREFIX=` (empty: use local tags).
- [ ] `docker compose -f compose.yaml -f compose.build.yaml build`, then
  `docker compose -f compose.yaml -f compose.build.yaml up -d`.
- [ ] `docker compose ps -a`. Expect: `createbuckets` and `init` exited 0, everything else healthy.
- [ ] `docker compose logs init`. Expect: migrations applied, the bootstrap step installed
  `openai-compatible` and `object-store-s3`, and `init: no admin password file ...` (web setup path).
  A second `docker compose up -d` prints `Bootstrap already done ...; nothing to do.`
- [ ] Optional password-file path instead of the setup page (deploy README "The first enterprise
  admin"): `CAPYBARA_INIT_ADMIN_PASSWORD_FILE=./secrets/admin_password`. Expect: `init` runs
  `capybara admin create --if-none` and later starts log `enterprise admin already exists; skipped`.
  Use one path per fresh volume set (`docker compose down -v` resets).
- [ ] Settings the compose file does not pass (proxy, purposes, limits): put them in
  `docker/compose.override.yaml` for `init`, `api`, `worker` and `gateway` (deploy README "More kernel
  settings"), e.g. `CAPYBARA_NET__HTTPS_PROXY`. Then
  `docker compose -f compose.yaml -f compose.build.yaml up -d`.
- [ ] Sandbox profile (needs this checkout):
  `docker compose -f compose.yaml -f compose.build.yaml --profile sandbox up -d`. Expect:
  `docker port` of `sandbox-proxy` is empty (no host port).
- CLI inside the stack: `docker compose exec api node /app/bin/capybara.mjs help`. The commands are
  `extensions list|install|enable|disable|uninstall|review|approve`, `plugins list|import`,
  `admin create|grant|revoke`, `bootstrap`, `migrate`, `start`.
  **Note:** m7 §7 still writes `plugins install / approve / enable` for sandbox-docker; the right
  commands are `extensions install / approve / enable`.
- To install a packed tgz: Admin → Extensions → Install extension (upload), or copy it in and run
  `docker compose cp ../artifacts/plugins/<file>.tgz api:/tmp/` then
  `docker compose exec api node /app/bin/capybara.mjs extensions install /tmp/<file>.tgz --yes`,
  `... extensions approve <name> --yes`, `... extensions enable <name>`.
- Browser: `http://localhost:3000`. On another host name over plain http, sign-in does not stick
  (Secure cookies): use localhost, HTTPS, or `CAPYBARA_COOKIE_SECURE=false` plus `CAPYBARA_PUBLIC_URL`.

### 1.5 Stack B (alternative): local dev from source

Faster to iterate, closer to the m4–m6 checklists. Don't run it in two worktrees at once.

```bash
pnpm install
docker compose -f docker/compose.dev.yaml up -d                     # postgres, valkey, seaweedfs (+ bucket)
docker compose -f docker/compose.dev.yaml --profile sandbox up -d   # optional: socket proxy 127.0.0.1:2375 + images
export CAPYBARA_DB__URL=postgres://capybara:capybara@localhost:5432/capybara
export CAPYBARA_REDIS__URL=redis://localhost:6379
export CAPYBARA_MASTER_KEY=<openssl rand -base64 32, kept across restarts>
export CAPYBARA_HTTP__TRUST_PROXY=1
export CAPYBARA_AUTH__COOKIE_SECURE=false
export CAPYBARA_EXTENSION_CONFIG='{"object-store-s3":{"endpoint":"http://localhost:8333","region":"us-east-1","bucket":"capybara","accessKeyId":"capybara","secretAccessKey":"capybara-secret","forcePathStyle":true}}'
export CAPYBARA_NET__HTTPS_PROXY=http://127.0.0.1:<port>             # §1.2
pnpm pack-bootstrap
pnpm capybara migrate
pnpm capybara start --bootstrap-dir artifacts/bootstrap              # kernel :8080, all three roles
pnpm dev:web                                                         # another terminal, web :3000
```

- A source checkout skips the bootstrap step unless `--bootstrap-dir` is given (the root README still
  says the two bootstrap plugins "ship inside the CLI"; that sentence is stale).
- `CAPYBARA_EXTENSIONS='["@capybara-hq/plugin-model-fake"]'` loads an extension straight from the
  workspace (source `config`) for the plugins the root `package.json` lists; install the others
  (`todo`, `slack`, `lark`, `example-board`, `hooks-probe`) from their tgz in the admin console.
- `CAPYBARA_EXTENSION_PERMISSIONS__AUTO_APPROVE=true` skips approvals; leave it off for this run so the
  approval screens get checked.

### 1.6 Plugins to install, and where they are used

Install from `artifacts/plugins/` through Admin → Extensions → Install extension (review the
permissions, approve, enable). Each later area says which it needs.

| Plugin | Areas |
|---|---|
| `openai-compatible`, `object-store-s3` (bootstrap, already there) | all |
| `model-fake` (deterministic: `echo:<text>`, `slow:<ms>:<text>`, `tool:<key>:<json>`, `fail:<kind>`, `long:<n>`, `stall`, `media:`; model `model-fake/fake-1`) | conversation page, channels, quick checks |
| `anthropic`, `openai` | models, media, sub-agents, evals |
| `connector-mcp`, `connector-openapi` | connectors, Claude plugins (MCP templates) |
| `todo`, `example-board` | conversation page, extension UI, channels |
| `sandbox-docker` or `sandbox-e2b` (one at a time: `sandbox@1` is single-provider) | sandboxes, skills, sub-agents |
| `slack`, `lark` | channels, login, directory |
| `hooks-probe` (fixture, §1.3) | hooks |

### 1.7 Automated live tests to run first

From the repo root, keys injected per §1.1. Each skips cleanly when its variables are missing.

- [ ] Model conformance (real APIs; text, tools, images, PDFs):
  `pnpm exec vitest run plugins/anthropic/test/conformance.test.ts plugins/openai/test/conformance.test.ts plugins/openai-compatible/test/conformance.test.ts`
- [ ] Connectors: `CAPYBARA_TEST_LIVE_TOOLS=1 pnpm exec vitest run plugins/connector-mcp/test/live plugins/connector-openapi/test/live -t live`
- [ ] Slack / Lark: `CAPYBARA_TEST_LIVE_TOOLS=1 pnpm exec vitest run plugins/slack/test/live plugins/lark/test/live -t live` (m4 §2 has the expected table).
- [ ] E2B: `pnpm exec vitest run plugins/sandbox-e2b/test/live` (first run: check the 14 assumptions in the test file header, m5 §3.2).
- [ ] Docker concurrent commands: `pnpm exec vitest run plugins/sandbox-docker/test/concurrent.test.ts`; gVisor on a Linux host: `pnpm exec vitest run plugins/sandbox-docker/test/sandbox-docker.test.ts -t runsc` (m5 §2).
- [ ] Real superpowers import: `CAPYBARA_TEST_CLAUDE_SUPERPOWERS=1 pnpm exec vitest run packages/kernel/test/catalog/claude-live.test.ts` (add `CAPYBARA_TEST_HTTPS_PROXY` behind the proxy).

---

## 2. Areas

### 2.1 Setup wizard

- [ ] Open `http://localhost:3000`. Expect: redirected to `/zh/setup` or `/en/setup`.
- [ ] Submit with a wrong setup token. Expect: refused (`setup.token_invalid`), nothing created.
- [ ] Submit with `CAPYBARA_SETUP_TOKEN` from `.env`: admin login, display name, password, and a first
  organization. Expect: signed in as enterprise admin, landing in the new org.
- [ ] Reload `/setup`. Expect: setup is closed (it never runs twice).

### 2.2 Login, sessions, members and invites

- [ ] Sign out, sign in with a wrong password several times. Expect: a clear error, then the per-IP
  rate limit; the right password still works afterwards (after the limit expires).
- [ ] Settings → Members → Invite members: create an invite as `member`. Open the link (`/invite/<token>`)
  in a private window, create the account. Expect: the new person lands in the org as member; the link
  is single use.
- [ ] Change that member's role (guest / member / admin / owner). Expect: the sidebar items follow the
  role (Channels and Evals only for admin, Admin only for the enterprise admin); a forbidden URL typed
  by hand is refused by the kernel, not just hidden.
- [ ] Change your password. Expect: other sessions and personal tokens are revoked.
- [ ] Remove a member. Expect: their session ends on the next request; their conversations stay.

### 2.3 Organizations

- [ ] Admin → Organizations: create a second org; Admin → Settings: the org-creation policy.
- [ ] Switch orgs from the account / org switcher at the bottom of the sidebar. Expect: every list
  (agents, conversations, connectors, skills) is per org; nothing of org 1 shows in org 2.
- [ ] Admin → Organizations: per-org sandbox limits and sub-agent limits (concurrent 1–20, dispatches
  1–500, tokens ≥ 10,000; empty = deployment default). Expect: invalid values are refused inline.

### 2.4 Admin console and extensions

- [ ] Admin → Extensions: the bootstrap plugins show "Required" with source bootstrap; disable /
  uninstall is refused (`extension.required`). `capybara extensions list` shows state `required`.
- [ ] Install `model-fake` from its tgz: the review lists permissions (sensitive ones marked), approve,
  enable. Expect: loaded with **no restart**; `capybara extensions list` agrees.
- [ ] Deployment config: fill `anthropic` `apiKey` in the console. Expect: the value shows only "set";
  a field also set by env shows read-only with its source; an invalid value leaves the extension
  "pending configuration" without breaking the kernel.
- [ ] Disable → enable → install a newer tgz of the same plugin (repack after bumping its version, or
  skip) → disable → uninstall `example-counter` or `model-fake`. Expect: each step applies without
  restart; uninstall keeps data.
- [ ] Admin → Accounts: grant / revoke enterprise admin (`capybara admin grant|revoke <login>` does the
  same). Expect: the last active admin cannot be revoked.
- [ ] Admin → Settings: currency for the price table; Admin → Models: prices and purposes (next).

### 2.5 Models and purposes

Needs: `anthropic` and / or `openai`, and `openai-compatible` configured (§1.1).

- [ ] Configure each provider. Expect: their models appear in the agent form's model list; an
  `openai-compatible` model reads `<endpoint>/<model id>`.
- [ ] Admin → Models: map `eval` (judge), `subagent_fast`, `subagent_standard`; leave
  `subagent_capable` unmapped. Settings → Models (org): override one purpose for this org, then restore
  the default. Expect: the org page says which values come from the deployment.
- [ ] A wrong key. Expect: a run fails with a readable provider error in the conversation, not a hang.

### 2.6 Agents

Needs: a real model; `todo` enabled in the org (Settings → Extensions).

- [ ] Agents → New: name, instructions, model, a fallback model, and model parameters. Expect: the
  parameter controls follow what the model declares (e.g. `effort` levels, `thinking`); a model that
  declares no effort shows no effort control.
- [ ] Tools: add `todo__write`, `ask_user`, the sandbox tools, `skill_load`; tighten one tool to `ask`.
  Save. Expect: a new agent version; the old version is kept.
- [ ] Visibility: private vs shared with the org vs named members. Expect: a member sees only what they
  should; a shared agent's members cannot edit it.
- [ ] Skills group with pinned skills (after §2.12 / §2.13 add some): pin up to 3. Expect: a 4th is
  refused (`agent.pinned_invalid`, `too_many`); an over-size set warns.
- [ ] Sub-agents section: the `agent` tool toggle, general-purpose on / off, plugin templates, inline
  templates (name, description, instructions, tier), allowlisted org agents, and "Can be used as a
  sub-agent by other agents" (`dispatchable`). Exercised in §2.14.

### 2.7 The shell: sidebar, groups, narrow screens, themes, i18n

- [ ] Sidebar: "New conversation" first, then Overview · Agents · Skills · Inbox (count) · Connectors ·
  Catalog · Channels · Evals, an Extensions group (only when the org has extension pages), Settings,
  Admin. Expect: the inbox count shows `99+` past 99.
- [ ] Conversations area: grouped by agent, most recent first, "More" per group, ＋ next to a group
  starts a conversation with that agent, groups collapse and stay collapsed per org after a reload.
- [ ] Resize the window: below 1280 the sidebar becomes an icon rail with tooltips, below 960 a drawer
  with a menu bar (its search button opens the command palette). No layout jump on first paint.
- [ ] ⌘K (Ctrl+K) opens the command palette from any page.
- [ ] Account menu: switch language (zh / en; the URL prefix follows) and theme (dark / light). Expect:
  every page reads well in both themes; no untranslated keys or mixed languages; status never shown by
  color alone.
- [ ] Status bar at the bottom of the content area: path, page status, version, time zone; read-only.
  Forms put their submit buttons in an action row above it.
- [ ] Tab through a page: the skip link is the first stop.

### 2.8 Conversation page (today's page)

Needs: an agent on `model-fake/fake-1` with `todo__write` (policy `ask`), `ask_user`, a connector with
prompts and resources (§2.11; you can come back to the `/` and `@` items), and a real-model agent.

Run each item; they are the UI refresh anti-goals, so §3.1 repeats them on the new page.

- [ ] **Stream and interject:** send `slow:300:` plus a paragraph; while it streams, send another
  message with Enter. Expect: the interjection is taken into the same run, not lost, not duplicated.
- [ ] **Stop:** send `slow:500:…`, click stop. Expect: the run ends as stopped; the partial text stays;
  the next message starts a new run. Also stop while waiting for an approval.
- [ ] **Approvals, three scopes:** send `tool:todo__write:{"todos":[{"content":"Ship","status":"pending","activeForm":"Shipping"}]}`.
  Expect: an approval card in the conversation and in the Inbox; approve "once" runs it once; "this
  conversation" stops asking in this conversation only; "always" stops asking for you on this agent.
  Each scope is offered only when the request allows it. Deny → the model is told it was denied.
- [ ] **Questions:** a real-model agent with `ask_user` asked to "ask me to choose between two
  options". Expect: options plus free text, answer and skip both resume the run.
- [ ] **URL elicitation:** a connector whose tool asks for a URL form (MCP elicitation). Expect: the
  link shows the full address; a URL that is not http(s) (e.g. `javascript:`) is not rendered as
  a link.
- [ ] **Connect cards:** an agent using a personal (`ownership: personal`) connector you have not
  connected. Expect: a connect card that affects only you; after connecting in the pop-up, the run
  continues.
- [ ] **Crash resume:** start `slow:1000:…` with several paragraphs, then `docker compose kill worker`
  (stack A) or Ctrl-C the kernel (stack B) and start it again. Expect: within about a minute
  (`runtime.jobLockMs` / `stalledIntervalMs`, 30 s each) the run resumes and finishes; no duplicate
  messages.
- [ ] **Reconnect:** during a stream, take the browser offline (DevTools → Network → Offline) for 10 s,
  then back. Expect: the stream catches up from where it was, with nothing missing or doubled.
- [ ] **Uploads:** attach by button, by drag and drop, and by paste (an image from the clipboard).
  Expect: a progress bar, then the file under the message; `media:` with model-fake echoes the media
  it received. Over 20 MiB or a type outside `attachments.allowedTypes`: refused with the reason.
  More than `attachments.maxPerMessage` (10): refused.
- [ ] **`/` connector prompts:** type `/` at the start of an empty composer. Expect: the connector's
  prompts grouped by connector; picking one fills the composer; unavailable connectors are listed apart.
- [ ] **`@` connector resources:** type `@`. Expect: the connector's resources; a picked resource is
  attached to the message and its body reaches the model.
- [ ] **Hook-denial notice:** see §2.18. Expect: a notice naming the extension.
- [ ] **Archived output:** a tool result over `tools.outputSpillChars` (50,000 chars), e.g.
  `sandbox_bash` with `seq 1 20000`. Expect: a preview in the conversation and the full text from the
  run panel; the model can read it with `read_tool_output`.
- [ ] **Run failure:** `fail:rate_limited` (or another kind). Expect: a readable failure; the next
  message works.
- [ ] **Right panel (Inspector):** tabs for extension views and embeds (§2.17), Artifacts (files from
  `sandbox_deliver`), Run (tool calls, full output, pending-approval mark) and Context (model, usage,
  connectors, sandbox status, compaction). The last tab is remembered after a reload.
- [ ] **Compaction:** a long conversation on a model with a small `contextWindow` (an
  `openai-compatible` entry with a low value, or `long:5000` messages on model-fake). Expect: the
  conversation keeps going; the Context tab shows the compaction.
- Not on today's page (they arrive with UI refresh B, §3.1): the ⌘↵ queue, deny with a reason,
  generated titles and rename, model and effort switching in the composer, file previews in a right
  panel, inline extension cards.

### 2.9 Object storage, attachments and media

Needs: a vision model and a model without vision (an `openai-compatible` model without `vision`).

- [ ] Upload a PNG, ask what color it is. Expect: correct; the trajectory's `model_call` shows the
  attachment as `bytes`.
- [ ] Upload a one-page PDF, ask about a word in it (a model with `documents`). Expect: correct.
- [ ] Same image to the model without vision. Expect: the model gets the English placeholder
  `[Attached image "<name>" — this model cannot view images.]` and answers anyway.
- [ ] Download an attachment and a delivered file. Expect: the right file name; in stack A the URL is
  on the web origin (`/capybara/...`), not SeaweedFS directly.
- [ ] Optional: switch `object-store-s3` to an external S3 with CORS for the web origin; repeat one
  upload and download.

### 2.10 Skills

Needs: object storage, a sandbox (§2.12 can come first if you prefer), a zip with `SKILL.md`
(frontmatter `name: fruit-sum`, `description`) and `run.sh` (`echo fruit-sum ok`).

- [ ] Skills → upload the zip. Expect: `fruit-sum v1`; SKILL.md shown as text; members can view but not
  upload or delete; uploading again gives v2; a zip without `SKILL.md` or over 50 MB is refused with
  the reason.
- [ ] Select it on an agent with `sandbox_bash` and `skill_load`. In a conversation:
  `tool:skill_load:{"name":"fruit-sum"}` then
  `tool:sandbox_bash:{"command":"sh /skills/fruit-sum/run.sh"}` (after UI refresh B, add the then
  required `"description":"run the skill"`). Expect: `fruit-sum ok`;
  `touch /skills/x` fails (read-only).
- [ ] **`skill_write` on a shared agent:** another member asks it to write a skill. Expect: a tool
  approval first, then a "Skill change" in the owner's Inbox with a per-file diff; other conversations
  don't see it until approved, then load the new version on their next run; reject → the originating
  conversation goes back.
- [ ] **`skill_write` on a private agent:** applies at once, no inbox item; with
  `skills.writePolicy: "ask"` it asks first. The owner can delete agent-written skills on the agent page.

### 2.11 Connectors

Needs: `connector-mcp`, `connector-openapi`; `CAPYBARA_PUBLIC_URL` (https tunnel) for OAuth.

- [ ] Connectors → Install → MCP: DeepWiki (`https://mcp.deepwiki.com/mcp`, auth none). Expect: the
  install preview lists tools with default policies (read-only → allow, others → ask); tools reach the
  model as `<slug>__<tool>`.
- [ ] GitHub MCP with a bearer PAT (org credential): create and close an issue in the scratch repo
  through an agent. Expect: the write asks for approval; the token never appears in logs, events or
  the UI (only "set").
- [ ] OpenAPI: Petstore by spec URL. Expect: the preview lists the operations and the declared auth;
  `listPets`-style reads work.
- [ ] OAuth (authorization code, personal): register `<publicUrl>/api/v1/oauth/callback` with the
  server, install with discovery and DCR (or a manual client). Expect: each member clicks Connect,
  logs in at the provider and comes back connected (Settings → Connections); a revoked token leads to
  the connect card again.
- [ ] Drift review: Refresh on a connector whose server changed a tool. Expect: the changed tool waits
  in "pending review" and the model can't use it until approved.
- [ ] `tool_search`: an agent with more than 30 tools. Expect: a tool catalog plus `tool_search`
  instead of all definitions; turning it off in Settings → Organization works.

### 2.12 Sandboxes

Needs: stack A with `--profile sandbox` (endpoint `tcp://sandbox-proxy:2375`) or stack B
(`tcp://127.0.0.1:2375`); later E2B. Agent with `sandbox_bash`, `sandbox_read`, `sandbox_write`,
`sandbox_edit`, `sandbox_glob`, `sandbox_grep`, `sandbox_deliver`.

Docker (m5 §4, folded in):

- [ ] First use: the result says the sandbox started; `docker ps` shows `cap-<conversation id>`; the
  Context tab shows "Running".
- [ ] Attachments are visible under `/workspace/attachments`; `sandbox_deliver` of a generated file
  shows it under Artifacts with preview and download.
- [ ] Idle past `sandbox.limits.suspendAfterIdleMinutes` (set it to 1 for the test). Expect:
  "Hibernated", the container stopped; the next call resumes it with files intact and no "started"
  notice.
- [ ] Egress allowlist: `curl -sI https://pypi.org` works, `curl -sI https://example.com` fails.
- [ ] Rebuild: `docker rm -f cap-<id>`, then use the sandbox. Expect: "Sandbox was recreated; previous
  files are gone." and the run continues.
- [ ] Timeouts: `sleep 600` with `timeoutSeconds: 2` returns timed out after about 2 s and leaves no
  `sleep` process.
- [ ] **Concurrent commands:** a real model asked to run three independent slow commands at once (or
  sub-agents in §2.14). Expect: they overlap (up to `sandbox.maxConcurrentCommands`, default 6) with no
  `sandbox.busy`; two writers to the same file get "Another sub-agent is writing this file…".
- [ ] Optional on Linux: `runtime: "runsc"` in the extension config (m5 §2.3): `dmesg` shows gVisor.

E2B (disable `sandbox-docker`, install and enable `sandbox-e2b` with `apiKey` and `template`):

- [ ] The same flow; the E2B console shows one sandbox per conversation with metadata
  `capybara-sandbox-name=cap-<conversation id>`, paused when idle, deleted with the conversation.

### 2.13 Plugins, catalog and marketplaces

Needs: the proxy (§1.2); `connector-mcp` installed (Claude MCP templates).

- [ ] **Upload import:** Admin → Catalog → Import, upload `artifacts/plugins/todo-*.tgz` (or any plugin
  tgz). Expect: one review (source, content digest, extension permissions, skills, connector templates,
  dependencies, license); confirm with "install the extension on the deployment".
- [ ] **CLI import:** `capybara plugins import <file.tgz> --deploy-extension` and `capybara plugins list`
  (inside the api container or `pnpm capybara` in stack B). Expect: the same review in the terminal.
- [ ] **Direct git import:** Admin → Catalog → Import from git (`owner/repo`, ref, path), e.g. a
  plugin folder of a public repo. Expect: the catalog version records host, repo, path and commit.
- [ ] **Git marketplace (Claude Code):** Admin → Marketplaces → add `obra/superpowers` (single-plugin
  repo) or `obra/superpowers-marketplace`. Expect: refresh records a commit; the entries page lists
  superpowers; skipped entries (zip archives, npm sources, bad names) are listed with reasons.
- [ ] **Import superpowers with the translation report:** Expect: the report lists ignored hooks
  (`hooks_not_run SessionStart`), commands (`command_manual_invocation` before phase D, `command_imported` after it), agents
  (imported as templates, `superpowers:code-reviewer`), other-harness files, and the MIT license; the
  "Suggest pinned" disclosure is open with `using-superpowers` ticked.
- [ ] **http marketplace:** host a `marketplace.json` over https (a GitHub raw URL works) whose entries
  are `archive` sources with integrity (format: `packages/plugin-sdk/schemas/marketplace.v1.schema.json`),
  add it with Admin → Marketplaces. Expect: entries import; a wrong integrity is refused
  (`marketplace.integrity_mismatch`); a mirror is tried when the main URL fails.
- [ ] **Content changed at the same version:** re-import after the repo moved without a version bump.
  Expect: "content changed at the same version", a new `<version>+git.<sha12>`; the old one stays.
- [ ] **Policy:** set an item to "needs approval", then "disabled". Expect: an org admin's install goes
  to Admin → Catalog → Requests; disabled refuses.
- [ ] **Org install (Catalog in the sidebar):** install superpowers into the org. Expect: dependencies
  first, skills and agent templates created, `suggestPinned` on `using-superpowers`; a skill name owned
  by another source is refused (`plugin.skill_conflict`).
- [ ] **Upgrade and rollback:** Settings → Installed plugins (`/settings/plugins`) → Upgrade to the newer version (preview, confirm),
  then roll back. Expect: the diff names skills, templates and agent templates; failure undoes every
  step.
- [ ] **Uninstall:** removes only the components this install created and nothing else uses.
- [ ] **Pinned skill at run time:** pin `using-superpowers` on an agent; ask for a new feature on a real
  model. Expect: the first request carries the pinned block and the tool-name map; the model loads
  `brainstorming` (`superpowers:brainstorming` also resolves).
- [ ] **Bootstrap plugins:** Admin → Catalog shows `openai-compatible` and `object-store-s3` with
  source bootstrap.

### 2.14 Sub-agents

Needs: a real model with parallel tool calls; the purposes of §2.5; a sandbox; superpowers installed
(§2.13). Folds in [phase C live](phase-c-live-acceptance-checklist.md) §3.

- [ ] **Dispatch:** an agent with the `agent` tool and general-purpose on, asked to "use a sub-agent to
  summarize X". Expect: a sub-agent row (status, type, calls, duration, `›`); opening it shows the
  read-only child (task block, agent / model / tools line, its messages, stop); the parent continues
  with the result.
- [ ] **Parallel:** ask for three independent sub-agent tasks in one go. Expect: three rows running at
  once (limit `subagents.maxConcurrentPerRun`, default 4); the Context total with sub-agents exceeds
  the parent's own usage.
- [ ] **Follow-up (`resume`):** ask the parent to send a correction to the same sub-agent. Expect: the
  same child conversation gets the new task; the row keeps its place.
- [ ] **Tiers:** a template on `fast` runs on the `subagent_fast` model; `capable` (unmapped) runs on
  the parent's model.
- [ ] **Org agents, three gates:** allowlist agent Y on X; with Y `dispatchable` off, dispatch is
  refused; on, it runs with Y's own tools and model; a member of X who cannot see Y gets a refusal
  naming only the type. Turning `dispatchable` off later stops new dispatches only.
- [ ] **Limits:** set the org's dispatches to 1 (Admin → Organizations), ask for two. Expect: the second
  `agent` call is refused with an actionable message; a tiny token cap stops running children.
- [ ] **Stop cascade:** stop the parent while children run. Expect: every child ends "stopped with this
  run"; no orphan keeps running (check the rows after a reload).
- [ ] **Approvals from a child:** a child calls a tool set to `ask`. Expect: the card appears in the
  parent conversation (and Inbox) with the sub-agent's name; `/chat/<parent>?subagent=<child>` opens it.
- [ ] **IM approvals (after §2.15):** the same from a bound Slack / Lark thread. Expect: the card in the
  parent's thread names the sub-agent; it refreshes when the child finishes.
- [ ] **superpowers SDD (the phase C gate):** follow phase C live §3: a two-task plan in `/workspace`,
  executed with `subagent-driven-development`. Expect: implementer and reviewer children per task,
  fixes through `resume`, commits in `git log`, no `sandbox.busy`, then a full-run replay of the parent
  with drift `[]`, zero `tool_unmatched` and no new child conversations.

### 2.15 Channels (Slack and Lark)

Needs: `slack` / `lark` installed; `CAPYBARA_PUBLIC_URL` set (binding links, SSO; https tunnel when the
platform requires it); a gateway role running (stack A has one; stack B runs all roles). Platform
setup: `plugins/slack/README.md`, `plugins/lark/README.md`. Do each platform once; m4 §4 has the
detailed expectations.

- [ ] **Connection:** Channels → New: credentials, an agent on model-fake with `todo__write` at `ask`,
  unbound handling `bind`. Expect: "Connected", tenant and bot shown, credentials only "set"; exactly
  one long connection on the platform side.
- [ ] **Binding:** person A DMs the bot. Expect: the link-your-account message and button; `/bind/<token>`
  shows A's platform name and the connection; confirming binds; the link is single use. A stranger
  mentioning the bot in a group gets only a hint to DM it.
- [ ] **Streaming:** `slow:150:` plus 200 words in a DM. Expect: one bot message updated in place; the
  same conversation in the web under A's account. `/new` in a DM starts a new conversation.
- [ ] **Cards:** in a group thread, `tool:todo__write:{…}`. Expect: an approval card in the thread; B
  clicking gets "You can't handle this request."; A approves, the card turns "Approved"; a double
  click runs once.
- [ ] **Questions** (`ask_user` on a real model) show as a card with options; answering resumes.
- [ ] **Sub-agent cards:** see §2.14.
- [ ] **IM language:** Settings → Organization → IM language en / zh changes the card text.
- [ ] **Directory sync and login:** Settings → Extensions → `slack` / `lark` org config, Sync now;
  joining and offboarding events; Sign in with Slack / Lark (`CAPYBARA_AUTH__LOGIN_SOURCES`) and the
  verify-identity rule (m4 §4.6–§4.7).
- [ ] **Lark card click while the kernel is down** (m4 §4.4.1, still unconfirmed): record whether
  Lark redelivers.
- [ ] Optional **webhook mode** (deploy README "Webhook"): `channels.webhookBaseUrl`, the gateway port
  behind an HTTPS proxy, switch the connection's inbound mode, one message round trip, switch back.

### 2.16 Evals, trajectories and replay

Needs: the `eval` purpose mapped; a few real conversations with tool calls and an approval.

- [ ] `/trajectories/<conversationId>` as org admin or agent owner: the timeline, waterfall, tokens,
  cost (from Admin → Models prices). Expect: anyone else gets 404; each view writes `trajectory.viewed`.
- [ ] Evals → New set for one agent; add cases from conversations. Expect: a case shows its snapshot,
  agent version and tool definitions.
- [ ] Step replay with another model. Expect: the estimated request count before start, per-step diffs,
  tokens and cost; runs within `evals.orgConcurrency`.
- [ ] Full-run replay. Expect: recorded tool results only, nothing executed (no new sandbox commands,
  no connector calls); a parent with sub-agents starts no children.
- [ ] Judge on. Expect: pass / fail with reasons; judge usage counts under `eval`.
- [ ] A very small token cap. Expect: the run stops at the cap, finished cases kept.
- [ ] Label a case by hand. Expect: counted as a human result.

### 2.17 Extension UI (`todo`, `example-board`)

- [ ] Enable `todo` in the org; the agent writes a list. Expect: a "Tasks" tab in the Inspector updating
  live; the tool row shows the display summary (e.g. "Update task list (4 items)").
- [ ] Enable `example-board` (its embed needs approval and is marked sensitive). Expect: a "Board" page
  in the sidebar's Extensions group and a "Board" tab in conversations; the iframe loads from
  `/plugin-ui/example-board/...`; it cannot call `/api` with its token.
- [ ] Disable `todo` mid-conversation. Expect: its tab disappears; the conversation keeps working; a
  call in flight ends with an "extension unavailable" style error.

### 2.18 Hooks (`hooks-probe`)

Needs: the `hooks-probe` tgz (§1.3) installed, approved (the review marks `hooks` sensitive), enabled
on the deployment and in the org; an agent with its tool `hooks-probe__probe_echo`. Its config goes
through its own route (`/plugins/hooks-probe/...`, kernel port, not under `/api`). In stack A run the
request inside the api container:

```bash
docker compose exec api node -e 'fetch("http://localhost:8080/plugins/hooks-probe/config",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({orgId:"<org id>",denyTools:["hooks-probe__probe_echo"]})}).then(r=>console.log(r.status))'
```

(stack B: `curl -X POST localhost:8080/plugins/hooks-probe/config -H 'content-type: application/json' -d '{…}'`).

- [ ] Observe: chat normally, then `GET /plugins/hooks-probe/counts?orgId=<org id>` (same way). Expect: counts for
  all five mount points; `usage.report` arrives through the worker queue (`cap-kernel-usage-report`).
- [ ] `denyTools: ["hooks-probe__probe_echo"]`, then make the agent call it. Expect: the tool result
  `Tool call blocked by the "hooks-probe" policy hook: nope`; the run continues.
- [ ] `denyModel: true`, then send a message. Expect: the run is blocked with a notice naming the
  extension (`run.hook_denied`); an audit row `hook.denied`.
- [ ] Reset with `{"orgId":"<org id>"}`. Expect: normal again. Replays (§2.16) fire no hooks.

### 2.19 Multi-replica sanity (compose)

- [ ] `docker compose -f compose.yaml -f compose.build.yaml up -d --scale api=2 --scale worker=2 --scale gateway=2`.
  Expect: all healthy; init ran once.
- [ ] Use the web for a few minutes (conversations, installs, approvals). Expect: no errors; both api
  containers serve requests (`docker compose logs api`).
- [ ] Install or disable an extension. Expect: every replica converges without restart (Admin →
  Extensions load status).
- [ ] `docker compose stop` one worker mid-run. Expect: the run resumes on the other.
- [ ] With a channel connected, stop the gateway holding it. Expect: the other takes over within about
  30 s (`channels.leaseTtlMs`); one reply per message, no duplicates.
- [ ] A sub-agent run (§2.14) with two workers: children may run on either; the parent resumes.

### 2.20 Upgrade path

There is no earlier release, so this is a rehearsal for 0.1.x upgrades
([upgrade.md](../../deploy/upgrade.md)).

- [ ] With data in stack A, rebuild the images from a newer commit (or the same one) and
  `docker compose ... up -d`. Expect: `init` migrates (or does nothing) and logs
  `Bootstrap already done`; conversations, agents, installs and secrets are intact.
- [ ] Bump a bootstrap plugin's version in a scratch branch (`pnpm check:bootstrap --write`), rebuild.
  Expect: the next bootstrap upgrades it in place and keeps it enabled; a plugin you upgraded further
  by hand is left alone.
- [ ] Upgrade a non-bootstrap extension by installing a newer tgz with conversations in flight. Expect:
  no restart; in-flight calls drain within `extensionHost.drainSeconds`.
- [ ] Old development databases: a database created before the 0.1.0 rename (migrations 0041–0043)
  cannot be rolled; stop old replicas first (upgrade.md "Version notes").
- [ ] Rotate `CAPYBARA_MASTER_KEY` with `CAPYBARA_MASTER_KEY_PREVIOUS`. Expect: stored credentials still
  work.

---

## 3. After merge (on branches today)

### 3.1 UI refresh B: the new conversation page

Spec: `docs/superpowers/specs/2026-10-22-ui-refresh-design.md` §5 (branch `feat/ui-refresh-b` adds the
sign-off rulings); plan `docs/superpowers/plans/2026-10-26-ui-refresh-b-conversation.md`. Rerun all of
§2.8 on the new page first: every item there must still work.

- [ ] **Layout:** title bar over the middle column only; properties panel (about 300) or one right
  panel (520–600, resizable, width remembered) at a time; below 1280 they become a sheet.
- [ ] **New conversation on first send:** "New conversation" opens an empty composer with an agent
  picker; nothing is created until you send; the sidebar ＋ preselects the agent; the agent locks after
  the first message.
- [ ] **Model and effort pickers:** switch model mid-conversation (chat models of enabled providers,
  the agent's model first) and effort (only the levels the model declares). Expect: applies from the
  next message, logged once (`model_switched`); a model that disappears falls back with a notice;
  replay honors switches.
- [ ] **Queue:** while running, the hint reads "↵ send now, ⌘↵ add to queue". ⌘↵ (Ctrl+↵) queues:
  dashed bubbles with copy / edit / delete / send now; they go out one at a time after the turn; they
  wait through approvals; they pause on failure or stop with "Continue sending"; they survive a reload
  and a replica restart; two tabs converge.
- [ ] **Titles:** generated after the first exchange (purpose `title`, falls back to the chat model),
  "Untitled conversation" until then, rename from the title's ⌄ menu wins forever; title usage logged.
- [ ] **Tool groups:** one gray line per call, groups with per-kind counts ("Ran N commands", "Edited N
  files · +a −b"), running elapsed time, a shell row shows the model's `description`, non-zero exit
  shows "Failed", diffs with line numbers, "View full text" for large output.
- [ ] **Approvals:** the accent-outlined card with key and all arguments, policy source, the three
  scopes, and **Deny with a reason** (the reason reaches the model); handled cards collapse to one line.
- [ ] **End states:** stopped / run failed (Retry re-sends the last message) / context compacted (view
  summary) dividers. Esc never stops a run.
- [ ] **Files:** attachment strip with progress and rejections; file output cards (two columns, "N more
  files"); built-in previews (images, text, code, Markdown, CSV) in the right panel; path chips in prose;
  a removed object shows "No longer available".
- [ ] **`file-preview@1`:** an extension previewer wins over the built-in one, switchable from the
  panel header; a failing previewer shows "Failed to load · Retry" and falls back.
- [ ] **Extension slots:** todo's inline card, "Tasks" properties section and right panel, with "open"
  links between them; example-board's embed in the right panel; a failing or disabled extension breaks
  only its block.
- [ ] **Sub-agents:** group header "N subagents running", rows open the child in the right panel (back,
  stop, full screen), the open row tinted, "Background tasks" section.
- [ ] **Hostile content:** a 2 MB output, a 10,000-line diff, a 300-character file name, Markdown with
  `<script>` and `javascript:` links render safely.
- [ ] Both themes, zh and en, narrow screens.

### 3.2 Phase D: manual skills via `/`

Spec: `docs/superpowers/specs/2026-10-27-phase-d-manual-skills-design.md` (§17 "As built" lists the
rulings; branch `feat/ecosystem-phase-d`). Its web part builds on UI refresh B's composer. The
automated acceptance is `packages/kernel/test/skills/manual-invocation.e2e.test.ts`; this section is
what only a person with real models, a sandbox and IM can check.

**Prepare.**

- Plugin with every kind: push `packages/kernel/test/catalog/fixtures/claude/commands-demo/` (a
  command `fix-issue` with `argument-hint: [issue-number]`, a manual-only `manual-script` with
  `scripts/run.sh`, a forked `review` with `agent: code-reviewer`) to a GitHub repository of your
  own, then import it as admin with a direct git import (the catalog's import, source "Git
  repository", the repository URL) and install it in the org.
- A real plugin with commands: `https://github.com/obra/superpowers` at tag `v5.0.7` (it still
  ships `commands/`, e.g. `commands/brainstorm.md`), as a git import with
  "Branch, tag or commit" `v5.0.7`.
- An agent on a real model (Anthropic or OpenAI), with `sandbox_bash` and a sandbox provider,
  selecting all skills of both plugins and the `commands-demo:code-reviewer` sub-agent template.

**Check.**

- [ ] **Import report:** `commands-demo` lists `command_imported` (fix-issue), `skill_manual_only`
  (manual-script), `skill_forked` (review) and `agent_imported` (code-reviewer); superpowers v5.0.7
  lists its commands as `command_imported`. A Claude plugin with commands that was imported before
  phase D (an old database, e.g. from §2.13) re-imports at the same commit as new content
  (`<version>+git.<sha12>`) and the review shows the new skills.
- [ ] **The `/` menu** (type `/` in an empty composer): "Skills" first, sorted by name, only this
  agent's skills; each row shows `/name`, the argument hint (`[issue-number]`), the tags "manual" /
  "sub-agent", the description and the plugin name at the right end; then the connector prompt
  groups. Typing `brai` and `superpowers:brai` both find `brainstorm*`; ⌘K still finds pages by a
  substring of their names.
- [ ] **Inline invocation:** pick `/fix-issue`, type `123`, send. Expect: the chip with the hint as
  placeholder; the bubble shows the chip and `123`, and a closed "Skill instructions" disclosure with
  "Fix GitHub issue 123 following our coding standards." (nothing executed); the model works on
  issue 123. Typed without the menu, `/fix-issue 7` does the same; `/etc/hosts` and `/nope 7` are
  sent as plain text. Backspace at the start of the text, or the chip's ×, removes the chip and
  keeps the text.
- [ ] **Typing during a send:** send a message and keep typing at once; the new text stays in the
  composer when the send returns.
- [ ] **Manual-only:** `manual-script` is in `/` but the model never mentions or loads it on its own
  (ask "which skills do you have?"); after `/manual-script` the model calls `skill_load` and runs
  `sh /skills/manual-script/scripts/run.sh` ("manual-script ok"). On the agent page it is tagged
  "manual" and cannot be pinned. A guest who can use the agent sees its instructions in their own
  bubble (accepted, spec §17.2).
- [ ] **Forked skill:** `/review src` on a conversation. Expect: a sub-agent row
  (`commands-demo:code-reviewer`) under the bubble before any reply, then a "Report" disclosure, then
  the parent's answer about the report. A plain message sent while the sub-agent runs shows
  "Answered after the sub-agent running /review finishes." and is answered after the report.
  Stopping the parent stops the sub-agent and the report says it was stopped.
- [ ] **Queue:** while a run is going, type `/fix-issue 9` and press ⌘↵: the queued bubble shows the
  chip; it is sent after the run. Deselect the skill on the agent while an invocation is queued:
  the queue pauses and says the first message's skill can no longer be used.
- [ ] **Narrow window:** at 900 px wide, load a conversation with a right panel open: the panel is a
  sheet and the page never scrolls sideways, also during load.
- [ ] **IM:** in a Slack and a Lark thread, `@bot /fix-issue 7` runs the skill (the reply works on
  issue 7); `@bot /nope 7` is answered as plain text; a skill whose arguments are too long is posted
  as text and the bot says the skill did not run; `/new` in a direct message still starts a new
  conversation. **Record whether a Slack direct message starting with `/fix-issue 7` reaches the bot**
  (the Slack client may treat it as a slash command; spec §17.4). Lark passes it through.
- [ ] **Replay:** add the conversation with `/fix-issue`, `/manual-script` and `/review` to an eval
  set and run a step replay and a full-run replay: drift `[]`, the fork's run uses the recorded
  report and no child conversation is created; the trajectory shows the fork span.

---

## 4. Known gaps (not bugs)

From the specs' "as built" / "not built" sections. Report something here only if it behaves worse
than described.

- **Release and marketplace (A2, A3a):** nothing on npm / ghcr yet; the official marketplace repo
  (`capybara-hq/plugins`) is not published and the marketplace is off by default; `bootstrap.json`
  entries are `source: "workspace"` (npm entries and the network half of `check:bootstrap` come in
  A3b); npm registry downloads don't use `net.httpsProxy`.
- **Marketplaces (A1):** refusing an import without valid provenance is not built (provenance is
  display only); a dependency installed at a version outside a new range is not upgraded automatically
  (`catalog.dependency_unresolved` until the org upgrades it).
- **Claude Code compatibility (B):** a root-source entry's `skills` does not restrict the default
  `skills/` scan; for `obra/superpowers-marketplace` (entry 5.0.7, plugin 7.0.1) "content changed" is
  never shown and importing entry 5.0.7 records 7.0.1; entry-only changes are not flagged; Claude npm
  and zip sources are skipped; personal static connectors need the installer's own credential at
  install; pinned bodies are re-read from storage on every run start (a storage blip can fail a run);
  the marketplace list shows no "Claude Code" marker; a relocated root `SKILL.md` in a big repo can
  exceed package limits; hooks are never run.
- **Sub-agents (C):** the dispatch-time
  authorization is not recorded in `subagent_dispatched`; an org agent child's skill files stay in the
  shared sandbox; no per-agent step limit for long plans; interim UI (no avatars, no live duration on
  running rows); IM cards for a child's approval refresh only when the child finishes; a decision made
  elsewhere shows after a reload; no owner-facing view of `subagent.dispatched` / `subagent.refused`
  audit rows. Finish rolling upgrades before using sub-agents.
- **UI refresh A:** the chat page's empty state is a single line; the settings nav marks its active
  item with an accent bar; above 1280 the status bar text starts at the sidebar gutter.
- **0.1.0 release notes:** no Gemini provider; the sandbox profile needs a checkout; CLI-installed
  packages live in PostgreSQL; duplicate Slack cards are possible after a worker crash at the wrong
  moment; deferred hooks (`session.*`, `agent.preStep`) and a Helm chart.
- **Docs to fix (found while writing this):** the root README says `openai-compatible` and
  `object-store-s3` ship inside the CLI (they are bootstrap plugins now); m7 §7 uses
  `plugins install / approve / enable` instead of `extensions …`.

## 5. How the older checklists map to this run

| Checklist | Covered here | Still run on its own |
|---|---|---|
| m4 (Slack / Lark) | §1.7, §2.15 | §4.4.1 Lark redelivery detail, §4.5 two-replica takeover detail, §5 "still to be confirmed" items |
| m5 (sandbox, media, skills) | §1.7, §2.9, §2.10, §2.12 | §2.4 CI linux/amd64 run, the 14 E2B assumptions log |
| m6 (evals, npm, marketplaces, Nacos, multi-host) | §2.4, §2.13, §2.16, §2.19 | §3 public / private npm (after the release), §5 Nacos, §7 multi-host, §8 a real third-party plugin |
| m7 (release gate) | — | all of it, after this run: §0–§2 publish, §3–§7 clean host from the two copied files |
| phase C live | §1.7, §2.14 | — |

## 6. How to report a problem

Capture, then open an issue in `capybara-hq/core` (or note it in "Results" and hand it over):

- **What and where:** the steps, what you expected, what you saw; a screenshot (both themes if it is
  visual) and the window width for layout problems.
- **Ids:** the conversation id (the `/chat/<conversationId>` URL); for sub-agents also the child id
  (`?subagent=<child>`); the trajectory link `/trajectories/<conversationId>`; the agent id and version.
- **Time and version:** the time with time zone and the version (both in the status bar), and
  `git rev-parse --short HEAD` of the checkout the images were built from.
- **Logs:** stack A: `docker compose logs --since 15m init api worker gateway web > capybara-logs.txt`
  (add `--timestamps`); stack B: the kernel and web terminals. Set `CAPYBARA_LOG__LEVEL=debug` when
  reproducing (hot). Browser problems: the console and a HAR of the Network tab.
- **State:** `capybara extensions list` output; recent audit rows:
  `docker compose exec postgres psql -U capybara -c "select at, action, target, detail from capybara.audit_events order by id desc limit 30"`
  (stack B: `docker compose -f docker/compose.dev.yaml exec postgres psql -U capybara -c "…"`).
- **IM:** platform, connection id, the thread link, and the time of each click.
- **Before attaching:** search the logs for tokens and keys and remove them. Secrets should only ever
  appear as "set" or masked; one that appears in clear is itself a bug to report.

## Results

| Section | Date | Stack (A / B), models, sandbox | Result / notes |
|---|---|---|---|
| 1.7 Automated live tests | | | |
| 2.1 Setup | | | |
| 2.2 Login, members, invites | | | |
| 2.3 Organizations | | | |
| 2.4 Admin console, extensions | | | |
| 2.5 Models, purposes | | | |
| 2.6 Agents | | | |
| 2.7 Shell | | | |
| 2.8 Conversation page | | | |
| 2.9 Storage, media | | | |
| 2.10 Skills | | | |
| 2.11 Connectors | | | |
| 2.12 Sandboxes (Docker / E2B) | | | |
| 2.13 Plugins, catalog, marketplaces | | | |
| 2.14 Sub-agents | | | |
| 2.15 Channels (Slack / Lark) | | | |
| 2.16 Evals, replay | | | |
| 2.17 Extension UI | | | |
| 2.18 Hooks | | | |
| 2.19 Multi-replica | | | |
| 2.20 Upgrade path | | | |
| 3.1 UI refresh B | | | |
| 3.2 Phase D | | | |
