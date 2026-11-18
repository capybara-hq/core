# Approval-only permission profiles and device sandbox settings

Status: design amendment, not yet reviewed. It amends the
[conversation permission profiles design](2026-11-16-conversation-approval-profiles-design.md) and the
parts of the [operation contract](2026-11-16-permission-operation-contract.md),
[call grants](2026-11-16-permission-call-grants-and-approvals-design.md),
[context replay](2026-11-16-permission-context-replay-design.md) and
[runtime cutover](2026-11-16-permission-runtime-cutover-design.md) designs that coupled a profile to
the execution boundary. It records the maintainer decisions of 2026-11-19 and the coordinator's
guardrails of the same day. Binding: `perm/w4-int` at `0ce1ab054`. The plan is
[2026-11-19-approval-only-profiles](../plans/2026-11-19-approval-only-profiles.md).

## Questions for the maintainer

Only these need a decision. Each has a recommendation; everything else below is decided.

1. **Cloud devices: the cloud machine is the sandbox.** Neither official provider implements the
   operation factory today (`plugins/sandbox-docker`, `plugins/sandbox-e2b`: no `permissionSupport`,
   `operation` or `revokeOperation`), and an in-VM per-operation runtime was never proven on E2B.
   **Recommendation:** a provider declares `boundary: "instance"`. The container or microVM is the
   sandbox, its whole filesystem is the scope, and its outer network (open public or allowlist,
   enforced by the provider) is the sandbox network. All three profiles are offered there. They
   differ only in sensitive-command consent: no directory crossing exists, running outside the
   sandbox does not exist, and a new host on an allowlist cannot be granted per call because the
   provider's network is instance-wide (the reply says to add it to the device's list). The Linux
   per-operation runtime stays the upgrade path for a provider that later declares
   `boundary: "operation"`. The alternative is to keep holding cloud profiles for an in-VM runtime.
2. **Full access keeps its confirmation.** Choosing it removes every approval on this device,
   including running commands outside the sandbox when the device allows that. **Recommendation:**
   keep the explicit confirmation and the consent binding to device plus crossing ceilings, with a
   rewritten, shorter dialog. A device switch or a widened ceiling resets the conversation to
   Approve for me, as today. Dropping the dialog would let one click auto-approve host escalation on
   a device whose owner allowed it for a different purpose.
3. **Cloud metadata, link-local addresses and the Docker/kernel sockets are reachable only by
   running outside the sandbox.** The coordinator's guardrail lists them as crossings approved per
   profile. **Recommendation:** private/LAN ranges and another process's loopback port are a
   network crossing that a call can be granted (`privateEndpoints`). Link-local and metadata
   addresses and the sockets are never granted inside the sandbox: reaching them needs the per-call
   outside-sandbox escalation, so the outside-sandbox ceiling bounds them. A metadata endpoint holds
   instance credentials, and a socket is root on the host, so a sandbox grant to either is not
   meaningfully narrower than running outside it.

## What changes, in one paragraph

A **profile** only chooses who approves a crossing: the person (Request approval), the review model
with the person as fallback (Approve for me), or nobody (Full access). The **sandbox** is a property
of the device, identical under all three profiles: the scope (project root, workspace, scratch and
tool directories), the sandbox network (open public internet by default, or an allowlist), whether
private-network crossings can be granted, and whether a call may run outside the sandbox. Full access
never removes the sandbox: its commands run in it, and its crossings are granted automatically within
the device's ceilings and recorded. Fixed denies and the minimal environment hold under every
profile.

## Superseded parts of earlier designs

| Earlier text | Now |
|---|---|
| Profiles design, "Proposed behavior" table, Full row: "use the device authority its owner/admin already granted" | Full access auto-approves crossings within the device ceilings; commands stay in the sandbox |
| Profiles design, "Full access follows the approved Codex-style preset ... removes Codex's own sandbox" and approach 3 coupling | Superseded by the Claude Code model below; the sandbox and the profile are independent |
| Profiles design, "Full access is unavailable when that ceiling forbids it" | Full access is available wherever a profile is; the ceiling bounds only outside-sandbox escalation |
| Operation contract, "Full access uses `filesystem.kind: "device"` and `network.kind: "environment"`" | Only an escalated call (outside the sandbox) uses that pair; every profile's ordinary call is scoped |
| Operation contract, `DeviceOwnerCeiling.fullAccess`, `restrictedAllowedDomains` "a restricted-profile allowance" | `outsideSandbox`, `network`, `privateNetwork`, `allowedDomains` describe the device sandbox for every profile |
| Operation contract, `SandboxPermissionSupport` v1 (`fullAccess`, restricted claims) | v2 below (`boundary`, network kinds, `outsideSandbox`) |
| Operation contract and cutover, `SandboxLimits.mode` as internal ceiling encoding | Removed; lifecycle receives the outer network only |
| Context replay design, refine "Full access must be device + environment" | Every profile records a scoped sandbox; escalation is per call in the review record |
| Call grants design, "`issueLocked` rejects full-access" | Full access issues grants with source `full-access`, recorded and audited |
| Config activation and cutover, `devices.fullAccess`, org `fullAccess`, `devicesFullAccess`, org `cloudNetwork` | Renamed and reshaped (section "Settings model") |
| Profiles design, "Device selection represents ... its independently authorized ceiling, without a daily auto/sandbox picker" | Kept: there is still no daily sandbox picker; device settings live on the device page |

