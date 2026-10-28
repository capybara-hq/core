#!/usr/bin/env bash
# Smoke test for docker/kernel.Dockerfile: builds the capybara-api / capybara-worker /
# capybara-gateway images, then against a throwaway PostgreSQL + Valkey network checks that
# `migrate`, `bootstrap` (the packages baked into /app/bootstrap, installed once; a re-run does
# nothing), `admin create --if-none --password-file`, `extensions list`, BullMQ and `start` work,
# that /readyz answers 200 for every role, and that the image holds no TypeScript sources or tsx.
# Written for bash 3.2 (macOS) too: empty arrays expand as ${a[@]+"${a[@]}"} under `set -u`.
#
# Usage: docker/test/kernel-image.sh            (from anywhere; needs Docker)
#   SKIP_BUILD=1       reuse existing capybara-<role>:test images
#   ROLES_TO_TEST="api" limit the roles (default: api worker gateway)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# Versions the bootstrap manifest pins (the image installs exactly these).
pin() { node -p "require(process.argv[1]).plugins.find((p) => p.name === process.argv[2]).version" "$ROOT/packages/kernel/bootstrap.json" "$1"; }
ROLES_TO_TEST="${ROLES_TO_TEST:-api worker gateway}"
ID="capybara-image-test-$$"
NET="$ID"
PG="$ID-pg"
VALKEY="$ID-valkey"
MASTER_KEY="$(head -c 32 /dev/urandom | base64)"
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
  for role in $ROLES_TO_TEST; do
    echo "==> building capybara-$role:test"
    docker build -f "$ROOT/docker/kernel.Dockerfile" --build-arg "ROLES=$role" \
      -t "capybara-$role:test" "$ROOT"
  done
fi

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
  # The official marketplace is on by default and on the internet: tests stay offline.
  -e "CAPYBARA_MARKETPLACES__OFFICIAL__ENABLED=false"
)
API_IMAGE="capybara-$(echo "$ROLES_TO_TEST" | awk '{print $1}'):test"
run() { docker run --rm --network "$NET" "${ENV_ARGS[@]}" "$@"; }

echo "==> image contents ($API_IMAGE)"
[ "$(docker run --rm --entrypoint id "$API_IMAGE" -u)" = "10001" ] || fail "image does not run as uid 10001"
# Emitted .d.ts files are not sources (P-8); everything else ending in .ts under our packages is.
TS_FILES="$(docker run --rm --entrypoint sh "$API_IMAGE" -c \
  'find / -xdev \( -path "*/kernel/*" -o -path "*/@capybara-hq/*" -o -path "/app/dist/*" -o -path "/app/bin/*" \) -name "*.ts" ! -name "*.d.ts" 2>/dev/null; true')"
[ -z "$TS_FILES" ] || fail "TypeScript sources in the image: $(echo "$TS_FILES" | head -5)"
TSX="$(docker run --rm --entrypoint sh "$API_IMAGE" -c 'find /app/node_modules -path "*/node_modules/tsx"')"
[ -z "$TSX" ] || fail "tsx is in the image: $TSX"
docker run --rm --entrypoint sh "$API_IMAGE" -c 'test ! -e /app/src' || fail "/app/src exists in the image"
docker run --rm --entrypoint sh "$API_IMAGE" -c '! command -v npm && ! command -v corepack' >/dev/null \
  || fail "npm or corepack is in the image"
[ -n "$(docker run --rm --entrypoint sh "$API_IMAGE" -c 'ls /app/node_modules/@capybara-hq/kernel/src/migrations/*.sql')" ] \
  || fail "kernel migrations missing from the image"

# <name>-<version>.tgz of every entry of the manifest the image was built from.
BOOTSTRAP_FILES="$(node -e '
const m = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
console.log(m.plugins.map((p) => `${p.name}-${p.version}.tgz`).sort().join("\n"));
' "$ROOT/packages/kernel/bootstrap.json")"
[ "$(docker run --rm --entrypoint sh "$API_IMAGE" -c 'ls /app/bootstrap')" = "$BOOTSTRAP_FILES" ] \
  || fail "the bootstrap packages are missing from /app/bootstrap"

echo "==> migrate"
run "$API_IMAGE" migrate

echo "==> bootstrap"
psql() { docker exec "$PG" psql -U capybara -tAc "$1"; }
OUT="$(run "$API_IMAGE" bootstrap)"
echo "$OUT"
echo "$OUT" | grep -q "openai-compatible $(pin openai-compatible): installed" || fail "bootstrap did not install openai-compatible"
echo "$OUT" | grep -q "object-store-s3 $(pin object-store-s3): installed" || fail "bootstrap did not install object-store-s3"
[ "$(psql "SELECT count(*) FROM capybara.extension_installs WHERE source = 'bootstrap' AND required AND desired_state = 'enabled'")" = "2" ] \
  || fail "expected two required, enabled bootstrap install records"
