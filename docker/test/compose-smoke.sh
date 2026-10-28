#!/usr/bin/env bash
# Smoke test for docker/compose.yaml, run from scratch with locally built images:
#   1. first `up` without an admin password file: init migrates and bootstraps (downloads the two
#      plugins bootstrap.json pins from npm and installs them, once) but creates no admin (web setup hint), the
#      setup wizard is open and requires CAPYBARA_SETUP_TOKEN (refused without it, works with
#      it), every service becomes healthy, two worker replicas (--scale worker=2);
#   2. `up` again with the password file: init creates the enterprise admin (bootstrap is already
#      done and does nothing); log in through web;
#   3. install model-fake from a local tgz with `compose run api extensions install`, enable it, and
#      without restarting anything both workers load it and a conversation turn completes;
#   4. a third `up`: init exits 0 again, bootstrap still ran only once, and there is still exactly
#      one enterprise admin;
#   5. object storage on the web origin (the bootstrap plugin object-store-s3): an attachment's
#      presigned upload and download go through web's proxy (the client uses another Host than the
#      signed one, like behind a front proxy);
#   6. networks: web reaches only api and the S3 gateway; the sandbox profile's sandbox-proxy publishes no port and
#      only worker reaches it;
#   7. PostgreSQL 14 on fresh volumes: init fails with a clear error and api never starts.
# (`pnpm check` keeps the inline haproxy config in sync with docker/sandbox-proxy/haproxy.cfg.)
# Written for bash 3.2 (macOS) too. Needs Docker (Compose v2.23+), node and curl on the host, and
# pnpm with dependencies installed unless MODEL_FAKE_TGZ is given; init needs the npm registry.
#
# Usage: docker/test/compose-smoke.sh
#   SKIP_BUILD=1              reuse existing capybara-{api,worker,gateway,web}:test images
#   MODEL_FAKE_TGZ=<path>     use this model-fake package (e.g. from the pack-plugins CI job)
#                             instead of packing it with pnpm
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# Versions the bootstrap manifest pins (init installs exactly these).
pin() { node -p "require(process.argv[1]).plugins.find((p) => p.name === process.argv[2]).version" "$ROOT/packages/kernel/bootstrap.json" "$1"; }
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

hex() { head -c "$1" /dev/urandom | od -An -tx1 | tr -d ' \n'; }
SETUP_TOKEN="$(hex 16)"
# A free host port for web: the public URL (and so the presigned URLs) must name it.
WEB_PORT="$(node -e 'const s = require("node:net").createServer().listen(0, "127.0.0.1", () => {
  console.log(s.address().port); s.close(); });')"
# Local images: no registry prefix, tag "test" (the tags docker/test/{kernel,web}-image.sh use).
cat >"$ENV_FILE" <<EOF
CAPYBARA_IMAGE_PREFIX=
CAPYBARA_VERSION=test
CAPYBARA_WEB_PORT=$WEB_PORT
CAPYBARA_PUBLIC_URL=http://localhost:$WEB_PORT
POSTGRES_PASSWORD=$(head -c 18 /dev/urandom | base64 | tr -d '/+=')
CAPYBARA_MASTER_KEY=$(head -c 32 /dev/urandom | base64)
CAPYBARA_S3_ACCESS_KEY=$(hex 12)
CAPYBARA_S3_SECRET_KEY=$(hex 24)
CAPYBARA_INIT_ADMIN_LOGIN=$ADMIN
CAPYBARA_INIT_ADMIN_NAME=Root
CAPYBARA_SETUP_TOKEN=$SETUP_TOKEN
CAPYBARA_OFFICIAL_MARKETPLACE=false
EOF
printf '%s\n' "$PW" >"$PW_FILE"
printf 'services:\n  postgres:\n    image: postgres:14\n' >"$TMP/pg14.yaml"

