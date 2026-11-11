# Asking a person to allow a network domain

- Date: 2026-11-12.
- Status: draft for review. Direction approved by the maintainer (2026-11-12); the calls made here
  are marked **(designer's call)**; §13 lists what the maintainer still decides.
- Amends: the environments spec `2026-11-07-environments-design.md` (§6.4 local policy, §8.2 "the
  local policy cannot be loosened remotely", §13.6 the program), the scheduled tasks spec
  `2026-11-11-scheduled-tasks-design.md` (§7 task grants), the reply-while-question spec
  `2026-11-10-reply-while-question-pending-design.md` (§4.4, for network asks only), the device
  protocol (`packages/plugin-sdk/src/device-protocol.ts`) and `ExecResult`
  (`packages/plugin-sdk/src/sandbox.ts`).
- Markers: **(decided)** is the maintainer's direction of 2026-11-12.

## 1. Why

An agent's command on a connected device that reaches a domain outside the allowed set fails with
whatever the client prints: `curl: (56) CONNECT tunnel failed, response 403`, a Python
`ProxyError`, or `Operation not permitted` for a tool that ignores the proxy variables. Nothing says
which domain was refused, by which layer, or who can change it. In acceptance the agent guessed the
cause wrong twice (DNS, then the remote server), and the person did not know a local policy existed.

What the code does today (verified on `main`, 2026-11-12):

- **Two layers, intersected.** A device command may reach the domains in
  `effectiveEgress(policy, limits)` (`packages/device/src/policy.ts`): the org's effective egress
  (`limits.egress` / `limits.allowHosts`, from `effectiveSandboxEgress` in
  `packages/kernel/src/orgs/settings.service.ts`: the deployment's `sandbox.limits` replaced by the
  org setting `sandboxEgress`, never more open than a deployment `none`) cut to the local policy's
  `allowedDomains`. "The cloud can only narrow it: an empty policy allows nothing." The default local
  policy is empty (`DEFAULT_POLICY` in `state.ts`), so **a fresh device has no network at all**.
- **The org's limits travel with every `exec`** (`DeviceExecArgs.limits`, read at that moment, ruling
  R27 in `local-device-provider.ts`); the local policy is read **once** at `capybara-device start`
  (`commands/start.ts` → `readPolicy`) and `capybara-device policy set` says "Restart
  capybara-device for it to take effect". Its header comment: "Only the machine's user edits this
  file: the cloud never writes it."
- **OS mode** (`exec/os.ts`) runs each command through `@anthropic-ai/sandbox-runtime` (pinned
  0.0.81). Network goes through the runtime's local HTTP / SOCKS proxy; each command's allowed
  domains are registered with `SandboxManager.registerCommandNetworkLists(commandId, …)` under an
  unguessable per-command id. `initialize` is called **without an ask callback** ("a destination
  outside the lists is refused, never prompted"). The runtime already records every refusal as a
  violation under the command id (`recordOutboundDeny` → `deny network-outbound <host>:<port>
  (<reason>)`, readable with `getSandboxViolationStore().getViolationsForCommand(commandId)`), and an
  ask callback may deny with `{ allow: false, reason }`, which becomes the 403's status phrase
  (`askCallbackDenyReason` is true in 0.0.81). Hosts that resolve to loopback, private or link-local
  addresses are refused by the runtime's resolved-address guard whatever the lists say.
- **Docker mode** (`exec/docker.ts`) has no domain allowlist: the container is on the default bridge
  when the effective egress is non-empty, otherwise disconnected. It cannot tell which host a command
  wanted.
- **Cloud sandboxes** (`sandbox-docker`, `sandbox-e2b` in `capybara-hq/plugins`) get the org's
  effective egress at `create` and enforce it in their own proxy; core sees only the command output.
- **Devices are personal** in phase 1 (`devices.owner_kind = 'personal'`,
  `packages/kernel/src/devices/access.ts`): only the owner may use one, and a conversation is bound
  to a device of its owner. So **the conversation's owner is the device's owner** for every
  conversation that runs on a connected device.

## 2. Goals, non-goals, anti-goals

Goals:

- The default stays restricted **(decided)**.
- When a command is blocked, the person is asked on the spot, in the conversation (web) or on an IM
  card: 「智能体想访问 files.slack.com，允许吗？」 with 「这次允许 / 这台设备一直允许 / 拒绝」 **(decided)**.
- 「一直允许」 writes the device's local policy, live, without a restart **(decided)**.
- The device owner can switch 「这台设备不限网络」 on, off by default, with a clear risk text
  **(decided)**.
- Unattended runs never ask; they use pre-approved domains, collected like scheduled tasks'
  pre-approved tools **(decided)**.
- Every blocked request explains itself to the model and the person: the domain, the layer that
  refused it, and who can lift it. This ships first, before any card (§9).

Non-goals:

- No change to how org admins and super admins set the org / deployment allowlist (`sandboxEgress`,
  `sandbox.limits`); the card only links to it and files a request (§5.3).
- No per-path or per-method rules (the proxy sees the host and port of a CONNECT, not the URL of an
  HTTPS request); no port-specific entries (the local policy's entries keep matching every port).
- Docker device mode and cloud sandboxes get the self-explaining note later (§11, phase 3); they get
  no card in this spec.

Anti-goals:

- The model never decides: no tool, Platform operation or API token can approve a network ask or
  widen a device's policy (§10).
- The cloud never widens a device's policy without its owner's decision in a signed-in session, and
  a device can refuse cloud widening altogether (§5.2).
- No live "hold the connection and ask" (§4.3).

## 3. Terms

- **Layer**: what refused a host. `device` (not in the device's local policy, but the org allows it),
  `org` (not in the org's effective allowlist, or the org / deployment egress is `none`), `address`
  (an IP literal, or a name that resolves to a loopback / private / link-local address: refused by
  the runtime's guard, never liftable), `unknown` (a refusal without a host, such as a raw socket).
  A host blocked by both the org and the device is reported as `org`: lifting the device layer would
  not help until the org allows it.
- **Network ask**: an approval of the new kind `network` (§6.1), for the device layer only.
- **Run grant**: 「这次允许」: the host is allowed for the rest of the current run (§6.3).
- **Device grant**: 「这台设备一直允许」: the host is added to the device's local policy.
- **Task grant**: a pre-approved domain of a scheduled task (§8).

## 4. Detection

### 4.1 The device reports blocked hosts per command (designer's call)

The proxy is the only component that knows the host; parsing client output (`curl: (56)`, Python
tracebacks, `getaddrinfo` messages) is guessing. So the device reports refusals as structured data:

1. After each command (OS mode), the executor reads
   `SandboxManager.getSandboxViolationStore().getViolationsForCommand(commandId)` and extracts the
   `deny network-outbound <host>:<port> (<reason>)` lines. The line format belongs to the pinned
   runtime version; a unit test pins it against that version, and the plan files an upstream request
   for a structured field on `SandboxViolationEvent` so the parse can go.
2. It classifies each host against the command's own `args.limits` and the local policy it used
   (§3), dedupes by host, keeps at most 20 hosts per command, and returns them in the exec result:

   ```ts
   // packages/plugin-sdk/src/sandbox.ts (ExecResult, optional; SDK public API change)
   network?: {
     blocked: { host: string; port: number; layer: "device" | "org" | "address" | "unknown" }[];
   };
   ```

   `parseOpResult("exec", …)` accepts and validates the optional field (each host passes
   `validateAllowHost` or is reported as `address`; unknown layers are dropped). An old device sends
   none; an old kernel drops the field.
3. **The kernel recomputes the `org` layer itself** from the org's effective egress at the time of
   the call: it trusts the device's word that a host was refused, never its word that the org allows
   a host. A host the device calls `device` that the org does not allow becomes `org`.

`ExecResult.network` is optional for every provider, so cloud sandboxes can fill it later (phase 3)
without another contract change.

Background commands (`Bash` with `run_in_background`) report the same way in their finished task's
output; they never raise a card (§6.9).

### 4.2 Cloud sandboxes: later (designer's call)

Devices first: that is where acceptance hit the problem, the device layer is the only one a member
can lift on the spot, and the proxy is ours. For cloud sandboxes only the org layer exists, so the
card would only ever offer "ask an admin". Phase 3 asks `sandbox-docker` to report refusals from its
per-instance egress proxy into `ExecResult.network` (attribution per exec needs a per-exec proxy
credential, as sandbox-runtime does), and documents that `sandbox-e2b` cannot.

### 4.3 Rejected: asking while the connection waits

sandbox-runtime's ask callback could hold the CONNECT open while the kernel asks a person. Rejected:
the callback gets no command id (it cannot tell which conversation asked), the device protocol has no
device-initiated request, a person may answer in minutes or hours while clients time out connects in
seconds, and a command may open dozens of connections. The device still installs a callback, but only
to deny with a reason (§9).

## 5. Who can lift which layer

### 5.1 Summary

| Layer | Who can lift it | What the card offers |
|---|---|---|
| `device` | The device's owner, in a signed-in session (web, or an IM identity bound to their account) | 「这次允许」, 「这台设备一直允许」, 「拒绝」 |
| `org` | Org admins (`sandboxEgress`); a super admin when the deployment egress is `none` | No approve button: the facts plus 「请管理员添加」 (§5.3) |
| `address` | Nobody | The facts only |
| `unknown` | — | No card; the note explains the proxy (§9) |

Org admins and super admins cannot lift the device layer of a member's machine: it is the owner's
machine **(designer's call)**.

### 5.2 Device layer: the owner decides, the device applies

- **Who.** The approval's `requestedFor` is the device's owner (`devices.owner_account_id`). The
  decision route is human-only (`HUMAN_ONLY`, no PAT, no embed token, no Platform tool); an IM card
  click is re-authorized like any approval card (the clicker mapped to an account, then the same
  check). Anyone else gets "Only <owner> can allow network access on this device."
- **How the decision reaches the device.** A new kernel→device operation `policy` (device protocol
  v1, gated by a hello feature, §5.4):

  ```ts
  // DeviceOp "policy"
  args: {
    add?: string[];                         // hosts to add to allowedDomains
    remove?: string[];                      // hosts to remove
    network?: "allowlist" | "open";         // §7
    source: { approvalId?: string; accountId: string; accountName: string; via: "web" | "im" };
  }
  result: { policy: LocalPolicySummary }    // the policy as written
  ```

  It travels the existing relay (`capk:device-req:<deviceId>`, the gateway's `capk:device-taken`
  check), so only the kernel, over the device's authenticated socket, can send it.
- **What the device does.** It refuses `add` and `network: "open"` unless its local setting
  `remoteGrants` is `"owner"` (default, §13 Q1); `remove` and `network: "allowlist"` (narrowing) are
  always accepted. Each entry must pass `validateAllowHost`. It applies the change with a
  read-modify-write of `policy.json` under a lock file (`policy.json.lock`, `O_EXCL`, stale after
  10 s) so a concurrent `capybara-device policy` run cannot lose an update, writes atomically
  (`writePolicy`), swaps the in-memory policy, and appends an audit line to the local command log:
  `policy add files.slack.com by <accountName> (<accountId>) via web, approval <id>`.
- **Live, without a restart.** Per-command network lists are built at each `exec` from the in-memory
  policy, so the next command sees the change; the sandbox is not reinitialized. The program also
  re-reads `policy.json` before an `exec` when its mtime changed, so `capybara-device policy set` on
  a running device applies at the next command too (and its "Restart capybara-device" line goes). An
  invalid file on reload keeps the last good policy and prints an error to the program's log once.
- **Ordering in the kernel.** The decision route sends `policy` first, outside any transaction
  (idempotent: adding a present host changes nothing), then records the decision with the scope that
  actually took effect in a `@Transactional()` method, and resumes the run in `afterCommit`. If the
  device is offline or refuses, the decision falls back to a run grant (the device must be online for
  the run to continue anyway) and the card says 「设备离线 / 设备不接受远程修改，已按这次允许」.
- **Kernel audit**: `device.network_allowed` (approval, device, hosts, scope, by, via) and
  `device.policy_changed` (device, add / remove / network, by).

**Local confirmation (considered, not recommended for v1).** A device setting
`remoteGrants: "confirm"` would make the program ask on the machine before writing. Devices run as a
launchd / systemd service without a terminal, and the person is often answering on a phone in IM, so
it would need an OS notification with buttons per platform. The owner who wants that guarantee sets
`remoteGrants: "off"` and allows hosts with the CLI; a confirming notification can come later.

### 5.3 Org layer: a request to the admins, never a button

The card states the fact and offers 「请管理员添加」 (members) or a link 「去组织设置添加」 to the org
settings' sandbox network section with the host prefilled (org admins), never a one-click widening
of an org-wide setting from inside a conversation **(designer's call, §13 Q4)**.

The request reuses the catalog request flow (`packages/kernel/src/catalog/requests.service.ts`,
inbox type `catalog_request`, decided notice `catalog_request_decided`): a new kind
`network_allowlist` with the host(s), the member's optional note, the agent and the conversation
link. Approving adds the hosts to the org's `sandboxEgress.allowHosts`; when the org follows the
deployment default, the approve dialog says the org will keep its own list from now on (the
deployment's list copied plus the hosts). A deployment egress of `none` makes the card say
「平台关闭了沙箱网络，只有超级管理员能开启」 with no request button (requests to the platform inbox can
come later). The run does not wait for admins: the call's result is written at once (§6.6).

### 5.4 What the kernel knows about a device's policy

The device's `hello` gains optional fields (ignored by older kernels, `parseHello` keeps reading only
what it knows):

- `features: ("networkReport" | "policyOp")[]`;
- `policy: { network: "allowlist" | "open"; allowedDomains: string[]; remoteGrants: "owner" | "off" }`.

The `policy` op's result refreshes the summary. The kernel keeps the latest summary in the device's
row (`devices.local_policy jsonb`, nullable; expand-only migration), shown on the device page (§7)
and used to pick the card's options: no 「一直允许」 when `remoteGrants` is `off` or the feature is
absent; then the card says how to allow it locally (`capybara-device policy add allowedDomains
files.slack.com`). A summary may be stale after a local edit until the next connect; the device is the
authority and the card's outcome reports what it actually did.

## 6. The ask

### 6.1 One approval kind, not a new mechanism (designer's call)

A network ask is an approval (`approvals` table, `ApprovalsService`) with a new `kind` column
(`'tool' | 'network'`, default `'tool'`) and `detail jsonb`
(`{ deviceId, hosts: [{ host, port }], command, description }`). That reuses, unchanged: expiry
(`tools.approvalTimeoutHours`, the `wait-timeout` job), the run parked in `Waits` without the
conversation lock, the inbox item (`tool_approval`), the IM approval card and its re-authorization,
sub-agent waits (`subagent_waiting` kind `approval`) and the multi-replica resume. `scopes` stores
`["once", "always"]` (`["once"]` when the device takes no remote grants), with network meanings:
`once` = run grant, `always` = device grant.

### 6.2 Flow

1. `Bash` runs; the exec result carries `network.blocked`.
2. The kernel keeps only `device`-layer hosts that are not already granted in this run, not denied in
   this run (§6.8), and pass `validateAllowHost`. If none remain, or the run is unattended (§8), or
   the call ran in the background, the result is written at once with the note (§6.6).
3. Otherwise the `Bash` handler returns a kernel-internal outcome `network_ask` (like
   `input_required`): the formatted command result is kept as the resume `state` (≤ 16 KB; larger
   output is already archived as `{"$output": id}` by the formatter), the approval is created, the
   log gets `approval_requested` with a new optional, display-only field
   `network: { hosts: string[] }`, and the run waits.
4. On a decision, expiry, skip or cancel, the kernel calls the handler again with `call.resume`; it
   **does not run the command again**. It returns the kept result plus the decision note (§6.6). The
   agent decides whether to re-run (the command may have had side effects before the refusal), which
   the note tells it to do.

### 6.3 Options and their scope (designer's call, §13 Q2)

| Option | zh / en | Effect |
|---|---|---|
| This time | 「这次允许」 / "Allow this time" | A run grant: the host is allowed for the rest of the current run of this conversation and its sub-agents (the run tree, `budget_run_id` lineage). Ends when the run ends. |
| Always on this device | 「这台设备一直允许」 / "Always allow on this device" | The `policy` op adds the host to the local policy (§5.2). |
| Deny | 「拒绝」 / "Deny" | Nothing changes; the host is not asked again in this run. Optional reason, as for tool approvals. |

"This command only" was rejected: the agent's next command is a re-run, often a slightly different
one, or a `ls` first; a one-shot allowance would be spent or missed unpredictably. "This
conversation" was rejected for v1: it outlives the person's attention and is close enough to
「一直允许」 that the third button would mostly confuse.

**Run grants reach the device** in the exec args:

```ts
// DeviceExecArgs, optional
grants?: { hosts: string[]; source: { kind: "run" | "task"; id: string; accountId: string } };
```

The kernel builds them from PG for each `exec` (the run tree's approved `network` approvals with
scope `once`, or the task's grants, §8). The device adds them to the command's list only when
`remoteGrants` is `"owner"` and only as far as the org allows (the intersection with `limits` still
applies), and logs the source with the command. A device without the feature ignores the field.

### 6.4 Multiple domains, wildcards, dangerous hosts (designer's call)

- **Multiple hosts**: one ask per tool call, listing every `device`-layer host. The web card shows a
  checkbox per host, all checked; the decision applies to the checked ones (the rest count as denied).
  IM cards decide all at once (no checkboxes in a card); the text says so.
- **Wildcards**: cards grant exact hosts only. A wildcard (`*.slack.com`) is a bigger decision than a
  card should invite, and slack-like services need few hosts; wildcards stay a local decision
  (`capybara-device policy add allowedDomains '*.slack.com'`) or the device page (§7).
- **Never offered**: IP literals, names that resolve to loopback / private / link-local addresses
  (layer `address`), single-label names, `.local` / `.internal` / `.localhost` (all refused by
  `validateAllowHost` or the runtime's guard). The card shows these as facts with no button.
- **Lookalikes**: the card shows the registrable domain prominently (the last labels per the public
  suffix list, e.g. **evil.io** in `files.slack.com.evil.io`) and the full host in code style.

### 6.5 The card

Web (an approval block under the command's row, `docs/design/spec.md` approval states) and IM (the
`approval` card). Model-controlled values (host, command, description) are always rendered as code /
plain text.

| Part | zh | en |
|---|---|---|
| Title (one host) | 智能体想访问 `files.slack.com`，允许吗？ | The agent wants to reach `files.slack.com`. Allow? |
| Title (n hosts) | 智能体想访问 n 个域名，允许吗？ | The agent wants to reach n domains. Allow? |
| Body | 这条命令被这台设备的网络规则拦下了：<description> | This command was blocked by this device's network rules: <description> |
| Command | the command, clipped to 300 characters, redacted like `callSummary` | same |
| Hint under 这次 | 到智能体这次回复结束为止有效 | Until the agent finishes this reply |
| Hint under 一直 | 写入这台设备的本地策略，之后的命令都可以访问；可在设备页或用 `capybara-device policy` 撤销 | Saved in this device's local policy for all later commands; undo on the device page or with `capybara-device policy` |
| Buttons | 这次允许 / 这台设备一直允许 / 拒绝 | Allow this time / Always allow on this device / Deny |
| Decided | 已允许（这次）· 已允许（这台设备）· 已拒绝 · 已过期 · 已跳过 | Allowed (this time) · Allowed (this device) · Denied · Expired · Skipped |
| Org layer | `api.foo.com` 不在组织的网络白名单里，只有组织管理员能添加。[请管理员添加] | `api.foo.com` is not in the organization's network allowlist; only an org admin can add it. [Ask an admin] |
| Address layer | 这个地址指向内网或本机，智能体的命令不能访问。 | This address points to a private network or this machine; agent commands cannot reach it. |

The primary (focused) button is 「这次允许」, never 「一直允许」.

IM: the `approval` card gains an optional `scopeLabels?: Partial<Record<"once" | "session" |
"always", string>>` and the kernel fills `title`, `toolName` (`Bash`) and `inputPreview` (the host
list and the command). Channel plugins that do not know `scopeLabels` render their default scope
labels, which still read sensibly; slack, lark and telegram are updated to use them
(`capybara-hq/plugins`). `renderCardAsText` uses the labels too. Org-layer and address-layer facts
are not cards: they go into the agent's reply naturally (the model sees the note) and the web shows
the display-only event below. SDK change: `pnpm gen:sdk-api` and a changeset.

A new display-only event `network_blocked` (`{ step, callId, hosts: [{ host, port, layer }] }`,
not model-visible) records every reported refusal, including those that raise no ask, so the web can
draw the org-layer request button and the facts under the command row.

### 6.6 What the model sees

Everything model-visible is the call's `tool_result` content, written once and kept in the log, so no
`DriftReason` is needed **(designer's call)**; `approval_requested.network` and `network_blocked`
are display-only. The note is English, appended after the command output by the kernel, one line per
outcome:

- Asked, allowed this time: `[network] files.slack.com was blocked by this device's network policy.
  The user allowed it for the rest of this task. Run the command again.`
- Allowed always: `[network] … The user allowed it on this device from now on. Run the command again.`
- Denied: `[network] … The user declined access to files.slack.com. Do not try to reach it another
  way; continue without it or ask the user.` (plus `Reason: …` when given).
- Expired: `[network] … The user did not answer within 24h; access stays blocked.`
- Skipped (§6.7): `[network] … The user sent a message instead of answering; access stays blocked.`
- Org layer: `[network] api.foo.com is not in the organization's network allowlist. Only an
  organization admin can add it; the user can ask an admin from the conversation. Continue without
  it or tell the user.`
- Address layer: `[network] 10.0.0.5 is a private or local address, which commands can never reach.`
- Unattended (§8): the texts in §8.3.

The device's own trailer (§9) stays in stderr as well; the kernel's note adds only the outcome.

### 6.7 Timeouts and replies (designer's call, §13 Q3)

- Expiry: `tools.approvalTimeoutHours` (24 h default), as for tool approvals.
- **A message from the person skips the ask** (outcome `skipped`, access stays blocked, the run goes
  on with the message), exactly like a pending question (reply-while-question spec), unlike a tool
  approval (that spec's §4.4). The difference is justified: a tool approval guards an action that has
  not happened, while here the command already ran and nothing runs on "yes" either; the run should
  follow the person.
- Abort / cancel: as for approvals (`cancelled`, the note says the run was stopped).

### 6.8 Approval fatigue (designer's call)

- A host denied, expired or skipped in a run is not asked again in that run: later refusals of it
  get the denied note directly.
- At most one pending network ask per run tree; at most 5 network asks per run; beyond that the note
  says "Too many network requests in this task; ask the user to allow the domains on the device page."
- Hosts already allowed by a run grant never reach the card (they are not refused).

### 6.9 Not asked

Background commands, `Read` / `Write` / file helpers (no network), and runs on a device whose program
lacks the feature: the note or the device trailer explains, no card.

## 7. 「这台设备不限网络」

- **What it means**: the local policy stops narrowing (`policy.network = "open"`); the command's
  allowed set becomes exactly the org's effective egress (an org `allowlist` still applies; an org
  that is `open` makes it any public host; `none` stays none). Loopback and private addresses stay
  refused by the runtime's guard. So the org always narrows: a member cannot open more than the org
  allows **(designer's call)**. `effectiveEgress` returns the org's list for `allowlist` and `["*"]`
  for `open` (the runtime accepts `*`; the plan verifies its per-command list does).
- **Where it is set** (designer's call, §13 Q6): locally, `capybara-device policy set network open`,
  which prints the risk text and asks for `--yes` (or an interactive `y`); and on the device's page by
  its owner (a switch with the same risk text in a confirm dialog), delivered by the `policy` op and
  accepted only under `remoteGrants: "owner"`. Turning it off is always accepted.
- **Risk text** (zh / en):
  - 不限网络后，智能体在这台设备上运行的命令可以访问组织允许的任何地址（组织也不限时，就是任何公网地址），包括把文件上传到外部网站。提示注入能让智能体这样做。只在你自己的开发机上、并且信任所用的智能体和资料时开启。
  - With no network limit, agent commands on this device can reach any address the organization
    allows (any public address if the organization has no limit), including uploading files to
    outside sites. Prompt injection can make an agent do that. Turn it on only on your own
    development machine, with agents and material you trust.
- **Visible**: the device page and the device picker show 「不限网络」 with a warning tone while it is
  on; the hello summary keeps the kernel's view current.
- **Device page network section** (owner only): the local allowlist with remove buttons (narrowing,
  always accepted), an add field that accepts wildcards (same `validateAllowHost`), the switch, and
  the `remoteGrants` state read-only (it is set only locally:
  `capybara-device policy set remoteGrants owner|off`).

## 8. Unattended runs

### 8.1 Scheduled tasks: domains are task grants

- Task grants (`scheduled_task_grants`) accept entries with the key `network:<host>` (exact host;
  `validateAllowHost`). They mean: in this task's unattended runs, the host is a run grant (§6.3,
  `grants.source.kind = "task"`). The device applies them under `remoteGrants: "owner"` only.
- `grantRefusalOf` (`schedules/grant-rules.ts`) gains the network rules: refuse an invalid host
  (`not_grantable`), a host outside the org's effective egress (`needs_admin`: only an admin can add
  it, the inbox shows it without an action and links the request flow), and any network grant when
  the task's device reports `remoteGrants: "off"` (`device_refuses`, with the CLI hint).
- **Collected** like tools: added on the task form (a "Network access" list), or by a **trial run**:
  a network ask the creator allows 「这次」 in a trial run becomes a task grant when the rule allows it;
  an 「一直允许」 needs no task grant (the device already has it). The task page lists them for review.

### 8.2 Channel connections: no list (designer's call, §13 Q5)

An IM-triggered run is started by a person and is attended by the scheduled tasks spec's definition;
its ask goes to that person (the device owner) on the card in the thread, and a reply skips it
(§6.7), so nothing hangs longer than any approval. A per-connection domain list would let whoever
can post in a group spend the owner's allowances. Revisit when channels gain triggers without a
person.

### 8.3 Fail fast

In an unattended run (`runs.scheduled_task_run_id` set, the same rule as tool grants), a refused
`device`-layer host without a task grant, under the org's `unattendedAsk`:

- `fail` (default): no approval; the note is `[network] files.slack.com is blocked on this device and
  this scheduled run cannot ask for network access. The task's owner can add it to the task's approved
  domains. Continue without it.`; `network:files.slack.com` is recorded in `missing_grants`, so the
  creator's inbox (`schedule_attention`, `<taskId>:grants`) offers "allow for this task".
- `wait`: an ordinary network ask to the creator (inbox, IM card), as tool approvals do.

An `org`-layer host records `network:<host>` with `needsAdmin`; the inbox item says an admin must add
it. Sub-agents of an unattended run use the root task's grants.

## 9. Phase 0: self-explaining refusals now

Shipped in `@capybara-hq/device` alone (plus one kernel line), before any card:

1. **Deny with a reason.** `createOsExecutor` initializes the runtime with an ask callback that
   always returns `{ allow: false, reason }`, checked against `SandboxManager.askCallbackDenyReason`.
   The callback has no command id, but a device belongs to one org, so it classifies against the
   last `limits` seen and the current policy: `"capybara: files.slack.com is not in this device's
   allowed domains"` or `"capybara: files.slack.com is not in the organization's network
   allowlist"`. Clients that print the status phrase (Python, `curl -v`, Node) now say why.
2. **A trailer after every blocked command.** After the command, the executor reads the command's
   violations (§4.1) and appends to stderr, English, at most 20 hosts:

   ```
   [capybara-device] Network access was blocked:
   - files.slack.com:443: not in this device's allowed domains. Only the device owner can allow it
     (capybara-device policy add allowedDomains files.slack.com, or the device page).
   - api.foo.com:443: not in the organization's network allowlist. Only an organization admin can
     add it.
   - 10.0.0.5:22: a private or local address; commands can never reach it.
   ```

   The trailer is model-visible through the existing `tool_result` (in the log; no `DriftReason`).
   It names the layer precisely because the device has both lists.
3. **Proxy hint in `Bash`'s description** (kernel): "Network access goes through a proxy set in
   HTTP_PROXY / HTTPS_PROXY / ALL_PROXY; a tool that ignores them fails with 'Operation not permitted'.
   A blocked domain is reported after the output." A description change shows as `tools_changed` in
   replays of older cases, which is that reason's purpose.
4. **Live policy reload** and `capybara-device policy add|remove allowedDomains <host>` (§5.2).

## 10. Security review

### 10.1 What changes in the trust model

The environments spec §8.2 said the local policy "cannot be loosened remotely". With this spec it can
be, **only** by the device owner's own decision in a signed-in session, and only while the device's
local `remoteGrants` is `"owner"`. A compromised deployment could forge such a decision. An owner who
wants the old guarantee sets `remoteGrants: "off"` locally: the device then refuses every widening
from the cloud (run grants, task grants, `add`, `open`) and the cards show only the CLI hint. The
environments spec's §8.2 row is amended to say so. Narrowing from the cloud is always accepted.

### 10.2 Threats

| Threat | Measure |
|---|---|
| Prompt injection makes the agent exfiltrate to an attacker's host | The request is refused and a person must decide; the card shows the command, the agent and the registrable domain; the primary button is the narrowest grant; a denied host is not asked again in the run; the model-visible note tells it not to try another way. An allowlist never stops exfiltration to an allowed host (stated in the risk text and the sandbox README rules). |
| A malicious page or message asks the person to approve ("click allow to continue") | The card's text is the kernel's, never model text; model values are code-styled; 「一直允许」 is never the default; wildcards are never offered on cards. Residual: a person can still be persuaded; that is their decision, recorded in the audit. |
| The agent approves its own request | Decision routes are human-only (no PAT, no embed token); no Platform operation decides network asks or changes a device policy (exclusions with reasons in `platform-ops`: "a person must decide network access on their own device"); `AskUserQuestion` answers never grant. |
| Approval fatigue | §6.8 caps, one pending ask per run tree, run grants end with the run, exact hosts only. |
| Another member or an admin widens my machine | `requestedFor` is the device owner; admins cannot decide device-layer asks; the device op carries the deciding account and is logged locally. |
| A forged or replayed `policy` frame | Only the kernel writes to the device socket (authenticated `cap_dev_` credential, gateway `device-taken` checks); the op is idempotent; the device validates every host. |
| DNS tricks (`a.allowed.com` resolving to `10.0.0.1`, control characters) | The runtime's host validation and resolved-address guard refuse them regardless of grants; layer `address` is never offered. |
| A device lying about the layer | The kernel recomputes the `org` layer; a device can only cause an ask about its own policy, which its owner decides. |
| A rogue local edit of `policy.json` | Local root and the owner are trusted (environments spec §8.2). |

### 10.3 Multi-replica and multi-tenant

- Approvals, run grants (approved `network` approvals by run tree), task grants and the device's
  policy summary live in PG; nothing in process memory. The wait and resume use the existing
  approval waits; the device op uses the existing Redis relay; a decision on one replica resumes a run
  parked by another.
- The `policy` op is sent outside the decision transaction; the decision, its audit row and the
  resume enqueue follow the `@Transactional()` + `afterCommit` rule.
- Every lookup is org-scoped: the approval's org, the conversation's org and the device's org must
  match; the device belongs to one org; a run grant never leaves its run tree, a task grant its task.
- Concurrent writers on the machine (CLI and program) are serialized by the lock file.

### 10.4 Audit

- Kernel: `device.network_allowed`, `device.network_denied` (asks), `device.policy_changed` (the op,
  with add / remove / network and the deciding account); an admin's change of the org allowlist is
  the existing `org.settings_updated` row (an approved request adds the request id).
- Device: the local command log records each policy change (source CLI or cloud, account,
  approval) and each command's grants source.
- Web: the device page shows the recent policy changes from the audit rows.

## 11. Phases

| Phase | Scope | Packages |
|---|---|---|
| 0 | §9: deny reason, stderr trailer, `Bash` proxy hint, live reload, `policy add/remove` | device, kernel (description) |
| 1 | Structured report (`ExecResult.network`, hello `features` / `policy`, `devices.local_policy`); network asks for the device layer (approval kind, `network_ask` outcome, run grants in exec args, `policy` op, cards web + IM with `scopeLabels`, notes, `network_blocked` event, audit, Platform exclusions); unattended runs fail fast with the note (no task grants yet); `remoteGrants` | plugin-sdk (changeset), device, kernel, web, plugins (card labels) |
| 2 | Org-layer requests (`network_allowlist` request kind, inbox); device page network section and 「不限网络」 (CLI and web); scheduled task network grants, trial collection, `missing_grants` | kernel, web, device |
| 3 | Cloud sandboxes report refusals (`sandbox-docker` proxy; `sandbox-e2b` documented as unable); Docker device mode behind a domain proxy so it can report and allow per host | plugins, device |

Each phase is a design-reviewed plan in `docs/superpowers/plans/`; phase 1 touches a trust boundary
(device widening) and is reviewed alone on the most capable model per the subagent strategy.

## 12. Tests (outline)

- Device: the violation-line parse pinned to sandbox-runtime 0.0.81; classification (device / org /
  address, both layers → org); the trailer; the ask callback's reason; live reload (mtime, invalid
  file keeps the last good policy); the lock file under concurrent CLI + op writes; `policy` op
  refused under `remoteGrants: "off"` except narrowing; run grants applied only within the org's
  limits; an OS-mode integration test with a local HTTP server behind the proxy (blocked, then
  allowed by a run grant, then by `add`, without a restart).
- SDK: `parseOpResult` with and without `network`; hello with and without the new fields; the
  `policy` op guards; `renderCardAsText` with `scopeLabels`.
- Kernel (model-fake, sandbox-fake / a fake device): a blocked command asks, the run waits, each
  decision writes the expected note without re-running the command; "always" sends the op once and
  falls back to "this time" when the device is offline; the org layer recomputed from settings;
  repeated host in a run not asked again; caps; a reply skips the ask; expiry; sub-agent ask
  surfaces in the root; unattended `fail` records `missing_grants`, `wait` asks the creator; trial
  run turns allowances into task grants; non-owner, PAT and Platform calls refused; dual-replica:
  ask on one replica, decide on the other, resume once.
- Replay: zero-drift fixture tests before and after (`reconstruct.test.ts`, `rename-compat.test.ts`);
  a reconstruct case with a network ask (the note is in the `tool_result`, the display fields are
  ignored).
- Channels: fake-im approval card with `scopeLabels`, click by the owner, click by another member,
  text fallback.
- Web: the approval block variants (one host, n hosts with checkboxes, org-layer facts with request
  button, address facts), the device page network section, the 「不限网络」 confirm dialog, i18n zh / en
  (`check:i18n`: 智能体, 平台, 超级管理员).

## 13. Open questions for the maintainer

1. **May the cloud widen a device's policy by default?** `remoteGrants` default `"owner"` (cards can
   offer 「这次」 / 「一直允许」 and the web switch works) or `"off"` (the old guarantee; cards only show
   the CLI command). *Recommendation*: `"owner"`, as the approved direction implies; the risk is stated
   in the trust model, and the owner can turn it off locally.
2. **What does 「这次允许」 cover?** The rest of the current run including its sub-agents, vs this one
   command, vs this conversation. *Recommendation*: the current run (§6.3).
3. **Does a reply skip a pending network ask?** Unlike tool approvals. *Recommendation*: yes (§6.7).
4. **May an org admin widen the org allowlist from the card in one click?** *Recommendation*: no; a
   link to org settings with the host prefilled, and a request for members (§5.3).
5. **Pre-approved domains per channel connection?** *Recommendation*: no for now (§8.2).
6. **「不限网络」 from the web too, or only the device CLI?** *Recommendation*: both, the web switch only
   while `remoteGrants` is `"owner"`, with the risk text in a confirm dialog (§7).
