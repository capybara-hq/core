# Capybara

An open-source enterprise agent platform. A lean kernel, with capabilities provided as plugins. TypeScript / Node 24 / pnpm monorepo, Apache-2.0.

## Quick start

Run a complete deployment on one machine with Docker Compose: PostgreSQL, Valkey, S3 storage, the
kernel and the web app. You need Docker with Compose v2.23 or newer, git and openssl. Pulling the
images takes most of the time; on a typical connection it's under 5 minutes.

```bash
git clone https://github.com/capybara-hq/core.git
cd core
# the latest stable release (prerelease tags such as v0.2.0-rc.1 are skipped)
tag="$(git describe --tags --abbrev=0 --match 'v*' --exclude 'v*-*' 2>/dev/null)" \
  && git checkout "$tag" \
  || echo "No stable release tag yet: staying on main, whose images may not be published yet."
cd docker
{
  echo "POSTGRES_PASSWORD=$(openssl rand -hex 24)"
  echo "CAPYBARA_MASTER_KEY=$(openssl rand -base64 32)"   # encrypts stored secrets: back it up
  echo "CAPYBARA_S3_ACCESS_KEY=$(openssl rand -hex 24)"
  echo "CAPYBARA_S3_SECRET_KEY=$(openssl rand -hex 24)"
  echo "CAPYBARA_SETUP_TOKEN=$(openssl rand -hex 16)"     # the setup page asks for it
} > .env
docker compose up -d
docker compose ps -a     # createbuckets and init exit 0, the other services become healthy
```

`.env.example` lists every optional setting: the image version, the port, the public URL, and an
admin password file instead of the setup page. The compose file pulls the images of its own version
(`CAPYBARA_VERSION` defaults to it), which is why the commands check out a release tag: on `main`,
the compose file may name a version whose images are still being published.

1. Open <http://localhost:3000>. The setup page creates the enterprise admin and the first
   organization. Enter the setup token from `.env` (`grep CAPYBARA_SETUP_TOKEN .env`): without it,
   setup is refused, so nobody else who reaches the port can take the deployment over. Use
   `localhost`: over plain http on another host name, browsers drop the session cookie (see
   [docs/deploy](docs/deploy/README.md#https-the-public-url-and-cookies)).
2. Install a plugin from npm. `model-fake` is a scripted model that needs no API key:

   ```bash
   docker compose exec api node /app/bin/capybara.mjs plugins install npm:@capybara-hq/plugin-model-fake --yes
   docker compose exec api node /app/bin/capybara.mjs plugins approve model-fake --yes
   docker compose exec api node /app/bin/capybara.mjs plugins enable model-fake
   ```

   Or use the admin console: Admin → Plugins → Install plugin, enter the npm package name, review
   the permissions, then approve and enable. No restart is needed.
3. Create an agent with the model `model-fake/fake-1` and send `echo:hello`.

For real models, configure the builtin `openai-compatible` plugin (Admin → Plugins), or install
another model plugin, such as `@capybara-hq/plugin-anthropic` or `@capybara-hq/plugin-openai`, the
same way. To connect Slack or Lark, install `@capybara-hq/plugin-slack` or `@capybara-hq/plugin-lark`.

**Production:** read [docs/deploy](docs/deploy/README.md) for HTTPS and the public URL, roles and
scaling, IM webhooks, the sandbox and Kubernetes; [docs/deploy/upgrade.md](docs/deploy/upgrade.md)
for upgrades; and [docs/config.md](docs/config.md) for every setting.

## Development: run from source

You need Node 24, pnpm, Docker and openssl. The database must be PostgreSQL 15 or newer (migrations use `UNIQUE NULLS NOT DISTINCT`; development and CI use 17).

```bash
pnpm install
docker compose -f docker/compose.dev.yaml up -d      # postgres:5432 + valkey:6379 + seaweedfs (S3 API 8333)

export CAPYBARA_DB__URL=postgres://capybara:capybara@localhost:5432/capybara
export CAPYBARA_REDIS__URL=redis://localhost:6379
export CAPYBARA_MASTER_KEY=$(openssl rand -base64 32)
export CAPYBARA_PLUGINS='["@capybara-hq/plugin-example-counter"]'
export CAPYBARA_PLUGIN_CONFIG='{"example-counter":{"step":1}}'   # optional, step defaults to 1
export CAPYBARA_PLUGIN_PERMISSIONS__AUTO_APPROVE=true   # local trials only: auto-approve plugin permissions (keep it off in production)

pnpm capybara migrate     # migrate the kernel and plugin schemas
pnpm capybara start       # listens on :8080 (change with CAPYBARA_HTTP__PORT)
```

Here the startup config `CAPYBARA_PLUGINS` loads a plugin straight from the workspace (development mode, source `config`); production deployments install plugin packages instead, see "Plugins: install, lifecycle and the admin console" below. `openai-compatible` and `object-store-s3` ship inside the CLI and don't need to be listed in `CAPYBARA_PLUGINS`.

Plugin permissions: a plugin is **not loaded** (the startup log has a warn) when it appears for the first time, or when an upgrade makes its manifest request any permission beyond what was approved; plugins that depend on it are not loaded either.
If permissions shrink or stay the same, it loads directly. In production, don't enable `autoApprove`; instead the enterprise admin reviews and approves in the web app under "Admin → Plugins", or uses the CLI (it connects to PG directly and runs the kernel migrations first). After approval, running replicas load the plugin **without a restart** (the CLI writes to PG and notifies the replicas through Redis; if the notification fails, the next reconcile cycle picks it up):

```bash
pnpm capybara plugins review                    # list plugins pending approval and their newly requested permissions
pnpm capybara plugins approve example-counter   # confirm in the terminal, then write the snapshot and an audit record; --yes skips the confirmation
```

Verify from another terminal:

```bash
curl localhost:8080/healthz
curl -X POST localhost:8080/plugins/example-counter/inc      # {"count":1}
curl localhost:8080/plugins/example-counter/count            # {"count":1}
curl -X POST localhost:8080/plugins/example-counter/inc-later  # returns {"jobId":"…"}; about 200ms later count goes up by 1 again
```

### Setup (create the first enterprise admin)

A fresh deployment starts uninitialized (the log has a warn). Use the setup wizard to create the first enterprise admin, and optionally the first org at the same time:

```bash
curl -s localhost:8080/api/v1/setup                          # {"needsSetup":true}
curl -s -X POST localhost:8080/api/v1/setup \
  -H 'Content-Type: application/json' -H 'X-Capybara-Csrf: 1' \
  -c cookies.txt \
  -d '{"login":"admin","password":"change-me-please","displayName":"Admin","orgName":"Research"}'
# 201, returns the account and org, and sets the session cookies (cap_at / cap_rt)
curl -s localhost:8080/api/v1/me -b cookies.txt               # the current account and its orgs
curl -s localhost:8080/api/v1/setup                          # {"needsSetup":false}; a second POST returns 409 setup.already_completed
```

- POST requests to public endpoints must carry the `X-Capybara-Csrf: 1` header.
- Production deployments should set `CAPYBARA_AUTH__SETUP_TOKEN` and send the same value as `setupToken` in the setup body, so nobody can initialize the deployment before you.
- You can also create an enterprise admin with the CLI, without HTTP (the password is read from stdin only): `echo "$PW" | pnpm capybara admin create --login admin --display-name Admin`.
- Grant or revoke enterprise admin for an existing local account: `pnpm capybara admin grant <login>` / `pnpm capybara admin revoke <login>` (audited; the last active enterprise admin cannot be revoked). Enterprise admins manage accounts, orgs (run concurrency, sandbox CPU / memory), deployment settings (price currency, whether orgs may create their own connectors / skills), plugins (install, approve, deployment-level config), model prices and purpose mappings, and the enterprise directory under "Admin" (`/admin`) in the web top bar. Enterprise admins **cannot read conversations** by default: trajectories and evals are available only to org admins and agent owners.
- When trying the web app over plain http on a host other than localhost, set `CAPYBARA_AUTH__COOKIE_SECURE=false`; otherwise the browser won't store the session cookie. Keep the default `true` in production.

### Plugins: install, lifecycle and the admin console

The core image bundles only two plugins: `openai-compatible` (model) and `object-store-s3` (object storage). The CLI passes them to the kernel as builtin plugins (source `builtin`): pre-approved, always enabled, no per-org enablement needed, and they can't be uninstalled or disabled; they only need deployment-level config (when it isn't set up, the admin console shows "pending configuration" and the kernel starts normally). Every other plugin lives outside the image and is installed into the plugin directory as a **plugin package** (an npm-pack tgz: single-file ESM with third-party dependencies bundled in; only `@capybara-hq/plugin-sdk` and `zod` are provided by the host):

- Pack: `pnpm pack-plugin plugins/<name>` (`pnpm pack-plugins` packs every official plugin, output in `artifacts/plugins/`).
- Install: the enterprise admin goes to "Admin → Plugins → Install", uploads a tgz or enters an npm package name and version (`packages.npmRegistry`; the token for a private registry is `packages.npmToken`), reviews the permissions (sensitive items and migration warnings are highlighted), then installs, approves and enables. The CLI works too:

```bash
pnpm capybara plugins install ./artifacts/plugins/capybara-hq-plugin-todo-0.1.0.tgz   # or npm:@capybara-hq/plugin-todo@0.1.0
pnpm capybara plugins approve todo
pnpm capybara plugins enable todo
pnpm capybara plugins list            # each plugin's desired state and whether the replicas agree
pnpm capybara plugins disable todo    # disable before uninstalling: pnpm capybara plugins uninstall todo
```

- **Install, enable, disable, upgrade and uninstall never restart anything**: the admin console and CLI only write the desired state into PG, and each replica loads / revokes on notification (a maintenance task reconciles as a fallback every `pluginHost.reconcileIntervalSeconds` seconds). When switching versions, the new version loads first and the old one is revoked after; on disable or upgrade, in-flight tool calls are given up to `pluginHost.drainSeconds` (default 30 seconds). If the new version needs more permissions, it stays pending approval while the old version keeps running; plugin migrations run on one replica holding a lock and are expand-only; a downgrade can only go back to a version whose migrations have all been run. Uninstalling doesn't delete data (the plugin schema, secrets, org config and approval records are all kept). Old version code stays in process memory until restart; when one process has been upgraded many times (> 20), the log suggests restarting that replica.
- **Deployment-level config can be changed in the admin console** ("Admin → Plugins → Config", stored in PG, secrets encrypted): precedence is env vars > config file / Nacos > admin console > defaults, and fields given in the startup config are read-only in the admin console and show their source. When the config is invalid, the plugin shows "pending configuration" and isn't loaded while the kernel starts normally; it loads automatically once fixed.
- Packages are stored under `deployment/plugins/blobs/` in object storage (in PG when no object storage is configured), and each replica syncs them by sha256 into the local `pluginHost.dir` (default `/var/lib/capybara/plugins`, safe to clear at any time). **When you change the object-storage bucket or endpoint, migrate the objects under the `deployment/` prefix too**; otherwise the plugin packages and catalog files stored in the old bucket can't be fetched and new replicas fail to sync.
- Packages uploaded through the web app are also limited by the web layer's `CAPYBARA_WEB_MAX_PACKAGE_BYTES` (default 50 MiB); raise it together with the kernel's `packages.maxBytes`, see [docs/config.md](docs/config.md).

**Migrating from config-declared plugins to install records** (C15): the `plugins` list in the startup config still works (development mode and existing deployments, source `config`), but plugins declared that way are read-only in the admin console: they can't be installed / upgraded / disabled from the web app, changing the list needs a restart, and installing a plugin with the same name returns 409 `plugin.config_declared`. The kernel doesn't convert automatically; the migration steps are:

1. Prepare a plugin package of the same npm package (`pnpm pack-plugin plugins/<name>`, or the version on npm): a plugin name belongs to the first npm package that used it, and changing the package name is rejected (`plugin.name_conflict`).
2. Remove it from the `plugins` list (deployment config in `pluginConfig` can stay and still takes effect; you can also move it to the admin console) and roll-restart the replicas. The plugin is then not loaded, plugins that depend on it are unloaded with it (the admin console shows `dependency`), and they reload automatically once the plugin is back.
3. Upload / npm-install the package and enable it (admin console, or `capybara plugins install …` + `enable`). The plugin schema, secrets, org config and approval records carry over; if the new package's permissions don't exceed what was approved, it loads directly.

**Trust model**: plugins run with full trust inside the kernel process (a plugin's migration SQL also runs on the kernel's database connection). The permission manifest, approval and catalog policy are **governance and audit, not a sandbox**: they control the resources the kernel holds (secrets, storage, tools, conversation content), but can't stop a plugin from connecting to the database or the network directly. Install packages only from publishers you trust, and read the migration SQL before approving (writes outside the plugin's own schema, permission changes, `DO` blocks and the like are listed as sensitive warnings, and a changed warning needs a new approval); don't run `pnpm pack-plugin` on untrusted source (packing executes plugin code). Make untrusted extensions external apps that call the kernel over HTTP. To write a plugin, see [.agents/skills/writing-plugins](.agents/skills/writing-plugins/SKILL.md).