echo "==> compose config: published ports and networks"
dc --profile sandbox config --format json >"$TMP/config.json"
# No service but web publishes a port (sandbox profile included).
PUBLISHED="$(node -e '
const cfg = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
for (const [n, s] of Object.entries(cfg.services)) if ((s.ports ?? []).length > 0) console.log(n);
' "$TMP/config.json")"
[ "$PUBLISHED" = "web" ] || fail "services publishing ports: $(echo $PUBLISHED) (expected only web)"
# frontend holds exactly web and api, objectstore exactly web and the S3 gateway; web is on
# nothing else.
NETS="$(node -e '
const cfg = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
const nets = (s) => Object.keys(s.networks ?? { default: null }).sort();
const on = (net) => Object.entries(cfg.services).filter(([, s]) => nets(s).includes(net)).map(([n]) => n).sort().join(" ");
console.log(`${on("frontend")} | ${on("objectstore")} | ${nets(cfg.services.web).join(",")}`);
' "$TMP/config.json")"
[ "$NETS" = "api web | seaweedfs-s3 web | frontend,objectstore" ] || fail "networks: $NETS"

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
# init_log_has TEXT: init's log contains TEXT. Read into a variable first: with pipefail, `dc logs |
# grep -q` fails when grep exits on an early match and dc logs gets SIGPIPE.
init_log_has() {
  local log
  log="$(dc logs --no-color init)"
  grep -qF -- "$1" <<<"$log"
}
# bootstrap_once: the bootstrap step completed exactly once, with two required bootstrap installs.
bootstrap_once() {
  [ "$(psql_q "SELECT count(*) FROM capybara.bootstrap_runs")" = "1" ] \
    || fail "expected one bootstrap run, got $(psql_q "SELECT count(*) FROM capybara.bootstrap_runs")"
  [ "$(psql_q "SELECT count(*) FROM capybara.audit_events WHERE action = 'bootstrap.completed'")" = "1" ] \
    || fail "expected one bootstrap.completed audit"
  [ "$(psql_q "SELECT string_agg(name, ',' ORDER BY name) FROM capybara.extension_installs WHERE source = 'bootstrap' AND required AND desired_state = 'enabled'")" = "object-store-s3,openai-compatible" ] \
    || fail "the bootstrap plugins are not installed as required and enabled"
}

echo "==> first up, no admin password file (init migrates and bootstraps)"
dc up -d --scale worker=2
wait_healthy postgres valkey seaweedfs api worker gateway web
[ "$(init_exit)" = "0" ] || fail "init exited with $(init_exit)"
init_log_has "web setup page" || fail "init did not print the web setup hint"
init_log_has "object-store-s3 $(pin object-store-s3): installed" || fail "init did not bootstrap object-store-s3"
init_log_has "Bootstrap done" || fail "init did not finish the bootstrap step"
# "Ran once" is the DB count (bootstrap_once), not the log: init's log accumulates across restarts
bootstrap_once
echo "    init bootstrapped openai-compatible and object-store-s3 (required, enabled)"
[ "$(dc ps -q worker | grep -c .)" = "2" ] || fail "expected two worker containers"
[ "$(admin_count)" = "0" ] || fail "an enterprise admin exists without a password file"

# 127.0.0.1, not the public URL's "localhost": the Host web sees differs from the signed one.
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
# The setup page requires CAPYBARA_SETUP_TOKEN (compose passes it to api): without it, or with a
# wrong one, setup is refused; with it, setup succeeds.
SETUP_BODY='"login":"webadmin","password":"web-setup-password-123","displayName":"Web Admin"'
out="$(api POST /api/v1/setup "{$SETUP_BODY}")"
[ "${out%% *}" = "403" ] && echo "$out" | grep -q 'setup.token_invalid' \
  || fail "setup without the token was not refused: $out"
out="$(api POST /api/v1/setup "{$SETUP_BODY,\"setupToken\":\"wrong\"}")"
[ "${out%% *}" = "403" ] || fail "setup with a wrong token was not refused: $out"
out="$(api POST /api/v1/setup "{$SETUP_BODY,\"setupToken\":\"$SETUP_TOKEN\"}")"
[ "${out%% *}" = "201" ] || fail "setup with the token: $out"
[ "$(admin_count)" = "1" ] || fail "setup with the token did not create the admin"
echo "    setup page: refused without the token (403), created the admin with it (201)"
# Reopen setup for the password-file step below: demote the web-created admin (test-only shortcut).
psql_q "UPDATE capybara.accounts SET is_enterprise_admin = false WHERE display_name = 'Web Admin'" >/dev/null
[ "$(admin_count)" = "0" ] || fail "could not demote the web-created admin"

