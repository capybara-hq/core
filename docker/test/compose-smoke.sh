#!/usr/bin/env bash
# Smoke test for docker/compose.yaml, run from scratch with locally built images:
#   1. first `up` without an admin password file: init only migrates (web setup hint), the
#      setup wizard is open, every service becomes healthy, two worker replicas (--scale worker=2);
#   2. `up` again with the password file: init creates the enterprise admin; log in through web;
#   3. install model-fake from a local tgz with `compose run api plugins install`, enable it, and
#      without restarting anything both workers load it and a conversation turn completes;
#   4. a third `up`: init exits 0 again and there is still exactly one enterprise admin;
#   5. the sandbox profile: sandbox-proxy publishes no port, only the worker network reaches it, and
#      its inline haproxy config matches docker/sandbox-proxy/haproxy.cfg;
#   6. PostgreSQL 14 on fresh volumes: init fails with a clear error and api never starts.
# Written for bash 3.2 (macOS) too. Needs Docker (Compose v2.23+), pnpm (dependencies installed,
# for packing model-fake), node and curl on the host.
#
# Usage: docker/test/compose-smoke.sh
#   SKIP_BUILD=1   reuse existing capybara-{api,worker,gateway,web}:test images
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
COMPOSE="$ROOT/docker/compose.yaml"
COMPOSE_BUILD="$ROOT/docker/compose.build.yaml"
PROJECT="capybara-smoke-$$"
PROJECT14="$PROJECT-pg14"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/capybara-compose-smoke.XXXXXX")"
ENV_FILE="$TMP/.env"
PW_FILE="$TMP/admin_password"
PW="compose-smoke-password-123"
ADMIN="root"

dc() { docker compose -p "$PROJECT" --env-file "$ENV_FILE" -f "$COMPOSE" "$@"; }
dc14() { docker compose -p "$PROJECT14" --env-file "$ENV_FILE" -f "$COMPOSE" -f "$TMP/pg14.yaml" "$@"; }

cleanup() {
  local code=$?
  if [ "$code" -ne 0 ]; then
    echo "---- compose ps ----" >&2
    dc ps -a >&2 2>/dev/null || true
    echo "---- compose logs (tail) ----" >&2
    dc --profile sandbox logs --no-color --tail 40 >&2 2>/dev/null || true
    dc14 logs --no-color --tail 20 init >&2 2>/dev/null || true
  fi
  dc --profile sandbox down -v --remove-orphans >/dev/null 2>&1 || true
  dc14 down -v --remove-orphans >/dev/null 2>&1 || true
  rm -rf "$TMP"
  exit "$code"
}
trap cleanup EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

[ -f "$COMPOSE" ] || fail "missing $COMPOSE"

# Local images: no registry prefix, tag "test" (the tags docker/test/{kernel,web}-image.sh use).
cat >"$ENV_FILE" <<EOF
CAPYBARA_IMAGE_PREFIX=
CAPYBARA_VERSION=test
CAPYBARA_WEB_PORT=0
POSTGRES_PASSWORD=$(head -c 18 /dev/urandom | base64 | tr -d '/+=')
CAPYBARA_MASTER_KEY=$(head -c 32 /dev/urandom | base64)
CAPYBARA_S3_ACCESS_KEY=smoke-access
CAPYBARA_S3_SECRET_KEY=$(head -c 18 /dev/urandom | base64 | tr -d '/+=')
CAPYBARA_INIT_ADMIN_LOGIN=$ADMIN
CAPYBARA_INIT_ADMIN_NAME=Root
EOF
printf '%s\n' "$PW" >"$PW_FILE"
printf 'services:\n  postgres:\n    image: postgres:14\n' >"$TMP/pg14.yaml"

echo "==> haproxy config inlined in compose.yaml matches docker/sandbox-proxy/haproxy.cfg"
# Compare without comments and blank lines (the inline copy drops the file's comments).
dc --profile sandbox config --format json >"$TMP/config.json"
node -e '
const fs = require("node:fs");
const strip = (s) => s.split("\n").map((l) => l.replace(/\s+$/, "")).filter((l) => l.trim() !== "" && !l.trim().startsWith("#")).join("\n");
const cfg = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
// `compose config` prints a literal "$" in content as "$$".
const inline = cfg.configs?.["sandbox-proxy-haproxy"]?.content?.replaceAll("$$", () => "$");
if (typeof inline !== "string") { console.error("configs.sandbox-proxy-haproxy.content missing"); process.exit(1); }
if (strip(inline) !== strip(fs.readFileSync(process.argv[2], "utf8"))) {
  console.error("the inline haproxy config differs from docker/sandbox-proxy/haproxy.cfg"); process.exit(1);
}' "$TMP/config.json" "$ROOT/docker/sandbox-proxy/haproxy.cfg" || fail "haproxy config drift"
# No service but web publishes a port (sandbox profile included).
PUBLISHED="$(node -e '
const cfg = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
for (const [n, s] of Object.entries(cfg.services)) if ((s.ports ?? []).length > 0) console.log(n);
' "$TMP/config.json")"
[ "$PUBLISHED" = "web" ] || fail "services publishing ports: $(echo $PUBLISHED) (expected only web)"

