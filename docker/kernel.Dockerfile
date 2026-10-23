# syntax=docker/dockerfile:1
#
# Backend image: one Dockerfile for capybara-api, capybara-worker and capybara-gateway. They differ
# only in the default roles, chosen at build time with ROLES (a JSON array, as the config expects):
#
#   docker build -f docker/kernel.Dockerfile --build-arg 'ROLES=["api"]'     -t capybara-api .
#   docker build -f docker/kernel.Dockerfile --build-arg 'ROLES=["worker"]'  -t capybara-worker .
#   docker build -f docker/kernel.Dockerfile --build-arg 'ROLES=["gateway"]' -t capybara-gateway .
#
# The image holds only the `tsc -b` output of the CLI, the kernel, the plugin SDK and the two builtin
# plugins (openai-compatible, object-store-s3), the kernel SQL migrations and production
# dependencies. No TypeScript sources and no tsx loader.

ARG NODE_IMAGE=node:24-bookworm-slim

# ---- build: install the workspace, compile, then deploy the CLI with production deps only ----
FROM ${NODE_IMAGE} AS build
ENV PNPM_HOME=/pnpm
ENV PATH=/pnpm:$PATH
WORKDIR /src

# pnpm at the version pinned by the root package.json "packageManager" field.
COPY package.json ./
RUN npm install -g "pnpm@$(node -p 'require("./package.json").packageManager.split("@")[1]')"

# Fetch dependencies from the lockfile alone so this layer survives source edits.
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=capybara-pnpm-store,target=/pnpm/store \
    pnpm config set store-dir /pnpm/store && pnpm fetch

COPY . .
RUN --mount=type=cache,id=capybara-pnpm-store,target=/pnpm/store \
    pnpm config set store-dir /pnpm/store \
    && pnpm install --frozen-lockfile --offline \
    && pnpm -r --filter "@capybara-hq/capybara..." build \
    # pnpm 10 deploys only with injectWorkspacePackages unless --legacy is given; turning injection
    # on for the whole workspace would change local dev installs, so the image uses --legacy. It
    # copies each workspace dependency's packed contents ("files": dist, src/migrations, ...).
    && pnpm --filter @capybara-hq/capybara deploy --prod --legacy /out \
    # Fail the build if any TypeScript source slipped in (emitted .d.ts files are fine).
    && ! find /out -name "*.ts" ! -name "*.d.ts" -path "*capybara-hq*" | grep . \
    && ! find /out/node_modules -path "*/node_modules/tsx" | grep .

# ---- runtime ----
FROM ${NODE_IMAGE}

RUN groupadd --system --gid 10001 capybara \
    && useradd --system --uid 10001 --gid capybara --home-dir /var/lib/capybara \
       --shell /usr/sbin/nologin capybara \
    && mkdir -p /var/lib/capybara/plugins \
    && chown -R capybara:capybara /var/lib/capybara

# Default roles of this image, a JSON array (CAPYBARA_ROLES is parsed as JSON); default all three.
# Declared after the shared layers so the three role images reuse them.
ARG ROLES='["api","worker","gateway"]'
# Reject a malformed ROLES at build time instead of at the first container start.
RUN node -e 'let r; try { r = JSON.parse(process.argv[1]); } catch {} if (!Array.isArray(r) || r.length === 0 || r.some((x) => !["api", "worker", "gateway"].includes(x))) { console.error(`ROLES must be a non-empty JSON array of "api", "worker", "gateway", e.g. ["api"]; got ${process.argv[1]}`); process.exit(1); }' "$ROLES"

# Owned by root: the app is read-only for the runtime user.
COPY --from=build /out /app

ENV NODE_ENV=production \
    CAPYBARA_ROLES=${ROLES} \
    CAPYBARA_PLUGIN_HOST__DIR=/var/lib/capybara/plugins
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
