# Development: run from source

You need Node 24, pnpm, Docker and openssl. The database must be PostgreSQL 15 or newer (migrations use `UNIQUE NULLS NOT DISTINCT`; development and CI use 17).

```bash
pnpm install
docker compose -f docker/compose.dev.yaml up -d      # postgres:5432 + valkey:6379 + seaweedfs (S3 API 8333)

export CAPYBARA_DB__URL=postgres://capybara:capybara@localhost:5432/capybara
export CAPYBARA_REDIS__URL=redis://localhost:6379
export CAPYBARA_MASTER_KEY=$(openssl rand -base64 32)
export CAPYBARA_EXTENSIONS='["@capybara-hq/plugin-model-fake"]'
export CAPYBARA_EXTENSION_CONFIG='{"example-counter":{"step":1}}'   # optional, step defaults to 1
export CAPYBARA_EXTENSION_PERMISSIONS__AUTO_APPROVE=true   # local trials only: auto-approve extension permissions (keep it off in production)

pnpm capybara migrate     # migrate the kernel and extension schemas

# example-counter, the reference extension, is not published: pack it from a capybara-hq/plugins checkout
git clone https://github.com/capybara-hq/plugins.git ../plugins
(cd ../plugins && pnpm install && pnpm pack-plugins)    # writes ../plugins/artifacts/plugins/*.tgz
pnpm capybara extensions install ../plugins/artifacts/plugins/capybara-hq-plugin-example-counter-*.tgz --yes
pnpm capybara extensions approve example-counter --yes
pnpm capybara extensions enable example-counter

pnpm dev:kernel           # capybara start with readable logs, also written to /tmp/capybara-dev-kernel.log; listens on :8080 (change with CAPYBARA_HTTP__PORT)
```

`pnpm dev:kernel` is `pnpm capybara start` with `CAPYBARA_LOG__FORMAT=pretty` and `FORCE_COLOR=1`,
its output copied with `tee` to `/tmp/capybara-dev-kernel.log` (colors in the terminal, none in the
file); extra
arguments go to `start` (`pnpm dev:kernel --role api`). `pnpm dev:web` likewise copies the web
app's output to `/tmp/capybara-dev-web.log`. Look there first when a local kernel misbehaves.
Without a terminal (containers) the kernel logs JSON; see "Logs" in
[docs/deploy/README.md](deploy/README.md) for the format, request ids and Loki.

The kernel is one NestJS application (`packages/kernel`): global infra modules (config, logging,
database with `@Transactional`, Redis, locks, cache, queues, schedules, throttling, health), one
module per domain, and the role modules `--role` selects (`api`: the HTTP API; `worker`: agent runs,
queue consumers and every periodic job; `gateway`: IM long connections and webhooks). Extensions
never see Nest, only the SDK `ctx`. Ctrl-C stops the kernel gracefully; a second Ctrl-C exits at
once. How to add a service, a route, a job or a test is in
[.agents/skills/writing-kernel-api](../.agents/skills/writing-kernel-api/SKILL.md), and
`pnpm check:kernel-conventions` (part of `pnpm check`) enforces the conventions.

Instead of exporting the variables in every shell, put them in a `.env` file at the repository root (copy [.env.example](../.env.example); `.env` is gitignored): every `capybara` command loads `.env` from its working directory first, and variables already set in the shell win. `--env-file <path>` loads another file, `--no-env-file` none. Any config key can go there as `CAPYBARA_<A>__<B>`, next to `CAPYBARA_CONFIG_SOURCE` / `CAPYBARA_CONFIG_FILE` / `CAPYBARA_NACOS_*` choosing where the rest of the config comes from ([docs/config.md](config.md)).