echo "==> up with the password file: init creates the enterprise admin"
echo "CAPYBARA_INIT_ADMIN_PASSWORD_FILE=$PW_FILE" >>"$ENV_FILE"
# Compose doesn't recreate a container when only a secret's source file changes (documented in
# .env.example): recreate init, then a plain `up` (which runs init once more and skips).
dc up -d --force-recreate --no-deps init
dc up -d --scale worker=2
wait_healthy api worker gateway web
[ "$(init_exit)" = "0" ] || fail "init exited with $(init_exit)"
init_log_has "enterprise admin created" || fail "init did not create the admin"
# init was recreated above, so this log is the new container's run only
init_log_has "Bootstrap already done" || fail "init did not skip the bootstrap step"
bootstrap_once
[ "$(admin_count)" = "1" ] || fail "expected one enterprise admin, got $(admin_count)"
out="$(api POST /api/v1/auth/login "{\"login\":\"$ADMIN\",\"password\":\"$PW\"}")"
[ "${out%% *}" = "200" ] || fail "admin login through web: $out"
echo "    admin login through web: 200"

echo "==> install model-fake from a local tgz, approve and enable it, no restarts"
mkdir -p "$TMP/pkg"
if [ -n "${MODEL_FAKE_TGZ:-}" ]; then
  [ -f "$MODEL_FAKE_TGZ" ] || fail "MODEL_FAKE_TGZ=$MODEL_FAKE_TGZ does not exist"
  cp "$MODEL_FAKE_TGZ" "$TMP/pkg/model-fake.tgz"
else
  (cd "$ROOT" && INIT_CWD="$ROOT" pnpm -s pack-plugin plugins/model-fake --out "$TMP/pkg") >/dev/null
fi
TGZ="$(cd "$TMP/pkg" && ls ./*.tgz | head -1)"
[ -n "$TGZ" ] || fail "no model-fake tgz"
chmod a+r "$TMP/pkg/$TGZ"
WORKERS_BEFORE="$(dc ps -q worker | sort | tr '\n' ' ')"
dc run --rm --no-deps -T -v "$TMP/pkg:/pkg:ro" api extensions install "/pkg/${TGZ#./}" --yes
dc run --rm --no-deps -T api extensions approve model-fake --yes
dc run --rm --no-deps -T api extensions enable model-fake
[ "$(dc ps -q worker | sort | tr '\n' ' ')" = "$WORKERS_BEFORE" ] || fail "worker containers changed"
# Each worker replica reports its load result in extension_replica_status (replica id = <hostname>-...).
for id in $WORKERS_BEFORE; do
  host="$(docker inspect -f '{{.Config.Hostname}}' "$id")"
  ok=""
  for _ in $(seq 1 90); do
    st="$(psql_q "SELECT state FROM capybara.extension_replica_status WHERE plugin = 'model-fake' AND replica_id LIKE '$host-%' ORDER BY heartbeat_at DESC LIMIT 1")"
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

echo "==> object storage on the web origin: attachment upload, finalize, download through web"
CONTENT="compose smoke object $$"
out="$(api POST "$BASE/attachments" "{\"name\":\"smoke.txt\",\"contentType\":\"text/plain\",\"size\":${#CONTENT}}")"
[ "${out%% *}" = "201" ] || [ "${out%% *}" = "200" ] || fail "create attachment: $out"
ATT="$(json_get id)"
# As a browser: the presigned URL is on the public origin (http://localhost:<port>/capybara/...).
# Send it to 127.0.0.1 instead, as if a front proxy rewrote the Host: web signs nothing, it only
# forwards with the public host, so the signature still verifies.
node -e '
const u = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).upload;
const pub = new URL(u.url);
if (pub.origin !== process.argv[3]) { console.error(`presigned origin ${pub.origin}`); process.exit(1); }
const url = process.argv[2] + pub.pathname + pub.search;
const body = new Blob([process.argv[4]], { type: "text/plain" });
let init;
if (u.method === "POST") {
  const form = new FormData();
  for (const [k, v] of Object.entries(u.fields ?? {})) form.append(k, v);
  form.append("file", body, "smoke.txt");
  init = { method: "POST", headers: u.headers, body: form };
} else {
  init = { method: "PUT", headers: u.headers, body };
}
fetch(url, init).then(async (r) => {
  if (!r.ok) { console.error(r.status, await r.text()); process.exit(1); }
}, (e) => { console.error(String(e)); process.exit(1); });' "$TMP/body" "$WEB" "http://localhost:$WEB_PORT" "$CONTENT" \
  || fail "presigned upload through web failed"
