# Capybara Overall Architecture Design

- Date: 2026-10-17
- Status: design confirmed section by section, pending review of this document
- License: Apache-2.0

> **Terminology (renamed 2026-10-24, `2026-10-22-package-ecosystem-design.md` §1 / §13).** This document
> predates the rename and keeps its original wording; read it with this mapping. "Plugin" in chapters
> 2, 7 and 9 (the in-process code: manifest, `ctx`, permissions, approval, plugin host) is now an
> **extension**, and the kernel's plugin host is the **extension host**. "App" / "app bundle" (§7.1) is
> now a **plugin**, the install unit bundling an extension, connector templates and skills; phase 0b
> (2026-10-25) replaced the package formats of §7.1 (the `capybara` package.json section, the bundle
> manifest and the catalog `index.json`) with `.capybara-plugin/plugin.json` and `marketplace.json`
> (`2026-10-22-package-ecosystem-design.md` §4, §5).
> "Capability" (a contract such as `channel@1`) is now an **extension point**; "platform capabilities"
> (`ctx.db`, `ctx.storage`, …) are the **platform API**. The "enterprise directory" is the **catalog**,
> and "catalogs" / "directory sources" are **marketplaces**. "Embedded app" is now **embed**. "App"
> keeps only the meaning "external app" (§1.0). Code identifiers, tables, config keys and routes cited
> below were updated to the renamed ones; data locations (`plugin_<name>` schemas, `plugins/<plugin>/`
> storage keys, `/plugin-ui`, `/plugins/<name>/…`) keep their names.

> **Capybara: the enterprise agent platform that gets along with everything.**
> *The calm agent that gets along with everything.*
>
> "Gets along with everything" = connects to everything (Lark, Slack, all kinds of existing systems);
> "emotionally stable" = enterprise grade (high concurrency, multiple replicas, self-healing).

## 0. Background and positioning

Capybara is an **independent open-source project**: an enterprise-grade, high-concurrency agent platform that connects everything in the enterprise.
It will be released on its own first to test the waters, and merging into other product lines will be considered once the community responds. By design it is **not tailored to any specific commercial product**;
commercial capabilities (billing, seats, etc.) all plug in through plugin seams.

It draws on two sources:

- **DeepSeek Harness**: we borrow its **seam design** (three roles of interface definition / implementer / consumer, the event log as the source of truth,
  middleware interception points, a replaceable loop, approval failure means rejection), and **not its runtime shape** (in-process registries, in-process locks and events,
  hot reload, single-user local storage), because the latter fundamentally conflicts with multi-replica deployment.
- **Lessons from an existing internal agent platform**: several identity systems coexisting, bidirectional coupling between services,
  billing gates across multiple replicas, complex per-agent × per-channel permission matrices, and the many patches caused by squeezing every model into an OpenAI-compatible gateway.
  Capybara must avoid all of these structurally.

### 0.1 Namespaces

| Resource | Value |
|---|---|
| Domain | `capybarahq.com` (primary), `capybarahq.cn` |
| GitHub | `github.com/capybara-hq` |
| npm | org `@capybara-hq/*`; the bare package `capybara` (historical versions 0.0.1, 0.1.2, 1.0.0–1.0.5 cannot be reused) |

### 0.2 Non-goals (not in the first version)

- Clients (desktop / mobile)
- A built-in workflow engine, knowledge base, or memory (all are external apps)
- Nested orgs
- Process-level isolation of plugins (plugins are trusted code, see 1.6)
- Direct local stdio MCP connections (see 4.2)

## 1. Overall architecture

### 1.0 Three layers

| Layer | Criterion | Form | Who installs |
|---|---|---|---|
| **Kernel** | Every deployment needs it; defines the contracts between the other layers; sits on the hot path of every conversation turn | Kernel code | — |
| **Plugin** | Needs to **take part in or intercept the agent's run** (entry points, models, tool execution, metering, identity, sandbox) | In-process trusted TS package, extends through the `ctx` seam | Enterprise admin, **at deploy time** |
| **External app** | Only **provides tools or data to the agent**, with its own data and lifecycle | MCP or OpenAPI endpoint; Capybara does not execute its code | Org admin |

A common pattern is "external app + thin plugin": the data and logic live in the app (a memory service, say),
and when per-turn automatic injection is needed, a thin plugin that only attaches a hook is added.

### 1.1 Process and dependency topology

```
            ┌────────── one image, three roles ──────────┐
 Browser/IM →│ api / gateway / worker                     │
            │  ┌──────── kernel ───────┐  ┌─── plugins ──┐ │
            │  │ identity & tenancy     │←→│ Lark/Slack   │ │
            │  │ Agent runtime(LangGraph)│  │ model providers│ │
            │  │ tool runtime + policy  │  │ sandbox impls│ │
            │  │ connectors(MCP/OpenAPI)│  │ metering/obs.│ │
            │  │ plugin host + ctx      │  │ ...          │ │
            │  └────────────────────────┘  └──────────────┘ │
            └──────┬───────────┬───────────┬──────────────┘
               Postgres   Redis/Valkey  S3-compatible storage · sandbox · external apps
```

- `api`: HTTP / WebSocket, the admin console and static assets for web chat
- `worker`: executes agent runs
- `gateway`: channel inbound (webhooks and long connections)

The three roles share one image and are distinguished by start-up arguments; in production each scales on its own; for a trial one process does everything.

### 1.2 Kernel responsibilities (only five)

1. Identity and tenancy: accounts, orgs, members, roles
2. Agent runtime: conversations, loop, model calls, context management, interrupt and resume, streaming push
3. Tool runtime: registration, execution pipeline, policy
4. Connectors: MCP / OpenAPI clients, auth adaptation, credential custody
5. Plugin host: loading, `ctx`, config, permission manifest

## 2. Kernel and plugin contracts

### 2.1 Capability interfaces

The kernel declares **versioned capability interfaces** in `@capybara-hq/plugin-sdk`; plugins implement them, and the kernel and other plugins use them.
A **plugin** is the unit of installation, a **capability** is the extension point: a plugin can provide several capabilities, and can also use capabilities provided by the platform or other plugins.

| Cardinality | Meaning | Examples |
|---|---|---|
| Single-choice | Only one implementation in the whole deployment | `sandbox@1`, `config-source@1`, `secret-store@1`, `object-store@1` (adjusted 2026-10-19) |
| Multi-choice | Several can be installed at once, told apart by name | `channel@1`, `model-provider@2`, `identity-source@1`, `directory@1`, `connector@1` (protocol adapters: MCP, OpenAPI; adjusted 2026-10-18) |
| Middleware chain | Chained in order | hook (see 2.4) |

**Consuming capabilities** (adjusted 2026-10-19; see the extension model design `2026-10-18-extension-model-design.md`):

- **Depend on capabilities, not on plugins**: the manifest's `requires` (cannot load if missing) and `optional` (can load if missing) hold capability references,
  matched by major version; switching providers is transparent to consumers.
- **Two kinds of capability**:
  - **Pass-through** (`directory`, `channel`, `identity-source`, etc.): consumers get the implementation directly through `ctx.extensionPoints.get` / `list`;
  - **Relayed** (`model-provider`, `object-store`, `secret-store`, `connector`, `sandbox`): usable only through platform capabilities (`ctx.models`, `ctx.storage`, ...),
    the raw implementation is not reachable, and credentials, metering, quotas, audit and tenant isolation are all handled in the kernel.
