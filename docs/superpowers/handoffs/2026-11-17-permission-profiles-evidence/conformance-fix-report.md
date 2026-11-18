# Permission conformance fix report

Worktree: `/Users/grant/Capybara/core/.claude/worktrees/fix-permission-conformance-endpoints`
Branch: `fix/permission-conformance-endpoints` (from origin/main `fa0bb3c5e`). Local only, no push, no PR.

## Commits

- `38dba683d` fix(testing): split permission endpoints into name and address
- `7c913838a` docs(sdk): record the launcher's /proc cmdline limitation

## 1. Endpoint name / address split

`packages/testing/src/sandbox-permission-conformance.ts`

- `SandboxPermissionEndpoint` is now `{ name, address, port, receipts }`. `name` is what the scope
  allowlists (the suite checks it with `validateAllowHost` up front and fails fast with
  "granted endpoint name X is not a valid allowlist host"); `address` must be an IP literal, the
  granted one IPv4 (race program).
- `fixture.endpoints.access: "direct" | "proxy"`:
  - `direct`: positives as before (Python, curl, Node) against `address`; granted receipts +3.
  - `proxy`: positives are curl and Python `urllib` to `http://name:port/` through the
    operation's `http_proxy`; granted receipts +2. Ungranted endpoints must fail both a raw
    connect and a by-name request through the proxy. The pointer race uses the proxy from the
    environment as its allowed target (asserts `ok>0`, ungranted receipts unchanged).
  - Both: network `none` refuses a raw connect and a by-name request to the granted endpoint;
    Full control still connects to an ungranted address.
- Core Docker fixture (`test/fixtures/linux-permission/docker.ts`, `listen.py`): names
  `*.permission.test`; `operation()` refuses invalid allowlist hosts like a conforming provider;
  a root-run HTTP forward proxy (127.0.0.1:18090, forwards only the granted name, 403 otherwise);
  `Agent` takes `access: "proxy"` (launcher endpoint = the proxy, `http_proxy`/`HTTP_PROXY` set for
  restricted allowlist operations). New test: full conformance with allowlist traffic through the
  proxy. The mechanism tests' allowlists use `ENDPOINT_NAMES.granted`.

## 2. waitFor tied to the operation

New exported (module-level, not in the package index) `waitForFile(read, path, pending)`: polls,
and once `pending` settles does one last read, then throws
`operation ended before <path> existed: <error message | exit N: stderr>` (error as `cause`).
The rejection is always handled. All 8 readiness waits pass their operation; the UNIX-server
"count reaches 7" loop uses the same helper against the server operation.

RED first: 6 new unit tests failed (missing helper, IP-literal name accepted, plus an unhandled
rejection), then passed.

## 3. M6 decision: not narrowed, documented as a known limitation

Probed in the hardened container with a staged mutant launcher whose system roots drop `/proc` and
keep `cpuinfo, meminfo, stat, loadavg, uptime, version, sys, self`:
- `/proc/1/cmdline` became unreadable (the goal), but so did the process's own `/proc/self/*`:
  `/proc/self/status`, `ls /proc/self/fd`, `/proc/self/mountinfo`, `/proc/self/maps`.
- Node `process.memoryUsage()` throws; Python `os.listdir('/proc/self/fd')` and reading
  `/proc/self/maps` fail. (python/node start, curl, nproc, `/dev/stdin` still worked.)
- Cause: Landlock rules attach to inodes at ruleset time; `/proc/self` resolves to per-process
  `/proc/<pid>` directories created later, so only a rule on `/proc` itself covers them, and that
  covers every pid. hidepid needs a mount, PID namespaces need new privileges: out of scope.

So no safe narrowing exists. Documented in the launcher's "Documented behaviour" header
(`packages/plugin-sdk/src/sandbox-linux-runtime-source.ts`, digest updated in
`sandbox-runtime-source.ts` to `f27ab699…d599`) and in the conformance JSDoc as "not covered, by
design". Ptrace-guarded entries (environ, mem, maps, fd) stay closed. Recommendation for providers:
keep secrets out of Full command lines (e.g. pass command text over stdin/a file, not argv).

## Verification

- Unit: `packages/testing/test/sandbox-permission-conformance.test.ts` 8 passed;
  plugin-sdk all 41 files / 1152 tests passed; native conformance + runtime source + operation
  tests 98 passed.
- Docker, `CAPYBARA_TEST_REQUIRE_LINUX_RESTRICTED=1 --maxWorkers=2`, run twice (second run after
  the launcher digest change): 20 passed, 1 skipped (the "required" guard) each; no containers left.
- `pnpm typecheck` pass; `pnpm check` all passed; `check:sdk-api` and
  `check:sdk-api-changeset --base origin/main` passed (no SDK export change); Biome clean on the
  changed files (repo-wide warnings pre-existing).
- Changesets: `@capybara-hq/testing` patch, `@capybara-hq/plugin-sdk` patch.

## Note for the plugins repository

`plugins/sandbox-docker/test/permission-scopes.test.ts` (branch
feat/sandbox-docker-permission-scopes) rewrites `127.0.0.1` to `GRANTED_HOST` in its fixture; with
the next testing rc it should instead set `name: GRANTED_HOST`, `address`, and `access: "direct"`
(its `permissionTestEndpoints` hook maps the name to the endpoint) and drop the rewrite. This is
a breaking interface change for that fixture (pre-0.1.0, no compat layer).