out="$(api POST "$BASE/attachments/$ATT/finalize" '{}')"
[ "${out%% *}" = "200" ] || fail "finalize attachment: $out"
LOCATION="$(curl -sS -o /dev/null -w '%{redirect_url}' -b "$JAR" "$WEB$BASE/attachments/$ATT/download")"
case "$LOCATION" in
  "http://localhost:$WEB_PORT/capybara/"*) ;;
  *) fail "attachment download redirects to $LOCATION, not the web origin's /capybara/" ;;
esac
GOT="$(curl -sS -D "$TMP/dl-headers" --fail "$WEB${LOCATION#http://localhost:$WEB_PORT}")" \
  || fail "presigned download through web failed"
[ "$GOT" = "$CONTENT" ] || fail "downloaded \"$GOT\", expected \"$CONTENT\""
grep -qi '^x-content-type-options: nosniff' "$TMP/dl-headers" || fail "download lacks nosniff"
grep -qi '^content-security-policy: sandbox' "$TMP/dl-headers" || fail "download lacks CSP sandbox"
st="$(curl -sS -o /dev/null -w '%{http_code}' -X PUT --data x "$WEB/capybara/kernel/x")"
[ "$st" = "405" ] || fail "PUT through the object-store proxy: $st (expected 405)"
echo "    presigned upload and download through web (other Host than signed); PUT 405; nosniff, CSP"

echo "==> third up: init exits 0, still one enterprise admin"
dc up -d --scale worker=2
wait_healthy api worker gateway web
[ "$(init_exit)" = "0" ] || fail "init exited with $(init_exit) on the third up"
init_log_has "already exists; skipped" || fail "init did not skip the admin"
# The log holds every run of this container; that bootstrap did not run again is the DB count
bootstrap_once
[ "$(admin_count)" = "1" ] || fail "expected one enterprise admin after the third up, got $(admin_count)"

echo "==> networks: web reaches only api and the S3 gateway; sandbox-proxy on the internal network only"
dc --profile sandbox up -d --no-deps sandbox-proxy
PORT_OUT="$(dc --profile sandbox port sandbox-proxy 2375 2>/dev/null || true)"
echo "$PORT_OUT" | grep -q ':[0-9]' && fail "sandbox-proxy publishes 2375 at $PORT_OUT"
# tcp_probe SERVICE HOST PORT: "open" when SERVICE can open a TCP connection to HOST:PORT.
tcp_probe() {
  dc exec -T "$1" node -e '
const s = require("node:net").connect(Number(process.argv[2]), process.argv[1]);
const done = (r) => { console.log(r); s.destroy(); process.exit(0); };
s.once("connect", () => done("open")).once("error", () => done("closed"));
setTimeout(() => done("closed"), 5000);' "$2" "$3"
}
for target in postgres:5432 valkey:6379 seaweedfs:8888 seaweedfs:9333 seaweedfs:8080 \
  worker:8080 gateway:8080; do
  [ "$(tcp_probe web "${target%%:*}" "${target##*:}")" = "closed" ] || fail "web reaches $target"
done
[ "$(tcp_probe web api 8080)" = "open" ] || fail "web cannot reach api:8080"
[ "$(tcp_probe web seaweedfs-s3 8333)" = "open" ] || fail "web cannot reach seaweedfs-s3:8333"
# The S3 gateway's Iceberg (8181) and Lance (9101) servers are off (gRPC 18333 can't be disabled).
for p in 8181 9101; do
  [ "$(tcp_probe web seaweedfs-s3 "$p")" = "closed" ] || fail "web reaches seaweedfs-s3:$p"
done
echo "    web reaches api and seaweedfs-s3 only (not postgres, valkey, the filer, worker, gateway)"
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