[ "$(psql "SELECT count(*) FROM capybara.bootstrap_runs")" = "1" ] || fail "expected one bootstrap run"
OUT="$(run "$API_IMAGE" bootstrap)"
echo "$OUT" | grep -q "Bootstrap already done" || fail "a second bootstrap did not skip: $OUT"
[ "$(psql "SELECT count(*) FROM capybara.bootstrap_runs")" = "1" ] || fail "the second bootstrap ran again"

echo "==> admin create --if-none --password-file"
admin_create() {
  docker run --rm --network "$NET" "${ENV_ARGS[@]}" --entrypoint sh "$API_IMAGE" -c \
    'printf "%s\n" "image-test-password-123" > /tmp/pw && exec node /app/bin/capybara.mjs admin create --login root --display-name Root --if-none --password-file /tmp/pw'
}
psql_count() {
  docker exec "$PG" psql -U capybara -tAc \
    "SELECT count(*) FROM capybara.accounts WHERE is_enterprise_admin AND status = 'active'"
}
OUT="$(admin_create 2>&1)"
echo "$OUT" | grep -q "enterprise admin created" || fail "first admin create did not create: $OUT"
[ "$(psql_count)" = "1" ] || fail "expected one enterprise admin after the first admin create"
OUT="$(admin_create)"
echo "$OUT" | grep -q "enterprise admin already exists; skipped" \
  || fail "second admin create --if-none did not skip: $OUT"
[ "$(psql_count)" = "1" ] || fail "the second admin create --if-none changed the admin count"

echo "==> BullMQ round trip"
docker run --rm --network "$NET" -e "REDIS_URL=redis://$VALKEY:6379" --entrypoint node "$API_IMAGE" -e '
const { createRequire } = require("node:module");
// The kernel package is a pnpm symlink; resolve from its real location like Node does.
const req = createRequire(require("node:fs").realpathSync("/app/node_modules/@capybara-hq/kernel/package.json"));
const { Queue, Worker } = req("bullmq");
const IORedis = req("ioredis");
const conn = () => new (IORedis.default ?? IORedis)(process.env.REDIS_URL, { maxRetriesPerRequest: null });
(async () => {
  const q = new Queue("image-smoke", { connection: conn() });
  const done = new Promise((resolve, reject) => {
    const w = new Worker("image-smoke", async (job) => job.data.n * 2, { connection: conn() });
    w.on("completed", (_job, result) => w.close().then(() => resolve(result)));
    w.on("failed", (_job, err) => reject(err));
  });
  await q.add("double", { n: 21 });
  const result = await Promise.race([done, new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 15000))]);
  await q.close();
  if (result !== 42) throw new Error(`unexpected result ${result}`);
  console.log("bullmq ok");
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
' || fail "BullMQ round trip failed"

echo "==> extensions list"
LIST="$(run "$API_IMAGE" extensions list)"
echo "$LIST"
[ "$(echo "$LIST" | grep -c "	bootstrap	required	")" -eq 2 ] || fail "expected two required bootstrap plugins"
echo "$LIST" | grep -q "^openai-compatible	$(pin openai-compatible)	bootstrap	" || fail "openai-compatible missing"
echo "$LIST" | grep -q "^object-store-s3	$(pin object-store-s3)	bootstrap	" || fail "object-store-s3 missing"

for role in $ROLES_TO_TEST; do
  name="$ID-$role"
  echo "==> start capybara-$role:test"
  [ "$(docker run --rm --entrypoint printenv "capybara-$role:test" CAPYBARA_ROLES)" = "$role" ] \
    || fail "capybara-$role:test has the wrong default CAPYBARA_ROLES"
  docker run -d --name "$name" --network "$NET" "${ENV_ARGS[@]}" "capybara-$role:test" >/dev/null
  STARTED+=("$name")
  ok=""
  for _ in $(seq 1 60); do
    status="$(docker exec "$name" node -e \
      'fetch("http://127.0.0.1:8080/readyz").then((r) => console.log(r.status), () => console.log(0))' \
      2>/dev/null || echo 0)"
    if [ "$status" = "200" ]; then ok=1; break; fi
    sleep 1
  done
  [ -n "$ok" ] || fail "capybara-$role:test /readyz never returned 200 (last: $status)"
  echo "    /readyz 200"
done

echo "==> waiting for the image HEALTHCHECK"
for name in ${STARTED[@]+"${STARTED[@]}"}; do
  health=""
  for _ in $(seq 1 60); do
    health="$(docker inspect -f '{{.State.Health.Status}}' "$name")"
    [ "$health" = "healthy" ] && break
    sleep 1
  done
  [ "$health" = "healthy" ] || fail "$name health is $health"
done

echo "==> stop gracefully"
for name in ${STARTED[@]+"${STARTED[@]}"}; do
  docker stop -t 30 "$name" >/dev/null
  code="$(docker inspect -f '{{.State.ExitCode}}' "$name")"
  [ "$code" = "0" ] || fail "$name exited with $code after SIGTERM"
done

echo "PASS: kernel images ($ROLES_TO_TEST)"