Everything else in those designs stands: operation identity, admission, epochs and revocation,
call-bound grants and their immutability, owner-only profile changes, pending-card supersession,
starting grants for started work, the event log as the source of truth.

## Profiles

Crossing kinds are the closed set below. A **sensitive command** is one the review rules classify as
consent (`ask.sudo`, `ask.credential-print`, `ask.credential-link`, `ask.persistence`,
`ask.shell-config`, `ask.ssh`, `ask.secret-file`, `ask.global-install`, `ask.force-push`,
`ask.remote-destroy`, `ask.remote-write`, `ask.docker-privileged`, `ask.kill-other`, `ask.git-exec`,
`ask.dynamic-arg`, and every `unsure.*`) (`sandbox/review/rules.ts`).

| Request | Request approval | Approve for me (default) | Full access |
|---|---|---|---|
| Read, edit, command inside the sandbox scope, network the sandbox allows | Runs | Runs | Runs |
| Directory outside the scope (`directory`) | Ask | Review model | Auto-grant, recorded |
| New host while the network is an allowlist (`host`) | Ask | Review model | Auto-grant within the network ceiling, recorded |
| Private/LAN address or another loopback port (`private-endpoint`) | Ask | Review model | Auto-grant if private grants are allowed, recorded |
| Run this call outside the sandbox (`outside-sandbox`) | Ask | Review model | Auto-grant if the outside-sandbox ceiling allows, recorded |
| Sensitive command | Ask | Review model | Runs, recorded (unchanged from today) |
| Fixed deny (rule `deny.*`, platform/org deny, protected paths inside the sandbox) | Deny | Deny | Deny |
| Crossing beyond a ceiling | Unavailable: actionable error naming the layer | Same | Same |

