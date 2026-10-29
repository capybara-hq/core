---
name: writing-sandbox-providers
description: 'Use when changing the kernel side of sandbox@1 or anything that drives a sandbox from the kernel: the contract as the kernel relies on it (abort, SandboxGoneError versus ordinary errors, auto-start, in-sandbox time limits, killAll / killTagged, concurrentExec and exec tags, same-name replacement, read-only /skills), effective org limits and egress (sandboxLimitOverrides, sandboxEgress, allowOpenEgress), the SandboxService lifecycle (shared and exclusive leases, intent, holder records, path leases, maxConcurrentCommands, TTL, lockWaitSeconds, fencing generation, idle suspension, maxRunning, inactivity destruction, rebuild and notices), the socket proxy config and compose sandbox profile core ships, and kernel tests on the sandbox-fake fixture. To write a sandbox extension (sandbox-docker, sandbox-e2b) see writing-sandbox-providers in capybara-hq/plugins.'
---

# Sandboxes: the kernel side of `sandbox@1`

One sandbox per conversation (D4), shared by its sub-agents. The kernel's sandbox tools (`sandbox_bash` / `read` / `write` / `edit` / `glob` / `grep` / `deliver`),
attachment sync and `skill_load` all use it through `SandboxService`. `sandbox@1` is a **single-choice, brokered** extension point: a deployment installs only one sandbox extension,
and other extensions cannot `requires` it. For the extension host see `.agents/skills/writing-extensions`; for the tools side see `.agents/skills/writing-tools`.

