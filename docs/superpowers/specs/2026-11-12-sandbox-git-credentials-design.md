# Git credentials for sandboxes

- Date: 2026-11-12.
- Status: approved (2026-11-12). The maintainer accepted every recommendation of §13 ("whatever
  can be built and is safe and sound is right"); §13 now records them as decisions. Calls made here
  are marked **(designer's call)**. Plan: `docs/superpowers/plans/2026-11-12-sandbox-git-credentials.md`.
- Issue: capybara-hq/core#194.
- Related: the GitHub connector templates (capybara-hq/plugins#76, PR #77), the sandbox
  development tiers (`2026-11-12-sandbox-dev-tiers-design.md`, issue #190, PR #191; this design
  only reads it and stays consistent with it), the network ask-to-allow spec
  (`2026-11-12-network-ask-to-allow-design.md`), scheduled tasks
  (`2026-11-11-scheduled-tasks-design.md`), environments / devices
  (`2026-11-07-environments-design.md`).

## 1. Why

Agents can work with GitHub's API through the GitHub connector (issues, pull requests, reviews,
CI status) as the person using them. Real code work also needs git in the sandbox: clone a private
repository, fetch, branch, commit, push. Today that fails everywhere except an unsandboxed local
device:

| Environment | Git credentials today |
|---|---|
| Local device, sandboxed (OS mode) | none: `~/.ssh`, the macOS keychain and `SSH_AUTH_SOCK` are denied (`DENIED_SECRET_PATHS`) |
| Local device, Docker mode | none: no keys in the container |
| Local device, unsandboxed (dev tiers §5.4) | the host's own (SSH keys, keychain, `gh`) |
| Cloud Docker / E2B | none |

The goal: **one GitHub connection covers API work and git push / pull, permissions follow the
person**, and the person's token never lands on disk, in logs, in the event log or in anything the
model sees.

## 2. Goals, non-goals, anti-goals

Goals:

- `git clone / fetch / pull / push` over HTTPS to github.com (and GHE hosts) work in every sandbox
  (local OS mode, local Docker mode, cloud Docker, E2B), shared devices included, as the person the
  command runs for.
- The person's GitHub token never enters the sandbox: not in env, files, process memory of
  sandboxed processes, command output, events or logs.
- What an agent may do with git is governed like the rest: reads run, pushes follow a policy
  (allow / ask / deny), unattended runs use task grants.
- Disconnecting the GitHub connection, ending the run, or an admin switch stops access at once.
- Every push (and a summary of fetches) is audited with the person, run, repository and result.

Non-goals:

- SSH transport (`git@github.com:`). It is rewritten to HTTPS (§5.5), never served.
- The GitHub CLI (`gh`), `curl` to `api.github.com`, package registries with tokens (npm, GHCR):
  API work goes through the connector's tools; registry credentials are a later design.
- Commit signing (GPG / SSH signatures). Later (§12).
- The unsandboxed local device: it keeps the host's own credentials (§8.3).

Anti-goals:

- A token in the sandbox "just for the duration of the command".
- A long-lived machine identity (deploy key, bot PAT) that silently replaces the person.
- Writing a credential store, `.git-credentials`, a `credential.helper=cache` socket or a remote URL
  with userinfo into the sandbox's file system.

## 3. Constraint that shapes the design: GitHub cannot mint a short, narrow user token

The proposed direction was: a credential helper in the sandbox asks the kernel, the kernel mints a
short-lived token from the person's connection, scoped to github.com and optionally to named
repositories. GitHub's token types do not allow that for a person:

| Token | Acts as | Lifetime | Narrow to repos? |
|---|---|---|---|
| GitHub App user-to-server (`ghu_`), our `github` template | the person (∩ app permissions ∩ installation) | 8 h, refreshable | no (the installation's repos) |
| OAuth App token (`gho_`) | the person, classic scopes | never expires | no |
| Fine-grained PAT (`github_pat_`), `github-pat` template | the person | up to the person | fixed at creation |
| GitHub App installation token (`ghs_`) | **the app** (a bot), not the person | 1 h | yes, repos and permissions |

So any design that hands a token to a process in the sandbox hands over the person's real token,
valid for hours (or forever) and for every repository the person can reach. The model can print it
(`git credential fill`, `env`, `/proc/<pid>/environ`), and an allowed egress host (github.com
itself: a gist, an issue comment) can carry it away. Redacting the exact string in command output
helps with accidents, not with an injected prompt that base64-encodes it. An installation token
would be narrow and short, but pushes would be the app's, not the person's (anti-goal).

**Therefore (designer's call): the kernel holds the token and git talks to the kernel.** The
sandbox gets only a **ticket**: an opaque, kernel-only capability bound to one run and one
person, usable only for git smart-HTTP to declared hosts through the kernel, dead when the run
ends. The kernel adds the person's token on the way out. This is the "git gateway" (§5). The
credential helper design is kept in §11 as the alternative.

## 4. Terms

- **Git gateway**: a kernel HTTP route that relays git smart-HTTP requests from a sandbox to a git
  host, adding the person's credential. Stateless across replicas.
- **Ticket**: a random 256-bit bearer value the kernel gives one exec (env). Stored hashed in Redis
  with its binding; never a GitHub credential.
- **Git source**: a connector that declares it can authenticate git for some hosts (§6.1), e.g. the
  `github` / `github-pat` templates for `github.com`.
- **Actor**: the account a sandbox command runs for (`SandboxActor.accountId`, the run's
  `trigger_account_id`).

## 5. The git gateway

### 5.1 Request path

```
sandbox: git push origin feat/x
  │  git config from env (§5.4): url."<gw>/github.com/".insteadOf "https://github.com/"
  │                              http."<gw>/".extraHeader "Authorization: Bearer <ticket>"
  ▼
kernel  POST /git/v1/github.com/acme/app.git/git-receive-pack     (route group "git", api role)
  1. ticket → { orgId, accountId, runId, execId, hosts, repos?, expiresAt }   (Redis, sha256 key)
  2. run still active (or its background work), account still an active member, gateway on for org
  3. path is smart-HTTP only: info/refs?service=git-upload-pack|git-receive-pack,
     git-upload-pack, git-receive-pack (+ LFS batch later, §12); repo matches ticket.repos
  4. push? → policy (§7): allow, or refuse with an ask recorded for the exec
  5. credential: the actor's connection of the git source for this host (§6) → fresh token
     (Credentials.injection: refresh, cross-replica lock, as for tool calls)
  6. relay to https://github.com/acme/app.git/... with Authorization: Basic x-access-token:<token>
     streaming both ways, no redirects followed, client Authorization stripped
  7. audit (§9); per-exec counters for the Bash result note
```

The token exists only in the kernel process for the duration of the upstream request.

### 5.2 Why HTTP to the kernel and not a socket or the device WebSocket

- Every sandbox kind can already reach some HTTP host through its egress; the kernel's public URL
  is one more host (§10). No new transport in the device protocol, no device-initiated request
  (which the network ask-to-allow spec §4.3 rejected for good reasons).
- Multi-replica: any api replica serves any request; nothing lives in process memory.

### 5.3 Relay rules

- Only the smart-HTTP endpoints above; anything else 404. No dumb HTTP, no `/archive`, no API.
- Upstream host = the path's first segment, which must be one of the ticket's hosts (which come from
  the org's git sources, §6). The kernel's outbound goes through `packages/kernel/src/net`
  (no private addresses unless the deployment allows the host, as for every admin-supplied URL).
- Request headers forwarded: `Content-Type`, `Content-Encoding`, `Accept`, `Git-Protocol`,
  `User-Agent` (suffixed `capybara-git-gateway`). Response headers back: `Content-Type` and the
  cache headers (`Cache-Control`, `Expires`, `Pragma`); `Content-Encoding` is not passed back
  because the kernel's HTTP client decodes the body. Invalid or expired tickets answer 403
  `text/plain` (git hides 401 bodies). Never the
  ticket upstream, never upstream `Set-Cookie` / `WWW-Authenticate` downstream (a 401 upstream
  becomes a 403 with an actionable git error text, §5.6).
- Streaming with backpressure, no buffering; per-request idle timeout and a byte cap per run
  (`tools.git.maxBytesPerRun`, default 5 GiB) **(designer's call)**.
- Errors reach git as `ERR` pkt-lines / HTTP status with a short English message git prints, e.g.
  `remote: Capybara: pushing needs approval; the agent will ask you.`.

### 5.4 How git in the sandbox is pointed at the gateway

Per exec, the `Bash` tool (and background tasks) pass env through the existing per-exec `env` of
`sandbox@2` (`exec` args; docker `Env`, e2b command envs, device `DeviceExecArgs.env`), using git's
environment config (git ≥ 2.31):

```
GIT_CONFIG_COUNT=4
GIT_CONFIG_KEY_0=url.<gw>/github.com/.insteadOf      GIT_CONFIG_VALUE_0=https://github.com/
GIT_CONFIG_KEY_1=url.<gw>/github.com/.insteadOf      GIT_CONFIG_VALUE_1=git@github.com:
GIT_CONFIG_KEY_2=http.<gw>/.extraHeader             GIT_CONFIG_VALUE_2=Authorization: Bearer <ticket>
GIT_CONFIG_KEY_3=credential.<gw>/.helper            GIT_CONFIG_VALUE_3=     (empty: no helper asks)
GIT_TERMINAL_PROMPT=0
GIT_AUTHOR_NAME / GIT_AUTHOR_EMAIL / GIT_COMMITTER_*  = the person's GitHub name and noreply email
```

(`ssh://git@github.com/` too; one `insteadOf` pair per declared host.) Nothing is written to disk:
`insteadOf` is applied at use, so `.git/config` keeps `https://github.com/acme/app.git`, which works
again in the next command with the next ticket. Submodules follow the same rewrite.

Commit identity: at connect (and on refresh) the kernel reads the person's GitHub login and id
once and derives `<id>+<login>@users.noreply.github.com` **(designer's call: the noreply address,
not a private email)**.

### 5.5 SSH

Not served. `git@github.com:` and `ssh://git@github.com/` are rewritten to the gateway (§5.4), so
remotes written with SSH URLs just work over HTTPS. The dev tiers' SOCKS path for port 22 stays for
other uses; there are no keys in any sandbox (dev tiers §6.2 defers `sshAgent` to this design: this
design keeps it deferred, recommended never for cloud).

### 5.6 What the model sees

- The `device_paths` event (already model-visible, no `DriftReason`; dev tiers §11.5 extends it)
  gains one English line when a git source covers the actor: "Git over HTTPS to github.com uses
  your GitHub connection; pushes may need approval." Zero-drift fixtures before and after.
- After a command that used the gateway, the `Bash` result note (like the network note) may say
  "Pushed acme/app (feat/x)" or "Push to acme/app needs approval" (§7). Never the ticket, never
  a token.
- The ticket is in the command's environment, so `env` would print it: the Bash formatter redacts
  the exec's ticket from stdout / stderr before the result is formed (the kernel knows it), and
  the ticket is useless outside the gateway and after the run anyway.

## 6. Whose credential

### 6.1 Git sources (contract change)

A connector template (and a custom connector) may declare git hosts it authenticates:

```json
"git": { "hosts": [{ "host": "github.com", "username": "x-access-token" }] }
```

`username` is the Basic user the host expects with a token password (GitHub `x-access-token`,
GitLab `oauth2`, Bitbucket `x-token-auth`). Validated like `endpoint` (hosts pass
`validateAllowHost`, no credentials). The `github` and `github-pat` templates get
`github.com`; a GHE.com template variant derives `<sub>.ghe.com` from its editable URL **(designer's
call: an `editableEndpoint`-derived host is resolved at install and stored on the connector)**.
SDK public API change (`pnpm gen:sdk-api`, changeset).

### 6.2 Selection

For an exec, the kernel builds the ticket's hosts from the org's git sources the **actor** has a
usable credential for:

- **Personal connections (default)**: the actor's own connection. No connection → no rewrite for
  that host; git falls back to anonymous HTTPS (public repos clone) and a push fails with
  `remote: Capybara: connect GitHub to push (Settings → Connectors).`
- **Org connections** (a connector with `ownership: "org"`, e.g. a bot PAT): used only when an org
  admin turns on "use for git" on that connector, and then pushes are the bot's; the audit and the
  Bash note say so **(designer's call)**. Never mixed: a host has one source per org (the admin
  picks when several match, §13 Q4).
- **Anonymous channel guests** (channel connection with unbound policy `anonymous`): never a
  credential.

### 6.3 Who the actor is, per run kind

| Run | Actor (existing rules) | Git |
|---|---|---|
| Web / API chat | author of the message (`trigger_account_id`) | their connection |
| Channel (Slack, Lark, …) | the bound account | their connection; guests none |
| Sub-agent, skill fork | the parent's account | same as the parent |
| Scheduled task (unattended) | the task's creator (scheduled tasks §3, decided) | creator's connection; pushes need a task grant `git:push` or `git:push:<owner>/<repo>` (§7) |
| Wake after background work | the stored trigger account | same; unattended rules if the trigger was |
| Shared device, several people | each exec's own actor | each person's own ticket; files are shared, credentials never |

## 7. Policy: fetch runs, push follows a policy

- Fetch / clone / pull (`git-upload-pack`) run without asking (reads, like `allow` tools).
- Push (`git-receive-pack`) is governed by a per-connector virtual tool policy `git_push`
  (`allow` / `ask` / `deny`), default **`ask`**, same place as the connector's tool policies,
  member overrides where allowed **(designer's call)**.
- `ask` reuses the network ask-to-allow flow (§6.1–6.2 there): the gateway refuses the push with
  the pkt-line error, records `{ execId, repo, refs }` (Redis, TTL), the `Bash` handler sees it after
  the exec and returns the `network_ask`-style outcome with an approval of a new kind `git`
  (`detail: { host, repo, refs }`; scopes `once` = this run, `always` = this repo for the person,
  stored as a member policy). The command is not re-run by the kernel; the note tells the agent to
  run the push again.
- Optional **repo allowlist**: an agent definition or a scheduled task may list repositories
  (`owner/repo` patterns); the ticket carries it and the gateway refuses others. This is how
  "scoped to named repos" is enforced, since the token cannot be (§3).
- Unattended runs: no asking; `git:push` task grants as in network grants (scheduled tasks §7,
  network ask-to-allow §8.1), collected on the task page by the creator. Task grants
  `git:push:<owner>/<repo>` carry no host: they cover that repository on every git host declared
  in the org, while member standing allows and run grants are per host.
- Branch protections, required reviews and push rulesets stay GitHub's: the person's own rights
  apply.

## 8. Environments

### 8.1 Cloud Docker

The egress proxy must let the sandbox reach the gateway. `SandboxLimits` gains
`gateway?: { origin: string }` (sandbox@2, additive) **(designer's call)**; sandbox-docker's proxy
allows exactly that origin even if it resolves to a private address (a kernel on the same compose
network), and only that one. The kernel's sandbox-facing origin is `tools.git.gatewayUrl`, default
`http.publicUrl`. Works in every tier (strict included): the gateway is the kernel, not the
internet.

### 8.2 E2B

E2B sandboxes run in E2B's cloud: the gateway origin must be publicly reachable (https). The
kernel adds its host to `network.allowOut`. A deployment without a public URL gets no git gateway on
E2B; the device page says so.

### 8.3 Local devices

- **OS mode (sandboxed)**: the device adds the gateway origin (from the exec's limits) to srt's
  allowed domains for that command. The device already connects to the same deployment, so the host
  is known and trusted.
- **Docker mode**: today env goes to `docker exec -e K=V` on the command line, visible in the
  host's process list. The device must pass env through `--env-file` (0600, removed after start)
  or `-e NAME` with the value in the docker CLI's own environment **(required fix, small)**.
- **Unsandboxed** (dev tiers §5.4): the gateway env is **not** injected by default: the host's own
  credentials apply, as the person chose. A local policy key `gitGateway: "on"` opts in
  (e.g. to push as the connected account on a shared build box) **(designer's call)**.

### 8.4 Dev tiers consistency

- The dev hosts preset `D` already lists `github.com`, `codeload.github.com`, `api.github.com` and
  the githubusercontent hosts; the deployment's default `allowHosts` already lists github.com and
  codeload. With the gateway, git itself needs only the gateway origin; direct github.com egress
  stays useful for anonymous clones of public repos, release downloads and tarballs (codeload).
- The gateway is allowed in every tier and does not widen any tier: it reaches only declared git
  hosts with the actor's own rights.

## 9. Revocation and audit

Revocation, each effective on the next request (the gateway looks everything up per request):

- The person disconnects GitHub, or the token is refused upstream: a repeated upstream 401
  deletes a credential only when an OAuth refresh is refused (a static token stays, as for tool
  calls), and git gets a reconnect message.
- The run ends, is aborted, or the actor leaves the org / is deactivated → tickets of the run are
  deleted (run-end hook) and also expire: a ticket lives a fixed `tools.git.ticketTtlSeconds` per
  exec (no renewal yet; renewal for long background work is decided with the exec env task).
- An org admin switches the gateway off for the org (`gitGateway: false` org setting), or a
  connector's "use for git" off; the super admin via `tools.git.enabled`.

Audit (`audit_log`, never a token or ticket):

- `git.push` per receive-pack: account, run, conversation, connector, host, repo, refs updated,
  result (ok / refused: policy, repo list, upstream status).
- `git.fetch` aggregated per run and repo (count, bytes), written at run end.
- `git.ticket.issued` is not audited (one per exec would flood); tickets are counted in metrics.

Logs: the gateway logs host, repo, service, status, bytes and duration with `reqId`; the token is
registered with the redactor as for tool calls; tickets are logged only as their hash prefix.

## 10. Security review

| Threat | Measure |
|---|---|
| Token theft from the sandbox | the token never enters it (§3, §5) |
| Ticket theft (printed, exfiltrated) | bound to one run and actor, dead at run end, usable only through the gateway for smart-HTTP to declared hosts, pushes still policy-gated, redacted from Bash output |
| Gateway as open relay / SSRF | upstream host only from the org's git sources; fixed path shapes; `net` rules; no redirects |
| Another org's or person's credential | ticket binds org and account; credential lookup by (org, connector, actor) as tool calls do |
| Prompt injection pushes malicious code | push `ask` by default, repo allowlists, GitHub branch protection; audit |
| Large transfers exhaust a replica | streaming, byte caps per run, idle timeouts, per-org concurrency limit |
| Docker-mode device leaks env in `ps` | `--env-file` fix (§8.3) |
| Shared device: one person's push as another | ticket per exec actor; no credential on disk |

Multi-replica: no in-process state; tickets and pending push asks in Redis with TTL; the run-end
cleanup is an `afterCommit` step; the per-run byte counter is a Redis counter.

## 11. Alternative: a credential helper (the original direction)

`git-credential-capybara` in every image / device: git calls it, it asks the kernel (ticket in env),
the kernel returns the person's token, git uses it. Simpler: no relay, traffic goes straight to
github.com, no kernel bandwidth. But the person's full token is in sandbox memory and printable
(§3), for 8 hours or forever, for all their repositories, and it needs a binary in every image and
on every device. Not built (§13 Q1). Were the relay's bandwidth ever unacceptable, a helper
mode would at least add exact-token redaction of Bash output and use only GitHub App
(expiring) tokens.

Also considered: TLS interception in the egress proxy (inject `Authorization` for github.com).
Rejected: a trusted CA in every image and on every local device, and srt on local devices is not
ours to change into a MITM.

## 12. Generalisation and later

- **GitHub Enterprise**: GHE.com data residency works through the template's editable URL and a
  derived git host. GitHub Enterprise Server has no remote MCP server: a custom connector (a credential-only
  connector, §13 Q6) declares the GHES
  host as a git source.
- **Git hosts** are bare host names without a port; hosts under `.internal` / `.local` are refused
  by the SDK host rule, so a GHES on such a name or on a non-default port is not supported yet.
- **GitLab / Bitbucket / Gitea**: the gateway is host-agnostic; each needs only a git source with
  its host and Basic username. GitLab's MCP server or an OpenAPI connector can be that source.
- Later: Git LFS (batch API through the gateway, object downloads go to presigned URLs without
  credentials), commit signing (a kernel-side signing service, never a key in the sandbox),
  `gh` CLI support (an API relay with the same tickets), package registries.

## 13. Decisions (maintainer, 2026-11-12: every recommendation accepted)

1. **Relay (gateway) or credential helper?** **Decided: the gateway** (§5): it is the only way the
   token stays out of the sandbox with GitHub's token types. Cost: clone traffic through the kernel.
2. **Push policy default**: decided: `ask` per push (once / always-for-this-repo), consistent with
   the template's write tools; unattended runs need a `git:push` task grant.
3. **Org connections for git**: decided: personal only by default; an org connector used for git
   only when an org admin turns it on, labeled as a bot identity everywhere.
4. **Several sources for one host** (e.g. `github` and `github-pat` both connected): decided: the
   org admin picks one per host (org setting); default the OAuth template when both exist.
5. **Unsandboxed local devices**: decided: no injection by default (host credentials), opt-in
   `gitGateway: on` in the local policy.
6. **Credential-only connectors** (GHES, GitLab without MCP): decided: a tiny `connector-git`
   kind later (endpoint = host, no tools) rather than abusing an OpenAPI connector; not in phase 1.
7. **Gateway origin for sandboxes**: decided: `tools.git.gatewayUrl` (default `http.publicUrl`)
   plus the `SandboxLimits.gateway` exception in the Docker proxy; E2B needs a public origin.
8. **Commit identity**: decided: the GitHub noreply address and display name from the connection;
   the person can override in their account settings later.

## 14. Phases (detailed in the plan)

1. Core: SDK `git` template field and `SandboxLimits.gateway`; kernel gateway route (fetch + push,
   policy, tickets, audit), Bash env injection and ticket redaction, `device_paths` line; device
   Docker-mode env fix and OS-mode allow of the gateway origin; config and org setting.
2. Plugins: `github` templates declare `git.hosts`; sandbox-docker proxy gateway exception;
   sandbox-e2b allowOut; image already has git.
3. Approvals of kind `git`, task grants `git:push`, UI (connector page "use for git", device page
   line, task page grants).
4. Later: LFS, GHES / GitLab sources, signing.

Migrations: the kernel migrations are 0118 and 0119 and must be applied after sandbox dev tiers'
0117 (the migrator refuses out-of-order files).

## 15. Tests (outline)

- Gateway unit: path shapes, header filtering, no redirects, 401 → refresh once → refused, ticket
  binding (org, account, run, repo list), expiry at run end, byte caps.
- Kernel + fake git host (a `git http-backend` behind a fake server in `@capybara-hq/testing`):
  clone / fetch / push from sandbox-fake with injected env; `ask` push → approval → re-run; task
  grant in an unattended run; dual-replica: ticket issued on one replica, used on the other.
- Leak tests: the token in no event, log line, tool output or sandbox file; the ticket redacted
  from `env` output.
- Live (env-gated): clone and push a scratch branch to `CAPYBARA_TEST_GITHUB_REPO` through the
  gateway with the GitHub connector's credential, on Docker and a local device.
