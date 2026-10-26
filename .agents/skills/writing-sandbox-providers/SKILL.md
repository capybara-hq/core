---
name: writing-sandbox-providers
description: 'Use when creating or changing a sandbox extension (provides sandbox@1, e.g. plugins/sandbox-docker, plugins/sandbox-e2b): contract primitives and abort semantics, org-level cpu / memory overrides (sandboxLimitOverrides), SandboxGoneError versus ordinary errors, auto-starting stopped instances, in-sandbox command time limits, killAll (taking over from a crashed predecessor / recovering from suspension), same-name instance replacement and destroyByName, read-only /skills, egress none / allowlist / open and allowOpenEgress, limits taking effect only at creation; the SandboxService lifecycle (Redis lock TTL and renewal, lockWaitSeconds, fencing generation, idle suspension, maxRunning, inactivity destruction, rebuild and notices); security (where the socket proxy lives, the egress proxy blocking DNS rebinding by resolved IP); and writing tests with the fake sandbox extension, real Docker, and startFakeE2B / real E2B.'
---

# Writing sandbox extensions

**Where this goes after the repository split** (phase A3b, spec §6.2): the official plugins move to `capybara-hq/plugins` and the author half of this skill moves with them; author tooling is `capybara-plugin pack | check` (`@capybara-hq/plugin-tools`, `.agents/skills/writing-plugins` "Toolchain"; in core `pnpm pack-plugin` and `pnpm check`). **Stays in core**: "Lifecycle: `SandboxService`" (locks, fencing, suspension, destruction), the builtin `sandbox_*` tools and the egress proxy configuration, tested on the `sandbox-fake` fixture. Moves: the contract semantics an extension implements, "Security" for the provider, and the Docker / E2B tests (`plugins/sandbox-docker/test`, which keeps a copy of `docker/sandbox-proxy/haproxy.cfg` checked by `check:compose-haproxy` until the split, `plugins/sandbox-e2b/test`).

One sandbox per conversation (D4). The kernel's sandbox tools (`sandbox_bash` / `read` / `write` / `edit` / `glob` / `grep` / `deliver`),
attachment sync and `skill_load` all use it through `SandboxService`. `sandbox@1` is a **single-choice, brokered** extension point: a deployment installs only one sandbox extension,
and other extensions cannot `requires` it. For general extension writing see `.agents/skills/writing-extensions`; for the tools side see `.agents/skills/writing-tools`.

Reference implementations:

