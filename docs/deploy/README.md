# Deploying Capybara

This guide covers a production deployment: what Capybara needs, the Docker Compose setup in
`docker/compose.yaml`, the process roles and how to scale them, IM channel inbound modes, the optional
sandbox, and brief notes for Kubernetes. Upgrades are in [upgrade.md](upgrade.md). The maintainer
release runbook is in [release.md](release.md). Every configuration key is listed in
[docs/config.md](../config.md).

> **0.x:** while Capybara is on 0.x, the plugin SDK (`@capybara-hq/plugin-sdk`) and the kernel HTTP
> API may change in breaking ways between minor versions. The release notes describe each breaking
> change and how to migrate.

## Requirements

| Component | Version | Notes |
|---|---|---|
| PostgreSQL | **15 or newer** | `capybara migrate` refuses older servers (`PostgreSQL 15 or newer is required`): migration 0029 uses `UNIQUE NULLS NOT DISTINCT`. Development, CI and the compose file use 17. |
| Valkey or Redis | 7 or newer | Queues (BullMQ), leases, rate limits, caches. Turn on persistence (AOF) so queued jobs survive a restart. The compose file uses Valkey 8 with `--appendonly yes`. |
| S3-compatible object storage | any | Used by the builtin `object-store-s3` plugin for attachments, artifacts, skills and plugin packages installed through the admin console. AWS S3, MinIO, Ceph, SeaweedFS and S3-compatible services such as Alibaba OSS or Volcengine TOS work. Without it, the kernel starts, but features that need storage answer `storage.unavailable` (503). |

Images: `ghcr.io/capybara-hq/capybara-api`, `capybara-worker`, `capybara-gateway` and `capybara-web`
(linux/amd64 and linux/arm64). The kernel images run as the non-root user `capybara` (uid 10001).

## Docker Compose

`docker/compose.yaml` runs a complete deployment on one Docker host: PostgreSQL 17, Valkey 8,
SeaweedFS (S3), a one-shot `init` container, the three kernel roles and the web app. You need Docker
Compose v2.23 or newer (the file uses inline `configs: content:`).

### First start