if [ "${SKIP_BUILD:-}" != "1" ]; then
  echo "==> building the images (compose.build.yaml)"
  dc -f "$COMPOSE_BUILD" build api worker gateway web
fi

# wait_healthy SERVICE...: waits until every container of each SERVICE is healthy.
wait_healthy() {
  local svc ids id st ok
  for svc in "$@"; do
    ok=""
    for _ in $(seq 1 120); do
      ids="$(dc ps -q "$svc")"
      ok=1
      [ -n "$ids" ] || ok=""
      for id in $ids; do
        st="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$id")"
        [ "$st" = "healthy" ] || ok=""
      done
      [ -n "$ok" ] && break
      sleep 1
    done
    [ -n "$ok" ] || fail "$svc did not become healthy"
  done
}

psql_q() { dc exec -T postgres psql -U capybara -d capybara -tAc "$1" | tr -d '[:space:]'; }
admin_count() {
  psql_q "SELECT count(*) FROM capybara.accounts WHERE is_enterprise_admin AND status = 'active'"
}
init_exit() { docker inspect -f '{{.State.ExitCode}}' "$(dc ps -a -q init)"; }

echo "==> first up, no admin password file (init only migrates)"
dc up -d --scale worker=2
wait_healthy postgres valkey seaweedfs api worker gateway web
[ "$(init_exit)" = "0" ] || fail "init exited with $(init_exit)"
dc logs --no-color init | grep -q "web setup page" || fail "init did not print the web setup hint"
[ "$(dc ps -q worker | grep -c .)" = "2" ] || fail "expected two worker containers"
[ "$(admin_count)" = "0" ] || fail "an enterprise admin exists without a password file"

WEB_PORT="$(dc port web 3000 | sed 's/.*://')"
WEB="http://127.0.0.1:$WEB_PORT"
JAR="$TMP/cookies"
echo "    web on $WEB"
# api METHOD PATH [JSON]: prints "<status> <body>" of a request through web (cookie jar, CSRF header).
api() {
  local out
  out="$(curl -sS -o "$TMP/body" -w '%{http_code}' -X "$1" -b "$JAR" -c "$JAR" \
    -H 'content-type: application/json' -H 'x-capybara-csrf: 1' \
    ${3:+--data "$3"} "$WEB$2")" || out=0
  echo "$out $(cat "$TMP/body" 2>/dev/null)"
}
# json_get FIELD_PATH: reads a dotted path from the JSON body of the last api call.
json_get() {
  node -e 'let v = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
for (const k of process.argv[2].split(".")) v = v?.[k];
if (v === undefined) process.exit(1); console.log(v);' "$TMP/body" "$1"
}
out="$(api GET /api/v1/setup)"
[ "${out%% *}" = "200" ] || fail "GET /api/v1/setup: $out"
echo "$out" | grep -q '"needsSetup":true' || fail "the setup wizard is not open: $out"

echo "==> up with the password file: init creates the enterprise admin"
echo "CAPYBARA_INIT_ADMIN_PASSWORD_FILE=$PW_FILE" >>"$ENV_FILE"
# Compose doesn't recreate a container when only a secret's source file changes (documented in
# .env.example): recreate init, then a plain `up` (which runs init once more and skips).
dc up -d --force-recreate --no-deps init
dc up -d --scale worker=2
wait_healthy api worker gateway web
[ "$(init_exit)" = "0" ] || fail "init exited with $(init_exit)"
dc logs --no-color init | grep -q "enterprise admin created" || fail "init did not create the admin"
[ "$(admin_count)" = "1" ] || fail "expected one enterprise admin, got $(admin_count)"
out="$(api POST /api/v1/auth/login "{\"login\":\"$ADMIN\",\"password\":\"$PW\"}")"
[ "${out%% *}" = "200" ] || fail "admin login through web: $out"
echo "    admin login through web: 200"

echo "==> install model-fake from a local tgz, approve and enable it, no restarts"
(cd "$ROOT" && INIT_CWD="$ROOT" pnpm -s pack-plugin plugins/model-fake --out "$TMP/pkg") >/dev/null
TGZ="$(cd "$TMP/pkg" && ls ./*.tgz | head -1)"
[ -n "$TGZ" ] || fail "pack-plugin produced no tgz"
chmod a+r "$TMP/pkg/$TGZ"
WORKERS_BEFORE="$(dc ps -q worker | sort | tr '\n' ' ')"
dc run --rm --no-deps -T -v "$TMP/pkg:/pkg:ro" api plugins install "/pkg/${TGZ#./}" --yes
dc run --rm --no-deps -T api plugins approve model-fake --yes
dc run --rm --no-deps -T api plugins enable model-fake
[ "$(dc ps -q worker | sort | tr '\n' ' ')" = "$WORKERS_BEFORE" ] || fail "worker containers changed"
# Each worker replica reports its load result in plugin_replica_status (replica id = <hostname>-...).
for id in $WORKERS_BEFORE; do
  host="$(docker inspect -f '{{.Config.Hostname}}' "$id")"
  ok=""
  for _ in $(seq 1 90); do
    st="$(psql_q "SELECT state FROM capybara.plugin_replica_status WHERE plugin = 'model-fake' AND replica_id LIKE '$host-%' ORDER BY heartbeat_at DESC LIMIT 1")"
    [ "$st" = "loaded" ] && ok=1 && break
    sleep 1
  done
  [ -n "$ok" ] || fail "worker $host did not load model-fake (state: ${st:-none})"
  echo "    worker $host: model-fake loaded"