This skill covers what core owns: the contract as the kernel relies on it, `SandboxService` (leases, fencing, suspension, destruction), the builtin `sandbox_*` tools,
the socket proxy config and compose sandbox profile, and the kernel tests on the `sandbox-fake` fixture. **Writing a sandbox extension** (its code, README, Docker / E2B
specifics and tests) is in [writing-sandbox-providers in capybara-hq/plugins](https://github.com/capybara-hq/plugins/tree/main/.agents/skills/writing-sandbox-providers).

Implementations:

- `packages/kernel/test/fixtures/plugins/sandbox-fake`: the minimal shape (a local directory + `/bin/sh`, **no isolation, for tests only**); every kernel sandbox test runs on it.
- The official [`sandbox-docker`](https://github.com/capybara-hq/plugins/tree/main/plugins/sandbox-docker) (one container per conversation, runc or gVisor's runsc, Docker only through
  a socket proxy, an egress proxy container per sandbox) and [`sandbox-e2b`](https://github.com/capybara-hq/plugins/tree/main/plugins/sandbox-e2b) (E2B cloud or self-hosted)
  plugins in capybara-hq/plugins; their READMEs list every platform trade-off.

## Contract: `sandbox@1` (`packages/plugin-sdk/src/sandbox.ts`)

A change here is an SDK change (API snapshot + changeset) and must keep the official providers working; check them in capybara-hq/plugins.

```ts
interface SandboxProvider {
  create({ name, image, limits, signal }): Promise<SandboxHandle>;  // name = cap-<conversationId>
  resume(h, signal): Promise<"resumed" | "gone">;
  suspend(h, signal): Promise<void>;          // files must be kept; an instance that is not there also counts as success
  destroy(h, signal): Promise<void>;          // not being there counts as success
  destroyByName?(name, signal): Promise<void>;
  killAll?(h, signal): Promise<void>;
  readonly concurrentExec?: boolean;          // exec / readFile / writeFile / stat may run concurrently on one instance
  killTagged?(h, tags, signal): Promise<void>; // kill only the exec commands labelled with one of tags
  exec(h, { command, cwd?, env?, timeoutMs, maxOutputBytes, signal, tag? }): Promise<ExecResult>;
  readFile(h, path, { maxBytes, signal }): Promise<{ data; truncated } | null>;  // missing or a directory → null
  writeFile(h, path, data, signal): Promise<void>;                               // parent directories are created automatically
  stat(h, path, signal): Promise<{ size; isDir } | null>;
}
```

`glob` / `grep` / `edit` are composed by the kernel from `exec` + `readFile` / `writeFile`; the provider does not implement them. So the image must have GNU `find`
(`-print0`) and `grep` (`-rnHIE`, `--include`), `timeout`, `setsid`, `pkill` / `pgrep`.

### Semantics the kernel relies on

Every provider must follow these; the kernel's behaviour below assumes them. How the official providers implement each one is in the plugins repository's skill.

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
  The kernel calls it only where no live sibling can be running a command (see "Takeover per holder" below): under the exclusive lease when it finds records of
  crashed holders or an older kernel's busy marker, under a shared lease only for a provider without `killTagged` while it is the one holder, and right after
  recovering from `suspended` (an E2B pause preserves processes too). When the exec that kills processes cannot even start (process table exhausted),
  Docker falls back to `restart?t=0` and E2B falls back to pause + a `connect {memory: false}` cold start, which also end live siblings' commands; both log a
  warn and the call returns normally.
- **Concurrent use (`concurrentExec`, `killTagged`, `tag`; phase C)**: parallel sub-agents share their parent conversation's sandbox, so the kernel may call
  `exec` / `readFile` / `writeFile` / `stat` concurrently on one instance when the provider declares `concurrentExec: true`. Then those methods must be safe
  concurrently, and **auto-start must be idempotent under concurrent calls** (two calls that both find the instance stopped both start it without failing:
  Docker's `start` on a running container answers 304, E2B `connect` on a running sandbox only extends its timeout). Every `exec` gets the holder's `tag`
  (`SANDBOX_TAG_RE`, `^[a-z0-9-]{1,64}$`, checked by the provider before it goes near a command line): label the command with it (the official providers name
  the control file `/tmp/.capybara-exec-<tag>-<uuid>`), and implement `killTagged(h, tags)` to kill only those commands' process trees, matching the
  whole tag: `capybara-exec /tmp/[.]capybara-exec-<tag>-<uuid>( |$)` with the UUID's exact shape, because a tag may be a prefix of another (`ab` of `ab-cd`;
  the kernel's tags are UUIDs, but the contract allows any `SANDBOX_TAG_RE` tag). An aborted or timed-out `exec` still kills only its own command. `concurrentExec` requires `killTagged`: a
  provider that declares one without the other, or neither, gets one call at a time (a startup warn for the half-declared case), so providers written before
  phase C keep working unchanged. Concurrent commands share the sandbox's pids and memory limits; say so in the README.
- **Same-name replacement**: `create` first deletes an old instance of the same name and then builds (the kernel may exit after the provider has built it but before it has recorded the handle). Likewise implement
  `destroyByName`: when the kernel has no handle, it cleans up by `cap-<conversation>` (conversation deletion, test cleanup).
- **Output**: `maxOutputBytes` is the **combined** limit on stdout + stderr; excess is discarded and `truncated` is set; truncation backs off to a full UTF-8 character boundary.
- **`/skills` is read-only**: mounted read-only for the sandbox user (or owned by root with 0755), and `writeFile("/skills/…")` is written by the provider as root,
  and must not be redirected elsewhere by a symlink the sandbox user places. The kernel's `/skills` write protection judges only the path string and can be bypassed by symlinks; the real
  defense is in the provider. Skill files have no executable bit, and `skill_load` tells the model to run them with an interpreter (`sh /skills/x/run.sh`).
- **File operations resolve as the sandbox user**: permissions and symlinks are resolved as the non-root user, never as root through the daemon.
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
- **Leases** (phase C, `packages/kernel/src/sandbox/leases.ts`, spec `docs/superpowers/specs/2026-10-26-subagents-design.md` §10): using a sandbox recorded
  `running` takes a **shared** lease (up to `sandbox.maxConcurrentCommands`, default 6, hot; 1 for a provider without `concurrentExec` + `killTagged`):
  every `sandbox_*` tool, attachment sync, `skill_load` copies. Every lifecycle change (create, first use, rebuild after `gone`, `resume`, provider switch,
  `suspend`, `destroy`, `killAll` after resume) takes the **exclusive** lease, alone. Keys: `capk:sandbox:<conv>` (the old lock key, kept for rolling
  upgrades: an exclusive token or the literal `shared`), `capk:sandbox-users:<conv>` (zset of shared tokens by expiry), `capk:sandbox-intent:<conv>`
  (an exclusive waiter's intent: new shared leases wait, writer preference), `capk:sandbox-holders:<conv>` (holder records), `capk:sandbox-path:<conv>:<sha256>`.
  Every key carries a TTL, never shortened by a holder for a TTL another holder set: the lease keys (`capk:sandbox:<conv>`, `capk:sandbox-users:<conv>`)
  60 s (`SANDBOX_LOCK_TTL_MS`; the lease is a `LockService` shared lease, `tryShared` / `tryExclusive` in `infra/lock`, renewed every TTL/3 and lost at
  the R19 deadline: send time of the last successful renewal + 2/3 TTL, which aborts that holder's signal); the holder records
  and the `v2` busy marker `sandbox.limits.maxCommandSeconds` + 10 min; the intent max(4 × poll, 2 s); a path lease 30 s (renewed); the seen key
  below `destroyAfterInactiveDays` + 1 day. A caller loops: sandbox `running` → one try at a shared lease; otherwise one try at the exclusive lease with
  intent (same token, so it can switch to shared under its own intent once someone else made the sandbox run); the exclusive holder makes it run and
  **downgrades** to a shared lease to run its own command (always release the view `downgrade` returned; any view's `release` releases the lease's current kind).
  Waiting is capped at `sandbox.lockWaitSeconds` (default 75, **must be greater than the lease TTL**, Ruling M15), then `sandbox.busy`. Two replicas using it
  for the first time at once build only one; several holders hitting `gone` together rebuild once (the others find the new instance and see "recreated").
  A holder that was not there for the rebuild (the parent, or a sibling sub-agent, on its next call) also sees "recreated": the kernel keeps the
  instance each agent conversation last used (`capk:sandbox-seen:<conv>:<holder conv>`, its `created_at`, TTL `destroyAfterInactiveDays` + 1 day)
  and reports a change once.
  An instance is named by its handle **and** the row's `created_at` (set by the fenced write after each `create`): sandbox-docker's handle is the instance
  name, the same after a rebuild, so the handle alone would make every holder rebuild in turn and wipe the instance the previous one had just built.
- **Takeover per holder**: each holder records itself in `capk:sandbox-holders:<conv>` (TTL `maxCommandSeconds` + 10 min) before its provider calls,
  refreshes the record before every `exec`, and deletes it **before** releasing its lease. Every acquirer claims records without a live lease (crashed
  holders) atomically and kills their commands: `killTagged` under a shared lease whenever the provider has it (even with cap 1: a hot change of
  `maxConcurrentCommands` may have let a sibling in on another replica), `killAll` under the exclusive lease, or under a shared lease for a provider without
  `killTagged` only while it is the one holder (otherwise a warn; the in-sandbox time limit ends them). The claim removes the records before the kill: an
  acquirer that crashes in between leaves those commands to the in-sandbox time limit. The single marker `capk:sandbox-busy:<conv>` of kernels before phase C
  is still read, and claimed only by the caller holding the exclusive lease: it sends the next use down the exclusive path, which `killAll`s. Holders of this
  kernel also write that marker with the value `v2` while any holder record exists (this kernel ignores `v2`), so a replica from before phase C that takes
  the lock after a new holder crashed still kills the leftovers during a rolling upgrade. A sandbox just resumed from `suspended` is `killAll`ed too.
- **Kernel file writes per path**: `sandbox_write`, `sandbox_edit`, attachment sync (its marker) and `skill_load` copies (the skill's marker) take a per-path
  lease (30 s, renewed, waited for up to 30 s, then the tool error "Another sub-agent is writing this file; wait a moment and retry."). What shell commands write is not
  serialized; the `sandbox_bash` description says other sub-agents may run commands at the same time.
- **Fencing generation**: each lease acquisition (shared ones too) first increments `generation`, and later state writes (exclusive holders only; shared holders only move `last_used_at` forward with `GREATEST`) compare against it, so an old exclusive holder's writes necessarily fail (`SandboxLockLostError`).
- **Suspension**: a `@LockedCron` (`sandbox-suspend-idle`, once per minute across replicas) calls `suspend` on sandboxes idle longer than `suspendAfterIdleMinutes` (default 10), or running continuously longer than `maxRunningMinutes`
  (default 120, Ruling M1). Those with any holder are skipped until the next time (one try at the exclusive lease, no intent); one past `maxRunningMinutes`
  gets the intent for about a second so new commands wait briefly and the suspension can get in when the running ones end. `last_used_at` is set when each
  holder leaves, so the idle clock starts when the last concurrent holder finishes.
- **Destruction**: a `@LockedCron` (`sandbox-destroy-inactive`, hourly); sandboxes inactive longer than `destroyAfterInactiveDays` (default 7), whose org is deleted, or whose conversation is deleted get `destroy`;
  a departing member's (or a deleted agent's) are destroyed immediately through the one-off maintenance job `sandbox-destroy-for` (producer
  `SandboxJobs`).
- **Transparent recovery**: a suspended sandbox is `resume`d on next use; on `gone`, destroyed, or a recorded provider that is not the current provider, an empty sandbox is rebuilt and the tool result carries
  an English notice. Switching providers leaks old instances (the new provider cannot destroy them; they are recorded in the `prev_*` columns and cleaned up only while the old extension is still loaded).
- **Per-command** limit `sandbox.limits.maxCommandSeconds` (default 7200); `sandbox_bash` defaults to 120 seconds. A command timeout is also tightened to
  the time remaining in the owning run minus 30 seconds (`runtime.maxRunSeconds`, default 900, Ruling M20; the built-in tool context's `runDeadline`), and the result
  tells the model it was due to the run time limit. Long commands need `maxRunSeconds ≥ maxCommandSeconds`, otherwise startup logs a warn.

## Security

- **Docker's socket proxy** (`docker/sandbox-proxy/haproxy.cfg`, the one config core ships; `docker/compose.yaml` inlines it as `configs.sandbox-proxy-haproxy.content`,
  kept equal line for line by `pnpm check:compose-haproxy`): allows only the endpoints `sandbox-docker` uses, containers / volumes are recognized only by names starting with `cap-`,
  and request bodies are rejected by regex for privileged mode, `Binds`, `CapAdd`, non-ASCII keys (Go folds key names by Unicode, `Bindſ` = `Binds`) and so on. **This is only a backstop;
  the main defense is network position**: anything that can reach the proxy can nearly control Docker. **Never publish the proxy on any host address (127.0.0.1 included)**;
  in production, put it only on the internal network where the kernel runs, and do not attach sandboxes to that network. The dev compose publishes it on `127.0.0.1:2375` for the local machine only (Ruling M13); in that case do not enable
  `allowOpenEgress` (an open sandbox can reach the host loopback through `host.docker.internal`).
- **The proxy config has a copy in capybara-hq/plugins**: the `sandbox-docker` tests start a real HAProxy from `plugins/sandbox-docker/test/sandbox-proxy/haproxy.cfg` in that repository.
  `pnpm check:bootstrap --network` (rule `bootstrap-haproxy`) requires that copy, at the bootstrap manifest's `marketplace.commit`, to equal core's `docker/sandbox-proxy/haproxy.cfg` byte for byte.
  A change to the proxy rules therefore lands in both repositories: in capybara-hq/plugins with a violating case against the real proxy (proving it is rejected), then here with the
  `marketplace.commit` bump.
- **Sandbox images**: the compose `sandbox` profile builds `capybara-sandbox` and `capybara-sandbox-egress` from git contexts
  `https://github.com/capybara-hq/plugins.git#<marketplace.commit>:plugins/sandbox-docker/image` (and `…:plugins/sandbox-docker/egress-proxy`), pinned to the same commit
  (rule `bootstrap-compose-ref` of `pnpm check:bootstrap`). The images themselves (container hardening, the egress proxy that blocks DNS rebinding by checking every resolved IP)
  are the plugin's; see its skill.
- Logs and errors carry no secrets and no other orgs' ids.

## Tests

- **Kernel tests use the fake sandbox**: `packages/kernel/test/fixtures/plugins/sandbox-fake`, deployment config `{ root }`; multiple replicas sharing one
  root share the same instances. Helpers: `readFakeSandboxOps` (operation counts), `removeFakeSandbox` (simulate gone),
  `setFakeSandboxDelays` (slow operations; `exec` holds a command open), `fakeSandboxState`; the fake declares `concurrentExec`, records each command's tag in
  `procs/<pid>` and logs `exec <id> <tag> <startMs> <endMs>` and `kill-tagged <id> <tags>` in `ops.log`. Concurrent holders: `packages/kernel/test/sandbox/concurrent.test.ts`,
  `concurrent.dual.test.ts`; the Redis protocol: `leases.test.ts`; takeover after killing the executing replica and recovery after suspension:
  `packages/kernel/test/sandbox/sandbox-artifacts.dual.test.ts`. See `packages/kernel/test/sandbox/*`,
  `packages/kernel/test/tools/sandbox/sandbox-tools.test.ts`, `packages/kernel/test/skills/m5-segment3.dual.test.ts` for cases.
- `@capybara-hq/testing` exports what provider tests in capybara-hq/plugins assert on (`SANDBOX_STARTED_NOTICE`, `SANDBOX_RECREATED_NOTICE`, `SANDBOX_LOCK_TTL_MS`,
  `SANDBOX_SUSPEND_JOB`) and `startFakeE2B`; changing those texts or keys breaks the official providers' tests, so treat them as part of the contract.
- Real Docker, runsc and E2B are tested in capybara-hq/plugins; manual acceptance on real runtimes is in `docs/superpowers/plans/m5-live-acceptance-checklist.md`.