- When an org has no enabled provider, enabling a plugin that depends on it in that org is rejected; if a dependency is disabled while running, using it reports "capability unavailable", and the consumer decides whether to fail or degrade.

### 2.2 Plugin manifest and two-level config

```ts
export default defineExtension({
  name: "feishu",
  version: "1.2.0",
  sdk: "^1.0.0",
  provides: ["identity-source@1", "directory@1", "channel@1"],
  requires: [],
  optional: [],
  permissions: {                       // only write permissions that cannot be derived (see 2.5)
    http: [{ path: "/events", public: true }],
    network: ["open.feishu.cn"],
  },
  config: {
    deployment: z.object({ region: z.enum(["cn", "global"]) }),   // set by the enterprise admin
    org: z.object({ appId: z.string(), appSecret: secret() }),      // set by the org admin
  },
  migrations: "./migrations",        // applies only to this plugin's own PG schema
  setup(ctx) {
    ctx.provide("channel@1", (orgConfig) => new FeishuChannel(orgConfig, ctx));
  },
});
```

- **Installed at deployment level, enabled and configured at org level**: what the plugin offers the kernel is "a factory that creates an instance per org",
  so one Lark plugin can serve several orgs that each have their own Lark app.
- The admin console's config forms are generated from the Zod schema; `secret()` fields are stored encrypted and never echoed. Plugin config always has a schema; free-form key-value config without a schema is not provided.
- **Deployment-level plugin config is also stored in PG** (adjusted 2026-10-19): the enterprise admin edits it in the admin console; fields that appear in `extensionConfig.<plugin name>` in the config file / Nacos / environment variables
  are read-only in the UI with their source labeled, and each field has exactly one source. Fields whose meta is marked `hot: true` take effect immediately after a change via a `ctx.bus` broadcast; for the rest the UI says "takes effect after restart".

### 2.3 `ctx`: everything a plugin can get

| Capability | Description |
|---|---|
| `ctx.db` | A PG schema exclusive to this plugin |
| `ctx.kv` | Namespaced Redis, **writes must carry a TTL** |
| `ctx.queue` | Namespaced BullMQ queues, including delayed jobs (replaces timers) |
| `ctx.bus` | Cross-replica broadcast (replaces in-process events) |
| `ctx.lock` | Distributed lock (including leader election) |
| `ctx.secrets` | Encrypted credentials isolated per org |
| `ctx.config` | This plugin's deployment-level config (validated against the schema; `hot` fields read the new value) |
| `ctx.extensionPoints` | Consume the pass-through capabilities declared in the manifest (adjusted 2026-10-19) |
| `ctx.storage` | Object storage; keys are automatically prefixed `plugins/<plugin name>/<orgId>/`; supports presigned URLs (adjusted 2026-10-19) |
| `ctx.models` | Call models by purpose (chat, embedding), with unified metering and audit in the kernel; the interface is settled and is implemented with the first consumer (adjusted 2026-10-19) |
| `ctx.http` | Register routes under `/plugins/<name>/*` |
| `ctx.tools` | Register the plugin's own tools (name, description, inputSchema, annotations, handler; adjusted 2026-10-18) |
| `ctx.hooks` | Attach to middleware chains |
| `ctx.log` / `ctx.trace` | Logs and OpenTelemetry |

**`ctx` is built from the permission manifest** (adjusted 2026-10-19): `kv`, `lock`, `bus`, `queue`, `log` and the plugin's own `db` are granted automatically; everything else not declared does not exist, and accessing it throws.

**The call context follows the extension point** (adjusted 2026-10-19): `setup(ctx)` has only the deployment-level context and cannot see any org, account or conversation;
when the kernel calls a plugin implementation (tool execution, hook, channel inbound, login), it passes this call's context in the arguments, with contents decided by the extension point.

**`ctx` provides no timers and no in-process shared objects.** Since this cannot stop a plugin author from writing `new Map()` themselves,
the SDK ships a **dual-replica test tool**: it starts two kernel instances sharing the same PG/Redis, with requests landing on either in turn.
Plugin tests must pass in this environment; it is also a mandatory check for plugins listed on the public marketplace.

### 2.4 Hook attachment points

| Attachment point | Purpose | On error |
|---|---|---|
| `session.start` / `session.end` | Audit, analytics | Allow + alert |
| `agent.preStep` | Inject context (e.g. a memory plugin) | Allow + alert |
| `model.request` / `model.response` | Metering, observability, content filtering | Filtering kinds reject; observability kinds allow |
| `tool.preExecute` | Approval, policy, automatic review | **Reject** |
| `tool.postExecute` | Redaction, audit | Allow + alert |
| `usage.report` | Metering, billing | Allow + alert |

Rule: **policy kinds reject on error, observability kinds allow on error and alert**.

The hook chain (`ctx.hooks`) opened in M7 (it was planned for M6, adjusted 2026-10-19), together with `usage.report` metering.

**M7 implementation notes** (see the writing-extensions skill, "Hooks"):

- **Available now**: `model.request`, `model.response`, `tool.preExecute`, `tool.postExecute` and `usage.report`. `session.start` / `session.end` and `agent.preStep` stay reserved: they validate in a permission manifest but `ctx.hooks.on` rejects them.
- **Observe or deny only.** A hook never rewrites a request or a result. Policy hooks (`model.request`, `tool.preExecute`) run serially by plugin name and can deny; an error or timeout denies too (fail closed), with a generic reason for the model and the raw error only in the `hook.denied` audit row. Observe hooks are fire-and-forget and bounded per plugin and replica. Every denial is logged (audit row and a `hook_denied` event).
- **Declared and approved**: a mount point must be in `permissions.hooks`, and a policy hook also in `permissions.policyHooks`, so deployment state knows which plugins must fail calls closed on a replica where they are not loaded. Hooks are sensitive items at review. Hooks fire only for chat conversations of orgs that enabled the plugin, never in eval replays. Payloads are deep-frozen copies without media bytes (placeholders instead). Compaction model calls pass through the same hooks (`purpose: "compaction"`).
- **`usage.report`** (F11) goes through the BullMQ queue `cap-kernel-usage-report`: at least once, per-plugin retries (up to 5, 2 s doubling), a sweeper that re-offers recent usage events, handlers idempotent by `eventId`. Compaction calls and full-run eval replays are reported; single-step replays and judges are not.

### 2.5 Trust and versions

- Plugins are trusted code running in-process with no code sandbox; therefore **only the enterprise admin can install them at deploy time**,
  and org admins can only enable and configure them. Untrusted extensions are always built as external apps.
- Each capability interface is versioned independently (`channel@1` → `channel@2`), and the kernel supports the current version and the previous one at the same time.
- A plugin is an npm package, and the install list is written in the deployment config (`plugins: ["@capybara-hq/plugin-feishu"]`).
- **Permission manifest** (adjusted 2026-10-19; see section 7 of the extension model design `2026-10-18-extension-model-design.md`): a plugin declares everything it uses: capabilities provided and used, config items, data tables (derived from migrations),
  model purposes, object storage, secrets, HTTP routes, tools, hook attachment points, external network domains; items that can see conversation content (tools, hooks such as `agent.preStep`), secrets and public routes are marked sensitive.
  - **Undeclared means forbidden**; `check:extension-permissions` statically cross-checks the source against the manifest.
  - The enterprise admin approves at install time; after an upgrade, additional permissions must be approved again, and the plugin is not loaded before approval; the org admin sees the same manifest when enabling and does not approve separately.
  - **This is not a sandbox**: in-process code cannot be stopped from connecting directly to the database or making network requests. What the manifest really blocks are the resources the kernel holds (models, credentials, storage, conversation content);
    the rest is transparency and audit; in the MVP, external network domains are only displayed and labeled "declared, not enforced by the platform".