- `plugins/sandbox-docker`: one container per conversation (runc, or gVisor's runsc), reaching Docker only through a socket proxy; the egress allowlist is enforced by a proxy container that each sandbox brings along.
- `plugins/sandbox-e2b`: E2B cloud or self-hosted; pause for suspension and connect for resume; a hand-written minimal client (the official SDK is not used: it reads process environment variables and has a module-level connection pool).
- `packages/kernel/test/fixtures/plugins/sandbox-fake`: the minimal shape (a local directory + `/bin/sh`, **no isolation, for tests only**); read it before reading the real extensions.

The READMEs of the two extensions spell out, item by item, the platform sources, every trade-off and the known limitations; write a new implementation at that level of detail.

## Contract: `sandbox@1` (`packages/plugin-sdk/src/sandbox.ts`)

```ts
interface SandboxProvider {
  create({ name, image, limits, signal }): Promise<SandboxHandle>;  // name = cap-<conversationId>
  resume(h, signal): Promise<"resumed" | "gone">;
  suspend(h, signal): Promise<void>;          // files must be kept; an instance that is not there also counts as success
  destroy(h, signal): Promise<void>;          // not being there counts as success
  destroyByName?(name, signal): Promise<void>;
  killAll?(h, signal): Promise<void>;
  exec(h, { command, cwd?, env?, timeoutMs, maxOutputBytes, signal }): Promise<ExecResult>;
  readFile(h, path, { maxBytes, signal }): Promise<{ data; truncated } | null>;  // missing or a directory → null
  writeFile(h, path, data, signal): Promise<void>;                               // parent directories are created automatically
  stat(h, path, signal): Promise<{ size; isDir } | null>;
}
```

`glob` / `grep` / `edit` are composed by the kernel from `exec` + `readFile` / `writeFile`; the provider does not implement them. So the image must have GNU `find`
(`-print0`) and `grep` (`-rnHIE`, `--include`), `timeout`, `setsid`, `pkill` / `pgrep`.

### Semantics you must follow

- **Abort**: every method responds to `signal` promptly. Already aborted at call time → reject immediately; aborted in flight → end as soon as possible with the abort reason.
  The kernel relies on this to stop when the lock is lost, the run is aborted or times out; without it, you may operate on the same instance at the same time as a new lock holder.
  **An aborted `exec` must kill the command and its child processes**, not merely stop waiting for output; an `exec` aborted after the command has started resolves normally with
  `{ exitCode: null, timedOut: false }` (with the output collected so far) and does not reject. A timeout resolves `timedOut: true, exitCode: null`.
- **gone versus ordinary errors**: when the instance is **definitely** no longer there on the provider's side (container deleted, E2B sandbox expired), `exec` / `readFile` /
  `writeFile` / `stat` / `killAll` throw `SandboxGoneError` and `resume` returns `"gone"`. The kernel then rebuilds an empty sandbox and retries once,
  and the model sees `Sandbox was recreated; previous files are gone.`. If the instance is only temporarily unreachable (401, 5xx, network errors, a bare 404 returned by a proxy),
  throw an **ordinary error**; otherwise one network blip wipes the user's files. Use `isSandboxGoneError` to decide (duck-typed, compatible with an extension bundling its own copy of the SDK).
  E2B treats only E2B-format 404s (`{code: 404, …}`) as gone; failing to obtain the envd access token is also reported as gone (better to rebuild than to send a request without the token).
- **Auto-start**: when the instance still exists but is stopped / paused (host or daemon restart, the suspension sweep stopped it before it could record `suspended`, someone ran
  `docker pause`), `exec` / `readFile` / `writeFile` / `stat` / `killAll` first start it the way `resume` does and then proceed,
  without reporting an error. The kernel trusts only the `running` it recorded itself.
- **Command time limit inside the sandbox**: besides stopping the command on the provider side at `timeoutMs`, the command itself must run inside the sandbox through
  `timeout -s KILL <timeoutMs + a few seconds>`. When a kernel replica crashes, the provider-side timer disappears with it, and disconnecting does not end the command;
  this limit guarantees it cannot run indefinitely in parallel with the next lock holder's commands.
- **killAll**: kill every command started through `exec` that is still running (SIGKILL by process group and session); processes moved to the background in a new session are not guaranteed.
  The kernel calls it in two cases: when it gets the lock and finds the previous holder did not finish normally (the Redis marker `capk:sandbox-busy:<conversation>` is still there, i.e. taking over from a crashed
  replica), and right after recovering from `suspended` (an E2B pause preserves processes too). When the exec that kills processes cannot even start (process table exhausted),
  Docker falls back to `restart?t=0` and E2B falls back to pause + a `connect {memory: false}` cold start; both only log a warn and the call returns normally.
- **Same-name replacement**: `create` first deletes an old instance of the same name and then builds (the kernel may exit after the provider has built it but before it has recorded the handle). Likewise implement
  `destroyByName`: when the kernel has no handle, it cleans up by `cap-<conversation>` (conversation deletion, test cleanup).
- **Output**: `maxOutputBytes` is the **combined** limit on stdout + stderr; excess is discarded and `truncated` is set; truncation backs off to a full UTF-8 character boundary.
- **`/skills` is read-only**: mounted read-only for the sandbox user (or owned by root with 0755), and `writeFile("/skills/…")` is written by the provider as root,
  and must not be redirected elsewhere by a symlink the sandbox user places. The kernel's `/skills` write protection judges only the path string and can be bypassed by symlinks; the real
  defense is in the provider. Skill files have no executable bit, and `skill_load` tells the model to run them with an interpreter (`sh /skills/x/run.sh`).
- **File operations resolve as the sandbox user**: permissions and symlinks are resolved as the non-root user (Docker runs small `head` / `stat` scripts in the container; E2B's
  upload endpoint opens the target as root, so upload first to a root-only staging directory and then write the target with `runuser -u sandbox`). Don't write volumes as root through the daemon.
- Paths have already passed `validateSandboxPath` (only `/workspace`, `/skills`, `/tmp` are accepted); the working directory is `/workspace` and attachments are in
  `/workspace/attachments/`.

### Limits and egress (`SandboxLimits`)

- `egress` / `allowHosts` are the values **in effect for the org**: the org setting `sandboxEgress` can replace the allowlist with its own or cut the network,
  and cannot be more open than the deployment (Ruling M19, kernel `effectiveSandboxEgress`). The provider just enforces what `create` receives and does not read org settings.
- `cpu` / `memoryMb` are likewise the values **in effect for the org**: an enterprise admin can override them per org in the admin console (deployment setting `sandboxLimitOverrides`,
  orgId → `{ cpu?, memoryMb? }`, cpu 0.25–64, memoryMb an integer in 256–262144, C19); the items given replace the deployment defaults of `sandbox.limits`, and items not given and `diskMb` keep the deployment defaults (kernel `effectiveSandboxLimits`); org admins see the effective values and their source read-only in org settings.
  The provider just enforces the `limits` it receives from `create`; a provider that cannot size each sandbox (such as E2B, where the template decides the size) must state in its README
  "org-level cpu / memory overrides do not take effect for this plugin"; a deployer who needs different sizes uses different templates.
- `cpu` / `memoryMb` / `diskMb` / `egress` / `allowHosts` **take effect only at `create`**: changing config affects only sandboxes created afterwards,
  and existing ones (including those recovered from suspension) keep the settings from creation until they are destroyed and rebuilt. When an item cannot be done, say so in the README (Docker's default local volume driver
  does not limit `diskMb`; E2B's cpu / memory / disk are decided by the template).
- `egress`:
  - `none`: loopback only.
  - `allowlist` (default): allow only `allowHosts` (`validateAllowHost` already rejects IP literals, single-label names and `.local` / `.internal`;
    `*.example.com` matches subdomains and not the domain itself).
  - `open`: the provider's deployment config `allowOpenEgress` defaults to false; when false, `create` receiving open fails with an English error. New extensions implement it this way.
- **The allowlist does not prevent data exfiltration**: it blocks the internal network and hosts outside the allowlist, but not data sent to allowlisted hosts (`git push` to github.com, publishing packages).
  The README must say so and recommend `sandboxToolPolicy: ask` and / or `sandboxEgress: none` for sensitive orgs.
- A provider that cannot allow by domain name must **refuse, or degrade to `none` with a warning**, and must never silently open up (E2B self-hosted `domainAllowlist: false`).
  Where it can but more weakly, write it in the README (E2B looks only at Host / SNI and does not verify the destination IP, Ruling M14).

## Lifecycle: `SandboxService` (`packages/kernel/src/sandbox/sandbox.service.ts`)

The kernel owns it; the extension implements only primitives. **Do not do scheduling, timing or state tables in the extension**:

- **State** lives in the PG table `sandboxes` (status `creating` / `running` / `suspended` / `destroyed`, handle, owning provider),
  created lazily: `create` runs only on the first sandbox tool call.
- **Serialization**: everything for one conversation runs under the Redis lock `capk:sandbox:<conversation>`, TTL 60 seconds (`SANDBOX_LOCK_TTL_MS`), renewed every
  TTL/3 while held; failing to renew successfully for longer than the TTL counts as losing the lock and aborts the signal passed to the provider. Concurrent calls queue, waiting at most `sandbox.lockWaitSeconds`
  (default 75, **must be greater than the lock TTL**, otherwise the first call after a replica crash reports `sandbox.busy` first, Ruling M15). Two replicas using it for the first time at once build only one.
- **Fencing generation**: each lock acquisition first increments `generation`, and later state writes compare against it, so an old lock holder's writes necessarily fail (`SandboxLockLostError`).
- **Suspension**: a maintenance job scans every minute and calls `suspend` on sandboxes idle longer than `suspendAfterIdleMinutes` (default 10), or running continuously longer than `maxRunningMinutes`
  (default 120, Ruling M1). Those executing a command (lock held) are skipped until the next time.
- **Destruction**: scanned hourly; sandboxes inactive longer than `destroyAfterInactiveDays` (default 7), whose org is deleted, or whose conversation is deleted get `destroy`;
  a departing member is destroyed immediately through the one-off job `sandbox-destroy-for`.
- **Transparent recovery**: a suspended sandbox is `resume`d on next use; on `gone`, destroyed, or a recorded provider that is not the current provider, an empty sandbox is rebuilt and the tool result carries
  an English notice. Switching providers leaks old instances (the new provider cannot destroy them; they are recorded in the `prev_*` columns and cleaned up only while the old extension is still loaded).
- **Per-command** limit `sandbox.limits.maxCommandSeconds` (default 7200); `sandbox_bash` defaults to 120 seconds. A command timeout is also tightened to
  the time remaining in the owning run minus 30 seconds (`runtime.maxRunSeconds`, default 900, Ruling M20; the built-in tool context's `runDeadline`), and the result
  tells the model it was due to the run time limit. Long commands need `maxRunSeconds ≥ maxCommandSeconds`, otherwise startup logs a warn.

## Security

- **Docker's socket proxy** (`docker/sandbox-proxy/haproxy.cfg`): allows only the endpoints the extension uses, containers / volumes are recognized only by names starting with `cap-`,
  and request bodies are rejected by regex for privileged mode, `Binds`, `CapAdd`, non-ASCII keys (Go folds key names by Unicode, `Bindſ` = `Binds`) and so on. **This is only a backstop;
  the main defense is network position**: anything that can reach the proxy can nearly control Docker. **Never publish the proxy on any host address (127.0.0.1 included)**;
  in production, put it only on the internal network where the kernel runs, and do not attach sandboxes to that network. The dev compose publishes it on `127.0.0.1:2375` for the local machine only (Ruling M13); in that case do not enable
  `allowOpenEgress` (an open sandbox can reach the host loopback through `host.docker.internal`). The extension reaches Docker only through `endpoint` and does not mount `docker.sock`.
- **Container hardening**: commands run as non-root (uid 1000); PID 1 runs as root but with `CapDrop: ALL` (the sandbox user cannot stop the container, Ruling M16),
  `no-new-privileges`, a read-only root filesystem, `PidsLimit`, private IPC, and `/tmp` is a tmpfs.
- **The egress proxy blocks DNS rebinding**: checking only the hostname cannot stop `10.0.0.1.nip.io`. The proxy resolves first, and **every resolved IP** must not be private,
  loopback, link-local (169.254.169.254 included), CGNAT, ULA, multicast or reserved (IPv4-mapped / NAT64 / 6to4 are judged by the embedded IPv4),
  and then connects directly to the IP that was checked, with no second resolution. HTTPS goes through CONNECT, and only ports 443 / 80 are allowed. New egress implementations follow this standard.
- Logs and errors carry no secrets (E2B API key, envd token) and no other orgs' ids.

## Tests

- **Kernel tests use the fake sandbox**: `packages/kernel/test/fixtures/plugins/sandbox-fake`, deployment config `{ root }`; multiple replicas sharing one
  root share the same instances. Helpers: `readFakeSandboxOps` (operation counts), `removeFakeSandbox` (simulate gone),
  `setFakeSandboxDelays` (slow operations), `fakeSandboxState`. See `packages/kernel/test/sandbox/*`,
  `packages/kernel/test/tools/sandbox/sandbox-tools.test.ts`, `packages/kernel/test/skills/m5-segment3.dual.test.ts` for cases.
- **Docker extension**: `buildTestImages` (unique tag), `startSocketProxy` (a real HAProxy) and `cleanupTestResources` (cleans up by label) in `plugins/sandbox-docker/test/docker-env.ts`;
  without Docker (or with `CAPYBARA_TEST_NO_DOCKER=1`) the whole group is skipped, and runsc cases run only when the daemon has
  runsc registered. Test-only options (extra labels, `egressTestHosts`) go through the second parameter of `createDockerSandbox`; the extension config is strict and cannot set them.
  A change to the socket proxy rules must come with a violating case against the real proxy (proving it is rejected).
- **E2B extension**: `startFakeE2B` from `@capybara-hq/testing` (control plane + envd; commands really run in a local temp directory); the real-E2B
  `test/live` runs only when `CAPYBARA_TEST_E2B_API_KEY` / `CAPYBARA_TEST_E2B_TEMPLATE` are set, and the file header lists "assumptions that can only be confirmed in a real
  environment", to be checked one by one on the first run.
- **Dual-replica**: `plugins/sandbox-docker/test/sandbox-artifacts.dual.test.ts` (real Docker; takeover after killing the executing replica, recovery after suspension); the same flow on the kernel's fake sandbox is `packages/kernel/test/sandbox/sandbox-artifacts.dual.test.ts`.
- Every provider covers at least: the mapping of gone versus ordinary errors, abort (before the call / in flight), a timeout killing the whole process group, auto-start, killAll,
  same-name replacement, a `/skills` write through a symlink being rejected, the three egress modes, and output truncation at a UTF-8 boundary.
- Manual acceptance on real runtimes (runsc, E2B, CI amd64) is in `docs/superpowers/plans/m5-live-acceptance-checklist.md`.
