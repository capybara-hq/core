#!/usr/bin/env bash
# Smoke test for docker/web.Dockerfile: builds capybara-web (and capybara-api from
# docker/kernel.Dockerfile), runs both on a throwaway network with PostgreSQL + Valkey, and checks
# that the web image serves pages and proxies /api to the kernel, and that with forged forwarding
# headers the kernel (trustProxy 1) resolves the real client address and ignores the forged one.
# An echo upstream then shows what web actually forwards: x-forwarded-for replaced by the client
# address (not appended to), and, with CAPYBARA_WEB_TRUST_PROXY, the trusted proxy's client address.
# Publishes no host ports: requests come from a client container on the same network.
# Written for bash 3.2 (macOS) too: empty arrays expand as ${a[@]+"${a[@]}"} under `set -u`.
#
# Usage: docker/test/web-image.sh            (from anywhere; needs Docker)
#   SKIP_BUILD=1   reuse existing capybara-web:test and capybara-api:test images
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WEB_IMAGE="capybara-web:test"
API_IMAGE="capybara-api:test"
ID="capybara-web-test-$$"
NET="$ID"
PG="$ID-pg"
VALKEY="$ID-valkey"
API="$ID-api"
WEB="$ID-web"
WEB_ECHO="$ID-web-echo"
WEB_TRUST="$ID-web-trust"
CLIENT="$ID-client"
MASTER_KEY="$(head -c 32 /dev/urandom | base64)"
FORGED_IP="1.2.3.4"
# Per (login, IP) failed-login limit in the kernel (LOGIN_FAIL_LIMIT_PER_LOGIN_IP).
LOGIN_IP_LIMIT=10
STARTED=()

cleanup() {
  local code=$?
  if [ "$code" -ne 0 ]; then
    for c in ${STARTED[@]+"${STARTED[@]}"}; do
      echo "---- logs of $c ----" >&2
      docker logs --tail 50 "$c" >&2 || true
    done
  fi
  docker rm -f ${STARTED[@]+"${STARTED[@]}"} "$PG" "$VALKEY" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
  exit "$code"
}
trap cleanup EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

if [ "${SKIP_BUILD:-}" != "1" ]; then
  echo "==> building $WEB_IMAGE"
  docker build -f "$ROOT/docker/web.Dockerfile" -t "$WEB_IMAGE" "$ROOT"
  echo "==> building $API_IMAGE"
  docker build -f "$ROOT/docker/kernel.Dockerfile" --build-arg ROLES=api -t "$API_IMAGE" "$ROOT"
fi