### Talk to an agent in the web app (no model key needed)

`@capybara-hq/plugin-model-fake` is a deterministic scripted model that calls no external API, which makes it good for local trials and demos. Keep the database, Redis and master key environment variables from above, switch to loading it, then start the web app (Next, `apps/web`):

```bash
export CAPYBARA_PLUGINS='["@capybara-hq/plugin-model-fake"]'   # provides the model model-fake / fake-1
export CAPYBARA_PLUGIN_CONFIG='{}'
export CAPYBARA_HTTP__TRUST_PROXY=1          # trust this one proxy hop when the kernel is reached only through the web layer (see below)
export CAPYBARA_AUTH__COOKIE_SECURE=false    # local plain-http trial
pnpm capybara migrate
pnpm capybara start                          # kernel on :8080
```

In another terminal:

```bash
pnpm dev:web          # i.e. pnpm --filter @capybara-hq/web dev, started through apps/web/server.mjs, listens on :3000
# set CAPYBARA_KERNEL_URL when the kernel isn't at http://localhost:8080; change the web port with PORT
```

Open <http://localhost:3000> in a browser: the setup wizard creates the admin and org → create an agent (pick the model `model-fake/fake-1`) → chat. `model-fake` decides its reply from the message prefix: `echo:<text>` replies with the text unchanged, `slow:<milliseconds>:<text>` streams chunk by chunk slowly (handy for trying "Stop" and mid-run messages), and any other text gets `You said: …`.

- **The kernel behind the web layer needs `http.trustProxy: 1`** (`CAPYBARA_HTTP__TRUST_PROXY=1`): `server.mjs` drops forwarded headers forged by the client and rewrites `x-forwarded-for` to the real peer address before passing the request to the kernel; the kernel must trust that one hop to get the real client IP (login rate limiting counts per IP). The web layer must be started through `server.mjs` (`pnpm dev:web` / `pnpm --filter @capybara-hq/web start`); running `next dev` / `next start` directly skips this step.
- When the kernel is also exposed directly, don't use a hop count; use a list of trusted proxy addresses instead (such as `CAPYBARA_HTTP__TRUST_PROXY='["10.0.0.0/8"]'`), see [docs/config.md](docs/config.md).

Next you can invite members (`POST /api/v1/orgs/:orgId/invitations`) and manage members by role (`/api/v1/orgs/:orgId/members`); for how to write kernel APIs, see [.agents/skills/writing-kernel-api](.agents/skills/writing-kernel-api/SKILL.md).

