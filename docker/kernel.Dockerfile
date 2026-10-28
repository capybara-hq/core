# syntax=docker/dockerfile:1
#
# Backend image: one Dockerfile for capybara-api, capybara-worker and capybara-gateway. They differ
# only in the default roles, chosen at build time with ROLES (comma-separated, or a JSON array):
#
#   docker build -f docker/kernel.Dockerfile --build-arg ROLES=api     -t capybara-api .
#   docker build -f docker/kernel.Dockerfile --build-arg ROLES=worker  -t capybara-worker .
#   docker build -f docker/kernel.Dockerfile --build-arg ROLES=gateway -t capybara-gateway .
#
# The image holds only the `tsc -b` output of the CLI, the kernel and the plugin SDK, the kernel SQL
# migrations, production dependencies and the bootstrap packages: /app/bootstrap/<name>-<version>.tgz
# for every plugin packages/kernel/bootstrap.json pins (openai-compatible, object-store-s3, published
# from capybara-hq/plugins), downloaded by packages/plugin-tools (pnpm pack-bootstrap) from the npm
# registry given by the build argument NPM_REGISTRY (default the public registry; a mirror must
# serve the same tarballs) and checked against the pinned sha512. So the build needs the network
# for them; nothing after it does. `capybara bootstrap` (compose init) installs them from there,
# checking them again and never touching the network; `capybara start` does it too when it finds the
# step not done. No TypeScript sources, no tsx loader, no npm / corepack / yarn.
#
#   docker build -f docker/kernel.Dockerfile --build-arg NPM_REGISTRY=https://npm.example.com/ .
#
# Behind a proxy, pass it to Node's fetch, which uses HTTPS_PROXY only with NODE_USE_ENV_PROXY=1:
#   docker build ... --build-arg NODE_USE_ENV_PROXY=1 --build-arg HTTPS_PROXY=http://proxy:3128 .
# Fully offline builds use a mirror (NPM_REGISTRY). The same applies to `pnpm pack-bootstrap` in
# a source checkout (CAPYBARA_PACKAGES__NPM_REGISTRY for a mirror).
#
# Running it (compose / K8s): run with an init process (compose `init: true`) so signals reach node
# and zombies are reaped, and allow a stop grace period longer than the kernel's drain
# (compose `stop_grace_period: 40s`; extensionHost.drainSeconds defaults to 30).

# Pinned to an exact Node version plus the multi-arch index digest, so builds are reproducible
# across platforms. To bump: pick the new tag, then
#   docker buildx imagetools inspect node:<version>-bookworm-slim
# and copy the top-level "Digest" (the index digest, not a per-platform manifest).
ARG NODE_IMAGE=node:24.22.1-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205

# ---- build: install the workspace, compile, then deploy the CLI with production deps only ----
# Runs on the target platform, not $BUILDPLATFORM: pnpm installs platform-specific optional
# dependencies (native prebuilds) for the platform it runs on, and the deploy output ships them.
FROM ${NODE_IMAGE} AS build
ENV PNPM_HOME=/pnpm
ENV PATH=/pnpm:$PATH
WORKDIR /src

# pnpm at the version pinned by the root package.json "packageManager" field.
COPY package.json ./
RUN npm install -g "pnpm@$(node -p 'require("./package.json").packageManager.split("@")[1]')"

# Fetch dependencies from the lockfile alone so this layer survives source edits. The store cache
# is locked so concurrent (multi-platform) builds don't write it at the same time.
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=capybara-pnpm-store,target=/pnpm/store,sharing=locked \
    pnpm config set store-dir /pnpm/store && pnpm fetch

COPY . .
# The registry the bootstrap packages are downloaded from, and the opt-in for Node's fetch to use
# the HTTPS_PROXY build argument (see the header).
ARG NPM_REGISTRY=https://registry.npmjs.org/
ARG NODE_USE_ENV_PROXY=
RUN --mount=type=cache,id=capybara-pnpm-store,target=/pnpm/store,sharing=locked \
    pnpm config set store-dir /pnpm/store \
    && pnpm install --frozen-lockfile --offline \
    && pnpm -r --filter "@capybara-hq/capybara..." build \
    # pnpm 10 deploys only with injectWorkspacePackages unless --legacy is given; turning injection
    # on for the whole workspace would change local dev installs, so the image uses --legacy. It
    # copies each workspace dependency's packed contents ("files": dist, src/migrations, ...).
    && pnpm --filter @capybara-hq/capybara deploy --prod --legacy /out \
    # The bootstrap packages (npm downloads, which need the network here; a package that differs
    # from its pin, a tampered tarball or an unpublished version fails the build, so the image never
    # carries a package `capybara bootstrap` would refuse).
    && pnpm -s pack-bootstrap --registry "$NPM_REGISTRY" --out /out/bootstrap \
    # Source maps point at sources the image doesn't ship; the empty .tmp is a pnpm leftover.
    && find /out -name "*.map" -type f -delete \
    && rm -rf /out/node_modules/.tmp \
    # Fail the build if any TypeScript source slipped in (emitted .d.ts files are fine).
    && test ! -e /out/src \
    && ! find /out -name "*.ts" ! -name "*.d.ts" -path "*capybara-hq*" | grep . \
    && ! find /out/node_modules -path "*/node_modules/tsx" | grep .

# ---- runtime ----
FROM ${NODE_IMAGE}

# Only node is needed at runtime: drop npm, corepack, yarn and the C headers.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
       /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
       /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-* /usr/local/include \
    && groupadd --system --gid 10001 capybara \
    && useradd --system --uid 10001 --gid capybara --home-dir /var/lib/capybara \
       --shell /usr/sbin/nologin capybara \
    && mkdir -p /var/lib/capybara/plugins \
    && chown -R capybara:capybara /var/lib/capybara

# Owned by root: the app is read-only for the runtime user. Shared by the three role images.
COPY --from=build /out /app

# Default roles of this image: comma-separated or a JSON array (the config accepts both); default
# all three. Declared after the large layers so the three role images share them.
ARG ROLES=api,worker,gateway
# Reject a malformed ROLES at build time instead of at the first container start.
RUN node -e 'const v = process.argv[1].trim(); let r; if (v.startsWith("[")) { try { r = JSON.parse(v); } catch {} } else { r = v.split(",").map((x) => x.trim()).filter(Boolean); } if (!Array.isArray(r) || r.length === 0 || r.some((x) => !["api", "worker", "gateway"].includes(x))) { console.error(`ROLES must list api, worker and/or gateway (comma-separated or a JSON array); got ${v}`); process.exit(1); }' "$ROLES"

ENV NODE_ENV=production \
    CAPYBARA_ROLES=${ROLES} \
    CAPYBARA_EXTENSION_HOST__DIR=/var/lib/capybara/plugins
# Unpacked plugin packages (rebuilt from PostgreSQL on start, so a volume is only a cache).
VOLUME /var/lib/capybara/plugins

USER capybara
WORKDIR /var/lib/capybara
EXPOSE 8080

# Every role serves /healthz and /readyz (worker-only processes expose just those two). The port
# follows CAPYBARA_HTTP__PORT; when the port comes from a config file instead, override the check.
HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch(`http://127.0.0.1:${process.env.CAPYBARA_HTTP__PORT || 8080}/readyz`).then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]

ENTRYPOINT ["node", "/app/bin/capybara.mjs"]
CMD ["start"]
