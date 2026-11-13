# @capybara-hq/device

## 0.1.0-rc.7

### Minor Changes

- 76828c0: Device policy ops carry an op id. The device protocol's `policy` op now requires `opId` (non-empty,
  no `:`, at most 128 characters); the new `policyStatus` op asks a device what became of an op id
  (`applied`, `refused`, `started` or `unknown`, with its policy summary now); a hello may carry
  `recentOps`, the outcomes of the latest 100 policy ops; the new feature `policyOpId` announces all
  three. `capybara-device` logs each policy op in `policy-ops.json` next to `policy.json` (`started`
  before the change, then `applied` or `refused`; the last 100 kept), answers a repeated op id from
  that log without applying it again, and reports the log in every hello. The kernel sends its op id
  with each `policy` op.
  
  The SDK's hello parser keeps one `recentOps` entry per op id (the last one listed). `capybara-device`
  keeps a refusal's message in the log cut to 500 characters, never logs an applied op as refused
  when releasing the policy lock fails after the write, and keeps an op the log already says was
  applied as applied.

### Patch Changes

- a6d073a: A background task on macOS keeps its launch's network permissions until its process group ends; it lost them (proxy 403) as soon as the launch returned.
- Updated dependencies [76828c0]
  - @capybara-hq/plugin-sdk@0.1.0-rc.20

## 0.1.0-rc.6

### Patch Changes