**M6 implementation notes** (plan `2026-10-22-m6-eval-admin.md`):

- **Plugin package** (C11, C12): an npm-pack tgz with contents under `package/`; the `capybara` section of `package.json` holds the entry (`dist/index.mjs`, single-file ESM,
  third-party dependencies bundled in), the `sdk` range, a static manifest (permissions, secret / hot flags of config fields, etc.), and optional `migrations/` and `ui/`. The host provides only
  `@capybara-hq/plugin-sdk` and `zod`. Install-time validation covers size (`packages.maxBytes`), paths, no install scripts / dependency fields / `node_modules` / native modules,
  imports only allowed from `node:*`, those two packages and relative paths inside the package, and dynamic imports only allowed as literals. Review looks only at the static manifest and migration SQL and does not execute plugin code; at load time it is cross-checked against the real module,
  and a mismatch fails (`manifest_mismatch`). `tools/pack-plugin` (`pnpm pack-plugin`) packs, and `check:plugin-pack` ensures every official plugin can be packed.
- **Install records and sync** (C13, C14, C15): the source of truth is PG (`extension_packages` content-addressed by sha256, `plugin_installs` one desired-state row per plugin,
  `extension_replica_status` per-replica load result and heartbeat); packages are stored in object storage at `deployment/plugins/blobs/<sha256>.tgz` (in PG when there is no object storage).
  Each replica verifies the sha256 and unpacks to the local `extensionHost.dir` before loading. There are three sources: `builtin` (the core image bundles only `openai-compatible` and `object-store-s3`,
  pre-approved and always enabled), `config` (the `plugins` list in the startup config, read-only in the admin console; when a name collides with an install record, the config wins), and `install` (install records).
  The "install list is written in the deployment config" above still works for development and existing deployments; production uses install records instead.
- **Lifecycle without restarts** (C16, C17): the admin console and the CLI only write desired state and publish `kernel.plugins.changed`, and each replica reconciles (the maintenance job
  `plugins-reconcile` is a periodic backstop). On a version change the new one loads first and then the old one is revoked; if the new version fails or its permissions exceed the snapshot, the old one keeps running. Each plugin instance has one ledger, and on revocation it revokes item by item
  tools, queue workers, bus subscriptions, lock leases, UI contributions, capabilities it `provide`d, and derived channel long connections: first stop accepting new calls, then in-flight tool calls and queue jobs wait at most
  `extensionHost.drainSeconds` and are aborted at the deadline (the model receives an English error result), then `ctx.signal` is aborted, the ledger items are revoked, and the optional `dispose` is called; when the provider instance changes, plugins depending on it reload on this replica. Plugin migrations
  are run by the first replica that gets the advisory lock; no replica switches before migrations finish, and migrations only expand. Old module code stays in memory until restart.
- **Trust**: a plugin is still trusted code running with full privileges; approval and directory policy are governance, not a sandbox. A summary of the sensitive warnings in migration SQL (destructive statements, `DO` blocks, statements writing outside
  the plugin schema or changing permissions) is counted into the permission snapshot, and a changed warning requires re-approval.

## 3. Identity and orgs

### 3.1 Data model

```
account ─┬─ external identity (source + external ID: Lark union_id / Slack user id / OIDC sub)
         ├─ membership ── org (roles: owner / admin / member / guest)
         └─ enterprise admin flag (deployment level)

agent ── belongs to (org, owner account); visibility: only me / whole org / specified members;
         the agent itself also has an org role (see 3.6)
```

- One deployment = one enterprise or group; orgs are flat and correspond to subsidiaries or teams; accounts are shared within a deployment, can join several orgs, and have a "current org" context.
- **Identity is recognized only by "source + external ID", not by email.** Automatic merging happens only when both sides' emails are verified and the enterprise admin has explicitly trusted that identity source;
  in all other cases a signed-in user binds manually.

### 3.2 Login

- Login methods = identity-source plugins that are installed and enabled by the enterprise admin as login methods (Lark, Slack, DingTalk, WeCom, OIDC/SAML) + built-in local username and password.
- The first login automatically creates an **account** (not an org); joining an org happens through directory mapping or an invitation.
- The first enterprise admin: the setup wizard on first start, or `capybara admin create`.
- The web session cookie is limited to the current host and does not write the root domain; short-lived access token + revocable refresh token in PG.
- Programmatic access: personal access tokens, org service tokens.

Typical flow:

```
① First visit → setup wizard → become enterprise admin → create the first org
② Enable the Slack plugin and configure the mapping: Slack workspace X ↔ org "R&D Team"
③ An employee "logs in with Slack" → an account is created automatically → belongs to workspace X → automatically joins "R&D Team"
④ People not in the directory → invitation link
```

### 3.3 Directory sync and offboarding

A directory plugin syncs the enterprise directory into org members (mapping configured by the org admin). When a person leaves, **in one transaction**:
revoke the membership → revoke that person's sessions and tokens under the org → delete their connector credentials → transfer the agents they own to the org owner and mark them "pending reassignment".
Events are emitted after the transaction commits.

### 3.4 Roles

| Capability | Guest | Member | Admin | Owner |
|---|---|---|---|---|
| Use agents shared with you | ✓ | ✓ | ✓ | ✓ |
| Create agents, use installed connectors and skills | | ✓ | ✓ | ✓ |
| Request installation of connectors and skills | | ✓ | ✓ | ✓ |
| Install connectors and skills, configure plugins, manage members | | | ✓ | ✓ |
| Transfer ownership, delete the org | | | | ✓ |

- **Enterprise admin**: model providers, plugins, global policy, which connectors may be installed; can see all orgs, and **by default cannot read conversation content**
  (compliance audit is an explicitly enabled feature, and every view is audited).
- Any account can create an org; the enterprise admin can turn this off and make it "enterprise admins only".
- An org keeps at least one owner; the last owner must transfer ownership before leaving.
- **The management surface has only three knobs**: roles, agent visibility, tool policy. Channels have no separate permission matrix:
  who can use an agent in a channel = agent visibility ∩ the channel's own audience.

### 3.5 Identity in channels

- An IM sender is mapped to an account through external identity; when no mapping is found, channel policy applies: guide the user to bind, or treat them as an anonymous guest (public agents only, no personal connectors).
- **Hard rule: when identity cannot be recognized, never borrow the identity of the person who set up the channel.**
- Unattended runs (scheduled jobs, etc.) execute as the agent's owner, and the audit notes the trigger source.

### 3.6 Agents as org members

An agent, like a human employee, has an org role (default "member") and can modify its own runtime environment.
**But an agent cannot bear responsibility, so its role is a ceiling, not a source of power; power always comes from the people on the delegation chain.**