The review model's verdict is final only as an allow or a deny. Unavailable, unsure, a failing
classifier or an unmapped review purpose asks the person (today's `decidePermission`). Its deny stays
a deny. The review model sits **behind** the fixed denies: `ReviewService.decide` evaluates the rule
table first and a `deny.*` hit returns before `decidePermission` runs (`review.service.ts:387-394`);
a call grant can never add a protected path to the sandbox scope (the candidate builder refuses it,
admission re-checks it, and the device intersects it again). A prompt-injected allow therefore never
crosses a fixed deny.

**Sensitive consent under Full access** stays skipped, as today. It does not conflict with the new
model: the sandbox still holds the protected paths and the minimal environment, so `sudo` or a
credential read inside the sandbox fails by enforcement; doing it for real needs an outside-sandbox
crossing, which the outside-sandbox ceiling bounds. Every skip is recorded (`decisionSource:
"full-access"`, crossing kind `sensitive`).

**Unattended runs** (scheduled tasks, `facts.unattended`) use Request approval with every ask turned
into a deny, as today. They get the same sandbox. Their crossings are limited to the scheduled task's
explicit grants (`scheduled_task_grants` network hosts); they never escalate outside the sandbox and
never inherit a chat's Full access.

**Sub-agents** resolve the root's profile live. Their directory, host and private-endpoint crossings
use the root's approver: the root owner, the review model, or auto under Full access. Their
outside-sandbox escalations are refused with an actionable error ("ask the parent conversation to
run it"): a sub-agent cannot grant itself escalation, and a background child has no person watching.
Calls by another account (a shared viewer, a channel guest) never escalate and never get a crossing
issued; `reviewCall` already refuses a device call by a non-owner.

## Fixed denies and the minimal environment

These hold under every profile, Full access included:

- **Protected paths inside the sandbox.** The owner-denied secret paths
  (`DEVICE_DENIED_SECRET_PATHS`: `~/.ssh`, `~/.aws`, gcloud, `.azure`, `.kube`,
  `.docker/config.json`, `.netrc`, `.gnupg`, browser profiles, `gh`, `.git-credentials`, `.npmrc`,
  `.pypirc`, Keychains), the device state directory, and the persistence vectors: the mandatory write
  denies (`SANDBOX_MANDATORY_WRITE_DENIES`: shell rc files, `.git/hooks`, `.git/config` and the rest
  of the list) plus, added by this change, `~/Library/LaunchAgents`, `~/Library/LaunchDaemons`,
  `~/.config/systemd/user`, `~/.config/autostart` and the user crontab spool (crontab itself needs a
  setuid helper the sandbox refuses). No directory grant covers them; a proposal that would reaches
  `unsupported` with a message offering the outside-sandbox escalation.
- **Only an explicit per-call escalation outside the sandbox reaches them:** Request approval asks,
  Approve for me goes to the review model, Full access auto-grants only within the outside-sandbox
  ceiling. Rule-table `deny.*` hits (`deny.secret-exfil`, `deny.root-destroy`, `deny.tooling-edit`)
  stay denies even for an escalated call.
- **Minimal environment.** A sandboxed command never inherits the device program's environment. It
  gets `PATH`, `LANG`, `HOME` (the working root), a private `TMPDIR`/`TMP`/`TEMP`, the tool homes the
  device detects (`restrictedToolHomes`), the proxy variables and the call's own `env`. This is
  today's restricted environment (`operation-worker.ts:704-714`, `linux-operation-worker.ts:141-147`),
  now used by Full access too (which today inherits `process.env`). With the network open,
  exfiltration is therefore limited to what the sandbox can read: the project, the workspace and the
  readable tool directories, never the device's secrets, tokens or protected paths.
- An escalated call (outside the sandbox) gets the device program's environment minus every
  `CAPYBARA_*` variable and the device credential, because it runs as the owner by definition.

## Device settings model

### Fields

| Setting | Values | Meaning |
|---|---|---|
| Sandbox scope | `projectReach: "workspace" \| "os-user"` | Where a project root may live: under the device workspace, or anywhere the OS user can read (excluding protected paths). The scope of a call is always the selected project root, the workspace, scratch and tool directories, never all of `os-user`. Renames `restrictedProjectReach`. |
| Sandbox network | `network: "open" \| "allowlist"` and `allowedDomains: string[]` | `open` = the public internet (section "Open network"). `allowlist` = only the listed hosts, plus per-call host grants. |
| Private network | `privateNetwork: "allowed" \| "off"` | Whether a call can be granted a private/LAN endpoint or another loopback port. |
| Outside the sandbox | `outsideSandbox: "allowed" \| "off"` (device owner: boolean) | Whether a call may be granted escalation outside the sandbox. Renames the "Full access ceiling". |

### Layers, writers and intersection

| Layer | Writer | Where | Defaults |
|---|---|---|---|
| Platform | super admin: startup config (env > file / Nacos), else the admin console (deployment settings) | `devices.outsideSandbox`, `devices.network.default`, `devices.network.ceiling`, `devices.privateNetwork`; host list `sandbox.limits.allowHosts` with `orgHosts`; kill switch `sandbox.limits.egress` | `allowed`, `open`, `open`, `allowed` |
| Org | org admin, web session (narrow-only through the Platform tool or an API token, as today) | org settings `outsideSandbox`, `deviceNetwork { default?, ceiling?, base?, extraHosts?, excludedHosts? }`, `privateNetwork` | absent = follow the platform |
| Device, local | the owner on the machine (`capybara-device sandbox …`) widens; the owner in a web session narrows | on-disk `policy.json` `ownerCeiling { outsideSandbox, projectReach, network, privateNetwork }` and `allowedDomains` | new install: `outsideSandbox: false`, `projectReach: "os-user"`, `network: "open"`, `privateNetwork: true` |
| Device, cloud | the device owner or an org admin, web session, both directions within org/platform | `devices.network_mode`, `devices.network_hosts` | absent = follow the org |

Effective values, computed by one pure function `effectiveDeviceSandbox(platform, org, device,
provider)` in the new `packages/kernel/src/sandbox/device-sandbox.ts` and mirrored on the device by
`intersectOperation`:

- `outsideSandbox` = platform ∧ org ∧ device owner ∧ provider `outsideSandbox` (an instance-boundary
  provider has none).
- network ceiling = the narrower of platform and org `ceiling` (`allowlist` < `open`), and
  `allowlist` when the kill switch is `none` (with an empty list). Network mode = device choice ??
  org default ?? platform default, clamped to the ceiling, then clamped to the provider's outer
  network for a cloud device.
- allowlist hosts: when the ceiling is `open` (the owner chose the allowlist), the owner's
  `allowedDomains` ∪ the org's effective hosts (`orgEffectiveHosts`, platform `allowHosts` ± org
  `extraHosts`/`excludedHosts`); when the ceiling forces `allowlist`, the org's effective hosts, and
  the owner's hosts only where those cover them. A per-call host grant is possible under `orgHosts:
  extend`; under `within` only for hosts the list covers (else unavailable: "an admin adds the host").
- `privateNetwork` = platform ∧ org ∧ device; always off for an instance-boundary provider (its outer
  network blocks private ranges).
- `projectReach` = the owner's value (local); cloud: the whole instance.

The local device intersects every request with its on-disk ceiling even if the kernel's view is
stale (unchanged rule). The web can narrow a local device's ceiling (`network` to `allowlist`,
removing hosts, `privateNetwork` off, `outsideSandbox` off, reach to `workspace`) through the v3
`policy` op; widening any of them happens only on the machine. A cloud device has no machine, so its
owner or an org admin changes its network in both directions within the org and platform ceilings.

### Why open is the shipped default

Every device must be able to do development work: package installs, git over HTTPS, documentation
fetches and API calls are routine, and an empty allowlist makes the default device useless. The
sandbox still holds the filesystem, the environment is minimal, private ranges and the host's own
services stay closed, so open public egress exposes only what the sandbox can read. An enterprise
that needs egress control sets `devices.network.ceiling: allowlist` on the platform, or `deviceNetwork
.ceiling: allowlist` on an org, and keeps its list in `allowHosts`/`extraHosts`.

### Config keys and API fields (pre-0.1.0: renamed directly, no aliases)

| Old | New |
|---|---|
| `devices.fullAccess` (`CAPYBARA_DEVICES__FULL_ACCESS`), admin `devicesFullAccess` | `devices.outsideSandbox` (`CAPYBARA_DEVICES__OUTSIDE_SANDBOX`), admin `devicesOutsideSandbox`; hot |
| (none) | `devices.network.default`, `devices.network.ceiling` (`open \| allowlist`), `devices.privateNetwork` (`allowed \| off`); hot, published like the other permission keys |
| org `fullAccess` | org `outsideSandbox` |
| org `cloudNetwork { mode, base, extraHosts, excludedHosts }` | org `deviceNetwork { default, ceiling, base, extraHosts, excludedHosts }`, applying to local and cloud devices |
| (none) | org `privateNetwork` |
| local `ownerCeiling { fullAccess, restrictedProjectReach }` | `ownerCeiling { outsideSandbox, projectReach, network, privateNetwork }` |
| wire `DeviceOwnerCeiling { fullAccess, restrictedAllowedDomains, restrictedProjectReach }` | `{ outsideSandbox, network, privateNetwork, allowedDomains, projectReach }` |
| `devices.owner_full_access` (cloud) | `devices.network_mode`, `devices.network_hosts` (cloud has no outside-sandbox) |
| errors `org/deployment/device.full_access_not_allowed` | `*.outside_sandbox_not_allowed`; new `*.network_not_allowed` for a mode above the ceiling |
| `capybara-device ceiling set --full-access` | `capybara-device sandbox set --outside-sandbox on\|off --network open\|allowlist --private-network on\|off --project-reach …` |
| permission facts `fullAccessCeiling`, `broadProjectReach` | `outsideSandboxCeiling`, `projectReach` |

The old keys are refused with a conversion message (`config/load.ts`), and `capybara config
migrate-permissions` converts file and Nacos documents. Stored values are converted, not aliased:
`convertStoredPermissionKeys` (`sandbox/platform-full-access.ts:222`, which moves to
`sandbox/device-sandbox-settings.ts`) gains the conversions below, and the device's strict policy
parser converts an old `policy.json` once on start. The permission config fingerprint covers the new
keys, so a deployment that changes them activates with `--activate-permission-config` (config
activation design, unchanged mechanism).

## Open network

`open` means the public internet. Every sandboxed connection is decided on the **resolved address**
by the operation's own proxy (macOS SRT, the Linux forwarder, a provider's egress proxy); the proxy
dials the address it checked, so DNS rebinding cannot swap it. An IP literal is classified by the
same rules as a resolved name (SRT skips its resolved-address guard for literals, so the worker adds
explicit `deniedDomains` CIDR rules). Closed in open mode:

- private and LAN ranges: `10/8`, `172.16/12`, `192.168/16`, CGNAT `100.64/10`, IPv6 ULA `fc00::/7`;
- link-local and metadata: `169.254/16` (including `169.254.169.254`), `fe80::/10`, `fd00:ec2::254`;
- loopback and this host's own interface addresses: another process's localhost port; the command's
  **own** loopback listener stays reachable within the operation (Linux: the broker allows connect to
  ports the operation itself bound; macOS: the separate loopback fix);
- the Docker and kernel sockets: UNIX sockets outside the write roots stay refused
  (`/var/run/docker.sock`, `~/.docker/run/docker.sock`, `/run/containerd`), as does TCP to them via
  loopback;
- multicast, broadcast, `0/8`, NAT64 prefixes.

`private-endpoint` crossings (one `host:port` or `ip:port` each, at most 16 per call) re-open a single
private or loopback endpoint for one call. Link-local, metadata and sockets need an outside-sandbox
escalation (question 3). Traffic is proxy-mediated: HTTP(S) and SOCKS-aware clients work on any TCP
port; a client that ignores proxy variables (plain `ssh`) does not connect from the sandbox, which
the tool description states (`GIT_SSH_COMMAND` with a SOCKS `ProxyCommand` works). One shared
classification table lives in the SDK (`packages/plugin-sdk/src/network-classes.ts`, pure data plus
`classifyAddress`), consumed by the device workers and checked against the kernel's
`net/public-address.ts` by a unit test, so the classes cannot drift.

## SDK and protocol

- `SandboxNetworkScope` becomes `none | { allowlist, hosts, privateEndpoints } | { "open-public",
  privateEndpoints } | environment`; `environment` is legal only with `filesystem: device`, and that
  pair only for an escalated call.
- `SandboxOperationScope` gains `escalated: boolean`. The profile stays in the scope for audit only;
  providers never derive enforcement from it.
- `SandboxPermissionSupport` version 2: `{ version: 2, boundary: "operation" | "instance",
  restricted: {filesystem, network, native, concurrentScopes} | null, network: { openPublic,
  allowlist, perOperationHosts, privateEndpoints }, outsideSandbox: boolean, background: boolean,
  unavailableReason? }`. `boundary: "instance"` with `restricted: null` is a supported device whose
  scope is the instance.
- `SandboxLimits.mode` is removed; lifecycle create/update carries only resources and the outer
  network.
- `DeviceOwnerCeiling` (device protocol) takes the new fields; `DeviceOwnerCeilingNarrowing` can
  narrow each. If protocol 3 has not shipped in a release when this lands, it changes in place;
  otherwise it becomes protocol 4 with no fallback, paired kernel/device release as in Phase 8.6.
- `pnpm gen:sdk-api`, changesets on `@capybara-hq/plugin-sdk`, `@capybara-hq/testing`,
  `@capybara-hq/kernel`, `@capybara-hq/device`.

## Kernel: decision, admission and records

- **Candidate building runs for every profile.** `reviewPermissionCall` stops short-circuiting Full
  access to in-scope (`pipeline.ts:1940-1952`), and an unsupported device no longer sends Full access
  to the legacy review (`:1920-1933`). `buildPermissionCandidate` adds `private-endpoint` proposals
  (literal URL hosts that resolve to, or are, private addresses; the explicit `privateEndpoints`
  proposal of the network ask) and keeps the escalation kind from `perm/call-escalation`; its
  protected-path refusal text offers escalation instead of "choose Full access"
  (`permission-candidate.ts:91,110-113`).
- **One approver function** (`approverForProfile`, introduced by `perm/call-escalation`) maps profile
  → `person | review-model | none` for every crossing kind. `decidePermission` returns `allow` with
  `decisionSource: "full-access"` for `none`, but a call with a candidate continues to grant issuance.
- **Full access issues a grant.** `PermissionCallGrants.issueLocked` accepts `{ source: "full-access",
  reviewEventSeq, decidedBy: null }`. The pipeline appends `permission_reviewed` (outcome allow, kind,
  decision source `full-access`), writes the audit row `permission.crossing_auto_granted` with the
  kind, and inserts the grant, in one fenced transaction under the shared authority lock. The binding
  hash makes issuance exactly-once across replicas. The issue check re-reads current ceilings: an
  `outside-sandbox` grant needs `outsideSandboxCeiling`, a `private-endpoint` grant needs
  `privateNetwork`, a `host` grant needs the network ceiling rules above, and an `unattended`,
  sub-agent-escalation or non-owner call is refused.
- **Admission.** `intersectPermissionScope` (`operation-authority.ts:128`) no longer branches on the
  profile. Every call gets `filesystem: scoped` (base roots ∪ granted directories, protected paths
  excluded) and the device network: `open-public` (plus granted private endpoints) or `allowlist`
  (base hosts ∪ granted hosts, plus private endpoints), or `none` under the kill switch. Only a call
  holding an `outside-sandbox` grant gets `device` + `environment` and `escalated: true`, and only
  while `outsideSandboxCeiling` holds. `withheldScope` reads support v2. Full consent is no longer an
  admission input; it only keeps the profile selected (`viewWithAccess`).
- **Ceiling writes.** `PermissionCeilingWrites` gains the narrowing kinds `network-allowlist`,
  `hosts-removed`, `private-network-off`, `outside-sandbox-off`, `project-reach-workspace`. Each bumps
  its epoch and revokes affected admitted/started work in the same transaction: open-network work on
  `network-allowlist`, escalated work on `outside-sandbox-off`, private-endpoint work on
  `private-network-off`. Widening any of them resets Full consent (Full access would auto-approve
  more). A profile change alone never revokes started work (unchanged).
- **Consent fingerprint.** `scopeRevision` (`permission-facts.ts:451`) hashes the device identity,
  project binding and the crossing ceilings (`outsideSandbox`, network ceiling and mode,
  `privateNetwork`, `projectReach`, the epochs), no longer the old `mode/allowedMode`.

## Replay and permission context

- `PermissionContext` (events schema, today `PermissionContextV1Schema`, `conversations/events.ts:139`)
  becomes version 2: `selectedProfile`, `effectiveProfile`, `execution`, `inherited`, `deviceId`,
  `scopeRevision`, `authorityRevision`, `availability`, and `sandbox { boundary, location,
  workingRoot, projectReach, network: { kind: "none" | "allowlist" | "open-public", hostsCount },
  privateNetwork, outsideSandbox, outerNetwork }`. The refine that tied Full access to device +
  environment is removed; selected Full access reads effective Full access or Approve for me (consent
  mismatch), unchanged.
- The model-visible text (`runtime/context/permission-profile.ts:66-134`) states the sandbox once
  and the approver per crossing kind, and for Full access: "commands run in the sandbox; crossings
  this device allows are approved automatically; to run a command outside the sandbox set
  `sandbox: "escalated"` with a justification" (only when available).
- `DriftReason` gains `device_sandbox_changed` for a recorded context whose `sandbox` block differs
  from the previous one; `permission_profile_changed` stays for profile changes.
- `ReviewRecord` gains `crossing?: "directory" | "host" | "private-endpoint" | "outside-sandbox" |
  "sensitive"`; `decisionSource` keeps its values. Replay uses the recorded decision, never today's
  settings (unchanged). Before 0.1.0 there are no frozen copies: the zero-drift fixtures are
  regenerated in the same change and `reconstruct.test.ts` must pass before and after.

## UI

Composer picker (`apps/web/src/components/conversation/PermissionPicker.tsx`), three neutral rows,
unchanged order and icons; `chat.permission.description.*`:

| Profile | zh | en |
|---|---|---|
| 请求批准 / Request approval | 在沙箱内直接工作；超出沙箱或执行敏感命令前先问你。 | Works freely inside the sandbox; asks you before going beyond it or running sensitive commands. |
| 帮我批准 / Approve for me | 同样的沙箱；超出范围的请求交给审查模型，拿不准时问你。 | Same sandbox; a review model decides requests to go beyond it and asks you when unsure. |
| 完全访问 / Full access | 同样的沙箱；在此设备允许的范围内自动批准，不再询问。 | Same sandbox; approves whatever this device allows, without asking. |

Full access dialog (`chat.permission.full.*`): title 在 {device} 上使用完全访问？ / Use Full access on
{device}?; body: 命令仍在沙箱中运行。智能体超出沙箱的请求（项目外的目录、新的网络主机、内网地址{outside}）会自动批准并记录，不再询问你。 /
Commands still run in the sandbox. The agent's requests to go beyond it (directories outside the
project, new network hosts, private addresses{outside}) are approved automatically and recorded,
without asking you.; `{outside}` = ，以及在沙箱外运行命令 / , and running commands outside the
sandbox, only when the device allows it; limits: 受保护的路径、平台和组织的禁止项仍然有效。 /
Protected paths and platform and organization denials still apply. Remove `reason.ceiling` and
`reason.restrictedUnsupported` for Full access (it is never unavailable for a ceiling now).

Device page (`apps/web/src/app/(app)/devices/[id]/view.tsx`; `DeviceModeSection.tsx` becomes
`DeviceSandboxSection.tsx`), a `FormSection` titled 沙箱 / Sandbox, one box, no nesting:

- 网络 / Network: 开放互联网（内网除外） / Open internet (private networks blocked) | 白名单 /
  Allowlist; the host list editor when allowlist; a disabled option says which layer set the ceiling
  (平台已限定为白名单（超级管理员设置） / Limited to the allowlist by the platform (super admin)).
- 内网访问 / Private network: 可按次批准 / Can be granted per call | 关闭 / Off.
- 在沙箱外运行 / Run outside the sandbox: 允许 / Allowed | 关闭 / Off; for a local device, widening
  shows the machine command (`capybara-device sandbox set --outside-sandbox on`) in the existing
  keycap block; cloud: not shown (no outside).
- 项目范围 / Project reach: 工作区 / Workspace | 整个用户目录 / Anywhere in the user's home.
- The nameplate mark becomes neutral 可在沙箱外运行 / 仅沙箱 (Can run outside the sandbox / Sandbox
  only). Recent changes list each setting change with from/to.

Org settings (`/settings/sandbox`) and platform settings (`/admin/settings`) get the same three
groups as defaults and ceilings; the platform labels say 平台 and 超级管理员, never 企业. Approval cards
(`ApprovalCard.tsx`, `PermissionScopeDetail.tsx`) show `privateEndpoints` and the escalation
justification; the conversation timeline shows an auto-granted crossing as a neutral line (已自动批准：…
/ Approved automatically: …). Reads use `defineQuery`, writes `useAppMutation`; apps/web writes no
styles (writing-web-ui).

## Migration

- **Platform and org settings** (stored-key conversion on read and on the next write, as
  `convertStoredPermissionKeys` does today): `devicesFullAccess` → `devicesOutsideSandbox`; org
  `fullAccess` → `outsideSandbox`; org `cloudNetwork.mode: "allowlist"` → `deviceNetwork.ceiling:
  "allowlist"` with `base/extraHosts/excludedHosts` kept, `mode: "open"` or absent → absent.
- **Local devices** (device strict parser, once): `fullAccess: true` → `outsideSandbox: true,
  network: "open"`; `fullAccess: false` → `outsideSandbox: false, network: "allowlist"` with the old
  `allowedDomains`; `restrictedProjectReach` → `projectReach`; `privateNetwork: true`. No device gains
  reach it did not have; the CLI prints how to open the network (`capybara-device sandbox set
  --network open`). New installs get the open defaults.
- **Cloud devices** (kernel migration, expand then contract): add `network_mode`, `network_hosts`;
  copy the snapshot's `outer_network` where it was an allowlist; `owner_full_access` stops being read
  and is dropped in a later migration (writing-migrations two-step).
- **Conversations:** no data rewrite. The consent fingerprint changes, so a stored Full access
  selection reads as Approve for me (`viewWithAccess`) until the owner confirms again, and the next
  run records a context with `device_sandbox_changed`. Started work keeps its starting grant.
- **Call grants:** migration adds `full-access` to the grant `source` check and a nullable
  `private_endpoints` column (numbered after `perm/call-escalation`'s `0162`).

## What changes in existing code and tests

Kernel (`packages/kernel/src`): `tools/pipeline.ts` (`reviewPermissionCall`), `sandbox/review/
{review.service,permission-candidate,classifier}.ts`, `sandbox/{permission-call-grants,
permission-call-types,operation-authority,operation-authority-types,permission-facts,
permission-ceiling-writes,modes}.ts`, `sandbox/platform-full-access.ts` → `device-sandbox-settings.ts`,
new `sandbox/device-sandbox.ts`, `conversations/{permission-profiles.service,events}.ts`,
`runtime/context/permission-profile.ts`, `runtime/permission-context.service.ts`,
`evals/reconstruct.ts`, `config/{schema,load}.ts`, `orgs/{settings.service,cloud-network-setting}.ts`,
`identity/settings.ts`, `devices/devices.service.ts`, `local-devices/{owner-report,policy-summary,
device-policy.service,network-grants}.ts`, `tools/network-asks.ts`, `errors.ts`, `platform/ops/
{devices,org-settings,admin,platform}.ops.ts`, a migration. The activation already built on
`perm/w4-int` changes as follows: review order keeps fixed denies first but drops the Full-access
skip; permission facts drop `fullAccessCeiling = mode auto ∧ allowedMode auto`; admission's
`intersectPermissionScope` drops the profile branch; `platform-full-access` becomes the device
sandbox settings reader. Device (`packages/device/src`): `state.ts`, `policy.ts` (`effectiveEgress`),
`exec/operation-types.ts` (`intersectOperation`, `readStrictOwnerCeilingSync`), `exec/
{operation-worker,mac-operation-backend,linux-agent,linux-operation-worker,linux-operation-backend,
docker-operations}.ts`, `commands/{ceiling,policy,login}.ts`. SDK: `sandbox-operation.ts`,
`device-protocol.ts`, `sandbox.ts` (`SandboxLimits`), `device-denied-paths.ts`, `sandbox-write-denies.ts`,
`sandbox-linux-runtime-source.ts`, new `network-classes.ts`. Testing: `sandbox-permission-conformance.ts`.
Web: the files named in "UI". Docs and skills: `AGENTS.md` (Sandboxes line), writing-sandbox-providers,
writing-tools, writing-web-ui, writing-kernel-api, replay-evals, `docs/config.md`,
`docs/deploy/upgrade.md`. Plugins repo: `sandbox-docker`, `sandbox-e2b` (instance-boundary operation
factory, support v2).

Tests that encode the old coupling and change: the conformance "Full access controls ... no
restricted filters apply" cases (`sandbox-permission-conformance.ts:1020-1060`, the UNIX-socket Full
control `:1003`) become escalated-call controls; `test/sandbox/operation-authority.test.ts`,
`operation-scopes(.dual)`, `permission-wiring`, `platform-full-access`, `modes`,
`cloud-permission-snapshot*`, `test/tools/permission-policy`, `call-policy`, `pipeline`,
`test/sandbox/review-*`, `test/runtime/permission-context*`, `permission-activation`,
`test/conversations/permission-profiles.http`, `test/sandbox/permission-profiles.dual`,
`test/evals/reconstruct` fixtures, the device `operation-ceilings` and policy tests, and web
`permission-picker`, `devices-mode`, `settings-sandbox`, `admin-settings`, `e2e/permission-profiles`.

## Risks and how tests prove the semantics

| Risk | Proof |
|---|---|
| Full access silently keeps unsandboxed execution | Admission table test: every profile × device kind → scoped filesystem and non-`environment` network unless an `outside-sandbox` grant exists; conformance: a Full-profile call cannot read `~/.ssh`, write `~/.zshrc` or reach `10.0.0.1` |
| A review-model allow crosses a fixed deny | Classifier fake that always allows: every fixed-deny class still denies under all profiles, escalated or not where the rule is `deny.*`; a directory proposal covering a protected path is `unsupported` before review |
| Open network reaches private or host services | Device conformance on macOS SRT and Linux (Docker harness): public test target reachable; `10/8`, `100.64/10`, `fc00::/7`, `169.254.169.254`, another loopback port, `docker.sock`, an IP literal and a name resolving to a private address (rebinding fixture) all refused; the command's own loopback listener reachable |
| Secrets leak through env | Conformance: a device env variable (`AWS_SECRET_ACCESS_KEY=sentinel`) is absent inside a sandboxed command under every profile |
| Auto-grant issued twice or after narrowing | Dual-replica: two replicas race the same Full crossing → one grant row, one audit row; a ceiling narrowing races an auto-grant → either the grant is refused or the started work is revoked; network `open → allowlist` revokes running open-network work, sibling allowlist work survives |
| Profile change and crossing race | Dual: Approve for me → Full while a card waits → card superseded, re-evaluated as auto-grant, executed once |
| Unattended or sub-agent escalation | Unit + integration: scheduled run and sub-agent escalation refused with the actionable text; task-grant hosts still work |
| Cloud honesty | Fake instance-boundary provider: all three profiles available, no directory/outside crossings offered, an allowlist host request answers "add it to the device's list" |
| Drift | `reconstruct.test.ts` and `run-replay` before and after; a settings change between runs logs `device_sandbox_changed` |
| UI | Web unit tests for the picker copy and device section; Playwright `permission-profiles.spec.ts`: picker rows, Full dialog with and without outside, network toggle, allowlist editing, auto-granted line in the timeline and audit |

## AGENTS.md rules touched

- **Sandboxes** (changed): the line "in one of two modes (auto: the environment's own capability;
  sandbox: the OS sandbox and the allowlist network)" becomes: "commands run in the device's sandbox
  under every permission profile (scope: project, workspace, tool directories; network open public
  internet or an allowlist; private ranges, metadata and host services closed; minimal environment);
  a profile only chooses who approves a crossing (person, review model, nobody); running outside the
  sandbox is a per-call escalation bounded by the device's outside-sandbox setting". The command
  review failing closed, abort, locking and the socket proxy rule stay.
- **Runtime and replay** (applied): the new model-visible context dimension gets the DriftReason
  `device_sandbox_changed`.
- **Config** (applied): new keys use the `CAPYBARA_` prefix and the permission publication path;
  renamed keys have no aliases (Before 0.1.0).
- **Migrations** (applied): one new migration, expand then contract for `owner_full_access`.
- **Web UI** (applied): the device sandbox section uses `FormSection` and design components, one box.
- **SDK public API** (applied): `gen:sdk-api` and a plugin-sdk changeset.
- **Multi-replica discipline** (applied): auto-grants and ceiling revocations run in the existing
  fenced transactions with outbox rows; no process state.
