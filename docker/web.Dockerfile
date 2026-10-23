# syntax=docker/dockerfile:1
#
# Web image (capybara-web): the Next app served by apps/web/server.mjs, not Next's standalone output.
#
#   docker build -f docker/web.Dockerfile -t capybara-web .
#
# Why not standalone: the standalone build generates its own server.js, which would bypass
# server.mjs. server.mjs strips client-sent forwarding headers (x-forwarded-for, forwarded, ...),
# sets x-forwarded-for to the socket's peer address and marks the request with a per-process token,
# so the /api proxy hands the kernel the real client address. Run the kernel with
# `http.trustProxy: 1` (CAPYBARA_HTTP__TRUST_PROXY=1) behind this tier.
#
# The image holds the Next build output (.next without its cache), server.mjs, src/lib/peer.ts
# (imported by server.mjs through Node's type stripping), next.config.mjs (types stripped from
# next.config.ts) and the web app's production dependencies. It does not contain the kernel.
#
# Runtime variables: PORT (default 3000), CAPYBARA_KERNEL_URL (default http://api:8080),
# CAPYBARA_WEB_HOST (default 0.0.0.0), CAPYBARA_WEB_MAX_BODY_BYTES, CAPYBARA_WEB_MAX_PACKAGE_BYTES.
# Run it with an init process (compose `init: true`) so signals reach node.

# Pinned to an exact Node version plus the multi-arch index digest, so builds are reproducible
# across platforms. Keep it in step with docker/kernel.Dockerfile. To bump: pick the new tag, then
#   docker buildx imagetools inspect node:<version>-bookworm-slim
# and copy the top-level "Digest" (the index digest, not a per-platform manifest).
ARG NODE_IMAGE=node:24.22.1-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205

# ---- build: install the workspace, build the web app, then deploy its production deps ----
# Runs on the target platform, not $BUILDPLATFORM: pnpm installs platform-specific optional
# dependencies (Next's SWC binary, sharp, ...) for the platform it runs on, and the output ships them.
FROM ${NODE_IMAGE} AS build
ENV PNPM_HOME=/pnpm
ENV PATH=/pnpm:$PATH
ENV NEXT_TELEMETRY_DISABLED=1
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
RUN --mount=type=cache,id=capybara-pnpm-store,target=/pnpm/store,sharing=locked \
    pnpm config set store-dir /pnpm/store \
    && pnpm install --frozen-lockfile --offline \
    # Workspace dependencies first (design's dist, which the deploy below packs), then the app.
    && pnpm -r --filter "@capybara-hq/web^..." build \
    && pnpm --filter @capybara-hq/web build \
    # --legacy for the same reason as docker/kernel.Dockerfile (pnpm 10 deploys only with
    # injectWorkspacePackages otherwise). Only its node_modules is kept: the deploy also copies the
    # app's sources, which the image doesn't ship.
    && pnpm --filter @capybara-hq/web deploy --prod --legacy /deploy \
    && mkdir -p /out/src/lib \
    && mv /deploy/node_modules /out/node_modules \
    # .tmp is a pnpm leftover; the hoisted link to the web package points back into /src.
    && rm -rf /out/node_modules/.tmp /out/node_modules/.pnpm/node_modules/@capybara-hq/web \
    && cd apps/web \
    && cp package.json server.mjs /out/ \
    && cp src/lib/peer.ts /out/src/lib/peer.ts \
    && cp -R .next /out/.next \
    && if [ -d public ]; then cp -R public /out/public; fi \
    # Next loads its config again at runtime (poweredByHeader, ...). Ship it as JavaScript: the
    # config uses only erasable TypeScript syntax, so stripping the types is enough.
    && node --no-warnings -e 'const fs = require("node:fs"); const { stripTypeScriptTypes } = require("node:module"); fs.writeFileSync("/out/next.config.mjs", stripTypeScriptTypes(fs.readFileSync("next.config.ts", "utf8")));' \
    # Build cache, generated route types, traces and source maps are not needed to serve.
    && rm -rf /out/.next/cache /out/.next/types /out/.next/trace /out/.next/trace-build \
              /out/.next/diagnostics \
    && find /out -name "*.map" -type f -delete \
    # Next's own trace of its server (.next/next-server.js.nft.json) needs neither the SWC compiler
    # binary nor Playwright (an optional peer of next, resolved from the e2e tooling). Drop both,
    # then the symlinks left pointing at them. @swc/core stays: next-intl's plugin imports it when
    # next.config.mjs loads.
    && rm -rf /out/node_modules/.pnpm/@next+swc-* /out/node_modules/.pnpm/@playwright+test@* \
              /out/node_modules/.pnpm/playwright@* /out/node_modules/.pnpm/playwright-core@* \
    && find /out/node_modules -xtype l -delete \
    # Fail the build if the kernel or any TypeScript source other than peer.ts slipped in.
    && test ! -e /out/node_modules/@capybara-hq/kernel \
    && ! find /out -name "*.ts" ! -name "*.d.ts" ! -path "/out/src/lib/peer.ts" \
         ! -path "/out/node_modules/*" | grep . \
    && ! find /out/node_modules -path "*capybara-hq*" -name "*.ts" ! -name "*.d.ts" | grep .

# ---- runtime ----
FROM ${NODE_IMAGE}

# Only node is needed at runtime: drop npm, corepack, yarn and the C headers.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
       /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
       /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-* /usr/local/include \
    && groupadd --system --gid 10001 capybara \
    && useradd --system --uid 10001 --gid capybara --home-dir /var/lib/capybara \
       --shell /usr/sbin/nologin capybara \
    && mkdir -p /var/lib/capybara \
    && chown capybara:capybara /var/lib/capybara

# Owned by root: the app is read-only for the runtime user.
COPY --from=build /out /app

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    CAPYBARA_WEB_HOST=0.0.0.0 \
    CAPYBARA_KERNEL_URL=http://api:8080

USER capybara
WORKDIR /app
EXPOSE 3000

# The login page renders without calling the kernel, so the check reflects only this tier. The port
# follows PORT; when CAPYBARA_WEB_HOST is not a wildcard or loopback address, override the check.
HEALTHCHECK --interval=10s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch(`http://127.0.0.1:${process.env.PORT || 3000}/zh/login`, { redirect: 'manual' }).then((r) => process.exit(r.status === 200 ? 0 : 1), () => process.exit(1))"]

CMD ["node", "server.mjs"]
