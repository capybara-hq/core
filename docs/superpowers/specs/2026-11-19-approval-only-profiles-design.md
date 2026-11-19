# Approval-only permission profiles and device sandbox settings

Status: design amendment. The maintainer approved its three decisions and the trimmed R3 scope on
2026-11-19 (section "Decisions"); the rest is the author's technical design, for review. It amends
the [conversation permission profiles design](2026-11-16-conversation-approval-profiles-design.md),
including its "Per-call sandbox escalation" section, and the parts of the
[operation contract](2026-11-16-permission-operation-contract.md),
[call grants](2026-11-16-permission-call-grants-and-approvals-design.md),
[context replay](2026-11-16-permission-context-replay-design.md) and
[runtime cutover](2026-11-16-permission-runtime-cutover-design.md) designs that tied a profile to
the execution boundary. It records the maintainer decisions and the coordinator's guardrails of
2026-11-19. Binding: `perm/w4-int` at `91917b4b3`, which includes the merged per-call escalation
(`perm/call-escalation`, migration `0162`). R3 starts from `perm/w4-int` after R2 merges to `main`.
The plan is [2026-11-19-approval-only-profiles](../plans/2026-11-19-approval-only-profiles.md).

## Decisions (maintainer, 2026-11-19)

1. **Cloud devices: the instance is the sandbox.** A provider declares `boundary: "instance"`. The
   container or microVM is the sandbox, its whole filesystem is the scope, and its outer network,
   which the provider enforces, is the sandbox network. All three profiles are offered. On a cloud
   device they differ only in sensitive-command consent. There are no directory crossings and no
   running outside the sandbox. A new host on an allowlist cannot be granted per call, because the
   provider's network covers the whole instance, so the reply says to add the host to the device's
   list. If a provider later declares `boundary: "operation"`, it can use the Linux per-operation
   runtime.
2. **Full access keeps a shorter confirmation.** Consent stays bound to the device and its crossing
   ceilings. A device switch or a widened ceiling resets the conversation to Approve for me.
3. **Cloud metadata, link-local addresses and the Docker and kernel sockets are reachable only by
   running outside the sandbox.** With the trimmed scope this also holds for private and LAN ranges
   and for the host's other loopback ports. Inside the sandbox they are simply closed.

## What changes, in one paragraph

A **profile** only chooses who approves a crossing:

- Request approval: the person.
- Approve for me: the review model, falling back to the person.
- Full access: nobody.

The **sandbox** is a property of the device and is the same under all three profiles. It consists
of:

- the scope: the project root, the workspace, scratch and tool directories;
- the sandbox network: the open public internet by default, or an allowlist;
- whether a call may run outside the sandbox.

Full access never removes the sandbox. Its commands run inside it. Its crossings are granted
automatically within the device's ceilings, and every one is recorded and audited. The fixed denies
and the minimal environment hold under every profile.

## Superseded parts of earlier designs

| Earlier text | Now |
|---|---|
| Profiles design, "Proposed behavior" table, Full row: "use the device authority its owner/admin already granted" | Full access auto-approves crossings within the device ceilings; commands stay in the sandbox |
| Profiles design, Codex-style preset (Full access removes the sandbox) and the approach-3 coupling | The sandbox and the profile are independent (Claude Code model) |
| Profiles design, "Full access is unavailable when that ceiling forbids it" | Full access is available wherever any profile is; the ceiling bounds only running outside the sandbox |
| Profiles design, "Per-call sandbox escalation": "Until it lands, Full access still runs every call unsandboxed, so an escalation under Full access is a no-op"; "Escalation is possible only where Full access would be"; "E2B is Full only" | Full access runs in the sandbox and its escalation is a real, audited auto-grant within the outside-sandbox ceiling; the ceiling is renamed; cloud devices have no outside |
| Operation contract, "Full access uses `filesystem.kind: "device"` and `network.kind: "environment"`" | Only an escalated call uses that pair (`isFullExecutionScope`); every profile's ordinary call is scoped |
| Operation contract, `DeviceOwnerCeiling.fullAccess`, `restrictedAllowedDomains` "a restricted-profile allowance" | `outsideSandbox`, `network`, `allowedDomains` describe the device sandbox for every profile |
| Operation contract, `SandboxPermissionSupport` v1 | v2 (section "SDK and protocol") |
| Operation contract and cutover, `SandboxLimits.mode` as the internal ceiling encoding | Removed; lifecycle receives the outer network only |
| Context replay design, refine "Full access must be device + environment" | Every profile records a scoped sandbox |
| Call grants design, "`issueLocked` rejects full-access" | Full access issues grants with source `full-access`, recorded and audited |
| Config activation and cutover: `devices.fullAccess`, org `fullAccess`, `devicesFullAccess`, org `cloudNetwork` | Renamed and reshaped (section "Settings model") |