When you're done: `docker compose -f docker/compose.dev.yaml down` (add `-v` to also remove the data volumes).

### Model provider plugins

| Plugin | Description |
|---|---|
| `@capybara-hq/plugin-openai-compatible` | **Builtin** (ships with the CLI; no install, no need to list it in `CAPYBARA_PLUGINS`). OpenAI-compatible Chat Completions services (DeepSeek, Qwen, vLLM and so on), configured per endpoint, with dialect presets for the differences |
| `@capybara-hq/plugin-model-fake` | Deterministic scripted model for tests and key-free demos |
| `@capybara-hq/plugin-anthropic` | Anthropic (official SDK + native Messages API), **install on demand** |
| `@capybara-hq/plugin-openai` | OpenAI (official SDK + native Responses API), **install on demand** |

You can use several at once: `openai-compatible` is builtin and the rest are installed as plugin packages (see "Plugins: install, lifecycle and the admin console" above); during development you can also list them in `CAPYBARA_PLUGINS` (such as `'["@capybara-hq/plugin-anthropic"]'`); deployment-level config goes in `CAPYBARA_PLUGIN_CONFIG` keyed by plugin name, or is filled in by the enterprise admin in the admin console. `anthropic` and `openai` aren't in the core image; install them yourself when needed.

Each model declares in its plugin the parameters it supports (the standard knobs `effort`, `thinking`, `temperature`, `maxOutputTokens` and so on, plus vendor parameters of the form `<plugin name>.<name>`); the web agent form renders from the declarations, and agent versions are validated against them on save.

A deployment-level config example for `openai-compatible` connecting to DeepSeek (the default example):

```bash
export CAPYBARA_PLUGIN_CONFIG='{"openai-compatible":{"endpoints":[{"name":"deepseek","baseUrl":"https://api.deepseek.com","dialect":"deepseek","models":[{"id":"deepseek-flash","contextWindow":1048576,"maxOutputTokens":393216,"reasoning":true}]}],"apiKeys":{"deepseek":"sk-..."}}}'
```

- `endpoints` (at least one): `name` (the endpoint name, without `/`), `baseUrl`, `dialect` (`generic` / `deepseek` / `qwen` / `ark`; the Ark baseUrl is `https://ark.cn-beijing.volces.com/api/v3`), and `models` (at least one: `id`, `contextWindow`, `maxOutputTokens`, and optionally `reasoning`, `vision`, `documents` (accepts PDF; only the generic and qwen dialects can enable it), `caching`, `streamIdleTimeoutMs`); optional `midConversationSystem` (overrides the dialect default). The public model id is `<endpoint name>/<model id>`, such as `deepseek/deepseek-flash`. The `contextWindow` / `maxOutputTokens` in the example above come from what DeepSeek `GET /models` returns for `deepseek-flash`; for other models, use their official responses.
- `apiKeys`: endpoint name → key. It is a **top-level** secret field (keys can't go inside `endpoints[]` array elements); each key must be a configured endpoint name, and endpoints without a key (such as an internal vLLM) are left out.
- Dialects: `deepseek` provides `thinking` (`on|off`, default `on`) and `effort` (`low|high|max`, default `high`); thinking content is read through `reasoning_content` and sent back following DeepSeek's rules. `qwen` provides `thinking` (mapped to `enable_thinking`). `ark` provides `thinking` (mapped to `thinking.type`, no default, thinking isn't sent back). `generic` provides only `temperature` and `maxOutputTokens`. Every dialect declares `temperature` and `maxOutputTokens`; thinking-related parameters are declared only for models configured with `reasoning: true`. When `reasoning` is omitted it is `false`: under the `deepseek` dialect, requests for such a model always send `thinking: { type: "disabled" }` (DeepSeek enables thinking by default), so DeepSeek reasoning models must set `"reasoning": true` explicitly.
- The current DeepSeek models are `deepseek-flash` and `deepseek-v4-pro`; `deepseek-reasoner` has been retired.
- The SDK doesn't retry; retries are handled uniformly by the kernel.

A deployment-level config example for `anthropic`:

```bash
export CAPYBARA_PLUGINS='["@capybara-hq/plugin-anthropic"]'
export CAPYBARA_PLUGIN_CONFIG='{"anthropic":{"apiKey":"sk-ant-...","models":["claude-opus-5-5","claude-sonnet-5-5","claude-haiku-5-5"],"serverFallbacks":"default"}}'
# or field by field: CAPYBARA_PLUGIN_CONFIG__ANTHROPIC__API_KEY=sk-ant-...
```

- `apiKey` (required, a secret field, masked in logs automatically); `baseUrl` (optional, a gateway or test fixture address).
- `models`: the allowed model ids, default `["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"]`; model info comes from the Models API and is cached in kv for 1 hour.
- `serverFallbacks`: with `default` (the default), server-side refusal fallback is turned on for Claude Opus 5.5 / Opus 5 / Fable 5.1 / Sonnet 5.5 (beta `server-side-fallback-2026-07-01`, Claude API only); `off` turns it off.
- The SDK doesn't retry (`maxRetries: 0`); retries are handled uniformly by the kernel.

A deployment-level config example for `openai` (OpenAI's model endpoint doesn't return the context window and similar info, so the model list comes from config):

```bash
export CAPYBARA_PLUGINS='["@capybara-hq/plugin-openai"]'
export CAPYBARA_PLUGIN_CONFIG='{"openai":{"apiKey":"sk-...","models":[{"id":"gpt-5.5","contextWindow":400000,"maxOutputTokens":128000,"reasoning":true,"vision":true}]}}'
```

