# Sandbox development tiers

- Date: 2026-11-12.
- Status: approved (2026-11-12). The direction (three tiers, the same on local devices and cloud
  sandboxes, chosen per device / per org) is the maintainer's, 2026-11-12, marked **(decided)**.
  Calls made here are marked **(designer's call)**; the maintainer answered §14's eight questions as
  recommended (2026-11-12), now recorded decisions. Plan:
  `docs/superpowers/plans/2026-11-12-sandbox-dev-tiers.md`.
- Amends: the environments spec `2026-11-07-environments-design.md` (§8.4 limits and egress, §13.6
  the program), the network ask-to-allow spec `2026-11-12-network-ask-to-allow-design.md` (§7
  「这台设备不限网络」 becomes the `open` tier), `SandboxLimits` and the device protocol
  (`packages/plugin-sdk/src/sandbox.ts`, `device-protocol.ts`), the org setting `sandboxEgress`
  (`packages/kernel/src/orgs/settings.service.ts`), the deployment config `sandbox.limits`, and in
  `capybara-hq/plugins`: `sandbox-docker` (provider, image, egress proxy) and `sandbox-e2b`.
- Supersedes the unmerged local commit `45c326a95` on `fix/acceptance` (device keys
  `allowLocalBinding` / `allowUnixSockets`, `MAC_CHROMIUM_TMPDIR`): its behaviour becomes part of the
  `dev` tier (§5.2); §14 Q8 decides the sequencing.

## 1. Why

The maintainer, 2026-11-12: the sandbox is so restrictive that normal development work is nearly
impossible. "Don't restrict too tightly, or it's basically unusable." The cloud Docker sandbox must
follow the same policy as local devices: **same repo, same branch: develop locally, test in the
cloud.**

What blocks that today (verified on `main` at `74a028f9a`, plus measurements on macOS with
sandbox-runtime (srt) 0.0.81 after `45c326a95`):

- **A local device (OS mode) starts with no network at all** (`DEFAULT_POLICY.allowedDomains = []`);
  every registry has to be allowed by hand or through a network ask. `HOME` is the workspace root,
  so the person's package caches are never used and every device downloads everything again.
- **Local servers and unix sockets** are refused on macOS until `45c326a95` (not on `main`). With it,
  loopback listen and unix sockets under the device's `tmp/` work, `docker.sock` stays refused; but
  `allowLocalBinding` also opens outbound connections to **any** port on the host's localhost, so a
  local proxy such as Clash forwards past the egress allowlist.
- **Browsers on macOS**: Google Chrome aborts at start because srt's Seatbelt profile does not allow
  the sysctls `hw.product` and `kern.hv_vmm_present` (a fixed list in srt's
  `macos-sandbox-utils.js`, not configurable); `chrome-headless-shell` runs only with
  `--single-process` (its multi-process mode fails on mach `bootstrap_check_in`); unix socket paths
  are limited to 104 bytes, and `~/capybara-device/<uuid>/tmp/...` plus Chromium's singleton
  directory goes past it.
- **Linux OS mode**: bubblewrap gives the command its own network namespace (its loopback works but
  is not the host's), and srt's seccomp filter can only block every `AF_UNIX` socket or allow every
  one; the device keeps them all blocked, so browsers and most dev servers using sockets fail.
- **Cloud Docker** (`sandbox-docker`): the image has no Node, no pnpm, no Chromium libraries, no
  `ssh`/`nc`/`socat`; `/dev/shm` is Docker's default 64 MiB; the egress proxy allows `CONNECT` to
  ports 443 and 80 only and speaks no SOCKS, so `git` over SSH, Postgres on 5432 and gRPC on other
  ports fail even for allowed hosts; the org cannot choose `open` (`SandboxEgressSettingSchema` has
  only `none` / `allowlist`); deployment `open` attaches the container to a plain bridge that also
  reaches the host, the intranet and cloud metadata.
- **Cloud E2B**: the domain allowlist filters only HTTP on 80 (Host) and TLS on 443 (SNI); every
  other port is filtered by IP only, so any non-HTTP egress is impossible under `allowlist`.
- **Two vocabularies**: devices have `network: allowlist | open` and `remoteGrants`; orgs have
  `sandboxEgress: none | allowlist`; the deployment has `sandbox.limits.egress: none | allowlist |
  open` gated by the provider's `allowOpenEgress`. Nothing names "a development setup" as a whole.

## 2. Goals, non-goals, anti-goals

Goals:

- **Three tiers, the same everywhere** **(decided)**: `strict`, `dev`, `open`, with one meaning per
  tier across local devices (OS mode macOS / Linux, Docker mode) and cloud sandboxes (Docker, E2B).
  Where an environment cannot implement a property, the gap is named (§6), never silently different.
- **Chosen per device and per org** **(decided)**: the super admin sets the platform's ceiling, the
  org admin the org's ceiling and default, the device owner the device's tier within them (§4).
- **`dev` is the default for personal devices** **(decided)**: loopback servers and unix sockets,
  package caches that work, a built-in preset of common dev hosts, everything else through the
  existing ask-to-allow, and on Docker an image with Node / pnpm / git and Chromium's libraries plus a
  larger `/dev/shm` (§5.2).
- **`open` includes unrestricted egress, which an org can choose** **(decided)**, and, for a local
  device only, an **unsandboxed** option: commands run directly on the host, like Claude Code with
  its sandbox off; only the device owner can enable it; the kernel can never switch it on (§5.4).
- The same repository at the same branch installs, builds, serves, tests and runs a headless
  browser in a local `dev` device and in a cloud `dev` device, with the same toolchain major
  versions (§6, §8).

Non-goals:

- **Containers inside a sandbox** (docker compose, testcontainers): the Docker socket is a sandbox
  escape and is never mounted or reachable in any sandboxed tier (§6.5). Only unsandboxed local
  devices have it, because they have everything.
- **Credentials in cloud sandboxes** (gh, cloud CLIs, private git over HTTPS): the environments
  spec's kernel-backed credential helper and proxy substitution (§8.2 there) is its own design.
  This spec states the gap per tier (§6.2, §6.7).
- **Root in a cloud sandbox** (`apt install` at run time): the root file system stays read-only and
  the user non-root; system packages belong in the image or a custom image (§6.8).
- Per-path or per-method network rules; port-specific allowlist entries.
- Project (shared) devices: they do not exist yet (`devices.owner_kind = 'personal'` only); when they
  arrive, their default tier is `strict` (§4.4).

Anti-goals:

- The model never raises a tier, never turns on unsandboxed, and no Platform operation or API token
  can widen a tier (§10).
- No tier mounts or proxies the Docker socket, host daemon sockets, `~/.ssh`, cloud CLI
  credentials or the keychain while sandboxed.
- No hidden difference: a device's effective tier, and the reason it is lower than chosen, is shown
  on the device page and in the picker.
- `dev` does not make prompt-injection exfiltration easier than it already is with `open`; it never
  reaches private addresses, the host's services (§5.2 proxy guard) or metadata endpoints.

## 3. Terms

- **Tier**: `strict` < `dev` < `open` (ids; zh 严格 / 开发 / 开放; en Strict / Development / Open).
  Ordered, so "min" is defined.
- **Isolation**: `sandbox` (default) or `none`. `none` is the **unsandboxed** option, valid only with
  tier `open` on a local device in OS mode (zh 不使用沙箱; en No sandbox).
- **Ceiling**: the highest tier a layer allows: platform (`sandbox.tiers.max`), org
  (`sandboxTier.max`). **Effective tier** = min(device tier, org ceiling, platform ceiling).
- **Base list** (`L`): the org's effective allowlist as today (`sandboxEgress.allowHosts`, else the
  deployment's `sandbox.limits.allowHosts`), or nothing when the org's or platform's egress is `none`.
- **Dev hosts** (`D`): the platform's preset of common dev hosts (`sandbox.limits.devHosts`, §5.2).
- **Device layer / org layer / address layer**: as in the network ask-to-allow spec §3.

## 4. Who chooses, and how the layers meet

### 4.1 Settings

| Who | Setting | Values | Default |
|---|---|---|---|
| Super admin | `sandbox.tiers.max` (deployment config, hot) | `strict` / `dev` / `open` | `dev` |
| Super admin | `sandbox.tiers.default` | ≤ `max` | `dev` |
| Super admin | `sandbox.tiers.allowUnsandboxed` | boolean | `true` (decided, §14 Q2) |
| Super admin | `sandbox.limits.egress` | `none` / `allowlist` (the value `open` is removed: open egress is now the `open` tier) | `allowlist` |
| Super admin | `sandbox.limits.allowHosts` (`L` default) | hosts | today's 8 hosts, unchanged |
| Super admin | `sandbox.limits.devHosts` (`D`) | hosts, `validateAllowHost` | the preset of §5.2 |
| Org admin | org setting `sandboxTier: { max?, default? }` | tiers ≤ platform; absent = follow the platform | absent |
| Org admin | org setting `sandboxEgress` (unchanged schema) | `none` / `allowlist` + `allowHosts` | absent |
| Org admin | org setting `sandboxTier.allowUnsandboxed?` | boolean, only when the platform allows it | absent = follow the platform |
| Device owner, cloud device | device tier (`devices.tier`, nullable = the org's default) | tiers | null |
| Device owner, local device | local policy `tier`, `isolation` (`policy.json`) | tiers, or absent = the org's default; `sandbox` / `none` | absent, `sandbox` |

`sandbox.tiers.*` and `sandbox.limits.devHosts` follow the adding-config skill (descriptions,
`docs/config.md`). Org settings keep their lenient read: an invalid stored `sandboxTier` reads as
`{ max: "strict" }` (narrower, never wider; the same rule `sandboxEgress` follows today)
**(designer's call)**.

### 4.2 The effective tier and its network

The kernel computes one function, replacing `effectiveSandboxEgress` **(designer's call)**:

```ts
// packages/kernel/src/sandbox/tiers.ts
effectiveSandboxPolicy(deployment, orgSettings, deviceTier: SandboxTier | null): {
  tier: SandboxTier;          // min(deviceTier ?? orgDefault, orgMax, platformMax)
  ceiling: SandboxTier;       // min(orgMax, platformMax): what the device may reach
  cappedBy: "org" | "platform" | null;   // why tier < the chosen one
  egress: "none" | "allowlist" | "open"; // for `tier`
  allowHosts: string[];       // for `tier`
  devHosts: string[];         // D
  allowUnsandboxed: boolean;  // platform && org && ceiling === "open"
}
```

Network per tier, with `L` the base list:

| Org / platform egress | `strict` | `dev` | `open` |
|---|---|---|---|
| `none` (org or platform) | none | none | none |
| `allowlist` | allowlist `L` | allowlist `L ∪ D` | **open** (any public host) |

So `none` stays the kill switch for every tier; `open` egress exists only in the `open` tier, which an
org reaches by raising `sandboxTier.max` to `open` (only when the platform's max is `open`). That
is how "the org can choose unrestricted egress" **(decided)** lands without a second knob on
`sandboxEgress` **(designer's call)**: the org settings page shows it as the 开放 card (§11.2).

**Local devices** keep the network ask-to-allow spec's intersection with the local policy. The
kernel sends, with every exec, the network of the device's **ceiling** plus `D` (it cannot know a
stale local tier); the device computes its own tier `t = min(local tier, ceiling)` and:

- `strict`: `ceilingHosts ∩ allowedDomains` (today; an empty local list allows nothing but grants);
- `dev`: `ceilingHosts ∩ (allowedDomains ∪ D)`;
- `open`: `ceilingHosts` (`*` when the ceiling is `open`), as `network: "open"` does today;

plus run and task grants within the ceiling, as today (network spec §6.3). Address-layer refusals
(loopback, private, link-local) stay refused in every sandboxed tier, by srt's resolved-address guard
and the Docker egress proxy.

**Cloud devices** have no local policy; their network is `egress` / `allowHosts` for the effective
tier, passed at `create` as today.

### 4.3 Where each layer is enforced

- Platform and org ceilings: the kernel, when it builds `SandboxLimits` (cloud `create`, local
  exec args). A local device's tier above its ceiling is cut by the device itself (it gets the
  ceiling in `limits.tier`), and the kernel double-checks with the device's reported tier (§7.3).
- Unsandboxed: the device decides it; the kernel cannot turn it on (§5.4). The kernel **refuses to
  use** a device that reports `isolation: "none"` when `allowUnsandboxed` is false for its org:
  sandbox tools fail with `device.unsandboxed_not_allowed` ("This device runs commands without a
  sandbox, which your organization does not allow. Its owner can turn the sandbox back on with
  `capybara-device policy set isolation sandbox`.") **(designer's call)**. That is governance, not a
  security boundary: the owner controls the machine.

### 4.4 Defaults

- A new personal device (cloud or local) gets the org's default tier, `dev` unless changed
  **(decided)**. A cloud device row stores null ("follow the org default"); a local device leaves
  `tier` out of `policy.json`, which means the same: the kernel sends the org's default with every
  exec (`limits.defaultTier`, next to the ceiling in `limits.tier`) and the device uses
  `min(local tier ?? limits.defaultTier, limits.tier)` **(designer's call)**.
- Project devices, when they exist, default to `strict` and only the project admin raises them
  **(designer's call, consistent with environments spec §8.3)**.
- Existing devices and orgs get `dev` on upgrade: see §12 and §14 Q3.

## 5. The tiers

### 5.1 `strict`: today's behaviour

For shared environments and untrusted work. Exactly what `main` does today, with one change: the
Docker egress proxy stays at ports 443 / 80 and HTTP only, srt keeps `allowLocalBinding: false` and
no unix sockets, local `HOME` stays the workspace root. Network asks (network spec) work as today.

### 5.2 `dev`: the default for personal devices

| Property | Local OS mode, macOS | Local OS mode, Linux | Local Docker mode | Cloud Docker | Cloud E2B |
|---|---|---|---|---|---|
| Loopback servers | srt `allowLocalBinding: true`, with the proxy guard below | own network namespace (always works; not reachable from the host's browser) | container's own loopback | container's own loopback (already today) | VM's own loopback |
| Unix sockets | under `workspace/`, `tmp/` and the short socket dir (below) | all sockets, with host daemon sockets masked (§5.2.3; behind a spike) | container's own | container's own | VM's own |
| Package caches | redirected to `<dir>/cache` (below) | same | `/workspace/.cache` | `/workspace/.cache` | `/workspace/.cache` |
| Network | `ceiling ∩ (local ∪ D)` + asks | same | as `strict` until phase 3: the bridge only when the explicit local list is non-empty (`D` does not count), because the bridge has no domain filter and reaches the host and intranet (§13) | proxy, `L ∪ D`, any port, SOCKS5 (§5.2.4) | `allowOut: L ∪ D` on 80/443 only (§6.6) |
| Toolchain | the person's own | the person's own | the sandbox image (§8) | the sandbox image (§8) | template from the same image |
| `/dev/shm` | n/a | n/a | `--shm-size` (below) | `ShmSize` (below) | the VM's |

#### 5.2.1 Package caches

The goal is that installs work and are fast, without letting a sandboxed command poison the
person's own caches **(designer's call)**:

- **Local OS mode**: commands keep `HOME` = the workspace root (as today), and the device sets
  `XDG_CACHE_HOME`, `npm_config_cache`, `npm_config_store_dir` (pnpm), `PIP_CACHE_DIR`,
  `UV_CACHE_DIR`, `CARGO_HOME`, `GOMODCACHE`, `GOCACHE`, `GRADLE_USER_HOME`,
  `MAVEN_OPTS=-Dmaven.repo.local=…`, `PLAYWRIGHT_BROWSERS_PATH`, `COREPACK_HOME` to subdirectories of
  `<dir>/cache/` (one per device, outside `workspace/` so `Glob` / `Grep` don't wade through it,
  writable, kept across runs, left in place by `capybara-device logout` like the working directory). The person's real `~/.npm`,
  `~/.cache`, pnpm store etc. stay read-only (not denied: reading them is how `npm` finds nothing
  and moves on) **(designer's call)**. A command that sets its own value wins (`args.env` is
  applied after).
- Sharing the host's real caches **writable** is rejected for `dev`: a poisoned cache entry would
  run in the person's own unsandboxed builds later. Unsandboxed devices use the real caches
  (they use everything).
- **Cloud and Docker mode**: `HOME=/workspace` already; the image sets the same variables to
  `/workspace/.cache/...` (on the workspace volume, so they persist with the device's files and pnpm
  can hard-link into `node_modules`), and `pnpm` / `corepack` are told so (§8).

#### 5.2.2 The dev hosts preset `D`

A built-in list in `@capybara-hq/plugin-sdk` (`DEV_HOSTS`, exported so the device and both plugins
read one source; the kernel's `sandbox.limits.devHosts` defaults to it and the super admin may edit
it). The initial list (the builder adjusts it with a test that every entry passes
`validateAllowHost` and an integration note per ecosystem):

- npm / Node: `registry.npmjs.org`, `registry.yarnpkg.com`, `repo.yarnpkg.com`, `nodejs.org`;
- Python: `pypi.org`, `files.pythonhosted.org`;
- GitHub: `github.com`, `api.github.com`, `codeload.github.com`, `raw.githubusercontent.com`,
  `objects.githubusercontent.com`, `release-assets.githubusercontent.com`, `ghcr.io`,
  `pkg-containers.githubusercontent.com`;
- Rust: `crates.io`, `index.crates.io`, `static.crates.io`, `static.rust-lang.org`;
- Go: `proxy.golang.org`, `sum.golang.org`;
- JVM: `repo.maven.apache.org`, `repo1.maven.org`, `plugins.gradle.org`, `services.gradle.org`,
  `downloads.gradle.org`;
- Docker Hub (image metadata and layers for tools such as `crane`): `registry-1.docker.io`,
  `auth.docker.io`, `production.cloudflare.docker.com`;
- Playwright browsers: `cdn.playwright.dev`, `playwright.download.prss.microsoft.com`.

The dev tier's risk text (§11) says these hosts can receive data (pushing or publishing still needs
credentials the sandbox does not hold).

#### 5.2.3 Local OS mode details

- **macOS localhost proxy guard.** `allowLocalBinding` lets a command reach any host-localhost port,
  including a local proxy that forwards past the allowlist (measured with Clash). The device
  therefore checks at start and at each policy reload for a local forwarding proxy: the system proxy
  (`scutil --proxy`: HTTP / HTTPS / SOCKS enabled on `127.0.0.1` / `localhost`), `HTTP(S)_PROXY` /
  `ALL_PROXY` in the program's environment pointing at loopback, and a listener on the common proxy
  ports (7890, 7891, 7897, 1080, 1087, 8118, 9050, 9150) or the Docker TCP ports (2375, 2376). When
  one is found, `dev` runs **without** `allowLocalBinding` and `policy show` / the device page say
  why and how to override (`capybara-device policy set localhost allow`, a local-only key)
  **(decided, §14 Q5)**. The real fix is a port filter in srt (§9).
- **Short socket directory (macOS).** The device creates `/private/tmp/cap-<dirKey8>` (mode 0700,
  writable, unix sockets allowed) and points `TMPDIR` and `MAC_CHROMIUM_TMPDIR` at it, which keeps
  Chromium's singleton socket under 104 bytes; `roots.tmp` (what the kernel's tools use) is
  unchanged.
- **Unix sockets on macOS**: `allowUnixSockets: [roots.tmp, roots.workspace, socketDir]`, never
  `allowAllUnixSockets` (as `45c326a95`).
- **Unix sockets on Linux (spike, phase 1)**: enable srt's all-or-nothing unix sockets **only if**
  host daemon sockets can be hidden: `denyRead` (bwrap masks) on `/run`, `/var/run`,
  `$XDG_RUNTIME_DIR`, `~/.docker/run`, `/tmp/.X11-unix` and every socket the spike finds; abstract
  sockets are already per network namespace under bwrap's `--unshare-net`. The spike must prove
  `docker.sock`, the D-Bus system and session buses, `ssh-agent` and `podman.sock` unreachable.
  If it cannot, Linux `dev` keeps sockets blocked and says so (`policy show`, device page).
- **Browsers**: `dev` documents what works now (macOS: `chromium-headless-shell` with
  `--single-process`; Linux: depends on the spike) and the srt work that lifts it (§9).

#### 5.2.4 Cloud Docker details

- **Egress proxy, `dev` mode** (`egress-proxy/proxy.mjs`, new env `MODE=dev`): `CONNECT` to **any
  port** of an allowed host (as srt does), a **SOCKS5** listener on 1080 with the same host and
  resolved-address checks, so `ssh` (`GIT_SSH_COMMAND="ssh -o ProxyCommand='nc -X 5 -x
  <proxy>:1080 %h %p'"`), gRPC (`GRPC_PROXY`), and SOCKS-aware clients work. Private addresses stay
  refused. `strict` keeps `MODE=strict` (443 / 80, no SOCKS).
- **Container**: `ShmSize = min(1 GiB, memoryMb / 4)` for `dev` and `open` (64 MiB in `strict`);
  env `ALL_PROXY`, `GRPC_PROXY`, `GIT_SSH_COMMAND` as above; the image's cache variables (§8).
- PidsLimit stays 1024, the root file system read-only, the user uid 1000, `CapDrop ALL`,
  `no-new-privileges` in every tier.

### 5.3 `open`

- **Network**: any public host, any port. Cloud Docker: the egress proxy in `MODE=open` (no host
  list, private / loopback / link-local / metadata addresses still refused, HTTP + CONNECT + SOCKS5)
  by default; the old "attach to the shared bridge" behaviour stays available as the plugin setting
  `openEgress: "direct"` for trusted deployments, which also reaches the host and intranet
  **(decided, §14 Q7)**. E2B: `allow_internet_access: true` (E2B checks no destination IP,
  as documented). Local OS mode: srt with `*` (the ask callback allows public names), as
  `network: "open"` today. Docker device mode: the bridge.
- Everything of `dev` (caches, sockets, shm, image).
- The plugin setting `allowOpenEgress` is renamed to `openEgress: "off" | "proxy" | "direct"`
  (default `"proxy"`): `off` refuses `create` with open as today. The kernel's startup warning
  (`sandbox.service.ts`) moves to `sandbox.tiers.max = "open"` with a provider at `off`.

### 5.4 Unsandboxed (local devices only)

- **What it is**: an explicit local `tier: "open"` + `isolation: "none"` in the local policy, OS
  mode only; a tier that is open only because the org's default is open never removes the sandbox,
  and a `policy` op that changes the tier of a device set to `isolation: "none"` also sets it back to
  `sandbox`, so the deployment is never the last step that makes a device unsandboxed (a
  Docker-mode device is already isolated by its container and refuses the key). Commands run with
  `bash -c` directly on the host as the person, with their real `HOME`, `PATH`, environment, caches,
  credentials, keychain, Docker socket and network, like Claude Code with its sandbox off. The
  working directory is still the device's `workspace/`; the kernel's file tools still check paths
  against the device's roots **(designer's call)**: the agent reaches the rest of the machine
  through `Bash`, which is the point, and the file tools' contract stays the same.
- **Process control is unchanged**: commands lead their own process group and carry the
  `EXEC_MARKER`, so `killTagged` / `killAll` / timeouts work as in OS mode (macOS caveat as today:
  a child that leaves the group and runs only Apple binaries cannot be found).
- **Only the device owner turns it on, on the machine**: `capybara-device policy set isolation none`
  prints the risk text and needs `--yes` or an interactive `y` (same flow as `network open` today).
  The device **always** refuses `isolation: "none"` in a `policy` op, whatever `remoteGrants` says;
  turning it **off** from the deployment is accepted (narrowing). The device page offers the switch
  as described in §11.1 and §14 Q1.
- **Kernel gate**: §4.3 (`device.unsandboxed_not_allowed` when the platform or the org forbids it,
  and when the org ceiling is below `open`).
- **Risk text** (zh / en, shown by the CLI and on the device page):
  - 不使用沙箱时，智能体的命令直接以你的身份在这台电脑上运行：能读写你的所有文件、使用你的登录凭据（SSH 密钥、云账号、钥匙串）、Docker 和任意网络。提示注入能让智能体删除文件或把凭据发出去。只在你自己的开发机上、并且完全信任所用的智能体和资料时开启。
  - Without a sandbox, agent commands run on this computer as you: they can read and write all your
    files, use your credentials (SSH keys, cloud accounts, keychain), Docker and any network.
    Prompt injection can make an agent delete files or send your credentials away. Turn it on only
    on your own development machine, with agents and material you fully trust.

## 6. Development scenarios: gaps per environment

`S` = strict, `D` = dev, `O` = open, `U` = unsandboxed. "Today" is `main`.

### 6.1 Dependency install

| Env | Today | With tiers |
|---|---|---|
| Local macOS / Linux | fails: no network by default; caches re-downloaded | D: `D` reachable, caches in `<dir>/cache`; U: the person's own |
| Local Docker mode | image has no Node; network all-or-nothing | D/O: image has Node / pnpm (§8); network as today until phase 3 |
| Cloud Docker | pip / npm registries allowed; no Node in the image | D: Node, pnpm, `D`, caches on the volume |
| Cloud E2B | as Docker (same image) | same as Docker (template from the same image) |

### 6.2 Git over SSH and HTTPS credentials

| Env | Today | With tiers |
|---|---|---|
| Local macOS / Linux | srt sets `GIT_SSH_COMMAND` through its SOCKS proxy, so port 22 to an allowed host works, but `~/.ssh` is denied and `SSH_AUTH_SOCK` is outside the allowed sockets: no key | S/D/O: unchanged (no keys); HTTPS clone of public repos works. U: everything. An opt-in local key `sshAgent: true` (macOS only, adds `SSH_AUTH_SOCK`'s socket to the allowed sockets) is **deferred** to the credentials design: it lets the agent sign with every loaded key |
| Local Docker mode | no ssh in the image | D: `openssh-client` in the image; no keys |
| Cloud Docker | proxy is CONNECT 443 / 80 only: port 22 refused | D/O: SOCKS5 + `GIT_SSH_COMMAND`; port 22 to allowed hosts works; no keys (credentials design) |
| Cloud E2B | port 22 filtered by IP only: refused | D: still refused (E2B filters non-HTTP by IP); O: works |

### 6.3 Local servers

| Env | Today | With tiers |
|---|---|---|
| Local macOS | refused | D/O: loopback listen + connect (proxy guard §5.2.3) |
| Local Linux | works inside the namespace; not reachable from the host | unchanged; documented. U: host loopback |
| Docker / E2B | works in the container / VM | unchanged; preview from the web is a separate feature |

### 6.4 Browsers and e2e

| Env | Today | With tiers |
|---|---|---|
| Local macOS | Chrome aborts (sysctl); headless shell only `--single-process`; socket path ≤ 104 | D: headless shell `--single-process` + short socket dir; full Chrome after the srt fix (§9). U: everything |
| Local Linux | no unix sockets: Chromium fails | D: works if the §5.2.3 spike passes; otherwise Docker mode or U |
| Local Docker mode | no Chromium libs; 64 MiB shm | D: libs in the image, `--shm-size`, browsers downloaded into the cache |
| Cloud Docker | same | D: libs, `ShmSize`, Playwright downloads into `/workspace/.cache/ms-playwright`; Playwright's default `chromiumSandbox: false` avoids needing user namespaces (runc and runsc) |
| Cloud E2B | no libs | D: same image |

### 6.5 Containers (docker compose, testcontainers)

Never in a sandboxed tier: the Docker socket is a full escape (`docker run -v /:/host --privileged`).
Local: unsandboxed only. Cloud: none; a later "service containers" feature (the provider runs
compose services as sibling containers on the instance's internal network) is out of scope and
noted in §15. Testcontainers users point at a remote Docker host only in unsandboxed mode.

### 6.6 Non-HTTP egress (Postgres 5432, gRPC, WebSocket)

| Env | Today | With tiers |
|---|---|---|
| Local macOS / Linux | srt's HTTP proxy allows `CONNECT` to **any port** of an allowed host and its SOCKS proxy any TCP; `ALL_PROXY` / `GRPC_PROXY` are set. Proxy-aware clients work (gRPC, `wss` through clients that honour proxies, ssh); proxy-unaware ones (libpq, most DB drivers) fail; private addresses are refused | unchanged per tier (allowed hosts grow with `D` / asks); U: direct |
| Local Docker mode | bridge: everything | unchanged until phase 3 |
| Cloud Docker | 443 / 80 only | D/O: any port + SOCKS5 (proxy-aware clients); `socat` and `nc` in the image so an agent can bridge a proxy-unaware client (`socat TCP-LISTEN:5432,fork SOCKS4A:…`); private addresses refused; `openEgress: "direct"` for direct TCP |
| Cloud E2B | domains only on 80 / 443 | D: unchanged (documented: E2B can't filter other ports by domain); O: direct |

WebSocket over `wss://` on 443 already works wherever HTTPS does, for clients that honour
`HTTPS_PROXY` (Node's built-in `fetch` / `http` honour it with `NODE_USE_ENV_PROXY=1` on the Node
versions that have it, which the image sets; libraries such as `ws` need an agent of their own).

### 6.7 CLI credentials (gh, cloud CLIs, macOS keychain)

Denied in every sandboxed tier (`DENIED_SECRET_PATHS`, which includes `~/Library/Keychains`, so
`git-credential-osxkeychain` and `gh`'s keyring storage fail). Unsandboxed: available. Cloud: the
credentials design. The device page and `policy show` say which tier gives what.

### 6.8 System tools

- macOS Xcode / `xcrun` / simulators need mach services, `~/Library/Developer` and launchd: not
  workable inside srt; unsandboxed only (stated).
- `apt` in the cloud: no (read-only root, non-root user). The image carries the common set (§8);
  user-space installers (`uv`, `mise`, `rustup` into `CARGO_HOME`) work in `dev` because their hosts
  are in `D` or reachable by an ask; a device may pin a custom image.

### 6.9 Resources

- Cloud: `PidsLimit` 1024 (enough for Chromium + a test runner), memory per `sandbox.limits.memoryMb`
  (2 GiB default; a monorepo `pnpm install` + `tsc` + Playwright wants 4 GiB: the super admin's per-org
  override exists, and the device page shows the effective value), `/tmp` tmpfs at half the memory,
  `/dev/shm` per §5.2.4. Unchanged by tier except shm **(designer's call)**.
- Local OS mode: cpu / memory are not enforced (as today, README); unchanged.

## 7. Contract and protocol changes

### 7.1 `@capybara-hq/plugin-sdk` (public API: `pnpm gen:sdk-api` + changeset)

```ts
export type SandboxTier = "strict" | "dev" | "open";
export const DEV_HOSTS: readonly string[];       // §5.2.2

interface SandboxLimits {
  // existing: cpu, memoryMb, diskMb, egress, allowHosts
  tier: SandboxTier;            // the effective tier (cloud) or the ceiling (local exec args)
  defaultTier?: SandboxTier;    // local exec args only: the org's default (§4.4)
  devHosts: string[];           // D; cloud providers ignore it (allowHosts is final)
}

interface SandboxProvider {
  // optional, additive: apply new limits to a running instance without recreating it
  update?(h, limits, signal): Promise<"updated" | "recreate">;
  // optional: where `create`-time limits are fixed; absent = "instance" (Docker); E2B "fileSystem"
  readonly limitsApplyAt?: "instance" | "fileSystem";
}
```

- `tier` is required (pre-0.1.0, no compatibility); a provider that ignores it still behaves as
  `strict` plus whatever `egress` says, so old plugin versions keep loading.
- `update`: the kernel records the tier and egress mode an instance was created with (§7.2); on
  use, when the effective **tier or egress mode** differs, it calls `update` under the exclusive lease (Docker: recreate the egress
  proxy with the new mode and hosts, `"recreate"` when the shm size changed; E2B:
  `PUT /sandboxes/{id}/network` right after resume, it only works on running sandboxes), and on
  `"recreate"` or without `update` destroys and recreates the instance on the same files, with the
  existing "recreated" notice. **E2B without `update` cannot change a tier without a file reset**,
  because its instance is its file system; hence the method **(designer's call)**.
- What counts as a difference **(designer's call)**: only `tier` and `egress` mode. Changes of
  `allowHosts`, cpu, memory and disk keep today's rule (they reach instances created afterwards),
  so editing the org allowlist does not touch every running device. A NULL record (instances made
  before the migration) reads as `{ tier: "strict" }` with an unknown egress mode and therefore
  differs once, which applies the new tier on first use after the upgrade.
- Before phase 2 the E2B plugin has no `update`; a destroy + create keeps its network as fixed at
  `createFileSystem` (today's behaviour: org egress changes already reach an E2B device only when it
  is recreated). The kernel therefore records new limits only when `update` answered `"updated"`,
  or the instance or file system was actually created with them by a provider whose limits apply at
  instance create (a provider flag `limitsApplyAt: "instance" | "fileSystem"`, E2B the latter), so
  the record never claims more than is in force; the device page shows 「重置文件后生效」 for such a
  device.

### 7.2 Kernel

- Config: §4.1. `sandbox.limits.egress` loses `open` (a config with it fails validation with a
  message pointing to `sandbox.tiers.max`).
- Org settings: `sandboxTier` (`OrgSettingsSchema`, `OrgSettingsPatchSchema`); a patch above the
  platform ceiling fails with `org.sandbox_tier_not_allowed`; `sandboxEgress` keeps its schema.
  `GET` returns the platform's tiers next to `deployment.sandboxEgress`.
- Migration (expand-only, `NNNN_sandbox_tiers.sql`): `devices.tier text NULL CHECK (tier IN
  ('strict','dev','open'))`; `device_instances.instance_limits jsonb NULL` (the limits the current instance
  was created with, written with the fenced create). `device_machines.local_policy` keeps its
  column; its JSON shape changes (§7.3).
- `SandboxService.orgLimits(orgId)` becomes `deviceLimits(device)` using `effectiveSandboxPolicy`;
  the use path compares with `instance_limits` (§7.1). The idle / destroy sweeps are unchanged.
- Local provider: exec args carry `limits` for the ceiling (§4.2); the kernel refuses an exec to a
  device reporting `isolation: "none"` when not allowed (§4.3), re-checked at each exec.
- Routes: `PATCH /api/v1/orgs/:org/devices/:id` accepts `tier` (owner only, cloud devices; local
  devices go through the `policy` op). Platform: the device tier field is an exclusion ("a person
  decides their device's sandbox level"); the org-settings operation accepts `sandboxTier` only when
  it narrows, otherwise an actionable error ("Raising the sandbox level needs a person in the
  organization settings.") **(designer's call)**; the same narrowing-only rule applies to an
  API token (PAT) on the org settings route, and to `sandboxEgress` (a token or the Platform tool
  cannot lift `none` or add hosts to the base list), comparing both the effective values and the
  stored per-field caps (clearing an explicit cap counts as widening); `platform-parity.test.ts` and
  `check:platform-ops` cover both.

### 7.3 Device protocol and program

- `DeviceLocalPolicySummary`: `network` is replaced by `tier: SandboxTier` and
  `isolation: "sandbox" | "none"`; it also reports `localhost: "on" | "off-proxy-detected" | "off"`
  and `unixSockets: "roots" | "all-masked" | "off"` so the device page can say what `dev` really
  gives on that machine.
- `DevicePolicyArgs`: `network` is replaced by `tier`; widening (`tier` up) needs
  `remoteGrants: "owner"`, narrowing is always accepted; `isolation` is accepted only as
  `"sandbox"`.
- `policy.json`: `network`, `allowLocalBinding`, `allowUnixSockets` are replaced by `tier`
  (absent = the org's default), `isolation` (default `sandbox`), `localhost` (`auto` default / `allow`, §5.2.3).
  `policy set tier open` and `policy set isolation none` print the risk text and need `--yes`.
- The device reports both its chosen tier (`tier`, absent = follow the org) and the tier it ran
  the last command at; the kernel cannot verify either and does not try: it trusts the device to
  cut to `limits.tier` (the owner controls the machine anyway) and uses the summary for display and
  for the unsandboxed gate only. A device without the tier feature ignores `limits.tier` /
  `devHosts` and behaves as today, which is `strict`; the kernel keeps using it and the device page
  says the program needs an upgrade for 开发 / 开放 **(designer's call)**.
- Executors: `OsExecutor` builds the srt config from the tier (§5.2.3) and applies a change at the
  next command (`SandboxManager.updateConfig`, as `45c326a95`); a new `HostExecutor` (unsandboxed)
  shares the process tracking of `exec/procs.ts` and the file helpers of `exec/shared.ts`; the
  program switches executor at the next command after a policy change. `DockerExecutor` maps the
  tier to `--shm-size` and the network (§13 phase 3 for a domain proxy).
- The local command log records each command's tier and isolation.

## 8. The image (`plugins/sandbox-docker/image/Dockerfile`)

**One image for every tier** **(decided, §14 Q6)**: what limits `strict` is the policy, not
missing binaries, and a device that changes tier must keep its toolchain ("same repo, same branch").
Added to today's image:

- Node 22 LTS (official tarball, checksum-pinned), `corepack enable` with pnpm and yarn shims,
  `COREPACK_HOME=/workspace/.cache/corepack`, `COREPACK_ENABLE_DOWNLOAD_PROMPT=0`; a project's
  `packageManager` field picks its own pnpm version (downloaded from `registry.npmjs.org`);
- `openssh-client`, `netcat-openbsd`, `socat`, `build-essential` (native npm / pip modules),
  `pkg-config`;
- Chromium runtime libraries (the Debian package set `playwright install-deps chromium` installs,
  pinned in the Dockerfile), `fonts-liberation`, `fonts-noto-cjk` (zh screenshots); no browser
  binary (Playwright downloads its own into `PLAYWRIGHT_BROWSERS_PATH`);
- env: `XDG_CACHE_HOME=/workspace/.cache`, `npm_config_cache`, `npm_config_store_dir`,
  `PIP_CACHE_DIR`, `CARGO_HOME`, `GOMODCACHE`, `GOCACHE`, `PLAYWRIGHT_BROWSERS_PATH`,
  `NODE_USE_ENV_PROXY=1`.

Size grows by roughly 400–600 MB (to be measured in the plan); pre-pulling (README) matters more.
E2B builds its template from the same image (a new tag builds a new template, as today). The
device's Docker mode uses the same image, so it gets the same toolchain.

## 9. sandbox-runtime (srt) work

The macOS limits come from srt's fixed Seatbelt profile and its network filter. Approach
**(designer's call)**: open upstream issues / PRs first, and carry a pinned `pnpm patch` of
`@anthropic-ai/sandbox-runtime` in the meantime only for items that block `dev` acceptance:

1. sysctl reads `hw.product`, `kern.hv_vmm_present` (Chrome / Chrome for Testing start);
2. the mach-lookup services Chromium's multi-process mode registers (`bootstrap_check_in`), scoped
   to Chromium's service names, never a blanket allow;
3. a localhost port filter for `allowLocalBinding` (allow loopback listen and connections to ports
   the sandbox's own processes bound, or at least a port denylist), which removes the proxy guard's
   downgrade of §5.2.3;
4. a structured violation field (already requested by the network spec §4.1).

Each patched item has a device test pinned to the srt version; upgrading srt drops the patch.

## 10. Security review

### 10.1 What changes in the trust model

- `dev` widens the default for personal devices: local loopback servers (macOS: also the host's
  localhost services, unless the guard turns it off), unix sockets under the device's directories,
  the dev hosts preset, cloud SOCKS and any port to allowed hosts. It never adds credentials,
  private addresses, the Docker socket or host daemon sockets.
- `open` lets an org choose open egress, which today only the super admin can (deployment-wide).
- Unsandboxed removes the sandbox on a person's own machine, on that person's own local action; the
  platform and the org can forbid using such a device, never enable it.

### 10.2 Threats

| Threat | Measure |
|---|---|
| Prompt injection exfiltrates through a dev host | Stated in the dev risk text and the README rule "an allowlist does not prevent exfiltration"; pushing / publishing needs credentials the sandbox does not hold; `strict` and `sandboxEgress: none` remain for sensitive orgs |
| A local forwarding proxy bypasses the allowlist (macOS) | Proxy guard turns `allowLocalBinding` off when one is detected (§5.2.3); srt port filter later (§9) |
| A host daemon socket is reachable (Docker, D-Bus, ssh-agent) | macOS: path-scoped sockets only; Linux: only after the spike proves the masks (§5.2.3); never `allowAllUnixSockets` on macOS |
| The cloud or a misled agent turns on unsandboxed | The device refuses `isolation: "none"` from any `policy` op; no Platform op; the CLI needs `--yes` locally |
| The cloud raises a device's tier | Local: only under `remoteGrants: "owner"`, by the owner in a signed-in session (network spec §5.2), audited; cloud devices: owner-only route, human-only; the Platform tool can only narrow |
| An org admin opens egress for every member's machine | The org ceiling only allows; each local device's own tier still decides (`open` on a local device is the owner's choice) |
| `open` on cloud Docker reaches the host / intranet / metadata | Default `openEgress: "proxy"` refuses private addresses; `direct` is an explicit plugin setting with the existing warning |
| Cache poisoning of the person's own builds | Local caches are per device under `<dir>/cache`; the person's caches are read-only |
| Unattended runs on open / unsandboxed devices | §11.4 and §14 Q4 |

### 10.3 Multi-replica and multi-tenant

Effective policy is computed from PG (org settings, device row) and config at each use; the
instance's limits are a column on the device row, written by the fenced create; `update` runs under
the exclusive lease. Nothing in process memory. Every lookup is org-scoped as today.

### 10.4 Audit

- Kernel: `org.settings_updated` covers `sandboxTier` (before / after); `device.tier_changed`
  (cloud: by the owner; local: the `policy` op, recorded with the existing `device.policy_changed`
  plus `tier`); `device.isolation_reported` when a device's hello first reports
  `isolation: "none"` and when it returns to `sandbox`; a refused use of an unsandboxed device is
  logged (warn), not audited per call.
- Device: the local command log records tier and isolation per command and every policy change.
- Web: the device page's recent changes include tier and isolation changes.

## 11. UI

### 11.1 Device page (owner)

A section 「沙箱级别」 / "Sandbox level" for every device (cloud and local), replacing the local
network section's 「不限网络」 switch:

- three cards (严格 / 开发 / 开放), each with one line of what it allows and the selected one marked;
  a card above the ceiling is disabled with 「组织最高允许：开发」 / 「平台最高允许：开发」;
- the effective tier and, when lower than chosen, why;
- for local devices, what `dev` gives on this machine (from the summary: 本机端口 on / off and why,
  unix sockets, the note for Linux), and `remoteGrants` as today; raising the tier needs
  `remoteGrants: owner` (else the card shows the CLI command);
- choosing 开放 opens a confirm dialog with the risk text (the existing `OpenNetworkDialog`, reused);
- for local OS-mode devices under 开放, a 「不使用沙箱」 row: when off, it shows the local command
  (`capybara-device policy set isolation none`) with the risk text and a copy button (§14 Q1);
  when on, a warn badge and a 「恢复沙箱」 button (sent as a narrowing `policy` op);
- a cloud device's tier change notes 「下次使用时生效，文件保留」.

The device list and the composer's device picker show a badge for 开放 (warn tone) and 不使用沙箱
(danger tone).

### 11.2 Org sandbox settings (`/settings/sandbox`)

- A new section 「沙箱级别」 above 网络: 「最高级别」 as three cards (严格 / 开发 / 开放) and
  「新设备默认」 as a select ≤ the highest. The 开放 card is the org's open-egress choice: its
  description says any public address is reachable and it carries the risk text; it is disabled
  with 「平台未开放」 when the platform's max is below `open`. 「允许成员的设备不使用沙箱」 appears
  under 开放 when the platform allows it.
- The 网络 section keeps follow / none / allowlist and adds one line under allowlist:
  「开发级别还会放行常用开发域名（n 个）」 with the list in a disclosure.
- i18n zh / en; zh says 平台 / 超级管理员 / 智能体 (`check:i18n`).

### 11.3 Admin console (super admin)

The deployment's tiers are config (`sandbox.tiers.*`, hot); the admin console's sandbox page shows
them read-only with the config keys, as it does for `sandbox.limits` today.

### 11.4 Scheduled and unattended runs

A run without a person watching (`runs.scheduled_task_run_id` set) uses
**min(effective tier, `dev`)** unless the task grants `tier:open` (a task grant collected like tool
grants, by its creator on the task form, refused when the device or org cannot reach `open`); an
unsandboxed device runs unattended only with the same grant, otherwise the run's sandbox tools fail
with an actionable note and `missing_grants` records it **(decided, §14 Q4)**. Local
devices get the cap in the exec args (`limits.tier`), so the device enforces it. A cloud device's
tier is a property of its shared instance, so the cap cannot be applied per run: an unattended run
on a cloud device whose effective tier is `open` without the grant fails its sandbox tools with the
same note instead of switching the instance under attended sessions **(designer's call)**.

### 11.5 What the model sees

The `device_paths` event (already in the log, model-visible, needs no `DriftReason`) gains the
effective tier and isolation, rendered as one English line, e.g. "Sandbox level: development.
Package registries and common developer hosts are reachable; other domains need the user's
approval. Local servers and unix sockets work." Recorded on the first sandbox call and whenever
the tier or isolation changes **(designer's call)**. Zero-drift fixture tests run before and after.

## 12. Migration (pre-0.1.0: no compatibility layers)

- **Deployment config**: `sandbox.limits.egress: "open"` fails validation with the pointer to
  `sandbox.tiers.max: open`; `allowOpenEgress` in `sandbox-docker` / `sandbox-e2b` config fails the
  plugin's strict schema with a pointer to `openEgress` (invalid extension config never fails
  startup; the plugin reports `needsConfig`).
- **Org settings**: nothing stored changes; `sandboxTier` absent = follow the platform (`dev`).
- **Devices**: cloud device rows get `tier = NULL` (org default, `dev`); their next use sees
  `instance_limits` NULL ≠ effective and updates or recreates the instance (files kept, notice).
- **`policy.json`**: read leniently; `tier` absent = the org's default (§4.4); `network`, `allowLocalBinding`,
  `allowUnixSockets` are ignored on read and dropped on the next write. A stored `network: "open"`
  becomes the org default (`dev` unless changed; narrower), and `start` prints once: "policy.json: `network` is replaced by `tier`;
  run `capybara-device policy set tier open` to keep an unlimited network." That is a notice, not a
  compatibility layer.
- **`device_machines.local_policy`**: an old summary without `tier` reads as unknown until the next
  hello; the device page shows 「设备程序需要升级」 for features it lacks, as today.
- **Existing devices widen to `dev` on upgrade** (§14 Q3).

## 13. Phases

| Phase | Scope | Repos / packages |
|---|---|---|
| 1 | SDK types and `DEV_HOSTS`; kernel config, org `sandboxTier`, `effectiveSandboxPolicy`, `devices.tier` / `instance_limits`, `update` handling, local exec args, unsandboxed gate, audit, Platform op rules, `device_paths` tier line, unattended cap; device `tier` / `isolation` / `localhost`, caches, short socket dir, proxy guard, `HostExecutor`, Linux unix-socket spike; web device page, org settings, picker badges | core: plugin-sdk (changeset), kernel, device (changeset), web |
| 2 | Image (Node, corepack, ssh / nc / socat, Chromium libs, cache env); egress proxy `MODE` strict / dev / open, any port, SOCKS5; provider: tier → shm, env, proxy mode, `update`, `openEgress`; E2B: allowOut per tier, `update` via network PUT, `openEgress`; core: `bootstrap.json` `marketplace.commit` bump, compose `sandbox` profile pinned to it | plugins: sandbox-docker, sandbox-e2b; core: bootstrap |
| 3 | srt items of §9 (patch then upstream); Docker device mode behind the plugin's egress proxy image (domain filter, network spec phase 3); cloud device layer for asks (network spec phase 3) | core: device; plugins |

Phase 1 can ship before phase 2: cloud providers that ignore `tier` keep today's behaviour, and the
kernel's `devHosts` merge already widens cloud allowlists in `dev`. Phase 1 touches trust
boundaries (device widening, the unsandboxed gate) and is reviewed alone on the most capable model;
the `haproxy.cfg` rules are unchanged (`ShmSize` is not filtered), so no cross-repo proxy change.

## 14. Decisions (maintainer, 2026-11-12)

The eight questions this section held were answered "as recommended"; the text below keeps each
question with its answer.

1. **How does the device page turn on unsandboxed?** The direction says "locally or on the device
   page with a risk confirmation" and "the kernel must never be able to switch it on remotely".
   Both can't fully hold: a web switch that takes effect is a remote switch. Options: (A) the page
   shows the risk text and the exact local command with a copy button; nothing is sent; (B) a local
   key `remoteUnsandboxed: allow` (default off, set only locally) lets the page's switch work, like
   `remoteGrants`; (C) the page sends a request the program holds until confirmed on the machine
   (needs an OS notification or a terminal). **Decided: A** (the kernel truly cannot enable
   it; B is a later, opt-in convenience).
2. **Is unsandboxed allowed by default on the platform?** **Decided:**
   `sandbox.tiers.allowUnsandboxed` defaults to `true`, but it only works where the org ceiling is
   `open`, which the default (`dev`) is not; so an org admin's deliberate 开放 plus the owner's local
   `--yes` are both needed.
3. **Existing devices and orgs move to `dev` on upgrade** (local loopback / sockets / dev hosts,
   cloud dev hosts, SOCKS and any port to allowed hosts), without the owners doing anything. The
   direction makes `dev` the default; this confirms it applies to existing devices too.
   **Decided: yes**, with a one-time notice on the device page.
4. **Unattended runs**: cap at `dev` unless the scheduled task grants `tier:open`, and run on an
   unsandboxed device only with that grant. **Decided: yes** (no person watches a prompt
   injection there).
5. **macOS localhost reach in `dev`**: ship with the proxy guard (dev runs without local binding
   when a local proxy or Docker TCP port is detected; local override `localhost allow`), or keep
   local binding off in `dev` until srt has a port filter. **Decided: ship with the guard**;
   carry a `pnpm patch` of srt only for the Chrome sysctls (§9 item 1) and send the rest upstream.
6. **One image for every tier** (+400–600 MB for everyone, including strict deployments) or a
   separate dev image (two images to publish and pre-pull, E2B templates per tier, a toolchain that
   changes with the tier). **Decided: one image.**
7. **Cloud `open` on Docker**: through the egress proxy (any public host and port, private and
   metadata addresses refused, proxy-aware clients only) by default, with the old direct bridge as
   `openEgress: "direct"`. **Decided: yes**; direct TCP for libpq-style clients needs
   `direct` or `socat`.
8. **Commit `45c326a95`** (`allowLocalBinding` / `allowUnixSockets` as user keys, default true): its
   keys are replaced by `tier` here. **Decided:** do not merge its keys; keep its executor
   changes (`updateConfig`, `MAC_CHROMIUM_TMPDIR`) and fold them into phase 1, so no release ships
   keys that the next one removes.

## 15. Left to the builder

- The exact `DEV_HOSTS` list per ecosystem, the Chromium library set, Node minor and checksum pins.
- The proxy guard's detection details (`scutil` parsing, port probe timing) and its tests.
- The Linux spike's mask list and the decision record it produces.
- Copy for each card's one-line description (zh / en), within the terms of §3.
- Whether `update` on Docker can keep the container when only the egress proxy changes (expected
  yes) and its tests against a real Docker.
- Later, not here: service containers for cloud devices (compose services as siblings on the
  instance's internal network), the credentials design (git, gh, cloud CLIs, ssh-agent), web
  previews of a device's local server.

## 16. Tests (outline)

- SDK: `DEV_HOSTS` all valid; `parseHello` / `policy` op with `tier` / `isolation`; `isolation:
  "none"` refused by the op's guard.
- Kernel: `effectiveSandboxPolicy` table (every row of §4.2, caps and `cappedBy`); org patch above
  the platform refused; Platform op narrows only; cloud device tier change → `update` or recreate
  with the notice, files kept (sandbox-fake records limits); unsandboxed device refused when not
  allowed, accepted when allowed; unattended cap and `tier:open` grant; `device_paths` tier line;
  dual-replica: tier changed on one replica, used on the other.
- Replay: zero-drift fixture tests before and after; a reconstruct case with the tier line.
- Device: srt config per tier and platform; cache env; short socket dir; proxy guard detection
  (fake `scutil`, env, a listener on 7890); `HostExecutor` exec / kill / timeout parity with
  `OsExecutor`; policy op widening rules; OS-mode integration: `dev` reaches a fake registry host
  in `D`, `strict` does not; Linux spike tests on the Linux CI runner.
- Plugins: egress proxy `MODE` strict / dev / open (ports, SOCKS5, private addresses refused);
  provider shm / env / labels per tier; `update`; image smoke test (`node`, `pnpm`, `ssh`, `socat`,
  `npx playwright install chromium && a headless page load` under runc, and under runsc in the live
  checklist); E2B allowOut per tier and live `update`.
- Web: device page tier cards (capped, remoteGrants off, unsandboxed command view), org settings
  tier section and 开放 card disabled state, picker badges, i18n.