| Rule | Content |
|---|---|
| **R1 Power comes from people** | Effective permission = agent role ∩ the role of every person on the delegation chain. The delegation chain: the person currently sending the message; for scheduled and automatic triggers, the person who configured the trigger; for agent-calls-agent, every link upstream |
| **R2 Only people can approve** | Insufficient permission turns into an approval pushed to a person holding the needed role; an agent cannot approve any request, let alone one it initiated itself |
| **R3 Authorized ≠ confirmed** | Actions on a fixed list with high impact must be confirmed by a human even when authorized, and the policy can only be "ask": publishing to the public marketplace, installing connectors, filing plugin requests, changing roles and members, deleting, changing shared skills, changing its own instructions |
| **R4 A shared agent changing itself needs the owner's approval** | An agent visible only to its owner writes its own skills with immediate effect; for a shared agent, writing / changing a skill goes into review and takes effect for others only after the owner approves |
| **R5 Checked live at execution** | Permission is judged at the moment the action executes, and a downgrade during the run takes effect immediately |
| **R6 Audit the whole chain** | Who → via which agent → did what → who approved |

An agent's ability to modify its environment is all ordinary tools:

| Action | Role needed | Default policy |
|---|---|---|
| Write / change / try out skills for itself | Member | Allow (a shared agent is subject to R4) |
| Download skills from the enterprise directory / public marketplace for its own use | Member | Allow (within enterprise policy) |
| Publish a skill to the enterprise directory | Admin or via approval | Ask |
| Publish a skill to the public marketplace | Enterprise policy allows | Always manual approval + scan for secrets and internal addresses before publishing |
| Install a connector for the org | Admin | Ask |
| Plugins | — | Can only file a request to the enterprise admin |
| Change its own instructions | Generates a new version, effective after the owner confirms | Ask |

Approval cards must show the **concrete change (a diff)**, and approvals of the same kind can be handled in batches, to prevent approval fatigue.

## 4. Agent runtime

### 4.1 Agent definition

Name and avatar, instructions, primary and fallback models, available tools (connectors / skills / built-in), tool policy, whether a sandbox is needed, visibility, owner, org role.
**Every save produces a new version**; each run pins the version it uses at its start, so it is traceable and can be rolled back.

### 4.2 Two records

| | Conversation event log | Execution snapshot (LangGraph checkpoint) |
|---|---|---|
| Content | Append-only: user messages, model replies, tool calls and results, approvals, compaction summaries, usage | Graph execution state |
| Purpose | **The only record of truth**: UI history, audit, replay, analytics | **Used only for resuming**: recovery after approval, recovery after a crash |
| Retention | Permanent | Only the latest one is kept after a turn ends |

Principle: **everything the model sees goes into the log**; compaction summaries are also written as events, and the input of any model request can be reconstructed from the log.

### 4.3 One run (multi-replica, high concurrency)

```
Message arrives (Web / IM / API / scheduled)
  → write the user-message event → enqueue a run job (BullMQ)
  → any worker picks it up → load the agent version and execution snapshot → run the loop
  → streaming deltas are broadcast via Redis → the api replica holding the connection pushes to the browser; channel plugins deliver back to IM
```

- Only one turn runs per conversation at a time (conversation-level lock).
- **Interjection**: a new message during a run does not interrupt the current turn; it is inserted into the context at the next gap between steps; to change course completely, click stop.
- **Org-level concurrency quota** (Redis counter), to stop a single org from filling all workers; the enterprise admin can adjust it per org.
- Crash recovery: after a job times out, another worker resumes from the latest snapshot.
- **Tools with side effects are not blindly rerun**: a "call started" event is written before the call; on recovery, calls that have a start but no result are reported to the model as "result unknown", and the model verifies or asks the user.
- The abort signal is broadcast via Redis, so a run on any replica receives it.
- **Waiting for a person** (adjusted 2026-10-18): when a run hits an approval or a request for user input, it saves a snapshot and pauses, releasing the worker and the conversation lock; the outcome (or a timeout) re-enqueues the run, which resumes from the snapshot. New messages queue during the wait and are absorbed as interjections after resuming.
- Every turn has a maximum step count and a maximum duration as a backstop.

### 4.4 Loop

- The kernel defines the `AgentLoop` interface, implemented by default with **LangGraph** (call the model → execute tools → call the model again); extensions depend only on the interface.
- The hooks of section 2.4 attach to the loop.
- Built-in context compaction: when nearing the limit, earlier content is summarized, the summary goes into the log, and the most recent turns stay verbatim.
- Prompt caching: the kernel guarantees that stable content (instructions, tool definitions) comes first; the concrete cache markers are the model provider plugin's responsibility.

### 4.5 Models

- **Model providers are always plugins**; the kernel recognizes only the `model-provider` capability interface. **The default distribution bundles only `openai-compatible`**
  (connecting vLLM / DeepSeek / Qwen and other services that speak Chat Completions, handling vendor differences through "dialect presets",
  **vendor quirks are patched only in this plugin and never enter the kernel**); plugins for `anthropic`, `openai`, `gemini`, `deepseek` and the like, using each vendor's official SDK
  over the native protocol, are installed on demand. (adjusted 2026-10-18)
- Every provider plugin must pass the **conformance tests**: tool-call round trips, streaming, thinking mode, caching, usage statistics.
- Plugins report model capabilities to the kernel: tool calling, vision, reasoning, context length, caching.
- **Model parameters are declared by the plugin; the kernel and UI hardcode no vendor parameters** (adjusted 2026-10-18):
  - Each model declares the parameters it supports: key, value constraints (a restricted JSON Schema subset: enum / boolean / number with range / string), default, copy for each language.
  - Two tiers of parameters: **standard knobs** (uniform platform semantics: reasoning depth effort, thinking mode thinking, temperature, max output tokens), which the UI renders specially,
    whose semantics carry over when switching models or falling back, with the plugin responsible for mapping to native parameters; **vendor-specific parameters** (keys carry the plugin-name prefix), which the UI renders generically from the declaration, so a new vendor needs zero frontend change.
  - An agent version saves parameters for its primary and fallback models separately; on save the kernel validates against that model's declaration, at run time it passes them to the plugin as is, and they are written to the conversation log.
  - Capability-related elements of the chat UI (reasoning display, image upload, etc.) are shown only according to the capabilities the model declares, never by vendor name.
- The enterprise admin adds providers and models; the org admin selects them for agents; **the fallback model must be from a different provider** (the admin console hints at this).
- **Model capability layer** (adjusted 2026-10-19; see section 4 of the extension model design `2026-10-18-extension-model-design.md`):
  - Contracts are split by modality: chat is `model-provider@2`; for media input, M5 has done images and PDFs (`image` / `document` blocks appended within `@2`, gated by `vision` / `documents`; audio / video to be decided); embedding `embedding-provider` and rerank `rerank-provider` are reserved and will be implemented with the first consumer.
  - The agent main loop uses the model chosen by the agent version; other platform features and plugins **ask for models by purpose** (purposes are declared in the manifest, and the org admin maps each purpose to a concrete model), calling through `ctx.models` instead of each integrating its own model.
  - Generation kinds (text-to-image, text-to-video, TTS) are built as tools and do not enter the model capability layer.
- Every call produces a usage event attributed to (org, account, agent, conversation), handed to metering / billing plugins through `usage.report`; the open-source default only records.