- d3f5836: At tiers `dev` and `open`, sandboxed commands may write `.git/config`, so `git init`, `clone`,
  `config` and `remote add` work in OS mode. `.git/hooks` stays unwritable at every tier (now also
  when the program runs from a directory that does not contain the device's roots), init and clone
  use an empty template, and `strict` keeps `.git/config` unwritable.
- 873dc2c: Sandboxed commands no longer get `npm_config_store_dir`, which made every npm command warn
  `Unknown env config "store-dir"`; pnpm 10 has no other variable for its store, so it stays at
  pnpm's default under the command's HOME.
- 67e6ad5: A local OS-sandboxed device now kills what a foreground command leaves running (`server &`,
  `nohup …`) when the command ends, by its process group and by a per-command marker for processes
  that left the group. Inside the sandbox no later command could signal them, so they leaked. A
  background task launch, whose command starts with the new `BACKGROUND_LAUNCH_LINE`
  (`@capybara-hq/plugin-sdk`), keeps what it starts. The `Bash` description tells the model to use
  `run_in_background` for servers and watchers.
- cb0be5f: `capybara-device service install` on macOS waits until `launchctl bootout` has really removed the
  old agent before `bootstrap`, and retries a bootstrap that fails with error 5 (Input/output error),
  with a clear message when it keeps failing. On Linux a reinstall restarts the unit. `drain --wait
  [--timeout <seconds>]` returns once the program has exited.
- Updated dependencies [67e6ad5]
- Updated dependencies [e76028b]
  - @capybara-hq/plugin-sdk@0.1.0-rc.18

## 0.1.0-rc.5

### Patch Changes

- 8471657: A local policy change made on the machine (`capybara-device policy ...` while the service runs, a
  flipped localhost proxy guard, a new tier ceiling) reaches the deployment at once: the device
  pushes its new summary in a `policy` frame (new in the device protocol), and the kernel stores it
  as it stores the hello's, so the device page and the next `device_paths` line show it.
- 204a7ed: Version managers work inside the OS sandbox: asdf, nvm, pyenv, rbenv, mise, volta, sdkman and
  rustup get their data directories under the real home (read only) instead of the workspace HOME.
- Updated dependencies [8471657]
- Updated dependencies [a3ca5ef]
  - @capybara-hq/plugin-sdk@0.1.0-rc.17

## 0.1.0-rc.4

### Minor Changes

- 99d2fe8: Sandbox tiers in OS and Docker mode. A command runs at the device's tier (`policy set tier
  strict|dev|open|default`) cut to the organization's ceiling: `dev` adds the dev hosts preset to
  the network, package caches under `<dir>/cache/`, and on macOS local servers (unless a local
  forwarding proxy is detected; `policy set localhost allow` overrides) and unix sockets under the
  device's directories and a short socket directory that `TMPDIR` and `MAC_CHROMIUM_TMPDIR` point
  at; `open` reaches anything the organization allows and needs `--yes`. A tier change reaches the
  sandbox at the next command. Docker mode sizes `/dev/shm` per tier and opens the bridge only for
  explicit local domains or tier `open`. The proxy guard runs again every 30 seconds (before the next
  command) and, on macOS, counts a check that fails as a proxy found. A local tier change turns the
  sandbox back on for a device set to run without one. `policy show` says what the tier gives on this machine, and
  `start` prints a notice for a legacy `network: "open"`.
- 579b956: Accept owner-approved network changes from the deployment. `policy.json` gains `network`
  (`allowlist` default, or `open`: commands reach what the organization allows) and `remoteGrants`
  (`owner` default, or `off`: the device refuses every widening from the deployment). The new `policy`
  operation adds or removes allowed domains and switches `network` (narrowing always accepted, every
  host validated, written under the lock); a run's or task's granted hosts join a command's list
  within the organization's egress. In OS mode exec results report the refused hosts; the hello
  announces `networkReport` / `policyOp` and a summary of the local policy. The local command log
  records each change from the deployment, refused attempts and each command's grants. A
  Docker-mode device refuses widening from the deployment (it cannot limit single domains).
- 6cd651b: `capybara-device policy set network open` turns off the device's own network limit (commands
  reach what the organization allows) after printing the risk: it needs `--yes`, or an answer of `y`
  on a terminal; without a terminal and without `--yes` it exits with status 2 and a hint.
  `set network allowlist` is always accepted. `policy set remoteGrants owner|off` decides whether
  the device owner may widen the network from the deployment.
- 8fa0e32: `policy.json` replaces `network` with `tier` (absent = the organization's default), `isolation`
  (`sandbox` by default) and `localhost` (`auto` by default). The old keys `network`,
  `allowLocalBinding` and `allowUnixSockets` are ignored and dropped on the next write; a policy with
  tier `open` behaves as the old `network: "open"`, every other tier as before.
- 5d6f865: A device in OS mode runs commands without a sandbox when its owner sets it on the machine
  (`capybara-device policy set isolation none`, with tier `open`; the risk text is shown and needs
  `--yes` or a `y` at the prompt). Below tier `open`, or when the deployment does not allow the
  command to run unsandboxed (`limits.allowUnsandboxed` not `true`), such a device refuses commands,
  naming why; a command whose sandbox is turned back on while it starts is refused too, and an
  invalid `policy.json` turns the sandbox back on. The
  deployment can never turn the sandbox off: the `policy` op accepts only `isolation: "sandbox"`, and
  a higher tier only under `remoteGrants: "owner"`. The hello announces the `tiers` feature, the
  policy summary reports the tier the device runs at, and the local command log records each
  command's tier and isolation.

### Patch Changes

- 4ce2efa: Explain blocked network access: in OS mode a refused domain gets a reason from the proxy, and each
  command's stderr ends with a trailer naming every refused host and the layer that refused it (this
  device's allowed domains, the organization's allowlist, or a private address). Local policy changes
  apply at the next command without a restart (an invalid `policy.json` keeps the last valid policy),
  writes take `policy.json.lock`, and `capybara-device policy add|remove allowedDomains <host>` edits
  the list one host at a time.
- Updated dependencies [2682d5f]
- Updated dependencies [2e52ca1]
- Updated dependencies [8fa0e32]
- Updated dependencies [95fc4b0]
  - @capybara-hq/plugin-sdk@0.1.0-rc.16

## 0.1.0-rc.3

### Patch Changes

- 7f14dc0: After `capybara-device login`, say to run `capybara-device start` (or `service install`) to bring
  the device online; the upgrade message names the `next` dist-tag before 0.1.0.

## 0.1.0-rc.2

### Patch Changes

- ec79610: One name: devices. The program says device everywhere: `credential.json` holds `deviceId` (a file
  from an older version is unusable: run `capybara-device logout` and log in again), the default
  directory is `~/capybara-device/<deviceId>`, the sign-in follows the kernel's `device_sign_in.*`
  error codes, and `status` prints `device`. SDK doc comments say device instead of environment.
- Updated dependencies [ec79610]
- Updated dependencies [d495d7d]
- Updated dependencies [18defa0]
- Updated dependencies [0a35407]
- Updated dependencies [cf93278]
- Updated dependencies [199f895]
  - @capybara-hq/plugin-sdk@0.1.0-rc.9

## 0.1.0-rc.1

### Minor Changes

- 812318c: New package `@capybara-hq/device`: the `capybara-device` program with `login`, `logout`, `status`, `start`, `stop`, `drain` and `policy`: the connection to the deployment, operation dispatch, results kept across reconnects, a local command log, and the OS sandbox mode (every command inside `@anthropic-ai/sandbox-runtime`: writes only under the environment directory, secret paths unreadable, network limited to the local policy intersected with the environment's egress). The plugin-tools dependency check can hold a package to the plugin-sdk-only boundary (`deviceDirs`).

### Patch Changes

- 616cc33: `capybara-device` gains Docker mode (commands run with `docker exec` in one container per environment from the published sandbox image, the environment directory mounted at `/workspace`, `/skills` and `/tmp`; no network unless the effective egress allows some, with no domain allowlist) and `service install|uninstall` (a launchd agent on macOS, a systemd user unit on Linux).
- Updated dependencies [c505b45]
- Updated dependencies [ebbfeb5]
  - @capybara-hq/plugin-sdk@0.1.0-rc.6