- `apiKey` (required, a secret field); `baseUrl`, `organization` (optional).
- `models` (at least one): `id`, `contextWindow`, `maxOutputTokens`, `reasoning`, `vision`, and optionally `documents` (whether PDF is accepted, default false), `streamIdleTimeoutMs` (the watchdog threshold for a reasoning model that produces no output for a long time), and `effortLevels` (the effort levels the model accepts, taken from `low|medium|high|xhigh|max` and declared in the given order; when omitted it is `low|medium|high`, which every reasoning model accepts; levels differ by model, for example gpt-5-nano doesn't accept `max`).
- `reasoningSummary`: `auto` (the default) requests reasoning summaries, and an agent can turn them off with the thinking parameter; accounts that haven't completed org verification have summary requests rejected, in which case set `off`, and the model also stops declaring the thinking parameter.
- Calls use `store: false`, and reasoning items are replayed verbatim as encrypted content; the SDK doesn't retry here either.

Live-API conformance tests are skipped by default and run only when the environment variables are set: anthropic uses `CAPYBARA_TEST_ANTHROPIC_API_KEY`; openai uses `CAPYBARA_TEST_OPENAI_API_KEY` and `CAPYBARA_TEST_OPENAI_MODEL`; openai-compatible uses `CAPYBARA_TEST_OAICOMPAT_BASE_URL` / `_API_KEY` / `_MODEL` / `_DIALECT` (it runs only when all four are set).

To write a model provider plugin, see [.agents/skills/writing-model-providers](.agents/skills/writing-model-providers/SKILL.md).

`example-counter` is the reference implementation for writing plugins; to write your own, see [.agents/skills/writing-plugins](.agents/skills/writing-plugins/SKILL.md), and for the list of config options see [docs/config.md](docs/config.md).

### Tools and connectors (MCP / OpenAPI)

Agents act through "tools". Tools come from three sources: builtin (`ask_user`, `read_tool_output`, and `tool_search`, which is added automatically when there are many tools), plugins (such as the task-list tool of `@capybara-hq/plugin-todo`), and **connectors** (which bring a remote MCP service or an HTTP API described by OpenAPI into an org). Write operations trigger approval by default; the run pauses until confirmed and doesn't hold the conversation lock.

Load the connector plugins (deployment level, no per-org enablement needed):

```bash
export CAPYBARA_PLUGINS='["@capybara-hq/plugin-model-fake","@capybara-hq/plugin-connector-mcp","@capybara-hq/plugin-connector-openapi","@capybara-hq/plugin-todo"]'
# production accepts only https endpoints; turn on allowInsecureLoopback only for local integration (plain-http 127.0.0.1 / localhost / [::1])
export CAPYBARA_PLUGIN_CONFIG='{"connector-mcp":{"allowInsecureLoopback":true},"connector-openapi":{"allowInsecureLoopback":true}}'
```

**Web wizard** (org admins): after logging in, open "Connectors" → "Install" (`/connectors/install`): pick the endpoint type (MCP service / OpenAPI document) → fill in the endpoint (for OpenAPI, give a document URL or upload JSON / YAML, up to 2 MB; `baseUrl` can override the document's servers) → pick the auth (for OpenAPI it is prefilled from the `securitySchemes` the document declares, and the operations are listed for you to tick) → preview the tools and default policies → install. On the installed connector's detail page you can enable or disable each tool, adjust its default policy, and review drift (see below). Select the connector's tools in the agent form; the agent won't use them otherwise.

**API** (with the admin's session cookie or a token; write requests carry `X-Capybara-Csrf: 1`):

```bash
# install an MCP connector (static Bearer, one credential shared by the org)
curl -s -X POST localhost:8080/api/v1/orgs/$ORG/connectors -b cookies.txt \
  -H 'Content-Type: application/json' -H 'X-Capybara-Csrf: 1' \
  -d '{"name":"Docs","slug":"docs","connector":"mcp",
       "endpoint":{"url":"https://mcp.example.com/mcp"},
       "auth":{"type":"bearer","ownership":"org"},
       "credential":{"token":"<token>"}}'

# install an OpenAPI connector (API key in a header; omitting operations = all operations)
curl -s -X POST localhost:8080/api/v1/orgs/$ORG/connectors -b cookies.txt \
  -H 'Content-Type: application/json' -H 'X-Capybara-Csrf: 1' \
  -d '{"name":"Petstore","slug":"pets","connector":"openapi",
       "endpoint":{"specUrl":"https://api.example.com/openapi.json","operations":["listPets","getPet"]},
       "auth":{"type":"api_key","ownership":"org","in":"header","name":"X-Api-Key"},
       "credential":{"token":"<key>"}}'

# preview (writes nothing): returns the auth methods the document declares, the operation list and a tool preview
curl -s -X POST localhost:8080/api/v1/orgs/$ORG/connectors/preview -b cookies.txt \
  -H 'Content-Type: application/json' -H 'X-Capybara-Csrf: 1' \
  -d '{"connector":"openapi","endpoint":{"specUrl":"https://api.example.com/openapi.json"}}'
```

A connector tool's name as the model sees it is `<slug>__<tool name>` (such as `docs__search`). An agent definition selects tools by reference: `"tools":[{"kind":"connector","connectorId":"<id>","tools":"all"}]` (`"all"` = all currently enabled tools of that connector; you can also give an array of tool names).

**Auth methods** (`auth.type`; when `ownership` is `org`, the whole org shares one credential, and when it is `personal`, each member connects on their own, filling it in or authorizing under "Settings → My connections"):

| `auth.type` | Description | Credential |
|---|---|---|
| `none` | No authentication | — |
| `bearer` / `basic` / `api_key{in,name}` / `headers{names}` | Static credentials, stored encrypted and injected only at request time | `credential`: `{token}` / `{username,password}` / `{headers:{…}}`; after install, rotate with `PUT .../connectors/:connectorId/credentials/org` (personal credentials use `.../credentials/me`) |
| `oauth_code` (personal) | Authorization code + PKCE: each member clicks "Connect" and is redirected to log in at the authorization server; `discovery: "mcp"` discovers the authorization server automatically, and `client: "dcr"` registers the client automatically at install | If the authorization server doesn't support DCR, use `client: "manual"` and give `credential: {clientId, clientSecret?}` at install; you can also use `discovery: "manual"` and give `authorizationUrl` / `tokenUrl` |
| `oauth_client` (org) | Client credentials flow: the org shares one OAuth client to obtain tokens, verified at install | `credential: {clientId, clientSecret}`; rotate with `PUT .../credentials/org` |

- **OAuth needs `http.publicUrl`** (`CAPYBARA_HTTP__PUBLIC_URL`): set it to the **externally reachable origin of the web app (`apps/web`)**, such as `https://capybara.example.com`, not the kernel's own address. The callback URL is `<publicUrl>/api/v1/oauth/callback` and must be registered with the authorization server; it goes through the web app's `/api` proxy to the kernel. The binding cookie set when a connection starts is also set on the web origin through this proxy, and after the callback completes the user is redirected back to a web page under `<publicUrl>`, so all three must share one origin. When it isn't set, installing an OAuth app is rejected. Tokens are refreshed by the kernel automatically before they expire; if a refresh is rejected the credential is invalidated, and the member sees a "connection needed" card in the conversation.
- Credentials never enter the event log, the model context or audit; credential values that appear in tool results and errors are masked by the kernel. An endpoint's fixed headers and URL query can't contain credentials.

**Approval and the inbox**: the policy (`allow` / `ask` / `deny`) is derived from tool annotations by default (read-only → `allow`, everything else → `ask`); admins can change it per tool, and an agent can also tighten a tool. A call set to `ask` shows an approval card in the conversation and is also collected in the web app's "Inbox" (`/inbox`); when approving you can choose "this once / this conversation / always allow", and "always allow" grants can be viewed and revoked under "Settings → Remembered approvals" and become invalid as soon as the tool definition changes. An approval that goes past `tools.approvalTimeoutHours` (default 24) is treated as denied; an agent can't approve by itself. When a remote tool asks the user for input mid-call (MCP elicitation), an input card appears in the conversation. API: `/api/v1/orgs/:orgId/approvals`, `/questions`, `/me/tool-grants`.

**Tool definition drift**: the kernel re-reads a connector's tool list every `tools.driftIntervalHours` hours (default 24), when it receives a `list_changed` notification from the remote, and when an admin clicks "Refresh". New tools, and tools whose definition changed in any way, first go to "pending review", and the model can't use them until they are reviewed (approved / rejected); this prevents a remote from quietly changing tool descriptions.

**`tool_search`**: when an agent has more than `tools.searchThresholdTools` (30) tools available, or an estimated more than `tools.searchThresholdTokens` (8000) tokens of them, the kernel stops putting every definition into each request; it gives a tool catalog instead, and the model loads what it needs with `tool_search` by keyword. Org admins can turn it off under "Settings → Organization" (`PATCH /api/v1/orgs/:orgId/settings {"toolSearch":"off"}`).

**Plugin tools must be enabled in the org first**: a plugin's tools (such as `todo__write`) are available only in orgs that enabled that plugin (connectors don't need this). For org admins:

```bash
curl -s -X PUT localhost:8080/api/v1/orgs/$ORG/plugins/todo -b cookies.txt \
  -H 'Content-Type: application/json' -H 'X-Capybara-Csrf: 1' -d '{"enabled":true}'
```

To write tools, see [.agents/skills/writing-tools](.agents/skills/writing-tools/SKILL.md); to write connectors, see [.agents/skills/writing-connectors](.agents/skills/writing-connectors/SKILL.md); for the related config (`tools.*`, `http.publicUrl`), see [docs/config.md](docs/config.md).

### Connect Slack and Lark (bot, login, directory)

`@capybara-hq/plugin-slack` and `@capybara-hq/plugin-lark` each provide three capabilities: an IM bot (`channel@1`: talk to agents in the IM and approve by clicking cards), web login (`identity-source@1`) and directory sync (`directory@1`). All three use the same identity key (`slack:<team id>` / `lark:<tenant_key>` + the platform user id), so one person maps to one account. Both use long connections (Slack Socket Mode, Lark long connection) and **need no public callback address**. Every step on the platform side, the required permissions (scopes) and behavior details are in the plugin READMEs; only the order is listed here:

- Slack: [plugins/slack/README.md](plugins/slack/README.md)
- Lark: [plugins/lark/README.md](plugins/lark/README.md)

**0. Prerequisite**: configure `http.publicUrl` (the web app's externally reachable origin, as in the OAuth section above). Binding links, the web links in cards and login callbacks are all based on it; when it isn't set, the bot can't recognize unbound people (it only replies "please contact your admin"), approval / question cards degrade to a single line "please handle this on the web", and third-party login is unavailable. Long connections run only on replicas with the `gateway` role (`capybara start` runs all roles by default).

**1. Create the platform app**
- Slack: create the app from a manifest with [`plugins/slack/app-manifest.yaml`](plugins/slack/app-manifest.yaml) (Socket Mode, event subscriptions and bot scopes are all in it), then generate an app-level token `xapp-…` (scope `connections:write`) and install it to the workspace to get `xoxb-…`.
- Lark: create a **custom enterprise app** (long connections support only custom apps), add the bot capability, enable the permissions listed in the README, choose "Use long connection" for both events and callbacks, then publish a version and set its availability scope. **Login, bot and directory must use the same Lark app**: `open_id` is per app, so with a different app the same person no longer matches (the plugin checks as best it can and reports an error). Only Lark international (`open.larksuite.com`) is supported for now; the Feishu (`feishu`) region is reserved but not yet available.

**2. Install the plugin and approve its permissions**: the enterprise admin installs the plugin package of `@capybara-hq/plugin-slack` / `@capybara-hq/plugin-lark` under "Admin → Plugins" (or `pnpm capybara plugins install npm:@capybara-hq/plugin-slack`; during development you can also list them in `CAPYBARA_PLUGINS`). A new plugin isn't loaded when it first appears; on the install confirmation page, or with `pnpm capybara plugins review`, check the permissions it asks for (the two plugins declare only `permissions.network`, provide three capabilities, and carry deployment-level and org-level config; the channel, login and directory providers are marked sensitive). After approving (in the web app, or `pnpm capybara plugins approve slack` / `approve lark`) and enabling, the replicas load it without a restart. `pluginPermissions.autoApprove` is only for local development and trials.

**3. Enable in the org and create a channel connection** (org admins, web app): "Settings → Plugins" enable `slack` / `lark` (you can also fill in the directory's org-level config here, see step 5) → top-level navigation "Channels" → new connection: pick the plugin, fill in the bot credentials (Slack `appToken` + `botToken`; Lark `appId` + `appSecret`; all go into the secret store, and the API only returns "set"), then pick the bound agent and how to handle unbound users:
- `bind` (the default): someone unknown who DMs the bot gets a binding card, and confirms the binding after logging in on the web; in a group, they are only told to DM the bot (the binding link is not posted in the group).
- `anonymous`: people in this org's tenant who aren't bound converse as the org's "anonymous guest"; this takes effect only when the bound agent is visible to the whole org, and personal credentials can't be used; people from external tenants can still only bind.

On save, the plugin verifies the credentials (`verify`), and then a gateway replica opens the long connection; the connection page shows the status and the latest error (`last_error`). The language of the bot's fixed phrases in IM comes from "Settings → Organization → IM language" (zh / en, default en).

**4. Web login** (enterprise admin, deployment level):
- Register the callback URL `<http.publicUrl>/api/v1/auth/sso/slack/callback` / `.../sso/lark/callback` in the platform app;
- Write the deployment-level config `pluginConfig.slack.clientId` / `clientSecret` and `pluginConfig.lark.appId` / `appSecret` (secret fields are masked in logs);
- Add the plugin name to `auth.loginSources` (such as `CAPYBARA_AUTH__LOGIN_SOURCES='["slack","lark"]'`, hot-reloaded), and the login page shows "Sign in with Slack / Lark".

Third-party login only creates accounts and doesn't add anyone to any org (membership comes from invitations or directory sync). To have third-party login merge into an existing local account by **verified email**, put the tenants your enterprise controls into `auth.trustedIdentitySources`; each entry is a full key `<plugin>:<tenant id>` (such as `"slack:T0123ABCD"`; a bare plugin name is rejected). List only your own workspaces / tenants, otherwise anyone in that tenant could claim your users' emails. For now only Slack login reports "email verified"; Lark login and both platforms' directories always report unverified, so Lark login never merges accounts.

**5. Directory** (org admins): under "Settings → Plugins", in that plugin's org-level config, fill in the Slack `teamId` (`T…`) + `botToken`, or the Lark `appId` + `appSecret` (for Lark, also set the directory permission scope to all members). Leaving them empty counts as "not configured": no sync and no error. Once configured, the kernel syncs every hour, and also when the platform pushes a personnel change; "Sync now" on the same page triggers it manually (`POST /api/v1/orgs/:orgId/plugins/:plugin/directory/sync`). Sync only adds people (role member) and revokes memberships **that were added by the directory**; people who joined manually / by invitation are never removed by sync.

**Behavior notes**
- **The sessions and tokens revoked on offboarding are account-level**: when the directory decides someone has left, an admin removes them, or they leave an org themselves, all of that person's web sessions and personal tokens are revoked (not only those of that org), and they must log in again (Ruling A8). Their personal connector credentials in that org are also deleted, and their in-progress runs in that org are aborted.
- **Anonymous guests in one group thread share one conversation** (when the connection is `anonymous`): everyone unbound in the thread shares one conversation context, and any of them can give a "this once" approval on that conversation's approval cards (Ruling A16).
- **A local account with no bound external identity gets a second account created by directory sync**: directory sync doesn't merge by email. To avoid this, first have the person DM the bot in IM with their local account to complete binding, or merge by verified email through third-party login under a trusted tenant (currently only Slack login can), and then turn on directory sync (a consequence of Ruling A9).
- **An identity bound through IM can't be used directly for web login**: an identity created by clicking a binding card in IM can only represent the person inside IM; to use it to log in to the web app, first log in to the bound account, and then complete one third-party login of that platform while logged in ("Verify" on that identity under "Settings → IM identities"). Identities created by directory sync are not subject to this (Ruling A18 / A23).
- **Following up in a group thread requires @-mentioning the bot again**: in group chats only messages that @-mention the bot are handled, and replies in a thread without an @ are ignored (D4).
- **Mass-removal protection**: for syncs triggered by the schedule or by personnel changes, when the planned removals exceed `max(5, 20% of existing directory members)`, or when the directory has no active member at all, that round removes nobody and records the audit entry `org.directory.removal_blocked`. When you've confirmed it is a real mass departure, trigger "Sync now" manually; a manual sync isn't subject to this limit. But if another sync round happens to be running during a manual sync, it is instead completed by the catch-up run after that round ends; the catch-up run is handled as a `changed` trigger and is still protected (Ruling A17).
- **Removals are postponed while personnel changes keep coming**: if a personnel change arrives during a sync round, that round only adds people and doesn't remove, leaving removals to the catch-up run that follows (Ruling A32). If changes never stop, removals are postponed indefinitely.
- **Slack Enterprise Grid**: the tenant is the workspace (team), not the enterprise. People from other workspaces of the same enterprise who speak in a shared channel are treated as an external tenant, and can only bind, not be anonymous; the directory syncs only the full members of the workspace given by `teamId`, and guests (single- / multi-channel) are not synced (Ruling A26 / A27 / A29).
- **Other limits**: Sign in with Slack doesn't use PKCE (Slack OIDC doesn't declare it), and Slack users from any workspace can complete login (it only creates an account); Lark login serves only the tenant where the deployment-level login app lives, while orgs in other tenants can still use the bot and bind in IM; Slack sending has no idempotency parameter, so when an over-long reply is split into several messages, a failure midway followed by a retry may duplicate the first parts; replies visible only to yourself (ephemeral) are not supported in IM yet.
- **Still awaiting integration testing on the real platforms** (so far verified only against fake servers): whether a Lark card callback is re-pushed after a failure response like events are (if not, that click is lost and needs another click); Lark card callbacks arriving as event frames, and how multi-select forms and button layouts render in JSON 2.0 cards; the Lark long-connection WSS hostname; the return-code type of the Lark v2 token endpoint and the stability of recursive department pagination when the structure is unchanged; how Slack Socket Mode reconnection and rate limiting behave in a real workspace.

To write channel, login and directory plugins, see [.agents/skills/writing-channels](.agents/skills/writing-channels/SKILL.md).

### The conversation page's right panel and plugin UI

The middle of the conversation page is the conversation, with tool calls shown as one line each on a timeline (if the tool provided a display summary, that sentence is shown, such as "Update task list (4 items)"; expand to see the full input and output). On the right is a collapsible tab panel:

- Tabs built into the kernel: "Runs" (all tool calls of this conversation, with an alert mark when an action is pending approval) and "Context" (tokens used / context window, the agent and model, the connectors used, compaction records).
- Plugin tabs: they appear automatically once the org enables a plugin that has UI. For example, enabling `@capybara-hq/plugin-todo` adds a "Tasks" tab, which refreshes live every time the agent updates the list. A plugin can also add org pages to the top bar's "Extensions" menu.

Plugin UI comes in two tiers:

- **Rendered schema views**: the plugin returns only structured blocks (lists, tables, charts, buttons, forms and so on), and the web app draws them with design-system components. The plugin can't write styles or execute code. New views added in an upgrade don't need re-approval. See `plugins/todo`.
- **Embedded apps**: the plugin's own page goes into a sandboxed iframe, for complex interactions such as boards and workflows. The page loads through the same-origin proxy `/plugin-ui/<plugin>/...`, can't read the session cookie, and gets only a token that is valid for that plugin alone and expires in 5 minutes. Embedded apps are marked `(sensitive)` in `capybara plugins review` and load only after approval. See `plugins/example-board`: after adding it to `CAPYBARA_PLUGINS` and enabling it in the org, open the org board from the top bar's "Extensions" menu, and the conversation gets an extra "Board" tab.

To write plugin UI, see [.agents/skills/writing-plugin-ui](.agents/skills/writing-plugin-ui/SKILL.md).

### Object storage (attachments, artifacts, skill files)

Object storage is provided by an `object-store@1` plugin, with the default implementation `@capybara-hq/plugin-object-store-s3` (the official `@aws-sdk/client-s3`): it works with AWS S3, MinIO, Ceph, SeaweedFS, and with Alibaba Cloud OSS and Volcano Engine TOS, which offer S3-compatible APIs. One deployment has one bucket; plugins read and write through `ctx.storage`, with keys automatically prefixed `plugins/<plugin>/<org id>/` (the kernel itself uses `kernel/<org id>/`), so they can't see each other. Large files are uploaded directly from the browser through presigned URLs and downloaded directly, without going through the kernel; the upload size is limited by the storage side through policy.

The local `docker/compose.dev.yaml` ships the official SeaweedFS image (`chrislusf/seaweedfs`, pinned by tag plus digest): the S3 API is at `localhost:8333`, the credentials are `capybara` / `capybara-secret`, and the filer's file browser is at <http://localhost:8888>. The one-shot container `createbuckets` creates the bucket `capybara`. Tests use the same image (`startTestS3()`), and `CAPYBARA_TEST_S3_IMAGE` can switch it to a private image source. To enable it:

`object-store-s3` is a builtin plugin and doesn't need to be listed in `CAPYBARA_PLUGINS`; you only give the deployment-level config (the enterprise admin can also fill it in in the admin console):

```bash
export CAPYBARA_PLUGIN_CONFIG='{"object-store-s3":{"endpoint":"http://localhost:8333","region":"us-east-1","bucket":"capybara","accessKeyId":"capybara","secretAccessKey":"capybara-secret","forcePathStyle":true}}'
# or field by field: CAPYBARA_PLUGIN_CONFIG__OBJECT_STORE_S3__SECRET_ACCESS_KEY=...
```

| Field | Description |
|---|---|
| `endpoint` | The address of the S3-compatible service; leave it out for AWS S3 (the endpoint comes from `region`) |
| `region` | The region; use `us-east-1` for SeaweedFS and MinIO |
| `bucket` | The bucket name (must be created beforehand) |
| `accessKeyId` / `secretAccessKey` | Credentials (secret fields, stored encrypted, masked in logs) |
| `forcePathStyle` | Path-style access (`<endpoint>/<bucket>/<key>`); SeaweedFS, MinIO and Ceph generally need it on; default `false` |
| `publicEndpoint` | An address reachable from the browser, which presigned URLs are signed against; fill it in when the kernel uses the internal `endpoint` and browsers use a public domain |

For direct browser uploads and downloads, the bucket must allow cross-origin requests from the web origin (CORS: `GET`, `POST`, `PUT`, and request headers such as `Content-Type`). Set `AllowedOrigins` to the web app's origin (scheme + domain + port).

AWS S3 (paste into the console under "Permissions → Cross-origin resource sharing (CORS)"):

```json
[
  {
    "AllowedOrigins": ["https://capybara.example.com"],
    "AllowedMethods": ["GET", "POST", "PUT"],
    "AllowedHeaders": ["*"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3600
  }
]
```

For MinIO, Ceph and other S3-compatible storage that supports `PutBucketCors`, use the AWS CLI pointed at your own endpoint (`aws s3api put-bucket-cors --endpoint-url http://minio:9000 --bucket capybara --cors-configuration file://cors.json`):

```json
{
  "CORSRules": [
    {
      "AllowedOrigins": ["https://capybara.example.com"],
      "AllowedMethods": ["GET", "POST", "PUT"],
      "AllowedHeaders": ["*"],
      "ExposeHeaders": ["ETag"],
      "MaxAgeSeconds": 3600
    }
  ]
}
```

Older MinIO versions that don't support per-bucket CORS use the environment variable `MINIO_API_CORS_ALLOW_ORIGIN` to set the allowed origins. SeaweedFS allows cross-origin requests by default, so the development compose file and tests need no extra setup.

When the object-store plugin isn't configured properly (the admin console shows "pending configuration"): plugins that declare `permissions.storage` aren't loaded (`capybara plugins review` and the startup log say `object-store@1` is missing), and kernel features that depend on storage return `storage.unavailable` (503). After an org is deleted, its objects are purged for good by a maintenance task after `storage.purgeDeletedOrgsAfterDays` (default 30) days. While the org still exists, skill objects aren't cleaned up on deletion: soft-deleted skills, old skill versions, and agent-level skills of deleted agents all keep their files in object storage until this cleanup after the org is deleted (the skill catalog snapshots in the log and loaded versions still reference them).

**Attachments and image / PDF input**: once object storage is installed, the conversation input box can take attachments (by default each ≤ 20MB and ≤ 10 per message, with types limited to PNG / JPEG / GIF / WebP, PDF, and plain text / Markdown / CSV, see `attachments.*` in `docs/config.md`). When a model declares support for images (`vision`) or documents (`documents`), it receives the original file; when it doesn't, it receives only an English text placeholder, and the bytes are never sent to a model that doesn't support them. The event log records only attachment references. The total media per request is limited by `attachments.requestMediaBytes`, and when it is exceeded, earlier attachments are replaced by placeholders. To write storage plugins, see [.agents/skills/writing-object-store-providers](.agents/skills/writing-object-store-providers/SKILL.md).

### Conversation sandbox (Docker)

Sandboxes are provided by a `sandbox@1` plugin, and the Docker implementation is `@capybara-hq/plugin-sandbox-docker`: one container per conversation (runc, or gVisor's runsc), files on a volume, hibernated when idle and destroyed after long disuse; egress is allowed through a proxy by allowlist by default. The plugin reaches Docker only through the socket proxy (`docker/sandbox-proxy`) and doesn't mount `docker.sock` itself. Locally:

```bash
docker compose -f docker/compose.dev.yaml --profile sandbox up -d   # builds the sandbox and egress proxy images, starts the socket proxy (127.0.0.1:2375)
export CAPYBARA_PLUGINS='["@capybara-hq/plugin-model-fake","@capybara-hq/plugin-sandbox-docker"]'
export CAPYBARA_PLUGIN_CONFIG='{"sandbox-docker":{"endpoint":"tcp://127.0.0.1:2375"}}'
```

Production deployment:

- **Images**: `docker build -t capybara-sandbox:latest plugins/sandbox-docker/image` (the tag matches the default of the kernel config `sandbox.image`) and `docker build -t capybara-sandbox-egress:latest plugins/sandbox-docker/egress-proxy`; after pushing them to your own registry, **pre-pull them on every Docker node** (when the image isn't local, it is pulled the first time a sandbox is used, which may run past that tool call's time limit). To use gVisor, first register `runsc` in the daemon and add `"runtime":"runsc"` to the plugin config.
- **Where the socket proxy lives**: anyone who can reach the proxy can almost fully control Docker. `127.0.0.1:2375` is for local development only; in production, **never publish it on any host address (including 127.0.0.1)**; put it only on an internal network the kernel is on (set `endpoint` to `tcp://sandbox-proxy:2375`), and don't attach sandboxes to that network.
- **Egress**: `sandbox.limits.egress` defaults to `allowlist`, which allows only `sandbox.limits.allowHosts` (preloaded with npm, PyPI, and GitHub's clone, archive, raw and release download addresses; Debian mirrors are not preloaded: the sandbox user has no sudo and can't install apt packages, so install system packages into the image), and the proxy rejects internal-network and cloud-metadata addresses by resolved IP; `none` cuts the network; `open` requires explicitly turning on the plugin config `allowOpenEgress` (off by default) and should be used only in trusted environments. Org admins can change their org's sandbox network in org settings (`sandboxEgress`): replace it with a different allowlist (replacing the deployment's list) or cut the network, but can't be more permissive than the deployment (there is no `open`, and when the deployment is `none` the only choice is `none`). Changes to egress and resource limits affect only sandboxes created afterward. The default local volume driver doesn't enforce `diskMb`.
- **Long commands need a relaxed runtime limit**: a single command may run for at most `sandbox.limits.maxCommandSeconds` (default 7200 seconds), but a command is also stopped shortly before its run reaches `runtime.maxRunSeconds` (default 900 seconds) (the result tells the model it was due to the run time limit). When an agent needs to run long commands, raise `runtime.maxRunSeconds` to at least `maxCommandSeconds`; when this isn't satisfied, the kernel logs a warn at startup.

Once you add the builtin tools `sandbox_bash` / `sandbox_read` / `sandbox_write` / `sandbox_edit` / `sandbox_glob` / `sandbox_grep` / `sandbox_deliver` to an agent, it can use the sandbox (not included by default). Sandbox tools execute directly by default. **The sandbox isolates the host and the internal network, not data**: the egress allowlist blocks internal-network and cloud-metadata addresses, but can't stop data from being sent to hosts on the allowlist (for example `git push` to github.com, or publishing to npm); attachments in the conversation and any data the agent can read may flow out this way. For orgs that handle sensitive data, admins should change `sandboxToolPolicy` to `ask` in org settings (write, execute and deliver need approval), and / or set the sandbox network (`sandboxEgress`) to no network. Attachments are placed automatically in `/workspace/attachments/`, and files delivered with `sandbox_deliver` appear in the "Artifacts" tab on the right of the conversation page. A sandbox hibernates after 10 idle minutes (files are kept) and is destroyed after 7 days of disuse, see `sandbox.*` in `docs/config.md`. For config options, isolation settings, disk limits and egress allowlist details, see [plugins/sandbox-docker/README.md](plugins/sandbox-docker/README.md); to write sandbox plugins, see [.agents/skills/writing-sandbox-providers](.agents/skills/writing-sandbox-providers/SKILL.md).

### Conversation sandbox (E2B)

The other implementation is `@capybara-hq/plugin-sandbox-e2b` (an alternative to Docker): one E2B sandbox per conversation (E2B cloud or self-hosted), hibernation uses E2B's pause and resuming uses connect, pausing automatically on schedule instead of deleting; the egress allowlist maps to E2B's `allowOut` / `denyOut` (by domain, covering only ports 80 / 443). The template is built from the same `plugins/sandbox-docker/image/Dockerfile`:

```bash
export CAPYBARA_PLUGINS='["@capybara-hq/plugin-model-fake","@capybara-hq/plugin-sandbox-e2b"]'
export CAPYBARA_PLUGIN_CONFIG='{"sandbox-e2b":{"apiKey":"e2b_…","template":"capybara-sandbox"}}'
```

- **Template**: build it from the Dockerfile with E2B's Template SDK (`Template().fromDockerfile(...)`, with `cpuCount: 1` and `memoryMB: 2048` matching the kernel defaults), and put the template name into `template`; rebuild the template after changing the Dockerfile. E2B's CPU, memory and disk are determined by the template, so these three `sandbox.limits` settings have no effect on it, and the kernel config `sandbox.image` isn't used either.
- **Egress is weaker than Docker**: E2B's domain allowlist only looks at the Host header on port 80 and the SNI on port 443, and doesn't check the destination IP, so a sandbox may reach arbitrary addresses through a domain on the allowlist; when an allowlist is used, E2B also lets DNS to 8.8.8.8 through. Use Docker for deployments with strict egress requirements. For self-hosted E2B, block internal-network and cloud-metadata addresses yourself at E2B's network layer; for versions that don't support domain allowlists, set `domainAllowlist: false` (`allowlist` degrades to `none`).
- On the Hobby plan, the sandbox timeout is at most 1 hour, so set `sandbox.limits.maxCommandSeconds` below 3480.
- The sandbox CPU / memory overrides an enterprise admin sets for an org in the admin console have no effect on E2B (the spec is determined by the template) and apply only to the Docker implementation.

For template build steps, self-hosting (`apiUrl` / `domain`), and the limits of egress and resource limits, see [plugins/sandbox-e2b/README.md](plugins/sandbox-e2b/README.md).

### Skills

Skills are compatible with the Anthropic Agent Skills format: a directory with a `SKILL.md` at its root that has `name` / `description` frontmatter, and it can carry scripts and other files. Metadata is in PG and files are in object storage (so install an object-store plugin first).

- **Skill library** ("Skills" in the top bar): an org admin uploads a zip (≤ 50MB, each file ≤ 10MB, total after unzipping ≤ 50MB; `SKILL.md` sits at the root or in the single top-level folder), and uploading the same name again creates a new version; members can browse. When editing an agent, tick the org skills to use in the "Skills" group.
- **At runtime**: when a conversation starts a run, the kernel writes the list of skills available to that agent (name + description) into the conversation log and tells the model; the model reads the body by name with the builtin tool `skill_load`. Skills that carry scripts are copied into the sandbox's `/skills/<name>/` (read-only, run with `sh` / `python3`), and the agent needs sandbox tools. When skills change, the model gets a reminder at the **start of the next run**.
- **Agents writing their own skills**: add the builtin tool `skill_write` to an agent (not included by default). Skills written by a private agent take effect immediately; when a shared agent writes a skill, the initiator first confirms that tool call in the conversation, and then it goes to the agent owner's "Inbox" for approval; until approved, only the conversation that initiated the change can try it, and once approved all conversations use the new version from their next run. The owner can delete an agent's self-written skills on the agent edit page.

### Evals and trajectories

Org admins work under "Evals" in the top bar (agent owners get to the run records of their own agents from the agent detail page):

- **Trajectory viewer** (`/trajectories`): the event timeline and span waterfall of a conversation, the tokens, latency and cost of every model call (estimated at read time from the price table under "Admin → Models", with the currency taken from the deployment setting `priceCurrency`, and "—" shown when there is no price), tool calls and the approval chain. Only org admins and the agent's owner can view it, and anyone without permission always gets 404; every view records the audit entry `trajectory.viewed`.
- **Eval sets** (`/evals`): add cases from real conversations or by sampling (one eval set belongs to one agent; a case stores a log snapshot, ≤ `evals.maxCaseBytes`), switch the model / params / instructions / agent version to make candidates, and choose **step replay** (resend that moment's model requests one by one and compare) or **full-run replay** (rerun the whole run in a hidden conversation, using the tool results recorded at the time and **executing no tools**). Before a run, the expected request count and tokens are shown, and it stops at the token cap (`evals.defaultTokenCap` / `evals.maxTokenCap`); the number of cases an org executes at once is limited by `evals.orgConcurrency`. Results include the structural diff, an optional LLM judge (first pick a model for the purpose `eval` under "Settings → Model purposes" or "Admin → Models"), and manual pass / fail. Eval data stays inside the org, and there is no export.

To write eval and replay code, see [.agents/skills/replay-evals](.agents/skills/replay-evals/SKILL.md).

### Enterprise directory, catalogs and app bundles

The enterprise directory lives inside the deployment ("Admin → Enterprise directory") and has four kinds of items: **plugins**, **connector templates** (connectors with the endpoint and auth preset, so the org only fills in credentials), **skills**, and **apps** (`app.yaml` bundles: plugins + connector templates + skills). The enterprise admin sets a policy for each item: `allow` (the default for new items), `needs_approval` (when an org admin installs it, it goes to the enterprise admin for approval, and the approval holds for that org across versions), or `disabled` (cannot be newly installed; installed ones are unaffected; when a **plugin item** is set to `disabled`, apps that contain that plugin also can't newly enable it in an org). Members browse and request in "Directory" in the top bar, and requests go to the org admin's inbox. When the deployment settings `customConnectors` / `customSkills` are set to `deny`, orgs can only install connectors / skills from the directory (this doesn't affect agents writing their own skills with `skill_write`).

- **Item sources**: manual upload (tgz; connector templates and skills can also be zip) or npm; the **official catalog** (configured under `catalogs.official.*`; off by default until the official catalog goes live, then set `catalogs.official.enabled: true`); **enterprise catalogs** (added under "Admin → Enterprise directory → Sources", several allowed, with an optional mirror and token). A catalog is a static `index.json` (format in `packages/plugin-sdk/schemas/catalog-index.v1.schema.json`), pulled every `catalogs.refreshIntervalMinutes` minutes or refreshed manually; items in a catalog are browsed first, and a version is downloaded and built into a directory item only when you "import" it; when a new version appears you are only notified, and it isn't pulled automatically.
- **Verification**: downloads are always verified against the sha512 in the catalog (npm metadata is not trusted), and a mismatch is rejected (`catalog.integrity_mismatch`); the permission summary in the catalog is used for display only, and the review page warns when it differs from what is computed after download. Signatures / provenance come in M7.
- **Network and tokens**: catalog addresses, mirrors and the `tarball` download addresses of items accept only https (`catalogs.allowInsecureLoopback` is for tests only), redirects are not followed, and responses have a size limit. An enterprise catalog's token is sent only to the origin of the catalog's main address (not when the mirror is on another origin), and `tarball` downloads don't carry the catalog token; when a `tarball` is on the same origin as `packages.npmRegistry`, it carries `packages.npmToken`, and on any other origin never. **Don't put tokens in the query of a catalog URL** (URLs are stored in PG and shown in the admin console); use the source's "Token" field (stored encrypted, sent as `Authorization: Bearer`). The kernel doesn't block https URLs that resolve to internal-network addresses: catalog and `tarball` addresses are decided by the enterprise admin (and the catalog author), so add only catalogs you trust.
- **Offline deployment**: the official catalog is off by default (`catalogs.official.enabled` defaults to `false`, the admin console shows offline mode, and the official catalog is never contacted), so no extra setup is needed; use an enterprise catalog hosted on the internal network and manual upload instead; npm sources and app bundles need access to an npm registry, so point `packages.npmRegistry` at an internal mirror (such as Verdaccio or Nexus), and put the private registry's token in `packages.npmToken`.
- **App bundles**: `app.yaml` references plugins by npm package name + version range + lock (exact version + sha512); plugin packages are not packed into the app bundle, and import pulls them from `packages.npmRegistry` and verifies them against the lock — **importing an app bundle in an offline deployment requires an npm mirror**. On import, the enterprise admin reviews the permissions and migration warnings of all plugins at once, and at confirmation can also install the plugins to the deployment and enable them (`deployPlugins`); when it isn't ticked, only the directory item is created and the deployment is untouched, and later the plugin must be installed manually in the plugin admin console by the sha256 in the item (when a required plugin isn't installed at org install time, it shows "not deployed"). An org admin installing an app = enabling the plugins in this org, creating connectors from the templates (filling in credentials), and importing the skills, and on failure the parts created by this install are undone; uninstall removes only components created by this install that aren't in use elsewhere, and the kept ones are listed with reasons. Installs that were interrupted by a replica crash, that have been "installing" for more than `directory.staleInstallMinutes` (default 30) minutes, and failed installs can all be cleaned up through uninstall. **M6 doesn't support app upgrades**: uninstall first, then install the new version.
- **Plugin items and policy**: plugins can be installed to the deployment only by the enterprise admin; the org-side "install" = enabling it in this org, subject to the item's policy. When an org enables a plugin directly ("Settings → Plugins"), the decision is made over all directory items that brought this plugin into the deployment, and **the strictest wins** (any item `disabled` means it can't be enabled, and any `needs_approval` item that this org hasn't been approved for means a request must come first); plugins within an app are judged by the app item's policy. Plugins not installed through the directory aren't subject to directory policy. Exception: setting the plugin's own directory item to `disabled` is the master switch, and the plugin can't be newly enabled in an org whether or not there is a source record and whether or not it goes through an app.

To write connector templates and app bundles, see [.agents/skills/writing-apps](.agents/skills/writing-apps/SKILL.md).

## Operations notes

- **When the setup wizard reopens**: "needs setup" is decided as "no active (`status = active`) enterprise admin exists", checked live against PG every time. If someone edits the database directly and disables or revokes every enterprise admin, the deployment reopens to unauthenticated `POST /api/v1/setup`, and whoever calls it first becomes the new enterprise admin. Production deployments should always set `CAPYBARA_AUTH__SETUP_TOKEN` (setup must carry the same value as `setupToken`); to recover an admin, prefer the CLI: `echo "$PW" | pnpm capybara admin create --login <name> --display-name <display name>`.
- **Shutdown time budget**: after SIGTERM / SIGINT there are at most 30 seconds in total, spent by phase in order: abort in-progress kernel migrations 2s → HTTP (wait for listening to finish and close connections, forcing disconnect at the deadline) 10s → runs (this process's agent runs stop at the next step boundary and their jobs go back to the queue; ones that time out are continued by other replicas through the stalled mechanism) 10s → plugins (including draining plugin queues) 5s. Each phase actually waits `min(phase budget, total remaining)`; when all the earlier phases use their full budget, only about 3 seconds remain for the bus subscription connection, Redis and the PG pool to wrap up, and these three steps share the remaining time; on timeout it only logs a warn and stops waiting (destroying the PG pool may finish after `stop()` returns). The orchestrator's termination grace period (such as Kubernetes `terminationGracePeriodSeconds`) should be at least 30 seconds.

## Development

```bash
pnpm lint && pnpm typecheck && pnpm check && pnpm test   # tests need Docker (Testcontainers)
```

For the contribution guide see [CONTRIBUTING.md](CONTRIBUTING.md), and for the agent-facing repository guide see [AGENTS.md](AGENTS.md).

## License

[Apache-2.0](LICENSE)