### 4.6 Human-computer interaction

- Approval: the "ask" policy pauses the loop; the user can handle it on the Web or in an IM message card (cards are rendered by the channel plugin), and after handling the run resumes from the snapshot.
- **Requesting user input** (adjusted 2026-10-18): approval, the built-in `ask_user`, MCP elicitation and a plugin tool's `input_required` are one mechanism: pause → render an interactive card as declared → submit → resume.
  Plugin tools are **resumable calls**: the tool returns a form and state, and after the user submits, the kernel calls it once more with `resume` (the handler does not stay suspended across the pause, which satisfies multi-replica).
  Form fields use a restricted JSON Schema subset (same as the model parameters in 4.5), rendered by the web app according to the design system.
- Attachments: stored in object storage and mounted into the sandbox when needed.

## 5. Connectors and tool policy

### 5.1 Tool sources

| Source | Examples | Who installs |
|---|---|---|
| Built-in (as few as possible) | `ask_user` (ask the user and offer options), `read_tool_output`, `tool_search`; `skill_load` and, when a sandbox is enabled, command execution and file read / write come with the sandbox (done in M5: `sandbox_bash` / `read` / `write` / `edit` / `glob` / `grep` / `deliver`, `skill_load`, `skill_write`; keys contain no dots). The task list is no longer built in and is now the official plugin `todo` (adjusted 2026-10-18) | Kernel |
| Connector | Lark docs, Jira, company internal systems | Org admin |
| Skill | `SKILL.md` + scripts and materials | Org admin / the agent itself (see 3.6) |
| Tools provided by plugins | Slack "read channel history" | Come with the plugin |

### 5.2 Connectors: we adapt to them

**Principle: Capybara adapts to the authentication the other side already has, and does not require the other side to trust identities or tokens issued by Capybara.**

Terminology (M6 / D17 adjustment): a remote service instance set up in an org is called a **connector** (previously "app"); a plugin that implements an endpoint protocol (MCP, OpenAPI) is a **connector plugin**, and the capability name remains `connector@1`; a package in the enterprise directory that presets the endpoint and auth so that an org only fills in credentials to get a connector is a **connector template**; "app" now refers to a bundle (see 7.1).

An installed connector = an endpoint + the authentication the other side requires.

Endpoint types:

- **MCP** (remote Streamable HTTP). Support scope (adjusted 2026-10-18): tools, resources, prompts, elicitation, `list_changed`; **sampling is not supported**. MCP servers that support only stdio will later be run in the sandbox and exposed through a proxy; not in the first version.
- **OpenAPI**: import the other side's OpenAPI document and **generate a tool for each endpoint automatically**; you can tick to expose only some endpoints;
  GET is treated as read-only by default, and POST / PUT / PATCH / DELETE default to ask.

Authentication methods:

| Other side's auth | How to connect | Credential owner |
|---|---|---|
| API key / Bearer / Basic / custom header | Filled in by the org admin, or by each person | Org or individual |
| OAuth 2.0 authorization code (including standard MCP OAuth) | Each person clicks "Connect" and authorizes with their own account | Individual |
| OAuth 2.0 client credentials | The org admin fills in client id / secret | Org |

Rules:

- Tool calls use the credentials of **the person who started this conversation**; if not connected, it returns "connection needed" and pushes a connect card (clickable in IM too), and continues after connecting.
- Anonymous guests cannot get connectors with personal credentials; scheduled jobs use the agent owner's credentials.
- Credentials are envelope-encrypted; access tokens refresh automatically, **with a distributed lock on refresh** (to prevent concurrent refreshes from multiple replicas invalidating each other's refresh tokens).

Later hook (not in the first version): when the other side and Capybara trust **the same enterprise IdP** (Entra ID, Okta, etc.),
use that IdP's **own** on-behalf-of token exchange to achieve connection-free access; the trust anchor is the enterprise IdP, not Capybara.

### 5.3 Tool policy

- Two layers: the org admin sets a default policy for each connector / tool; the agent owner can only tighten it (allow → ask / deny), never loosen it.
- Defaults: `readOnlyHint` → allow; `destructiveHint` → ask; **no annotation → ask** (admins can change these to allow in batch).
- User approval options: just this once / allow for the rest of this session / always allow (recorded against "user × agent × tool", revocable in settings).
- Approval failure means rejection: timeout, channel not delivered, or no approver found are all treated as rejection.
- The policy of actions on the R3 list in 3.6 is fixed to "ask".

### 5.4 Tool execution pipeline

Argument validation → resolve `$output` references → policy decision → execute with a timeout → if the result is too large, store it as an **output archive** (kernel PG, kept 30 days by default), the model sees only a summary and an id and reads it page by page with `read_tool_output` → connectors that fail consecutively trip a circuit breaker automatically → write an audit event. (adjusted 2026-10-18)

The output archive is a kernel concept, unrelated to sandboxes or artifacts; `{"$output": "<id>"}` in arguments references the full archived text.

### 5.5 Tool scale

When the number of tools exceeds a threshold, only a tool catalog (name + one sentence) goes into the context; the model loads the full definition with `tool_search`.
Calling a tool directly without loading it → returns a clear validation error (the kernel does not load it for the model or guess).

### 5.6 Skills

- Compatible with the Agent Skills format proposed by Anthropic (a directory + `SKILL.md` with frontmatter + scripts and materials).
- Only the name and description go into the context; `skill_load` loads the full text when needed; skills with scripts run in the sandbox.

## 6. Getting things right (reliability principles)

| Principle | Approach |
|---|---|
| **1. Native protocol** | See 4.5; model / gateway-specific patches exist only in the corresponding provider plugin, with zero patches in the kernel |
| **2. General mechanisms are explicit pipeline stages** | Compaction, archiving of oversized output, the tool_use/result pairing guard, timeout degradation, circuit breaking, turn wrap-up and so on are each independent, tested stages |
| **3. Give facts, don't guess** | No fuzzy matching, auto-correction or "Did you mean"; tool errors must be accurate and actionable (with the full schema / existing candidates attached); correctness requirements are written as tool preconditions (such as "read before modify") |
| **4. Simple tool surface** | Only one discovery mechanism (catalog + `tool_search`), no multi-layer loading, so the corresponding prompt rules are not needed either |
| **5. Short, general behavior rules** | Report honestly, verify when done, ask when unclear, don't expose internal details; dynamic information reaches the model through reminders inserted in the conversation, not piled into the system prompt |
| **6. Task list** | For multi-step tasks, list the steps and tick them off as you go, with progress visible on Web and IM; provided by the official plugin `todo` (adjusted 2026-10-18) |
| **7. Verification loop** | The tool result of a write operation returns something checkable (id, link, read-back content); claiming completion requires citing evidence; a general mechanism, no per-app adapters |
| **8. Evals are first-class** | The kernel has built-in trajectory recording and replay: build eval sets by sampling real conversations, and run replay comparisons before switching models / changing prompts / upgrading versions; the admin console has a trajectory viewer. **Done in the first version** |

## 7. Extensions and marketplace

### 7.1 Package types

| Type | Content | Where it runs | Who installs |
|---|---|---|---|
| Plugin | npm package + plugin manifest (2.2) | In-process | Enterprise admin (at deploy time) |
| Connector (template) | A purely declarative manifest: connector plugin, endpoint type, address, auth requirements (no credentials), endpoint fields the org may edit, default tool policy, icon | The other side's system | Org admin |
| Skill | A compressed package of `SKILL.md` + scripts and materials | Context + sandbox | Org admin / agent |
| App | A bundle manifest: references plugins (version range + lock) + connector templates + skills (e.g. Lark plugin + Lark docs connector template + several skills) | — | Per each item's rules |

Unified metadata: name, version, publisher, `kind`, signature; npm plugins require provenance.

### 7.2 Two-level directory

```
Public marketplace hub.capybarahq.com (operated by us; a public read-only directory API)
      │  sync on demand
      ▼
Enterprise directory built into the deployment (PG) ← privately uploaded internal connector templates, skills and apps
      │  enterprise admin policy: allow direct install / needs approval / disabled
      ▼
Installed by the org admin ← requested by members (modeled on Slack)
```

- The enterprise directory is built into the deployment and does not need a separate service; an enterprise can build an internal marketplace against the same directory API.
- Fully offline operation is supported: do not connect to the public marketplace, and only import package files and private uploads.

**M6 implementation notes** (plan `2026-10-22-m6-eval-admin.md`; the public marketplace is still not built, and M6 first builds directory sources and catalogs):

- **Package format** (C21): packages in the directory are uniformly a `package.json` with a `capybara` section, with four kinds: `plugin`, `connector-template`, `skill`, `app`;
  connector templates and skills also accept zip. Signing / provenance is deferred to M7, and only the npm `integrity` is recorded.
- **Policy** (C22): item policy is `allow` (default for new imports) / `needs_approval` (after the org admin submits, the enterprise admin approves, and the approval is valid for that org across versions) /
  `disabled` (cannot be newly installed, installed ones are unaffected); member requests go to the org admin inbox. When the deployment settings `customConnectors` / `customSkills` are `deny`, orgs can only install from the directory.
  Plugins can only be installed to the deployment by the enterprise admin; the org-side "install" means enabling in this org and is subject to the item policy; when an org directly enables a plugin that came in through the directory, the strictest
  policy among all source items decides; a plugin inside an app is decided by the app item's policy; a plugin not installed through the directory is not subject to directory policy. **Exception (M6 final-review ruling M-5, overriding the app route of the previous sentence)**:
  a `disabled` directory item for the plugin itself is a master switch: no route (direct enable, plugin item, an app containing it) can newly enable that plugin in an org, and both org installation of an app containing it and
  app bundle import review return `directory.item_disabled` (naming the plugin); ones already enabled are unaffected.
- **Directory sources** (C25, C26): the official catalog (config `marketplaces.official.*`, can be turned off for offline deployment, supports mirrors), enterprise catalogs (PG, several allowed, optional token stored in secrets),
  and manual upload. A catalog is a static `index.json` (JSON Schema in `packages/plugin-sdk/schemas/`), and the maintenance job `catalogs-refresh` pulls it periodically (ETag + size cap),
  keeping the previous copy when it is invalid. Items are browsed first, and a version is downloaded and materialized as a directory item only when it is "imported"; if a `tarball` (must be https) is given for the download it is used, otherwise the npm registry is used,
  and verification is always against the catalog's sha512, never npm metadata. A new version is only announced and never pulled automatically.
- **Connector templates** (C30): connector plugin reference + `Connector.kind` + endpoint preset + `editableEndpoint` + auth preset (no credentials) + default ownership +
  default policy per tool + icon; an org installation can only fill in credentials and editable endpoint fields, and the default policy is recorded as `policy_source 'template'`.
- **App bundles** (C31): the bundle manifest references plugins by plugin name, npm package name, version range and lock (version + sha512) (plugin packages are not packed into the app bundle and are pulled from npm by lock at import), declares connector templates,
  and packs skills in the bundle. An enterprise import reviews all plugin permissions at once, and on confirmation can install to the deployment and enable at the same time. Org install = enable plugins + create connectors from templates +
  import skills, with `plugin_install_components` recording whether each component was newly created or already existed, and if it fails midway, what this install newly created is undone; uninstall removes only components that this install newly created and that nothing else uses. M6 does not support
  app upgrades; agent templates inside apps and members' personal connectors are deferred; stdio MCP is not supported.

### 7.3 Installation and drift protection

- Before a plugin is installed, the permission manifest is shown (see 2.5) with sensitive items highlighted (adjusted 2026-10-19).
- Before a connector is installed, it shows: the tool list, default policy, auth requirements; at install time, configure credentials or "each person connects on their own", and choose which agents it is open to.
- **Tool definition drift**: a snapshot of tool definitions is taken at install; they are compared periodically, and tools that are newly added or whose description changed are **disabled first until the org admin reviews them**
  (against rug pulls / tool poisoning); the same applies to OpenAPI document updates. This also applies to connectors that an agent installs itself.

### 7.4 Public marketplace operations

- Publishers log in with GitHub; after verifying a domain they get a "verified publisher" badge.
- Automatic checks (all packages): manifest validation; plugins pass the dual-replica test and carry provenance; skills get a prompt-injection scan; connector endpoints must be probeable and tool definitions parseable.
- Manual review applies only to the "official" and "recommended" labels and does not block ordinary listings.
- Show install counts and ratings.

### 7.5 Phasing

The public marketplace service goes live once the package format is stable; the first version builds the package format, the enterprise directory, and installing from files or npm. The concrete phasing is decided by the implementation plan.

## 8. Infrastructure and deployment

### 8.1 Dependencies

| Component | Purpose | Notes |
|---|---|---|
| **Postgres** | The only source of truth: accounts and orgs, agents, event log, checkpoints, extensions, encrypted credentials, audit | ≥ 15 (migrations use `UNIQUE NULLS NOT DISTINCT`; development and CI use 17); each plugin has its own schema; the kernel does not need pgvector |
| **Redis / Valkey** | Queues (BullMQ), cross-replica broadcast, locks, rate limiting, short-lived state, cache | Losing it causes at most retries and loses no data; only protocol-level features are used, so Valkey (BSD) is a drop-in replacement |
| **S3-compatible object storage** | Attachments, skill packages, sandbox workspaces | Connected through the `object-store@1` plugin, default `object-store-s3` (MinIO / Ceph / SeaweedFS / the S3-compatible interfaces of the various clouds); the dev compose ships SeaweedFS (adjusted 2026-10-19; changed from MinIO to SeaweedFS on 2026-10-21) |

- **No RabbitMQ** (no use case yet; shipping events out to Kafka / RabbitMQ is built as a plugin).
- The trial edition also requires both PG and Redis (no "PG only" slim mode), so there is only one implementation.

### 8.2 Config

```bash
CAPYBARA_CONFIG_SOURCE=file    # file | nacos
CAPYBARA_CONFIG_FILE=/etc/capybara/config.yaml
# or
CAPYBARA_NACOS_SERVER=nacos:8848
CAPYBARA_NACOS_NAMESPACE=prod
CAPYBARA_NACOS_DATA_ID=capybara.yaml
```

- Both sources are validated by the same schema; **environment variables have the highest priority**.
- Secret-type config is recommended to go only through environment variables / K8s Secrets.
- Hot update applies only to items marked "hot-updatable"; each replica listens on its own.
- New sources (Apollo, Consul) are added as plugins against the `config-source@1` interface.
- **The three are kept separate** (adjusted 2026-10-19): startup config (database, Redis, master key, plugin list) goes through the sources above; plugin config is stored in PG and edited in the admin console (see 2.2);
  secrets go through `secret-store@1` (default: PG envelope encryption). Nacos carries only startup config and the plugin fields locked by the deployer.

### 8.3 Sandbox

- **Lazy creation on demand**: it is started only when a sandbox-type tool is used.
- The implementation is chosen by deployment config (one kind per deployment):

| Form | Implementation | Isolation |
|---|---|---|
| Trial | Docker (runc) | Weak |
| Demo / small scale | Docker (**gVisor/runsc**), through a socket proxy | Strong, no KVM needed |
| Large scale | K8s **agent-sandbox + gVisor** (Kata optional for high security) | Strong / strongest |
| Optional plugin | E2B cloud or a self-hosted E2B runtime (the open-source version is designed for a single machine and needs KVM) | Strong |

```yaml
sandbox:
  provider: docker            # docker | k8s | e2b
  limits:
    cpu: 1
    memory: 2Gi
    egress: allowlist         # none | allowlist | open
    suspendAfterIdle: 10m     # suspend after idle (not destroyed)
    destroyAfterInactive: 30d # destroyed (files included) only after long disuse
    maxRunning: 2h            # backstop: maximum continuous running time, forcibly suspended when reached
  docker:
    runtime: runsc            # runc | runsc
    endpoint: tcp://sandbox-proxy:2375
  k8s:
    namespace: capybara-sandbox
    runtimeClassName: gvisor  # gvisor | kata
    warmPool: 20
  e2b:
    apiUrl: https://api.e2b.dev
    apiKey: ${E2B_API_KEY}
```

- **Two levels of suspension guarantee**: "filesystem retained" must be supported by every implementation (zero CPU / memory while suspended); "memory retained" is an optional capability
  (E2B supports it natively; gVisor checkpoint/restore will be integrated after verification). Agents depend only on filesystem retention.
- There is only one Dockerfile for the sandbox image, shared by Docker / K8s / E2B templates.
- **Single-machine security**: application containers do not mount `docker.sock` directly; they go through a socket proxy that allows only the sandbox lifecycle endpoints, or a separate sandbox management service.
- Later: on suspension, pack the workspace into object storage so that recovery is not tied to a node.

### 8.4 Deployment forms and frontend

| Form | Method |
|---|---|
| Trial | `docker compose up` starts all services (see below) |
| Demo / small-scale production | A single cloud host + compose + gVisor |
| Large-scale production | K8s + the official Helm chart |

**Frontend and backend are deployed separately** (adjusted 2026-10-17). The official compose file starts all services with one command:

```
docker compose up
├── api        backend image, role api      ┐
├── worker     backend image, role worker   ├─ the backend is always one image, split into services by role
├── gateway    backend image, role gateway  ┘
├── web        frontend image (`node server.mjs` serving the Next build), proxies /api to api
├── postgres
├── valkey
├── object storage (S3-compatible)
└── sandbox-proxy
```

The admin console and web chat are one **Next** app, built and released independently; the first version's UI supports Chinese and English.

**M7 implementation notes**: four images are published, `capybara-api`, `capybara-worker`, `capybara-gateway` (one Dockerfile, differing in the default roles chosen by the build argument `ROLES`) and `capybara-web`. `web` runs as `node server.mjs`, not Next's standalone server: `server.mjs` drops forwarding headers sent by clients and sets `X-Forwarded-For` to the real peer, which the `api` (with `http.trustProxy: 1`, one hop) needs for the per-IP login rate limit and session records. A one-shot `init` container runs `capybara migrate` on every `up` (and creates the first admin when a password file is set) before `api`, `worker` and `gateway` start. The optional `sandbox` compose profile publishes no ports: `sandbox-proxy` (the only container with the Docker socket) sits on an internal network reachable only by `worker`. See `docs/deploy/README.md`.
A marketing / docs site, if it needs SEO, goes in a separate repository, apart from the product frontend.

### 8.5 Zero-downtime upgrades

- Migrations are forward-compatible by one version (expand → contract in two steps); they are run by a standalone `capybara migrate` job (K8s Job / compose init container) before the new Pods start, migrating the kernel and plugin schemas together.
- Graceful worker exit: stop taking new jobs → finish within a grace period → if unfinished, save a snapshot and put the job back in the queue.

### 8.6 Scaling

`api` scales by CPU / connection count; `worker` by queue backlog (KEDA optional); for `gateway`, which holds the IM long connections, see the M7 note below.

**M7 implementation notes**: long connections run **only on processes with the `gateway` role** (outbound delivery and inbound jobs stay on `worker`). Each connection still has exactly one holder, guaranteed by a Redis lease (`capk:channel-lease:<id>`), and gateways claim connections **by fair share**: replicas heartbeat per channel plugin, each computes its target as its share of the runnable connections plus `channels.shareSlack`, stops claiming at the target and hands back one connection per scan round when above it. A dead gateway's leases expire after `channels.leaseTtlMs` and the survivors take over. Adding gateways spreads connections; it does not add throughput.

### 8.7 Observability

OpenTelemetry (traces / metrics / structured JSON logs); built-in metrics: queue backlog, per-turn duration, model error rate by provider,
number of active / suspended sandboxes, approval backlog; `/healthz`, `/readyz`; the admin console trajectory viewer. Langfuse and the like are built as plugins.

**M6 implementation notes** (plan `2026-10-22-m6-eval-admin.md`): the trajectory viewer lives on the org side ("Evals"), is open only to org admins and agent owners (the enterprise admin by default
cannot read conversations; eval replay conversations are open only to org admins), anyone without permission gets 404, and every view is audited as `trajectory.viewed`. A trajectory is derived entirely from the event log, with no new event fields (C2):
model latency = the `usage` time of that step − the `model_call` time (an attempt not followed by a `usage` counts as failed), tool duration = `tool_result` − `tool_call_started`, approval wait =
`approval_decided` − `approval_requested`. Cost is computed at read time: the PG table `model_prices` (per million tokens, currency taken from the deployment setting `priceCurrency`), not written to the log,
labeled "estimated" in the UI, and shown as "—" when there is no price; plugins do not declare prices.

### 8.8 Data security

- Credentials are envelope-encrypted: one data key per org, encrypted by the master key; the master key is rotatable, and can connect to Vault / a cloud KMS through a plugin.
- The audit log retention period is configurable; per-org data export and deletion are supported; the docs give backup recommendations for PG point-in-time recovery.

### 8.9 Releases

Semantic versioning; the plugin SDK is versioned independently; release notes state breaking changes and migration methods.

## 9. Channels and ecosystem plugins

An ecosystem plugin can provide identity source, directory and channel capabilities at the same time; the three have independent switches and can share the same platform app credentials.

- **Channel connection = (channel plugin, a set of bot credentials) → bound to one agent**; an org can have several channel connections (e.g. "HR assistant" and "IT assistant" are each a bot).
- Long-connection mode is supported (Slack Socket Mode, Lark long connection, DingTalk Stream), **so intranet deployments need no public address**; long connections use `ctx.lock` leader election to avoid receiving messages twice.
  When there is a public address, webhook mode can be used instead.
  **M7 implementation notes** (F8, F9): webhook is an **optional inbound mode** of a channel connection (long connection stays the default; `inboundMode` is per connection). A channel plugin opts in with `Channel.webhook`; the kernel serves one route, `POST /channels/webhook/<connectionId>` on the gateway role, outside `/api` and without kernel authentication. The plugin verifies signatures, decrypts, answers URL-verification challenges and checks replays; the kernel dedupes by `messageId` / `eventId`, enqueues durably and acks only after every event was accepted (otherwise 503, and the platform redelivers). It needs `channels.webhookBaseUrl` (a public https origin); Slack and Lark implement it.
- Special handling for China platforms (callback encryption, trusted IPs, old and new APIs, Feishu China edition / Lark) is all encapsulated inside the plugins.
- Business capabilities such as docs, calendar and approvals are built as external apps; the marketplace shows them as a whole in the form of an "ecosystem bundle".
- The recommended first official plugins are **Slack + Lark**; DingTalk and WeCom come in the second batch or go to the community.

## 10. Tech stack

- TypeScript throughout, using the latest versions of dependencies.
- Agent: LangChain / LangGraph (JS).
- Backend: **NestJS + the Fastify adapter** (decided 2026-10-17, consistent with the team's existing stack).
  **The plugin contract does not expose the framework**: plugins recognize only `ctx`, write no Nest controllers, and do not depend on Nest modules or dependency injection;
  plugin routes are dispatched through the single entry `/plugins/:name/*` to handlers the plugins register. Config, migrations, `ctx`, the plugin host,
  and the dual-replica test tool are framework-independent. Nest was chosen for team familiarity and for the structure it gives once the kernel grows (modules, validation, guards, Swagger),
  not for single-process performance; high concurrency comes from horizontal scaling across replicas and stateless design.
- Frontend: **Next** (a standalone web service, standalone image).
- Queue: BullMQ; the ORM / migration tool is decided in the implementation plan.

## 11. Items to verify

| Item | Impact |
|---|---|
| Current release status of MinIO community edition | Which object storage the compose file bundles by default |
| How agent-sandbox supports suspension (scale down while keeping the PVC) | How suspension is done in the K8s implementation |
| Time, snapshot size and failure rate of gVisor checkpoint/restore under Docker | Whether to offer memory retention in the Docker / K8s implementations |
| Whether WeCom has a long-connection mode that needs no public address | Intranet availability of the WeCom plugin |
| Plugin extension UI: inline in the conversation / right panel / page; declarative rendering vs. plugin HTTP page + isolated iframe; display-only vs. interactive; and artifact plugins | To be designed separately after M3; in M3 tool calls use a generic collapsible card uniformly (adjusted 2026-10-19: designed in M4 segment 3, together with the conversation page redesign) |
| "Capybara" trademark search (including rumors of an AI-field codename) | External brand risk |

## 12. Main risks

| Risk | Mitigation |
|---|---|
| Plugin authors write in-process state, breaking multi-replica | `ctx` does not provide such capabilities + the dual-replica test tool + a mandatory marketplace check |
| Prompt injection using an agent to modify the environment | R1–R6, a fixed manually confirmed list under R3, drift protection |
| Approval fatigue leading to rubber-stamping | Diff-style approval cards, batch handling, sensible default policy |
| Workload of native-protocol plugins | A conformance test suite; the default distribution bundles only openai-compatible, and native-protocol plugins are installed on demand |
| Developer searches confusing it with the Ruby test framework Capybara | Always use "Capybara Agent" externally, with the domain name |

## 13. Engineering collaboration conventions (contributor harness)

Community co-building means contributors come from everywhere, use AI coding assistants heavily, and none of them know this project's conventions.
This layer is as important as the product architecture.

### 13.1 Three layers of constraint

| Layer | For whom | Content | Binding force |
|---|---|---|---|
| ① Automated checks | Everyone | Lint, type checking, tests and custom checks in CI | Can't merge |
| ② Skills | AI coding assistants (humans can read them too) | Operating manuals for "how to do X" | Loaded on demand |
| ③ Docs | Humans | Architecture overview, contributing guide, the "why" of each convention | Understanding |

- **A rule that can be written as a check is not only written as a document.**
- **Every check must first be proven to go red**: deliberately create a violation to confirm it is caught, then fix it back to green. A check that reads right but never blocks anyone is worse than none.

### 13.2 Entry points for AI coding assistants

- The root `AGENTS.md` is the single source of truth (a cross-tool convention); `CLAUDE.md` contains only an `@AGENTS.md` reference and no separate copy.
- The repo's development skills use the Agent Skills format (`SKILL.md`) that the product itself supports: eating our own dog food.

### 13.3 First batch of conventions

| Topic | Automated check | Skill / doc |
|---|---|---|
| Architecture boundaries: kernel / plugin / app layering; plugins import only `plugin-sdk` | Dependency direction check | Architecture doc |
| Multi-replica discipline | A lint forbidding timers and module-level mutable state in plugin code; plugin tests must pass the dual-replica test tool | Skill: how plugins store state |
| Database and migrations: schema ownership, expand → contract, idempotency, naming | Migration check: no column drops within one version, idempotent style required | Skill: how to write migrations |
| Config and secrets: all config items declared in the schema; environment variables uniformly prefixed `CAPYBARA_`; marked hot-updatable / secret | Config docs generated automatically from the schema, blocked when out of sync | Skill: how to add a config item |
| Internationalization: UI text goes through keys; server errors use error code + translation; **text shown to the model is always English** | Keys in sync across languages; error codes unique | Skill: how to add text and error codes |
| Plugin SDK compatibility | Public API snapshot comparison; breaking changes must bump the major version | Doc: versioning policy |
| Tool design rules (the application of "give facts" in section 6) | Tool descriptions non-empty; error messages must carry an actionable fix | Skill: how to write a good tool |
| Testing and evals: unit tests, contract tests, provider conformance tests; run replay evals when changing prompts or the loop | CI triggers by change scope | Doc: test layers |
| Commits and releases: Conventional Commits; Changesets manage each package's version | Commit message check; blocked when a changeset is missing | Contributing guide |

### 13.4 Trade-offs

- Bring **principles** from the existing internal platform (multi-replica discipline, reversible migrations, error codes + i18n, English model-facing text, checks must be proven red, give facts and don't guess),
  and **not scripts bound to a specific framework**; once the tech choices are made, rewrite them under the same principles.
- Keep the number and speed of checks under control: the CI target is within 10 minutes; error messages say directly how to fix; anything reproducible locally with one command is not only run in CI.
- CI uses GitHub Actions.

### 13.5 Contribution licensing: CLA

- A **CLA** is adopted: when a contributor first opens a PR, a bot guides them through signing, authorizing the project to use and relicense their contributions,
  keeping the option to adjust the license or launch a commercial edition in the future.
- The contributing guide states explicitly: **the code will always be open source under Apache-2.0**, easing the community's concerns about the CLA.
- The CLA text and the signing tool (such as CLA Assistant) are decided when the repository is initialized; the text needs a look from the company's legal team.
- **M7**: the draft text is in [`CLA.md`](../../../CLA.md) (marked draft; not in effect until legal review finishes and the notice is removed) and the signing workflow is `.github/workflows/cla.yml`. External PRs are not merged until the CLA is in effect.