done

echo "==> one conversation turn through web"
out="$(api POST /api/v1/orgs '{"name":"Smoke"}')"
[ "${out%% *}" = "201" ] || fail "create org: $out"
ORG="$(json_get org.id)"
BASE="/api/v1/orgs/$ORG"
out="$(api POST "$BASE/agents" '{"definition":{"name":"Echo","instructions":"Echo.","model":{"provider":"model-fake","model":"fake-1"}},"visibility":"private"}')"
[ "${out%% *}" = "201" ] || fail "create agent: $out"
AGENT="$(json_get agent.id)"
# Several conversations so both worker replicas are likely to run a turn.
for n in 1 2 3 4; do
  out="$(api POST "$BASE/conversations" "{\"agentId\":\"$AGENT\"}")"
  [ "${out%% *}" = "201" ] || fail "create conversation: $out"
  CONV="$(json_get conversation.id)"
  out="$(api POST "$BASE/conversations/$CONV/messages" "{\"text\":\"echo:hello compose $n\"}")"
  [ "${out%% *}" = "202" ] || fail "send message: $out"
  ok=""
  for _ in $(seq 1 60); do
    out="$(api GET "$BASE/conversations/$CONV/events?after=0")"
    if echo "$out" | grep -q '"run_finished"'; then ok=1; break; fi
    if echo "$out" | grep -q '"run_failed"'; then fail "turn $n failed: $out"; fi
    sleep 1
  done
  [ -n "$ok" ] || fail "turn $n did not finish: $out"
  echo "$out" | grep -q '"assistant_message"' || fail "turn $n: no assistant message: $out"
  echo "$out" | grep -q "hello compose $n" || fail "turn $n: the reply is not the echo: $out"
done
echo "    4 turns finished with the echoed reply"

echo "==> third up: init exits 0, still one enterprise admin"
dc up -d --scale worker=2
wait_healthy api worker gateway web
[ "$(init_exit)" = "0" ] || fail "init exited with $(init_exit) on the third up"
dc logs --no-color init | grep -q "already exists; skipped" || fail "init did not skip the admin"
[ "$(admin_count)" = "1" ] || fail "expected one enterprise admin after the third up, got $(admin_count)"

echo "==> sandbox profile: sandbox-proxy on the internal network only"
dc --profile sandbox up -d --no-deps sandbox-proxy
PORT_OUT="$(dc --profile sandbox port sandbox-proxy 2375 2>/dev/null || true)"
echo "$PORT_OUT" | grep -q ':[0-9]' && fail "sandbox-proxy publishes 2375 at $PORT_OUT"
# probe SERVICE PATH: status of GET http://sandbox-proxy:2375PATH from SERVICE (0 = unreachable).
probe() {
  dc exec -T "$1" node -e '
fetch("http://sandbox-proxy:2375" + process.argv[1], { signal: AbortSignal.timeout(5000) })
  .then((r) => console.log(r.status), () => console.log(0));' "$2"
}
st=""
for _ in $(seq 1 30); do
  st="$(probe worker /_ping)"
  [ "$st" = "200" ] && break
  sleep 1
done
[ "$st" = "200" ] || fail "worker -> sandbox-proxy /_ping: $st"
[ "$(probe worker /containers/json)" = "403" ] || fail "sandbox-proxy allowed /containers/json"
[ "$(probe api /_ping)" = "0" ] || fail "api reaches sandbox-proxy (it is not on the sandbox network)"
[ "$(probe web /_ping)" = "0" ] || fail "web reaches sandbox-proxy"
echo "    no published port; worker gets /_ping 200 and /containers/json 403; api and web can't reach it"

echo "==> PostgreSQL 14 on fresh volumes: init fails, api does not start"
if dc14 up -d >"$TMP/pg14.log" 2>&1; then
  fail "compose up succeeded on PostgreSQL 14"
fi
dc14 logs --no-color init | grep -q "PostgreSQL 15 or newer is required (found 14" \
  || fail "init did not report the PostgreSQL version"
[ "$(docker inspect -f '{{.State.ExitCode}}' "$(dc14 ps -a -q init)")" != "0" ] || fail "init exited 0"
if dc14 ps --status running --services | grep -qx api; then fail "api is running on PostgreSQL 14"; fi
echo "    init: PostgreSQL 15 or newer is required; api not running"

echo "PASS: compose smoke"