echo "==> image contents ($WEB_IMAGE)"
[ "$(docker run --rm --entrypoint id "$WEB_IMAGE" -u)" = "10001" ] || fail "image does not run as uid 10001"
PKGS="$(docker run --rm --entrypoint ls "$WEB_IMAGE" /app/node_modules/@capybara-hq)"
echo "    @capybara-hq packages: $(echo $PKGS)"
if echo "$PKGS" | grep -qx kernel; then fail "@capybara-hq/kernel is in the web image"; fi
# The only TypeScript source allowed is src/lib/peer.ts (server.mjs imports it via type stripping).
TS_FILES="$(docker run --rm --entrypoint sh "$WEB_IMAGE" -c \
  'find /app -name "*.ts" ! -name "*.d.ts" ! -path "/app/src/lib/peer.ts" ! -path "/app/node_modules/*"; find /app/node_modules -path "*/@capybara-hq/*" -name "*.ts" ! -name "*.d.ts"; true')"
[ -z "$TS_FILES" ] || fail "TypeScript sources in the image: $(echo "$TS_FILES" | head -5)"
docker run --rm --entrypoint sh "$WEB_IMAGE" -c \
  'test -f /app/server.mjs && test -f /app/src/lib/peer.ts && test -f /app/.next/BUILD_ID && test ! -e /app/.next/cache' \
  || fail "server.mjs, peer.ts or the Next build output is missing (or .next/cache was shipped)"
docker run --rm --entrypoint sh "$WEB_IMAGE" -c '! command -v npm && ! command -v corepack' >/dev/null \
  || fail "npm or corepack is in the image"
DANGLING="$(docker run --rm --entrypoint find "$WEB_IMAGE" /app/node_modules -xtype l)"
[ -z "$DANGLING" ] || fail "dangling symlinks in the image: $(echo "$DANGLING" | head -5)"
[ "$(docker run --rm --entrypoint printenv "$WEB_IMAGE" CAPYBARA_KERNEL_URL)" = "http://api:8080" ] \
  || fail "CAPYBARA_KERNEL_URL default is not http://api:8080"

echo "==> starting PostgreSQL and Valkey on network $NET"
docker network create "$NET" >/dev/null
docker run -d --name "$PG" --network "$NET" \
  -e POSTGRES_USER=capybara -e POSTGRES_PASSWORD=capybara -e POSTGRES_DB=capybara \
  postgres:17 >/dev/null
docker run -d --name "$VALKEY" --network "$NET" valkey/valkey:8 >/dev/null
for _ in $(seq 1 60); do
  # pg_isready over TCP: the init phase only listens on the socket.
  if docker exec "$PG" pg_isready -h 127.0.0.1 -U capybara >/dev/null 2>&1; then break; fi
  sleep 1
done
docker exec "$PG" pg_isready -h 127.0.0.1 -U capybara >/dev/null || fail "PostgreSQL did not start"

ENV_ARGS=(
  -e "CAPYBARA_DB__URL=postgres://capybara:capybara@$PG:5432/capybara"
  -e "CAPYBARA_REDIS__URL=redis://$VALKEY:6379"
  -e "CAPYBARA_MASTER_KEY=$MASTER_KEY"
)

echo "==> migrate and create the enterprise admin"
docker run --rm --network "$NET" "${ENV_ARGS[@]}" "$API_IMAGE" migrate >/dev/null
docker run --rm --network "$NET" "${ENV_ARGS[@]}" --entrypoint sh "$API_IMAGE" -c \
  'printf "%s\n" "web-image-test-password-123" > /tmp/pw && exec node /app/bin/capybara.mjs admin create --login root --display-name Root --if-none --password-file /tmp/pw' \
  >/dev/null

echo "==> start $API_IMAGE (trustProxy 1)"
docker run -d --name "$API" --network "$NET" "${ENV_ARGS[@]}" \
  -e CAPYBARA_HTTP__TRUST_PROXY=1 "$API_IMAGE" >/dev/null
STARTED+=("$API")
ok=""
for _ in $(seq 1 60); do
  status="$(docker exec "$API" node -e \
    'fetch("http://127.0.0.1:8080/readyz").then((r) => console.log(r.status), () => console.log(0))' \
    2>/dev/null || echo 0)"
  if [ "$status" = "200" ]; then ok=1; break; fi
  sleep 1
done
[ -n "$ok" ] || fail "api /readyz never returned 200"

echo "==> start $WEB_IMAGE"
docker run -d --name "$WEB" --network "$NET" -e "CAPYBARA_KERNEL_URL=http://$API:8080" "$WEB_IMAGE" >/dev/null
STARTED+=("$WEB")
# A client on the same network (the web image has node; its entrypoint is not used here).
docker run -d --name "$CLIENT" --network "$NET" --entrypoint sleep "$WEB_IMAGE" infinity >/dev/null
STARTED+=("$CLIENT")
ip_of() { docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$1"; }
CLIENT_IP="$(ip_of "$CLIENT")"
WEB_IP="$(ip_of "$WEB")"
echo "    client $CLIENT_IP, web $WEB_IP"

# request METHOD PATH [JSON_BODY]: prints "<status> <body>" of a request from the client container
# to $TARGET (default: the web container), always with forged forwarding headers.
request() {
  docker exec -e "M=$1" -e "P=$2" -e "B=${3:-}" -e "U=http://${TARGET:-$WEB}:3000" -e "F=$FORGED_IP" \
    "$CLIENT" node -e '
const headers = { "x-forwarded-for": process.env.F, "x-real-ip": process.env.F,
  forwarded: `for=${process.env.F}`, "x-capybara-peer-token": "forged" };
const init = { method: process.env.M, headers, redirect: "manual" };
if (process.env.B) {
  Object.assign(headers, { "content-type": "application/json", "x-capybara-csrf": "1" });
  init.body = process.env.B;
}
fetch(process.env.U + process.env.P, init).then(
  async (r) => console.log(r.status, (await r.text()).slice(0, 200).replace(/\s+/g, " ")),
  (e) => console.log(0, String(e)),
);'
}

# wait_web NAME: waits until NAME answers GET /zh/login with 200.
wait_web() {
  local ok="" out=""
  for _ in $(seq 1 60); do
    out="$(TARGET="$1" request GET /zh/login 2>/dev/null || echo 0)"
    if [ "${out%% *}" = "200" ]; then ok=1; break; fi
    sleep 1
  done
  [ -n "$ok" ] || fail "GET /zh/login on $1 never returned 200 (last: $out)"
}
wait_web "$WEB"
echo "    GET /zh/login 200"
# next.config.mjs is loaded at runtime (it sets poweredByHeader: false).
POWERED="$(docker exec -e "U=http://$WEB:3000/zh/login" "$CLIENT" node -e \
  'fetch(process.env.U).then((r) => console.log(r.headers.get("x-powered-by") ?? "none"))')"
[ "$POWERED" = "none" ] || fail "x-powered-by is set ($POWERED): next.config.mjs was not applied"

echo "==> /api proxy"
out="$(request GET /api/v1/setup)"
[ "${out%% *}" = "200" ] || fail "GET /api/v1/setup through web: $out"
echo "$out" | grep -q '"needsSetup":false' || fail "unexpected setup status: $out"
out="$(request POST /api/v1/auth/login '{"login":"root","password":"web-image-test-password-123"}')"
[ "${out%% *}" = "200" ] || fail "admin login through web: $out"
echo "    setup status and admin login proxied"

echo "==> forged x-forwarded-for: $LOGIN_IP_LIMIT bad logins, then rate limited"
BAD='{"login":"victim","password":"wrong-password"}'
i=1
while [ "$i" -le "$LOGIN_IP_LIMIT" ]; do
  out="$(request POST /api/v1/auth/login "$BAD")"
  [ "${out%% *}" = "401" ] || fail "bad login $i: expected 401, got $out"
  i=$((i + 1))
done
out="$(request POST /api/v1/auth/login "$BAD")"
[ "${out%% *}" = "429" ] || fail "login $i: expected 429, got $out"
echo "$out" | grep -q "auth.rate_limited" || fail "login $i: expected auth.rate_limited, got $out"
echo "    login $i: 429 auth.rate_limited"

# The kernel keys its per-IP counter by the client address it resolved (capk:login-fail:ip:<ip>).
# This shows the kernel resolved the client and ignored the forged address; the echo upstream
# below checks the raw header web forwards.
vk() { docker exec "$VALKEY" valkey-cli "$@"; }
KEYS="$(vk --scan --pattern 'capk:login-fail:ip:*')"
echo "    kernel per-IP counters: $(echo $KEYS)"
[ "$(vk GET "capk:login-fail:ip:$CLIENT_IP")" = "$LOGIN_IP_LIMIT" ] \
  || fail "the kernel did not count the failures against the client address $CLIENT_IP"
[ -z "$(vk --scan --pattern "capk:login-fail:ip:$FORGED_IP")" ] \
  || fail "the kernel counted the failures against the forged address $FORGED_IP"
[ -z "$(vk --scan --pattern "capk:login-fail:ip:$WEB_IP")" ] \
  || fail "the kernel saw the web container ($WEB_IP), not the client"
[ "$(echo "$KEYS" | grep -c .)" = "1" ] || fail "expected exactly one per-IP counter, got: $KEYS"

echo "==> forwarded headers, seen by an echo upstream"
# The client container doubles as the upstream: it echoes the request headers as JSON.
docker exec -d "$CLIENT" node -e \
  'require("node:http").createServer((q, s) => s.end(JSON.stringify(q.headers))).listen(8081)'
docker run -d --name "$WEB_ECHO" --network "$NET" -e "CAPYBARA_KERNEL_URL=http://$CLIENT:8081" \
  "$WEB_IMAGE" >/dev/null
STARTED+=("$WEB_ECHO")
# The client acts as a TLS proxy that web trusts: its x-forwarded-for (the forged value) is used.
docker run -d --name "$WEB_TRUST" --network "$NET" -e "CAPYBARA_KERNEL_URL=http://$CLIENT:8081" \
  -e "CAPYBARA_WEB_TRUST_PROXY=$CLIENT_IP/32" "$WEB_IMAGE" >/dev/null
STARTED+=("$WEB_TRUST")
wait_web "$WEB_ECHO"
wait_web "$WEB_TRUST"
# echoed_header WEB HEADER: the HEADER value the upstream received through WEB ("none" if absent).
echoed_header() {
  docker exec -e "U=http://$1:3000/api/echo" -e "H=$2" -e "F=$FORGED_IP" "$CLIENT" node -e '
const F = process.env.F;
fetch(process.env.U, { headers: { "x-forwarded-for": F, "x-real-ip": F, forwarded: `for=${F}`,
  "x-capybara-peer-token": "forged" } })
  .then(async (r) => {
    if (r.status !== 200) throw new Error(`status ${r.status}`);
    console.log((await r.json())[process.env.H] ?? "none");
  })
  .catch((e) => { console.error(String(e)); process.exit(1); });' || fail "GET /api/echo through $1 failed"
}
XFF="$(echoed_header "$WEB_ECHO" x-forwarded-for)"
[ "$XFF" = "$CLIENT_IP" ] || fail "web forwarded x-forwarded-for \"$XFF\", expected exactly $CLIENT_IP"
for h in x-real-ip forwarded x-capybara-peer-token; do
  [ "$(echoed_header "$WEB_ECHO" "$h")" = "none" ] || fail "web forwarded $h"
done
echo "    x-forwarded-for replaced with $CLIENT_IP; x-real-ip, forwarded and the peer token dropped"
XFF="$(echoed_header "$WEB_TRUST" x-forwarded-for)"
[ "$XFF" = "$FORGED_IP" ] \
  || fail "with CAPYBARA_WEB_TRUST_PROXY web forwarded \"$XFF\", expected the proxy's $FORGED_IP"
echo "    CAPYBARA_WEB_TRUST_PROXY=$CLIENT_IP/32: forwarded the trusted proxy's client $FORGED_IP"

echo "==> waiting for the image HEALTHCHECK"
health=""
for _ in $(seq 1 60); do
  health="$(docker inspect -f '{{.State.Health.Status}}' "$WEB")"
  [ "$health" = "healthy" ] && break
  sleep 1
done
[ "$health" = "healthy" ] || fail "$WEB health is $health"

echo "==> stop gracefully"
docker stop -t 10 "$WEB" >/dev/null
code="$(docker inspect -f '{{.State.ExitCode}}' "$WEB")"
[ "$code" = "0" ] || fail "$WEB exited with $code after SIGTERM"

echo "PASS: web image"