Here the startup config `CAPYBARA_EXTENSIONS` loads an extension straight from the workspace (development mode, source `config`). That works only for `@capybara-hq/plugin-model-fake`, the one official plugin left in core: entries are package names resolved from the working directory, or absolute paths / `file:` URLs of a module file. Every other plugin is installed as an extension package, as example-counter is above: a published one straight from npm (`pnpm capybara extensions install npm:@capybara-hq/plugin-todo --yes`, then `approve` and `enable`), see [Extensions](guide/extensions.md). Without `@<version>`, `npm:` installs the `latest` dist-tag; while the release is a candidate (`next`), name the version if `latest` doesn't point at it (`npm:@capybara-hq/plugin-todo@0.1.0-rc.0`). `openai-compatible` and `object-store-s3` are bootstrap plugins (pinned in `packages/kernel/bootstrap.json`), installed by `capybara bootstrap` or a starting kernel, so they don't need to be listed in `CAPYBARA_EXTENSIONS`. On the first start against a fresh database, `pnpm capybara start` installs them itself: it downloads the pinned versions from npm and checks each against its pinned sha512 (once per manifest; a later start needs no network). Set `CAPYBARA_PACKAGES__NPM_REGISTRY=<url>` for a mirror that serves the same tarballs, or `NODE_USE_ENV_PROXY=1 HTTPS_PROXY=http://proxy:3128` to go through a proxy (Node 24 routes `fetch` through `HTTPS_PROXY` only with `NODE_USE_ENV_PROXY=1`). Fully offline, put the two tarballs in `./bootstrap/` (gitignored; another directory with `CAPYBARA_BOOTSTRAP__DIR`) under any file name, e.g. the output of `npm pack @capybara-hq/plugin-openai-compatible@0.1.0-rc.0` on another machine: a file whose sha512 equals a pin is installed instead of downloading it, any other file is ignored. A development database that was bootstrapped earlier keeps what it installed: a package at the same version with other bytes (for example the rc.0 plugins packed from core's workspace before they moved) is kept, with a warning, not replaced; recreate the database (or drop its volume) to test the npm packages.

Extension permissions: an extension is **not loaded** (the startup log has a warn) when it appears for the first time, or when an upgrade makes its manifest request any permission beyond what was approved; extensions that depend on it are not loaded either.
If permissions shrink or stay the same, it loads directly. In production, don't enable `autoApprove`; instead the enterprise admin reviews and approves in the web app under "Admin → Extensions", or uses the CLI (it connects to PG directly and runs the kernel migrations first). After approval, running replicas load the extension **without a restart** (the CLI writes to PG and notifies the replicas through Redis; if the notification fails, the next reconcile cycle picks it up):

```bash
pnpm capybara extensions review                    # list extensions pending approval and their newly requested permissions
pnpm capybara extensions approve example-counter   # confirm in the terminal, then write the snapshot and an audit record; --yes skips the confirmation
```

Verify from another terminal:

```bash
curl localhost:8080/healthz
curl -X POST localhost:8080/plugins/example-counter/inc      # {"count":1}
curl localhost:8080/plugins/example-counter/count            # {"count":1}
curl -X POST localhost:8080/plugins/example-counter/inc-later  # returns {"jobId":"…"}; about 200ms later count goes up by 1 again
```

## Talk to an agent in the web app (no model key needed)

`@capybara-hq/plugin-model-fake` is a deterministic scripted model that calls no external API, which makes it good for local trials and demos. Keep the database, Redis and master key environment variables from above, switch to loading it, then start the web app (Next, `apps/web`):

```bash
export CAPYBARA_EXTENSIONS='["@capybara-hq/plugin-model-fake"]'   # provides the model model-fake / fake-1
export CAPYBARA_EXTENSION_CONFIG='{}'
export CAPYBARA_HTTP__TRUST_PROXY=1          # trust this one proxy hop when the kernel is reached only through the web layer (see below)
export CAPYBARA_AUTH__COOKIE_SECURE=false    # local plain-http trial
pnpm capybara migrate
pnpm dev:kernel                              # kernel on :8080, logs also in /tmp/capybara-dev-kernel.log
```

In another terminal:

```bash
pnpm dev:web          # i.e. pnpm --filter @capybara-hq/web dev, started through apps/web/server.mjs, listens on :3000; output also in /tmp/capybara-dev-web.log
# set CAPYBARA_KERNEL_URL when the kernel isn't at http://localhost:8080; change the web port with PORT
```

Open <http://localhost:3000> in a browser: the setup wizard creates the admin and org → create an agent (pick the model `model-fake/fake-1`) → chat. `model-fake` decides its reply from the message prefix: `echo:<text>` replies with the text unchanged, `slow:<milliseconds>:<text>` streams chunk by chunk slowly (handy for trying "Stop" and mid-run messages), and any other text gets `You said: …`.

- **The kernel behind the web layer needs `http.trustProxy: 1`** (`CAPYBARA_HTTP__TRUST_PROXY=1`): `server.mjs` drops forwarded headers forged by the client and rewrites `x-forwarded-for` to the real peer address before passing the request to the kernel; the kernel must trust that one hop to get the real client IP (login rate limiting counts per IP). The web layer must be started through `server.mjs` (`pnpm dev:web` / `pnpm --filter @capybara-hq/web start`); running `next dev` / `next start` directly skips this step.
- When the kernel is also exposed directly, don't use a hop count; use a list of trusted proxy addresses instead (such as `CAPYBARA_HTTP__TRUST_PROXY='["10.0.0.0/8"]'`), see [docs/config.md](config.md).

Next you can invite members (`POST /api/v1/orgs/:orgId/invitations`) and manage members by role (`/api/v1/orgs/:orgId/members`); for how to write kernel APIs, see [.agents/skills/writing-kernel-api](../.agents/skills/writing-kernel-api/SKILL.md).

When you're done: `docker compose -f docker/compose.dev.yaml down` (add `-v` to also remove the data volumes).

## Checks

```bash
pnpm lint && pnpm typecheck && pnpm check && pnpm test   # tests need Docker (Testcontainers)
```

For the contribution workflow see [CONTRIBUTING.md](../CONTRIBUTING.md); for the repository guide coding agents read, [AGENTS.md](../AGENTS.md).