Everything else in those designs still stands:

- operation identity, admission, epochs and revocation;
- immutable call-bound grants;
- owner-only profile changes;
- pending-card supersession;
- starting grants for started work;
- the event log as the source of truth;
- no daily sandbox picker in the composer.

## Profiles

A **sensitive command** is one the review rules classify as consent:

- the `ask.*` rules: `ask.sudo`, `ask.credential-print`, `ask.credential-link`, `ask.persistence`,
  `ask.shell-config`, `ask.ssh`, `ask.secret-file`, `ask.global-install`, `ask.force-push`,
  `ask.remote-destroy`, `ask.remote-write`, `ask.docker-privileged`, `ask.kill-other`,
  `ask.git-exec`, `ask.dynamic-arg`;
- every `unsure.*` rule.

They live in `sandbox/review/rules.ts`.

| Request | Request approval | Approve for me (default) | Full access |
|---|---|---|---|
| Read, edit, command inside the sandbox scope; network the sandbox allows | Runs | Runs | Runs |
| Directory outside the scope (`directory`) | Ask | Review model | Auto-grant, recorded |
| New host while the network is an allowlist (`host`) | Ask | Review model | Auto-grant within the network ceiling, recorded |
| Run this call outside the sandbox (`outside-sandbox`): also the only way to reach private, LAN, loopback, link-local and metadata addresses, the sockets and the protected paths | Ask | Review model | Auto-grant within the outside-sandbox ceiling, recorded |
| Sensitive command | Ask | Review model | Runs, recorded (unchanged from today) |
| Fixed deny (rule `deny.*`, a platform or org deny, protected paths inside the sandbox) | Deny | Deny | Deny |
| Crossing beyond a ceiling | Unavailable: an actionable error that names the layer | Same | Same |

The review model's verdict counts only when it is an allow or a deny. An unavailable or unsure
model, a failing classifier or an unmapped review purpose all ask the person (today's
`decidePermission`). A deny from the model stays a deny.

**The review model sits behind the fixed denies.** `CommandReviewService.decide` evaluates the rule
table first, and a `deny.*` hit returns before `decidePermission` runs. A directory grant can never
add a protected path to the scope: the candidate builder refuses it, admission checks again, and
the device intersects again. A prompt-injected allow therefore never crosses a fixed deny.

**Sensitive consent under Full access** stays skipped, as today. This does not conflict with the new
model. The sandbox still holds the protected paths and the minimal environment, so `sudo` or a
credential read inside the sandbox fails by enforcement. Doing either for real needs an
outside-sandbox crossing, which the ceiling bounds. Every skip is recorded with crossing kind
`sensitive`.

**Unattended runs** (scheduled tasks) use Request approval with every ask turned into a deny, as
today. They get the same sandbox. Their crossings are limited to the task's explicit host grants.
They never escalate (the merged `escalationRefusal`) and never inherit a chat's Full access.

**Sub-agents** resolve the root's profile live:

- Their `directory` and `host` crossings use the root's approver.
- Their `outside-sandbox` escalation is decided by the person under Request approval and by the
  review model under Approve for me **and under Full access**. A sub-agent's escalation is never
  auto-granted. This keeps the merged rule ("only the person or the review model approves, never
  the agent itself") now that Full access really auto-grants.
- Another account's call never gets a crossing; `reviewCall` refuses a device call by a non-owner.

## Fixed denies and the minimal environment

These hold under every profile, Full access included.

**Protected paths inside the sandbox:**

- the owner-denied secret paths (`DEVICE_DENIED_SECRET_PATHS`): `~/.ssh`, `~/.aws`, gcloud,
  `.azure`, `.kube`, `.docker/config.json`, `.netrc`, `.gnupg`, browser profiles, `gh`,
  `.git-credentials`, `.npmrc`, `.pypirc`, Keychains;
- the device state directory;
- the persistence vectors already in `SANDBOX_MANDATORY_WRITE_DENIES`: shell rc files,
  `.git/hooks`, `.git/config` and the rest of that list;
- the persistence vectors this change adds: `~/Library/LaunchAgents`, `~/Library/LaunchDaemons`,
  `~/.config/systemd/user`, `~/.config/autostart` and the user crontab spool. `crontab` itself needs
  a setuid helper, which the sandbox refuses.

No directory grant covers a protected path. A proposal that would cover one returns `unsupported`,
with a message offering the outside-sandbox escalation.

**Only an explicit per-call escalation reaches the protected paths.** Request approval asks,
Approve for me goes to the review model, and Full access auto-grants only within the outside-sandbox
ceiling. Rule-table denies (`deny.secret-exfil`, `deny.root-destroy`, `deny.tooling-edit`) stay
denies for an escalated call too, which the merged escalation already tests.

**Minimal environment.** A sandboxed command never inherits the device program's environment. It
gets:

- `PATH` and `LANG`;
- `HOME`, set to the working root;
- a private `TMPDIR`, `TMP` and `TEMP`;
- the tool homes the device detects (`restrictedToolHomes`);
- the proxy variables;
- the call's own `env`.

This is today's restricted environment (`operation-worker.ts`, `linux-operation-worker.ts`). Full
access now uses it too; today Full access inherits `process.env`. With the network open,
exfiltration is therefore limited to what the sandbox can read: the project, the workspace and the
readable tool directories. It never includes the device's secrets, tokens or protected paths.

An escalated call runs as the owner by definition. It gets the device program's environment minus
every `CAPYBARA_*` variable and the device credential.

## Settings model

### Fields

| Setting | Values | Meaning |
|---|---|---|
| Sandbox network | `network: "open" \| "allowlist"`, `allowedDomains: string[]` | `open` is the public internet (section "Open network"). `allowlist` is only the listed hosts, plus per-call host grants. |
| Outside the sandbox | `outsideSandbox: "allowed" \| "off"` (device owner: a boolean) | Whether a call may be granted escalation outside the sandbox. This is the renamed "Full access ceiling". |
| Project reach | `restrictedProjectReach` | Unchanged: name, values, default, control and widening rule as today. |

### Layers, writers and intersection

| Layer | Writer | Keys | Defaults |
|---|---|---|---|
| Platform | the super admin: startup config (env > file / Nacos), else the admin console | `devices.outsideSandbox`, `devices.network.default`, `devices.network.ceiling`; the host list `sandbox.limits.allowHosts` with `orgHosts`; the kill switch `sandbox.limits.egress` | `allowed`, `open`, `open` |
| Org | an org admin in a web session (only narrowing through the Platform tool or an API token, as today) | `outsideSandbox`, `deviceNetwork { default?, ceiling?, base?, extraHosts?, excludedHosts? }` | absent = follow the platform |
| Device, local | the owner on the machine (`capybara-device ceiling set`) widens; the owner in a web session narrows | on-disk `ownerCeiling { outsideSandbox, restrictedProjectReach, network }` and `allowedDomains` | new install: `outsideSandbox: false`, `network: "open"`, reach as today |
| Device, cloud | the device owner or an org admin in a web session, both directions within the org and platform ceilings | `devices.network_mode`, `devices.network_hosts` | absent = follow the org |

The effective values come from one pure function, `effectiveDeviceSandbox(platform, org, device,
provider)`, in the new `packages/kernel/src/sandbox/device-sandbox.ts`. The device mirrors it in
`intersectOperation`.

- **`outsideSandbox`:** allowed only when the platform, the org, the device owner and the provider
  all allow it. An instance-boundary provider never does.
- **Network ceiling:** the narrower of the platform and org ceilings, where `allowlist` is narrower
  than `open`. It is `allowlist` with an empty list when the kill switch is `none`.
- **Network mode:** the device's choice, else the org default, else the platform default. It is then
  clamped to the ceiling, and for a cloud device also to the provider's outer network.
- **Allowlist hosts when the ceiling is `open`** (the owner chose the allowlist): the owner's
  `allowedDomains`, plus the org's effective hosts (`orgEffectiveHosts`).
- **Allowlist hosts when the ceiling forces `allowlist`:** the org's effective hosts, plus those of
  the owner's hosts the org's list covers.
- **Per-call host grant:** possible under `orgHosts: extend`. Under `within`, only for hosts the list
  covers; otherwise it is unavailable ("an admin adds the host").

The local device intersects every request with its on-disk ceiling even when the kernel's view is
stale; that rule is unchanged.

- The web can narrow a local ceiling through the v3 `policy` op: switch the network to `allowlist`,
  remove hosts, or turn `outsideSandbox` off.
- Widening happens only on the machine.
- A cloud device has no machine, so its owner or an org admin changes its network in both
  directions, within the ceilings.

### Why open is the shipped default

Every device must be able to do development work. Package installs, git over HTTPS, documentation
fetches and API calls are routine, and an empty allowlist makes the default device useless.

Open egress stays bounded. The sandbox holds the filesystem, the environment is minimal, and private
ranges and the host's own services stay closed. So open public egress exposes only what the sandbox
can read.

An enterprise that needs egress control sets `devices.network.ceiling: allowlist` on the platform,
or `deviceNetwork.ceiling: allowlist` on an org, and keeps its list in `allowHosts` / `extraHosts`.

### Config keys and API fields

Before 0.1.0 these are renamed directly, with no aliases.

| Old | New |
|---|---|
| `devices.fullAccess` (`CAPYBARA_DEVICES__FULL_ACCESS`), admin `devicesFullAccess` | `devices.outsideSandbox` (`CAPYBARA_DEVICES__OUTSIDE_SANDBOX`), admin `devicesOutsideSandbox`; hot |
| (none) | `devices.network.default`, `devices.network.ceiling` (`open \| allowlist`); hot, published like the other permission keys |
| org `fullAccess` | org `outsideSandbox` |
| org `cloudNetwork { mode, base, extraHosts, excludedHosts }` | org `deviceNetwork { default, ceiling, base, extraHosts, excludedHosts }`, for local and cloud devices |
| local `ownerCeiling { fullAccess, restrictedProjectReach }` | `ownerCeiling { outsideSandbox, restrictedProjectReach, network }` |
| wire `DeviceOwnerCeiling { fullAccess, restrictedAllowedDomains, … }` | `{ outsideSandbox, network, allowedDomains, restrictedProjectReach, revision, sequence, version }` |
| cloud `devices.owner_full_access` | `devices.network_mode`, `devices.network_hosts` (a cloud device has no outside) |
| errors `org/deployment/device.full_access_not_allowed` | `*.outside_sandbox_not_allowed`; new `*.network_not_allowed` for a mode above the ceiling |
| `capybara-device ceiling set --full-access` | `capybara-device ceiling set --outside-sandbox on\|off --network open\|allowlist` |
| facts `fullAccessCeiling`, `escalationRefusal` text "Full access ceiling" | `outsideSandboxCeiling`; texts say "running outside the sandbox" |

**Conversion of old keys:**

- `config/load.ts` refuses the old config keys with a conversion message.
- `capybara config migrate-permissions` converts file and Nacos documents.
- Stored values are converted, not aliased. `convertStoredPermissionKeys` gains the conversions in
  section "Migration"; it moves from `sandbox/platform-full-access.ts` to
  `sandbox/device-sandbox-settings.ts`.
- The device's strict policy parser converts an old `policy.json` once on start.
- The permission config fingerprint covers the new keys. A deployment that changes them activates
  with `--activate-permission-config`; that mechanism is unchanged.

## Open network

`open` means the public internet. Every sandboxed connection is decided on the **resolved address**
by the operation's own proxy: macOS SRT, the Linux forwarder, or a provider's egress proxy. The proxy
dials the address it checked, so DNS rebinding cannot swap it.

An IP literal is classified by the same rules as a resolved name. SRT skips its resolved-address
guard for literals, so the macOS worker adds explicit `deniedDomains` CIDR rules.

Closed in open mode, and reachable only by running outside the sandbox:

- private and LAN ranges: `10/8`, `172.16/12`, `192.168/16`, CGNAT `100.64/10`, IPv6 ULA `fc00::/7`;
- link-local and metadata: `169.254/16` (including `169.254.169.254`), `fe80::/10`, `fd00:ec2::254`;
- loopback and this host's own interface addresses, so another process's localhost port is closed.
  The command's **own** TCP loopback listener stays reachable within the operation. On Linux the
  broker allows a connect to ports the operation itself bound. On macOS this comes with the separate
  loopback-listening fix;
- the Docker and kernel sockets: UNIX sockets outside the write roots stay refused
  (`/var/run/docker.sock`, `~/.docker/run/docker.sock`, `/run/containerd`), and so does TCP to them
  over loopback;
- multicast, broadcast, `0/8` and the NAT64 prefixes.

Traffic goes through the proxy. HTTP(S)- and SOCKS-aware clients work on any TCP port. A client that
ignores proxy variables, such as plain `ssh`, does not connect from the sandbox. The `Bash`
description says so, and notes that `GIT_SSH_COMMAND` with a SOCKS `ProxyCommand` works.

The address classes live in one SDK table: `packages/plugin-sdk/src/network-classes.ts`, pure data
plus `classifyAddress`. The device workers consume it. A unit test checks it against the kernel's
`net/public-address.ts`, and a hash test checks it against the Linux forwarder's copy, so the
classes cannot drift.

## SDK and protocol

- `SandboxNetworkScope` gains `{ kind: "open-public" }`.
- `environment` is legal only together with `filesystem: device`. That pair is the escalated call,
  recognized by `isFullExecutionScope` as merged. The profile stays in the scope for audit only;
  providers never derive enforcement from it.
- `SandboxPermissionSupport` becomes version 2:
  `{ version: 2, boundary: "operation" | "instance", restricted: {filesystem, network, native,
  concurrentScopes} | null, network: { openPublic, allowlist, perOperationHosts }, outsideSandbox,
  background, unavailableReason? }`. `boundary: "instance"` with `restricted: null` is a supported
  device whose scope is the whole instance.
- `SandboxLimits.mode` is removed. Lifecycle create and update carry only resources and the outer
  network.
- The device protocol's `DeviceOwnerCeiling` takes the new fields, and `DeviceOwnerCeilingNarrowing`
  can narrow each of them. If R2 shipped protocol 3, this is protocol 4: a paired kernel and device
  release with no fallback, as in Phase 8.6.
- `pnpm gen:sdk-api`, plus changesets on `@capybara-hq/plugin-sdk`, `@capybara-hq/testing`,
  `@capybara-hq/kernel` and `@capybara-hq/device`.

## Kernel: decision, admission and records

**Candidate building runs for every profile.**

- `reviewPermissionCall` stops short-circuiting Full access to in-scope (`pipeline.ts`, the
  `facts.profile === "full-access"` branches, including the escalation-hint guard).
- An unsupported device no longer routes Full access to the legacy review.
- The candidate builder's protected-path refusal offers escalation instead of "choose Full access".

**One approver function.** The merged `approverForProfile` maps profile → `person | review-model |
none` for `directory`, `host` and `outside-sandbox` crossings. A sub-agent's escalation is the one
exception: `none` becomes `review-model`. For `none`, `decidePermission` returns allow with
`decisionSource: "full-access"`, and a call with a candidate continues to grant issuance.

**Full access issues a grant.** `PermissionCallGrants.issueLocked` accepts `{ source: "full-access",
reviewEventSeq, decidedBy: null }`. The pipeline writes the following in one fenced transaction under
the shared authority lock:

- a `permission_reviewed` event (outcome allow, the crossing kind, decision source `full-access`);
- an audit row `permission.crossing_auto_granted` with the kind;
- the grant itself.

The binding hash makes issuance exactly-once across replicas. Issuance re-reads the current
ceilings:

- an `outside-sandbox` grant needs `outsideSandboxCeiling`;
- a `host` grant needs the network rules above;
- unattended calls, non-owner calls and a sub-agent's auto-escalation are refused.

**Admission.** `intersectPermissionScope` no longer branches on the profile.

- Every call gets `filesystem: scoped`: the base roots plus granted directories, with protected
  paths excluded. On an instance-boundary device the scope is the whole instance.
- The network is `open-public`, or `allowlist` (base hosts plus granted hosts), or `none` under the
  kill switch.
- Only a call holding an `outside-sandbox` grant gets `device` + `environment`, and only while
  `outsideSandboxCeiling` holds.
- `withheldScope` reads support v2.
- Full consent is no longer an admission input. It only keeps the profile selected
  (`viewWithAccess`).

**Ceiling writes.** `PermissionCeilingWrites` gains the narrowing kinds `network-allowlist` and
`hosts-removed`; the existing Full-ceiling kind becomes `outside-sandbox-off`. Each narrowing bumps
its epoch and, in the same transaction, revokes the affected admitted or started work:

- open-network work on `network-allowlist`;
- escalated work on `outside-sandbox-off`, as the merged predicate already does.

Widening any of them resets Full consent, because Full access would then auto-approve more. A
profile change alone still never revokes started work.

**Consent fingerprint.** `scopeRevision` (`permission-facts.ts`) hashes the device identity, the
project binding and the crossing ceilings: `outsideSandbox`, the network ceiling and mode,
`restrictedProjectReach`, and the epochs. It no longer hashes `mode` / `allowedMode`.

## Replay and permission context

- `PermissionContext` (today `PermissionContextV1Schema` in `conversations/events.ts`) becomes
  version 2:
  - kept fields: `selectedProfile`, `effectiveProfile`, `execution`, `inherited`, `deviceId`,
    `scopeRevision`, `authorityRevision`, `availability`;
  - new block: `sandbox { boundary, location, workingRoot, network: { kind: "none" | "allowlist" |
    "open-public", hostsCount }, outsideSandbox, outerNetwork }`.

  The refine that tied Full access to device + environment is removed. A selected Full access still
  reads as effective Full access, or as Approve for me on a consent mismatch.
- The model-visible text (`runtime/context/permission-profile.ts`) states the sandbox once and then
  the approver per crossing kind. For Full access it says: "commands run in the sandbox; crossings
  this device allows are approved automatically; to run a command outside the sandbox set `sandbox:
  "escalated"` with a justification". The last clause appears only where escalation is available.
- `DriftReason` gains `device_sandbox_changed`, for a recorded context whose `sandbox` block differs
  from the previous one. `permission_profile_changed` stays for profile changes.
- `ReviewRecord` gains `crossing?: "directory" | "host" | "outside-sandbox" | "sensitive"`.
- Replay uses the recorded decision, never today's settings. Before 0.1.0 there are no frozen
  copies: the zero-drift fixtures are regenerated in the same change, and `reconstruct.test.ts` must
  pass before and after.

## UI

**Composer picker** (`apps/web/src/components/conversation/PermissionPicker.tsx`): three neutral
rows, order and icons unchanged. The `chat.permission.description.*` keys become:

| Profile | zh | en |
|---|---|---|
| 请求批准 / Request approval | 在沙箱内直接工作；超出沙箱或执行敏感命令前先问你。 | Works freely inside the sandbox; asks you before going beyond it or running sensitive commands. |
| 帮我批准 / Approve for me | 同样的沙箱；超出范围的请求交给审查模型，拿不准时问你。 | Same sandbox; a review model decides requests to go beyond it and asks you when unsure. |
| 完全访问 / Full access | 同样的沙箱；在此设备允许的范围内自动批准，不再询问。 | Same sandbox; approves whatever this device allows, without asking. |

**Full access dialog** (`chat.permission.full.*`), shorter than today:

| Part | zh | en |
|---|---|---|
| title | 在 {device} 上使用完全访问？ | Use Full access on {device}? |
| body | 命令仍在沙箱中运行；智能体超出沙箱的请求{outside}会自动批准并记录。 | Commands still run in the sandbox; the agent's requests to go beyond it{outside} are approved automatically and recorded. |
| `{outside}`, only when the device allows running outside the sandbox | （包括在沙箱外运行命令） | (including running commands outside the sandbox) |
| limits | 受保护的路径、平台和组织的禁止项仍然有效。 | Protected paths and platform and organization denials still apply. |

Remove `reason.ceiling` and `reason.restrictedUnsupported` for Full access: it is never unavailable
because of a ceiling now.

**Device page** (`apps/web/src/app/(app)/devices/[id]/view.tsx`, `DeviceModeSection.tsx`). The
existing settings section shows two groups, in one box with no nesting:

- **网络 / Network:** 开放互联网（内网除外） / Open internet (private networks blocked), or 白名单 /
  Allowlist with the host list editor.
  - A disabled option names the layer that set the ceiling, e.g. 平台已限定为白名单（超级管理员设置） /
    Limited to the allowlist by the platform (super admin).
  - A local device widens only on the machine, shown in the existing keycap block.
- **在沙箱外运行 / Run outside the sandbox:** 允许 / Allowed, or 关闭 / Off.
  - The local machine command is `capybara-device ceiling set --outside-sandbox on`.
  - Not shown for a cloud device.
- **Project reach** keeps today's control.
- The nameplate mark becomes the neutral 可在沙箱外运行 / 仅沙箱 (Can run outside the sandbox / Sandbox
  only).
- Recent changes show each setting change with its from and to values.

**Other pages:**

- Org settings (`/settings/sandbox`) and platform settings (`/admin/settings`) get the same two
  groups, as default and ceiling. The labels say 平台 and 超级管理员, never 企业.
- The conversation timeline shows an auto-granted crossing as a neutral line: 已自动批准：… /
  Approved automatically: ….
- Reads use `defineQuery` and writes `useAppMutation`; apps/web writes no styles (writing-web-ui).

## Migration

The migration never widens.

- **Platform and org settings:** stored keys are converted on read and on the next write, as
  `convertStoredPermissionKeys` does today.
  - `devicesFullAccess` → `devicesOutsideSandbox`.
  - org `fullAccess` → `outsideSandbox`.
  - org `cloudNetwork.mode: "allowlist"` → `deviceNetwork.ceiling: "allowlist"`, keeping `base`,
    `extraHosts` and `excludedHosts`.
  - `mode: "open"` or absent → absent.
- **Local devices:** converted once by the device's strict parser.
  - `fullAccess: true` → `outsideSandbox: true, network: "open"`.
  - `fullAccess: false` → `outsideSandbox: false, network: "allowlist"` with the old
    `allowedDomains`.
  - No device gains reach it did not have before. The CLI prints how to open the network
    (`capybara-device ceiling set --network open`).
  - New installs get the open default.
- **Cloud devices:** a kernel migration, expand then contract.
  - Add `network_mode` and `network_hosts`.
  - Copy the snapshot's `outer_network` where it was an allowlist.
  - `owner_full_access` is no longer read; a later migration drops it (the writing-migrations
    two-step).
- **Conversations:** no data rewrite.
  - The consent fingerprint changes, so a stored Full access selection reads as Approve for me until
    the owner confirms again.
  - The next run records a context with `device_sandbox_changed`.
  - Started work keeps its starting grant.
- **Call grants:** a migration adds `full-access` to the grant `source` check, numbered after
  `0162`.

## Later (cut from R3)

- Per-call private-endpoint grants (`privateEndpoints`), and the platform, org and device
  `privateNetwork` settings. Until then, private and LAN ranges and the host's other loopback ports
  are closed in open mode and need outside-sandbox escalation.
- Showing project reach in the new device settings layout, and renaming `restrictedProjectReach`.
- Restricted UNIX-socket listening on macOS.
- Operation-scoped (`boundary: "operation"`) cloud providers on the Linux runtime.
- Per-call host grants on instance-boundary devices (they need per-operation proxy credentials).

## What changes in existing code and tests

**Kernel** (`packages/kernel/src`):

- `tools/pipeline.ts`;
- `sandbox/review/{review.service,permission-candidate,classifier}.ts`;
- `sandbox/{permission-call-grants,permission-call-types,operation-authority,
  operation-authority-types,permission-facts,permission-ceiling-writes,modes,held-operations}.ts`;
- `sandbox/platform-full-access.ts` → `device-sandbox-settings.ts`, and the new
  `sandbox/device-sandbox.ts`;
- `conversations/{permission-profiles.service,events}.ts`;
- `runtime/context/permission-profile.ts`, `runtime/permission-context.service.ts`;
- `evals/reconstruct.ts`;
- `config/{schema,load}.ts`;
- `orgs/{settings.service,cloud-network-setting}.ts`, `identity/settings.ts`;
- `devices/devices.service.ts`;
- `local-devices/{owner-report,policy-summary,device-policy.service}.ts`;
- `tools/network-asks.ts`;
- `errors.ts`;
- `platform/ops/{devices,org-settings,admin,platform}.ops.ts`;
- two migrations.

**The activation already built on `perm/w4-int`:**

- The review order keeps the fixed denies first but drops the Full access skip.
- Permission facts drop `fullAccessCeiling = mode auto ∧ allowedMode auto`.
- `intersectPermissionScope` in admission drops the profile branch.
- `platform-full-access` becomes the device sandbox settings reader.
- The merged escalation's ceiling check and texts are renamed.

**Device** (`packages/device/src`):

- `state.ts`;
- `policy.ts` (`effectiveEgress`);
- `exec/operation-types.ts` (`intersectOperation`, `readStrictOwnerCeilingSync`);
- `exec/{operation-worker,mac-operation-backend,linux-agent,linux-operation-worker,
  linux-operation-backend,docker-operations}.ts`;
- `commands/{ceiling,login}.ts`.

**SDK:**

- `sandbox-operation.ts`;
- `device-protocol.ts`;
- `sandbox.ts`;
- `device-denied-paths.ts`;
- `sandbox-write-denies.ts`;
- `sandbox-linux-runtime-source.ts`;
- new `network-classes.ts`.

**Testing:** `sandbox-permission-conformance.ts`.

**Web:** the files named in "UI".

**Docs and skills:** `AGENTS.md`, writing-sandbox-providers, writing-tools, writing-web-ui,
writing-kernel-api, replay-evals, `docs/config.md`, `docs/deploy/upgrade.md`.

**Plugins repo:** `sandbox-docker` and `sandbox-e2b` get an instance-boundary operation factory and
support v2. This follows the R3 SDK release.

**Tests that encode the old coupling and change:**

- the conformance cases "Full access controls ... no restricted filters apply" and the UNIX-socket
  Full control, which become escalated-call controls;
- kernel: `test/tools/permission-escalation` ("Full access asks nobody: the call already runs
  outside the sandbox"), `test/sandbox/{operation-authority,operation-scopes(.dual),
  permission-wiring,platform-full-access,modes,cloud-permission-snapshot*,review-*}`,
  `test/tools/{permission-policy,call-policy,pipeline}`, `test/runtime/permission-context*`,
  `permission-activation`, `test/conversations/permission-profiles.http`,
  `test/sandbox/permission-profiles.dual`, the `test/evals/reconstruct` fixtures;
- device: `operation-ceilings` and the policy tests;
- web: `permission-picker`, `devices-mode`, `settings-sandbox`, `admin-settings`,
  `e2e/permission-profiles`.

## Risks and how tests prove the semantics

| Risk | Proof |
|---|---|
| Full access silently keeps unsandboxed execution | Admission table test: every profile × device kind gives a scoped filesystem and a non-`environment` network unless an `outside-sandbox` grant exists. Conformance: a Full-profile call cannot read `~/.ssh`, write `~/.zshrc` or reach `10.0.0.1` |
| A review-model allow crosses a fixed deny | A classifier fake that always allows: every fixed-deny class still denies under all profiles. A directory proposal covering a protected path is `unsupported` before review |
| Open network reaches private networks or host services | Device conformance on macOS SRT and on Linux (Docker harness). A public test target is reachable. Refused: `10/8`, `100.64/10`, `fc00::/7`, `169.254.169.254`, another loopback port, `docker.sock`, an IP literal, and a name that resolves to a private address (rebinding fixture). The command's own TCP loopback listener is reachable |
| Secrets leak through the environment | Conformance: a device env variable (`AWS_SECRET_ACCESS_KEY=sentinel`) is absent inside a sandboxed command under every profile |
| An auto-grant is issued twice or after narrowing | Dual-replica: two replicas race the same Full access crossing and produce one grant row and one audit row. A ceiling narrowing races an auto-grant: either the grant is refused or the started work is revoked. Network `open → allowlist` revokes running open-network work, while sibling allowlist work survives |
| A profile change races a crossing | Dual: Approve for me → Full access while a card waits. The card is superseded, re-evaluated as an auto-grant, and executed once |
| An unattended run or a sub-agent escalates | An unattended run is refused, as merged. A sub-agent's escalation under Full access goes to the review model, never auto. Task-grant hosts still work |
| Cloud devices are misrepresented | A fake instance-boundary provider: all three profiles are available, no directory or outside crossings are offered, and an allowlist host request answers "add it to the device's list" |
| Replay drift | `reconstruct.test.ts` and `run-replay` before and after. A settings change between runs logs `device_sandbox_changed` |
| UI | Web unit tests for the picker copy and the device section. Playwright `permission-profiles.spec.ts`: the picker rows, the Full access dialog with and without outside, the network toggle, allowlist editing, and the auto-granted line |

## AGENTS.md rules touched

- **Sandboxes** (changed). Today the rule says devices run "in one of two modes (auto: the
  environment's own capability; sandbox: the OS sandbox and the allowlist network)". The new text:
  "commands run in the device's sandbox under every permission profile (scope: project, workspace,
  tool directories; network: the open public internet or an allowlist; private ranges, metadata and
  host services closed; minimal environment); a profile only chooses who approves a crossing
  (person, review model, nobody); running outside the sandbox is a per-call escalation bounded by
  the device's outside-sandbox setting". The rest of the rule stays: the command review fails
  closed, abort kills the command, locking belongs to the kernel, and the socket proxy is never
  published on a host address.
- **Runtime and replay** (applied): the new model-visible context dimension gets the DriftReason
  `device_sandbox_changed`.
- **Config** (applied): the new keys use the `CAPYBARA_` prefix and the permission publication path;
  renamed keys get no aliases (Before 0.1.0).
- **Migrations** (applied): new migrations, expand then contract for `owner_full_access`.
- **Web UI** (applied): design components only, one box.
- **SDK public API** (applied): `gen:sdk-api` and a plugin-sdk changeset.
- **Multi-replica discipline** (applied): auto-grants and ceiling revocations run in the existing
  fenced transactions with outbox rows; no process state.