You need only `docker/compose.yaml` and `docker/.env.example` from the repository. The sandbox profile
is the exception: it needs a full checkout (see [Sandbox](#sandbox-optional)).

```bash
git clone https://github.com/capybara-hq/core.git
cd core/docker
cp .env.example .env
```

Fill in the required values in `.env`:

```bash
POSTGRES_PASSWORD=$(openssl rand -hex 24)       # letters and digits only: it goes into a URL
CAPYBARA_MASTER_KEY=$(openssl rand -base64 32)  # encrypts stored secrets: back it up
CAPYBARA_S3_ACCESS_KEY=$(openssl rand -hex 24)  # hex only: embedded in SeaweedFS's JSON config
CAPYBARA_S3_SECRET_KEY=$(openssl rand -hex 24)
CAPYBARA_SETUP_TOKEN=$(openssl rand -hex 16)    # the web setup page asks for it
```

Without `CAPYBARA_MASTER_KEY`, encrypted secrets (plugin, connector and channel credentials) can't be
read. Keep a copy somewhere safe. To rotate it, see `masterKeyPrevious` in
[docs/config.md](../config.md).

Then start:

```bash
docker compose up -d
docker compose ps -a     # init exits 0; everything else becomes healthy
```

Open `http://localhost:3000` (`CAPYBARA_WEB_PORT` changes the port).

### The first enterprise admin

There are two ways to create the first enterprise admin:

- **Web setup page (default).** With no password file, `init` only migrates and prints
  `init: no admin password file ...`. The web app opens on the setup page, which creates the
  enterprise admin and, optionally, the first organization. It asks for the setup token:
  `CAPYBARA_SETUP_TOKEN` from `.env`, which compose passes to `api` as `auth.setupToken`. Without the
  right token, setup is refused (403 `setup.token_invalid`), so whoever reaches the port first can't
  take the deployment over. If you leave `CAPYBARA_SETUP_TOKEN` empty, no token is needed and the
  first visitor becomes the enterprise admin.
- **Password file.** `init` creates the admin before anything is reachable, so the setup page is
  already closed and the setup token is moot:

  ```bash
  mkdir -p secrets && openssl rand -base64 18 > secrets/admin_password
  chmod 600 secrets/admin_password
  # in .env:
  CAPYBARA_INIT_ADMIN_PASSWORD_FILE=./secrets/admin_password
  CAPYBARA_INIT_ADMIN_LOGIN=admin            # default admin
  CAPYBARA_INIT_ADMIN_NAME=Administrator     # default Administrator
  ```

  On every `up`, `init` runs `capybara migrate`, then
  `capybara admin create --if-none --password-file /run/secrets/admin_password`. That creates the admin
  once and logs `enterprise admin already exists; skipped` on later starts. Relative paths are relative
  to `compose.yaml`. `init` runs as root, so mode 600 is fine.

  - **After the first start**, change the password in the web app and overwrite the file
    (`echo unused > secrets/admin_password`). Once an admin exists, `init` skips without reading the
    file.
  - **Don't just delete the file** while the variable is set: the existing `init` container still
    mounts it and won't start. To remove it, unset the variable, delete the file and run
    `docker compose up -d --force-recreate --no-deps init`.
  - **Setting the variable after the first start** also needs
    `docker compose up -d --force-recreate --no-deps init`. Compose doesn't recreate `init` when only
    the secret's file changes.
  - When the variable is unset, compose mounts `/dev/null` in its place, and `init` treats that as "no
    file". `/dev/null` doesn't exist on Windows hosts, so there you must always set
    `CAPYBARA_INIT_ADMIN_PASSWORD_FILE`.
  - If the login is already taken by an account that isn't an active enterprise admin,
    `admin create --if-none` fails (`account.login_taken`) instead of skipping. Choose another login.

A failing `init` (for example PostgreSQL older than 15) keeps `api`, `worker` and `gateway` from
starting. Read its output with `docker compose logs init`.

### Services, ports and networks

| Service | Image | Role |
|---|---|---|
| `postgres` | `postgres:17` | Database (volume `pgdata`) |
| `valkey` | `valkey/valkey:8` | Queues and coordination, AOF on (volume `valkeydata`) |
| `seaweedfs` | `chrislusf/seaweedfs` | SeaweedFS master, volume server and filer (volume `seaweedfsdata`) |
| `seaweedfs-s3` | `chrislusf/seaweedfs` | The S3 gateway (signed requests only) |
| `createbuckets` | `chrislusf/seaweedfs` | One-shot: creates the bucket `capybara` |
| `init` | `capybara-api` | One-shot on every `up`: migrate, then create the admin if the password file is set |
| `api` | `capybara-api` | HTTP API (`CAPYBARA_ROLES=api`) |
| `worker` | `capybara-worker` | Agent runs, queues, maintenance jobs (`CAPYBARA_ROLES=worker`) |
| `gateway` | `capybara-gateway` | IM long connections and channel webhooks (`CAPYBARA_ROLES=gateway`) |
| `web` | `capybara-web` | The web app; proxies `/api/*` to `api` and object storage (see below) |

- **Only `web` publishes a port**: `${CAPYBARA_WEB_BIND:-0.0.0.0}:${CAPYBARA_WEB_PORT:-3000}:3000`.
  Never publish `api` or `worker`. `api` trusts exactly one proxy hop (`CAPYBARA_HTTP__TRUST_PROXY=1`),
  which is `web`. If clients could reach `api` directly, they could forge `X-Forwarded-For` and get
  around the per-IP login rate limit.
- **Networks:**
  - `frontend` holds only `web` and `api`.
  - `objectstore` holds only `web` and `seaweedfs-s3`.
  - `sandbox` is internal (no route out) and holds only `worker` and `sandbox-proxy`.
  - Everything else is on the backend network (`default`), which `api` and `seaweedfs-s3` also join.

  So `web` reaches only `api:8080` and `seaweedfs-s3:8333`. It never reaches PostgreSQL, Valkey, the
  SeaweedFS filer / master / volume server, `worker` or `gateway`. The S3 gateway's gRPC port (18333)
  can't be turned off in SeaweedFS 4.48, so it stays reachable on the `objectstore` network. The
  Iceberg and Lance servers are turned off.
- **Shutdown:** the kernel services and `web` run with `init: true`, so signals reach node. The kernel
  services have `stop_grace_period: 40s`, which is longer than the kernel's drain
  (`pluginHost.drainSeconds`, default 30, inside a 30-second shutdown budget).
- **Scaling workers:** `docker compose up -d --scale worker=N`.
- **Image source:** `CAPYBARA_VERSION` picks the tag. Its default is the version the compose file
  belongs to: every release tags its commit `v<version>`, and the compose file at that tag defaults
  to that version's images. When `CAPYBARA_IMAGE_PREFIX` is
  unset, images come from `ghcr.io/capybara-hq/`. Set it to empty to use local tags. To build the
  images from a checkout, use `docker/compose.build.yaml`:

  ```bash
  docker compose -f compose.yaml -f compose.build.yaml build
  docker compose -f compose.yaml -f compose.build.yaml up -d   # with CAPYBARA_IMAGE_PREFIX= in .env
  ```

### HTTPS, the public URL and cookies

- **HTTPS or localhost.** Session cookies carry the `Secure` attribute, so browsers keep them only over
  HTTPS or on `http://localhost`. Over plain http on any other host name (an IP address, a LAN name),
  sign-in seems to succeed and then drops you back at the login page. In that case the login page
  shows a notice ("If sign-in doesn't stick: ..."). Serve `web` over HTTPS. For a short trial only,
  set `CAPYBARA_COOKIE_SECURE=false` in `.env`; compose passes it on as
  `CAPYBARA_AUTH__COOKIE_SECURE`.
- **`CAPYBARA_PUBLIC_URL` must be the exact origin browsers open** (scheme, host and any port), for
  example `https://capybara.example.com`. It sets the kernel's `http.publicUrl`, which is used for
  OAuth redirects, sign-in callbacks and links in IM cards. It also sets the object-store plugin's
  `publicEndpoint` and the web object-storage proxy's public host. The default is
  `http://localhost:<CAPYBARA_WEB_PORT>`.
- **A TLS proxy on the same host:** set `CAPYBARA_WEB_BIND=127.0.0.1`, so plain http isn't exposed on
  other interfaces, and point the proxy at `127.0.0.1:3000`.
- **`CAPYBARA_WEB_TRUST_PROXY`** behind a TLS proxy or load balancer: without it, every client looks
  like the proxy's address and all clients share one login rate limit. Set it to the proxy's addresses
  or CIDRs (preferred, e.g. `172.18.0.1` or `10.0.0.0/8`) or to a hop count (`1` = the nearest proxy).
  A hop count is safe only when clients can't reach `web` directly (`CAPYBARA_WEB_BIND=127.0.0.1`, or
  a firewall): otherwise a client could send its own `X-Forwarded-For` and `web` would trust it. It is
  unset or `0` by default, which trusts nothing. A `/0` CIDR such as `0.0.0.0/0` trusts every address
  and is refused, and any malformed value stops `web` at startup.
- **`CAPYBARA_WEB_SHUTDOWN_GRACE_MS`** (default 5000) is how long in-flight requests, including SSE
  streams, may run after SIGTERM before `web` exits. To raise it, add it to the `web` service's
  environment in a `compose.override.yaml` (below) and keep it below the service's stop grace period
  (compose's default is 10 s).

### Object storage on the web origin

Browsers upload and download attachments and artifacts with presigned S3 URLs. Nothing in the compose
deployment publishes SeaweedFS. Instead, `web` proxies the bucket path on its own origin:

- The object-store plugin signs URLs for `publicEndpoint` = `CAPYBARA_PUBLIC_URL`, path style, for
  example `https://capybara.example.com/capybara/<key>?X-Amz-...`.
- `web` forwards `/capybara/**` to `seaweedfs-s3:8333` and sets `Host` to the public host, which the
  signature covers.
  - Allowed methods: GET, HEAD and POST. At `/capybara` itself, only POST is allowed, so bucket
    listings are refused.
  - Dropped request headers: cookies, `Authorization` and forwarding headers.
  - Added response headers: `X-Content-Type-Options: nosniff` and `Content-Security-Policy: sandbox`.
- Upload bodies are capped at `CAPYBARA_WEB_MAX_PACKAGE_BYTES` (default 50 MiB). The real object size
  limit is enforced by the storage's presigned POST policy (`attachments.maxBytes`, default 20 MiB).

The `web` variables, which compose sets for you:

| Variable | Compose value |
|---|---|
| `CAPYBARA_WEB_OBJECT_STORE_URL` | `http://seaweedfs-s3:8333` (unset = proxy off) |
| `CAPYBARA_WEB_OBJECT_STORE_BUCKET` | `capybara` (must equal the plugin's `bucket`) |
| `CAPYBARA_WEB_OBJECT_STORE_PUBLIC_HOST` | `CAPYBARA_PUBLIC_URL` (the host of the plugin's `publicEndpoint`) |

If you use external object storage with its own HTTPS endpoint that browsers can reach (for example
AWS S3), leave `CAPYBARA_WEB_OBJECT_STORE_URL` unset. Set the plugin's `publicEndpoint` to that
endpoint, or leave it empty for AWS, and allow the web origin in the bucket's CORS rules. The README
section on object storage has CORS examples.

### More kernel settings: `compose.override.yaml`

`compose.yaml` passes the kernel only the variables listed in its `x-kernel-env` block. To set any
other key from [docs/config.md](../config.md), for example `CAPYBARA_CHANNELS__SHARE_SLACK` or
`CAPYBARA_PACKAGES__NPM_REGISTRY`, put it in a `compose.override.yaml` next to `compose.yaml`.
`docker compose` reads that file automatically when you don't pass `-f`. Add the variable to every
kernel service that reads it. When in doubt, add it to `init`, `api`, `worker` and `gateway`:

```yaml
# docker/compose.override.yaml
x-extra-env: &extra-env
  CAPYBARA_PACKAGES__NPM_REGISTRY: https://npm.internal.example.com
services:
  init: { environment: *extra-env }
  api: { environment: *extra-env }
  worker: { environment: *extra-env }
  gateway: { environment: *extra-env }
```

Compose merges these entries into each service's existing `environment`.

## Roles and scaling

One kernel image runs any combination of three roles. `capybara start` runs all three unless told
otherwise.

| Role | Does | Scale by |
|---|---|---|
| `api` | The HTTP API behind `web` (`/api/v1/*`, plugin routes) | CPU and request rate. Stateless. |
| `worker` | Agent runs, BullMQ queues (channel inbound and outbound delivery, evals, plugin jobs), maintenance jobs | Queue backlog and run concurrency. Serves only `/healthz` and `/readyz`. |
| `gateway` | IM long connections (Slack Socket Mode, Lark long connection) and the channel webhook route | For availability and to spread connections; see below. |

- **Choosing roles:**
  - `CAPYBARA_ROLES` accepts a comma-separated list (`api,worker`) or a JSON array
    (`["api","worker"]`).
  - `capybara start --role api,worker` overrides it.
  - The three published images differ only in their default `CAPYBARA_ROLES`: `api`, `worker` and
    `gateway`. They are built from one Dockerfile with the build argument `ROLES` (comma-separated or
    a JSON array, default `api,worker,gateway`):
    `docker build -f docker/kernel.Dockerfile --build-arg ROLES=worker .`.
- **IM needs a gateway.** Since 0.1.0, IM long connections run **only on processes with the `gateway`
  role**. A deployment whose processes don't include `gateway` receives no IM messages. Two log lines
  catch this:
  - At startup, a process with `worker` but not `gateway` logs at info: `this process runs the worker
    role without gateway; channel long connections are held only by processes with the gateway role`.
  - A worker job checks every minute and warns when active channel connections (long connection or
    webhook) have no live gateway replica with their plugin loaded: `active channel connections have
    no live gateway replica with their plugin loaded; add the gateway role to a process
    (CAPYBARA_ROLES) that can load the plugin, or they receive no messages`.

  Outbound delivery and the processing of inbound messages still run on `worker`.
- **Gateway fair share.** Each channel connection's long connection is held by exactly one gateway
  replica, under a lease in Redis.
  - Replicas send heartbeats per channel plugin and share each plugin's connections. For a plugin
    with `runnable` connections and `live` gateway replicas, a replica's target is
    `floor(runnable / live) + (rank < runnable % live ? 1 : 0) + shareSlack`, where `rank` is the
    replica's position among the live replica ids (sorted) and `shareSlack` is
    `channels.shareSlack` (default 1).
  - A replica above its target hands back one connection per scan round (`channels.scanIntervalMs`,
    default 10 s), and another replica picks it up.
  - `shareSlack` is how many connections a replica may hold above its fair share before it hands any
    back. A higher value means fewer handoffs when replicas come and go, at the cost of a less even
    spread. `0` keeps the spread exact.
  - When a gateway dies, its leases expire after `channels.leaseTtlMs` (default 30 s) and the
    survivors take over.

  Run two or more gateway replicas for availability. Adding replicas spreads connections; it doesn't
  add throughput, because the work happens on `worker`.
- **The api trusts one proxy hop.** `http.trustProxy: 1` is right for `api` only when nothing but
  `web` can reach it. `web` drops forged forwarding headers and sets `X-Forwarded-For` to the real
  peer address. The kernel needs this address for the per-IP login rate limit and for session records.
  `web` must be started with `node server.mjs`, which the image does. The Next standalone server and
  `next start` forward no `X-Forwarded-For` at all, so the kernel sees every client as `web`'s address
  and all clients share one login rate limit. If `api` is also reachable another way, use a list of
  trusted proxy addresses instead of a hop count, e.g. `CAPYBARA_HTTP__TRUST_PROXY='["10.0.0.0/8"]'`.

## Plugins

The kernel images contain two builtin plugins: `openai-compatible` (models) and `object-store-s3`
(storage). Every other official plugin is published on npm as `@capybara-hq/plugin-<name>` and
installed at runtime. Installing, enabling, upgrading and disabling plugins don't need a restart.

- **Admin console:** Admin → Plugins → Install plugin. Upload a `.tgz` or enter an npm package name and
  version, review the permissions, then install, approve and enable.
- **CLI**, inside a running kernel container:

  ```bash
  docker compose exec api node /app/bin/capybara.mjs plugins install npm:@capybara-hq/plugin-slack --yes
  docker compose exec api node /app/bin/capybara.mjs plugins approve slack --yes
  docker compose exec api node /app/bin/capybara.mjs plugins enable slack
  docker compose exec api node /app/bin/capybara.mjs plugins list
  ```

  `docker compose run --rm api plugins ...` works too: the image's entrypoint is the CLI. `--yes` on
  `install` only skips the install confirmation. A new plugin still needs `approve`, and a new install
  starts disabled.
- **Where packages are stored:** packages installed through the admin console go to object storage
  (`deployment/plugins/blobs/`). Packages installed with the CLI are stored in PostgreSQL, because the
  CLI doesn't load the object-store plugin. Each replica unpacks them into its local `pluginHost.dir`,
  which is a cache that can be emptied at any time. If you move to another bucket or endpoint, copy the
  `deployment/` prefix too.
- **npm registry:** `packages.npmRegistry` (default `https://registry.npmjs.org`). For a private
  registry, set its token in `packages.npmToken`.
- **Official catalog:** it isn't live yet, so it's off by default (`catalogs.official.enabled: false`).
  The admin console's directory shows it as offline and the kernel never fetches it. Enterprise
  catalogs, npm installs and manual uploads work as usual.

Plugin lifecycle, permissions and the trust model are described in
[skills/writing-plugins](../../skills/writing-plugins/SKILL.md).

## IM channels: inbound modes

Each channel connection (Slack, Lark) receives messages in one of two modes. You choose the mode per
connection in the web app (Channels → connection → Overview → Inbound mode), or with
`PATCH /api/v1/orgs/:orgId/channels/:connectionId` and `{"inboundMode": "webhook"}`.

### Long connection (default)

The gateway opens an outbound connection to the platform: Slack Socket Mode, or Lark's long
connection. You need no public address, so this works from an internal network. Slack needs the
connection's `appToken` (`xapp-...`) for Socket Mode.

### Webhook (optional)

The platform calls `POST <channels.webhookBaseUrl>/channels/webhook/<connectionId>` on a gateway
replica.

- **Public ingress to the gateway.** The route is served only by processes with the `gateway` role, on
  the kernel HTTP port (8080), and it is not under `/api`. In compose, uncomment the gateway's `ports`
  entry (`127.0.0.1:${CAPYBARA_GATEWAY_PORT:-8081}:8080`) and put an HTTPS proxy in front of it.
- **Proxy only the webhook path.** The ingress in front of the gateway should forward only
  `/channels/webhook/` and nothing else of the kernel HTTP port.
- **`channels.webhookBaseUrl` is set on `api`**, the role that validates the switch to webhook mode and
  shows each connection's webhook URL. It is the public https origin that reaches the gateway
  replicas, e.g. `https://im.example.com`. Plain http is accepted only for loopback addresses with
  `tools.oauthAllowInsecureLoopback` (testing). The setting isn't hot: a change needs a restart of
  `api`. The connection page then shows the webhook URL to register with the platform. Until the base
  URL is set, switching a connection to webhook mode is refused (`channel.webhook_unavailable`). In
  compose, uncomment `CAPYBARA_CHANNELS__WEBHOOK_BASE_URL` in the `api` service, or set it in a
  `compose.override.yaml` together with the gateway port:

  ```yaml
  # docker/compose.override.yaml
  services:
    api:
      environment:
        CAPYBARA_CHANNELS__WEBHOOK_BASE_URL: https://im.example.com
    gateway:
      environment:
        CAPYBARA_HTTP__TRUST_PROXY: 172.18.0.1   # the HTTPS proxy as the gateway sees it
      ports:
        - "127.0.0.1:8081:8080"
  ```
- **The gateway's trust proxy must be `false` or the proxy's address / CIDR, never `1`.** The webhook
  port is reachable without going through `web`, so a hop count would let any caller forge
  `X-Forwarded-For`. In compose, set `CAPYBARA_GATEWAY_TRUST_PROXY` to the proxy's address as the
  gateway sees it (a comma-separated list of addresses / CIDRs works too), or leave it `false` (the
  default). A proxy on the host connects from the bridge gateway address: the Gateway shown by
  `docker network inspect capybara_default`.
- **Limits:**
  - Bodies over `channels.webhookMaxBodyBytes` (default 1 MiB) get 413.
  - Unknown connections, disabled connections and connections that aren't in webhook mode all get
    the same 404.
  - The kernel acks only after every event has been queued. If queueing fails or takes longer than
    10 s, it answers 503, so the platform retries. Duplicate deliveries are dropped.

Platform setup:

- **Slack:**
  - Set the connection's `signingSecret` (app settings → Basic Information → Signing Secret).
    Requests are verified with it and must be no older than 5 minutes. Without it, every webhook
    request is refused.
  - Turn Socket Mode off in the Slack app.
  - Use the webhook URL as both the Event Subscriptions Request URL and the Interactivity Request URL.
  - `appToken` is optional in webhook mode, because only Socket Mode uses it.
- **Lark:**
  - Under Events & Callbacks, set the subscription method to send events to your server, and use the
    webhook URL. Configure **card callbacks there too**, under Events & Callbacks, with the same URL.
  - Set an **Encrypt Key** (recommended) and copy it to the connection's `encryptKey`. Requests must
    then be encrypted and signed, which also protects against replays.
  - Copy the Verification Token to `verificationToken`.
  - Without `encryptKey`, only plaintext requests with a matching `verificationToken` are accepted.
    That mode is weaker: the token is static and there is no replay protection.
  - With neither secret set, every request is refused.

**Known limitation: duplicate Slack cards.** Slack has no idempotency key for sending messages. If a
worker crashes after Slack accepted an approval or question card but before the kernel recorded it,
the retry can post the card a second time. This is rare, and both copies act on the same request.
Lark and the test fake deliver exactly once.

## Sandbox (optional)

Conversation sandboxes use the `sandbox-docker` plugin. They need a repository checkout, because the
two images are built from `plugins/sandbox-docker` and are not published:

```bash
docker compose --profile sandbox up -d      # builds capybara-sandbox and capybara-sandbox-egress, starts sandbox-proxy
docker compose exec api node /app/bin/capybara.mjs plugins install npm:@capybara-hq/plugin-sandbox-docker --yes
docker compose exec api node /app/bin/capybara.mjs plugins approve sandbox-docker --yes
docker compose exec api node /app/bin/capybara.mjs plugins enable sandbox-docker
```

Then set the plugin's `endpoint` to `tcp://sandbox-proxy:2375` (Admin → Plugins → sandbox-docker →
configuration).

- `sandbox-proxy` is the only container that mounts the Docker socket. It allows only the Engine API
  calls the plugin uses.
- Whoever reaches it nearly controls Docker. So it sits only on the internal `sandbox` network, which
  only `worker` joins, and **it never publishes a port, not even on 127.0.0.1**. Keep it that way in
  any other deployment too: never publish the socket proxy to a host address.

Isolation (runc or gVisor), egress allowlists and limits are described in
[plugins/sandbox-docker/README.md](../../plugins/sandbox-docker/README.md).

## Kubernetes

There is no Helm chart yet. The compose file is the reference. A Kubernetes deployment maps to it like
this:

- **One Deployment per role:** `capybara-api`, `capybara-worker`, `capybara-gateway` and `capybara-web`.
  - Scale `api` and `web` with an HPA on CPU.
  - Scale `worker` on queue backlog (for example KEDA on Redis), or on CPU as a first approximation.
  - Give `gateway` a fixed replica count, two or more. Its replicas are for availability and fair
    share, not throughput.
- **An init Job** runs `capybara migrate`, and optionally
  `capybara admin create --if-none --login <login> --display-name <name> --password-file <path>`, from
  the `capybara-api` image before each rollout (e.g. a Helm pre-upgrade hook or an Argo CD sync wave).
  Kernel replicas also apply pending kernel migrations at startup, under the same advisory lock, but
  only `capybara migrate` checks the PostgreSQL version. A replica starts listening on HTTP only after
  its startup migrations finish, so run migrations in the Job rather than leaving them to the pods.
  See [upgrade.md](upgrade.md).
- **Never expose `api` or `worker`.** Expose only `web`, and the gateway's webhook route if you use
  webhooks.
  - Restrict ingress to `api` with a NetworkPolicy so that only `web` pods reach it, or set
    `CAPYBARA_HTTP__TRUST_PROXY` to the web pods' CIDR instead of `1`.
  - On the gateway, set trust proxy to the ingress controller's CIDR, or `false`, and route only
    `/channels/webhook/` to it.
- **Plugin packages belong in object storage.** Configure the object-store plugin before you install
  plugins through the admin console. Each pod's `pluginHost.dir` (`/var/lib/capybara/plugins`) is a
  cache rebuilt from object storage or PostgreSQL, so an `emptyDir` is enough. Don't share a volume
  between pods.
- **Shutdown:** set `terminationGracePeriodSeconds` to 40 or more. The kernel's shutdown budget is 30
  seconds.
- **Probes:** `/readyz` and `/healthz` on port 8080 (`CAPYBARA_HTTP__PORT`) for every kernel role, and
  `/zh/login` on port 3000 for `web`. Give the kernel pods a `startupProbe` on `/healthz` with a
  generous failure threshold (minutes, not seconds): a pod that finds pending migrations doesn't listen
  until they finish, and a liveness probe must not kill it halfway.
- **Secrets:** pass `CAPYBARA_MASTER_KEY`, the database URL and plugin credentials from Kubernetes
  Secrets as environment variables
  (`CAPYBARA_PLUGIN_CONFIG__<PLUGIN_UPPER_SNAKE>__<FIELD>` for plugin deployment config).
