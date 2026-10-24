# Extension Model Design

- Date: 2026-10-18
- Status: confirmed; the conclusions were merged into the architecture spec on 2026-10-19 (§2.1–§2.5, §4.5, §7.3, §8.1, §8.2); this document is kept as the decision record and for details; terms superseded on 2026-10-24 (see §1: plugin -> extension, capability -> extension point)
- Relationship: supplements and revises chapter 2 "Kernel and plugin contract" of the *Capybara Architecture Design* (`2026-10-17-capybara-architecture-design.md`);
  written in parallel with M3 (tools and connectors) and **does not depend on the M3 implementation**; once M3 is merged, its conclusions are merged into the architecture spec (see section 10).

## 0. Background and goals

The architecture spec already fixes that "the kernel only does config / database / plugin host / HTTP, and every capability is provided as a plugin", and the plugin manifest already has `provides` / `requires`.
But so far only half of it works: plugins can **provide** capabilities and the kernel can **use** them; plugins using each other, and plugins using the platform's governed capabilities (models, storage), have no specification yet.
This document defines a "plugin" as the unit that can extend any capability of the platform, and fills in four things:

1. **Consuming capabilities**: a plugin can both provide capabilities and use capabilities provided by the platform or other plugins; it depends on a capability, not on a particular plugin.
2. **Model capability layer**: chat, embedding, multimodal and so on have separate contracts by modality; platform features and plugins ask the kernel for models by "purpose" and do not each integrate models themselves.
3. **Object storage and config**: object storage becomes a plugin capability; plugin config always has a schema and is namespaced by plugin name, and secrets go to the secret store.
4. **Permission manifest**: modeled on Android / iOS, a plugin declares everything it will use and the admin can see it at install time; **anything not declared is forbidden**.

### 0.1 Non-goals

- Memory and knowledge bases are still not in the MVP (architecture spec 0.2 unchanged); the embedding and rerank contracts only reserve a shape and are not scheduled.
- No model-call entry point is opened to external apps: the model capability layer serves only the kernel and the plugins of this deployment.
- No process-level isolation of plugins (architecture spec 2.5 unchanged). The permission manifest is **governance at the platform interface layer**, not a security sandbox (see 7.5).
- Generation models (text-to-image, text-to-video, TTS) do not enter the model capability layer and are built as tools (see 4.4). Real-time bidirectional voice is out of scope.

## 1. Terms

| Term | Meaning |
|---|---|
| **Plugin** | The unit of packaging and installation: one npm package + a plugin manifest, installed by an enterprise admin. A plugin can provide several capabilities and also use several capabilities |
| **Capability** | An extension-point contract with a major version, typed in `@capybara-hq/plugin-sdk`, of the form `channel@1`, `model-provider@2` |
| **Platform capability** | An interface the kernel provides directly to plugins through `ctx` (`ctx.db`, `ctx.kv`, `ctx.models`, `ctx.storage`, ...) |
| **Provider / consumer** | The plugin that implements a capability / the kernel module or plugin that uses it |
| **Extension-point call** | The kernel calls an implementation provided by a plugin at some moment (tool execution, hook, channel inbound, ...) and passes the context of this call |

~~The name stays "plugin" and is not changed to "extension": the platform already has "app", "skill" and "connector", and adding "extension" would be confusing.~~

> **Superseded (2026-10-24)** by the package ecosystem design (`2026-10-22-package-ecosystem-design.md` §1, §13): the in-process unit described in this document (`defineExtension`, `ctx`, the permission manifest, approval) is now called an **extension**; **plugin** now names the install and distribution unit that bundles an extension, connector templates and skills (formerly the "app bundle"); a **capability** is now an **extension point** and a **platform capability** is the **platform API**; "app" keeps only the meaning "external app". Read "plugin" in the rest of this decision record as "extension" and "capability" as "extension point". Code names in this document were updated to the renamed identifiers (`defineExtension`, `ctx.extensionPoints`, `EXTENSION_POINTS`, …); data locations such as the `plugin_<name>` schema keep their names.

## 2. Providing and consuming capabilities

### 2.1 Depend on a capability, not on a plugin

Plugin A needs "some kind of capability", not "plugin B":

```ts
defineExtension({
  name: "approval-cards",
  requires: ["channel@1"],            // cannot load without it
  optional: ["directory@1"],          // can load without it; using it yields an empty list
  ...
});
```

- `requires` is already implemented (existence, no cycles and topological ordering by dependency are validated at load time); `optional` is new, with the same semantics but a missing one does not block loading.
- Dependencies are matched by **major version**; the SDK supports the current major version and the previous one at the same time (architecture spec 2.5).
- Swapping the implementation (B replaced by C) is transparent to A; when there are several providers, who is chosen is decided by the consumer by name or by org config (2.3), and is not hard-coded in plugin code.

### 2.2 Two kinds of capability: pass-through and brokered by the kernel

| Kind | Examples | How the consumer uses it | Reason |
|---|---|---|---|
| **Pass-through** | `directory@1`, `channel@1`, `identity-source@1` | `ctx.extensionPoints.get` / `list` returns the implementation directly | No need for unified platform governance |
| **Brokered (governed)** | `model-provider`, `embedding-provider`, `object-store`, `secret-store`, `connector`, `sandbox` | Usable only through platform capabilities (`ctx.models`, `ctx.storage`, ...); **the raw implementation is not reachable** | Credentials, metering, quotas, audit and tenant isolation must be handled uniformly in the kernel |

The capability registry (`EXTENSION_POINT_CARDINALITY`) is widened to `{ cardinality, brokered }`; `ctx.extensionPoints.get` throws directly for a `brokered` capability.

> **M4 implementation note**: the registry is `EXTENSION_POINTS` (`packages/plugin-sdk/src/extension-point.ts`), each entry `{ cardinality, brokered, orgScoped }`; `channel` and `directory` are `orgScoped`, `identity-source` is not (login is deployment-level, enabled through `auth.loginSources`, Ruling P1). `get` / `list` also have overloads taking `{ orgId }`: they return a Promise and filter by that org's enabled state (a DB lookup every time, no caching; Ruling A1); without `orgId` they are synchronous and do not filter by org. Getting a brokered capability throws a plain `Error` (declaring cannot fix it, and no audit is written; Ruling A3).

```ts
// New on ctx (only capabilities declared in the manifest's requires / optional can be obtained)
capabilities: {
  /** Single-select capabilities take no provider; multi-select capabilities must pass one. */
  get<T>(ref: ExtensionPointRef, provider?: string): T;
  list<T>(ref: ExtensionPointRef): { plugin: string; impl: T }[];
};
```

- Dependencies are loaded in topological order, and the depended-on plugin is ready at `setup` time; the implementation object itself is a stateless factory / function that can be obtained in `setup` and held by closure,
  which does not violate "no mutable in-process state".
- The kernel's existing `ExtensionHost.get` / `list` are the basis of the implementation of this set of interfaces.

### 2.3 Org enablement and unavailability

- A plugin is **installed at the deployment level and enabled at the org level** (architecture spec 2.2). When a capability that A depends on has no enabled provider in some org, **enabling A in that org is rejected**, with a message saying which capability is missing.
- If the depended-on plugin is disabled in that org at runtime: using it throws `ExtensionPointUnavailableError` (an `optional` capability disappears from `list`), and A decides whether to fail or degrade.
  When disabling a depended-on plugin, the UI says "the following plugins depend on it".
  (M4 implementation: disabling is rejected only when it would leave an already-enabled dependent with **no** enabled provider of that capability, `plugin.has_dependents`, and can be forced; Ruling A5.)
- Deployment-level capabilities (such as model providers) are not affected by the org enable switch; which models an org can use is decided by the purpose configuration in 4.2.

## 3. Call context: it travels with the extension point

- What `setup(ctx)` gets is a **deployment-level** context: it cannot see any org, account or conversation.
- When the kernel calls a plugin implementation, it puts the context of this call into the call arguments, and the **content is decided by the extension point**:

| Extension point | Context |
|---|---|
| Tool execution (M3 `ToolCallContext`) | Org, account, agent, conversation, call id, abort signal |
| Hooks such as `agent.preStep`, `model.request/response` | Org, account, agent, conversation, and the data of that moment (messages, model request) |
| Channel inbound | Org, channel, external identity |
| Login (`identity-source`) | The auth request and the external identity, without any conversation |
| Queue jobs | What the plugin itself wrote into the job data when enqueuing (usually with orgId); the kernel checks that the plugin is enabled in that org |

- M3's `ToolCallContext` is the first implementation of this principle, and the other extension points are designed the same way.
- **Extension points that can see conversation content** (tools, `agent.preStep`, `model.*`, `tool.*` hooks, channel inbound) are declared separately in the permission manifest and highlighted (7.2).
- Conversation-related data a plugin needs to keep across calls is written to its own `ctx.db`; this is plugin data and is shown in the manifest's data items; the multi-replica discipline already forbids putting it in process memory.

> **M4 implementation note**: what a channel plugin actually receives is the channel connection's `connectionId` and the connection config (`send` additionally gets the target, the message and the org's language `locale`); the org and the speaker's account are resolved by the kernel from the connection and the identity, and the plugin cannot see them; a directory only gets that org's org-level config. Providing `channel@1` is not a separate permission item but is shown in the "provided capabilities" group: a group containing `channel@1` (receives the org's conversations in IM, Ruling A33), `directory@1` (can add people to the org) or `identity-source@1` (decides who can log in as which account) is marked sensitive; the other sensitive groups are secrets, public routes, tools and hooks (Ruling A5). When the `features.cards` / `threads` a channel plugin declares is false, the kernel falls cards back to text and removes `threadId` from the target before handing it to the plugin (Ruling A33).

## 4. Model capability layer

### 4.1 Contracts by modality

| Capability | Status | Description |
|---|---|---|
| `model-provider@2` | Exists | Chat: streaming, tool calls, thinking, caching. Used by the agent main loop |
| Media input (image / audio / video as input) | M5 did images and PDF (audio / video undecided) | Add media blocks to the chat contract; bytes go to object storage and the event log records only a reference; models declare support by media type, and the kernel does not send media to a model that doesn't support it. M5 decided to append `image` / `document` blocks inside `@2` (C1), gated by `capabilities.vision` / `documents`, without bumping to `@3` |
| `embedding-provider@1` | Reserved | `listModels()` (dimensions, max input, batch limit) + `embed(inputs, { model, dimensions?, inputType? })` → vectors and usage |
| `rerank-provider@1` | Reserved | Shaped like the embedding one, designed with the first consumer |

- One provider plugin can provide several model capabilities at once (for example a Bailian plugin provides `model-provider@2` and `embedding-provider@1`), with the key configured once.
- Every capability has a conformance suite, with the same rules as `skills/writing-model-providers` (native protocol, no retries inside the plugin, error mapping).

### 4.2 Purpose: ask for models by purpose, don't hard-code model ids

- The agent main loop uses the model selected in the agent version (existing, unchanged).
- Other platform features and plugins ask for models by **purpose**. Purposes are declared by the kernel or the plugin in the manifest:

```ts
models: [
  { purpose: "summarize", kind: "chat", requires: { tools: false }, label: { zh: "会话摘要", en: "Summaries" } },
]
// A purpose key declared by a plugin is "<plugin name>.<name>", the same rule as parameter keys; the kernel's own purposes have no prefix (such as "compaction").
```

- The org admin maps each purpose to a concrete model in the admin console (optionally, the enterprise admin gives a default mapping); calling an unmapped purpose reports `model.unconfigured`.
- Embedding purposes need special care: changing the model invalidates stored vectors, so the result of `embed` carries `{ provider, model, dimensions }`, the consumer must store it together with the vectors,
  and when the mapping changes the UI prompts "existing data needs to be rebuilt".

### 4.3 `ctx.models`

```ts
models: {
  chat(req: { purpose: string; system?; messages; tools?; params? }, call: { orgId: string; signal: AbortSignal }):
    AsyncIterable<ModelStreamEvent>;
  embed(req: { purpose: string; inputs: string[]; inputType?: "query" | "document" }, call: { orgId: string; signal: AbortSignal }):
    Promise<{ provider: string; model: string; dimensions: number; vectors: number[][]; usage }>;
};
```

In the middle the kernel uniformly does: resolve the model by purpose → check that the plugin declared the purpose and is enabled in that org → quota → call (reusing the existing degradation ladder) →
produce a usage event attributed to (org, plugin, purpose) (`usage.report`) → audit.

- A plugin calling a model inside a conversation (for example a tool asking the model once more internally) is not written to the conversation's event log, because it is not content the main-loop model sees;
  the usage record carries `conversationId` and `callId` for traceability. "Everything the model sees goes into the log" still constrains only the main loop.
- `ctx.models` has no consumer within the MVP; the interface shape is fixed here and the **implementation is scheduled with the first consumer**.

### 4.4 Generation as tools

Text-to-image, text-to-video and TTS are "submit a task → poll for the result", with large outputs, and are used as "the model decides to call": they are built as tools that plugins register through `ctx.tools`,
polling goes through `ctx.queue`, and outputs go to object storage or M3's output archive (artifacts). No new model capability is added.

## 5. Object storage

- A new capability `object-store@1`: **single-select, brokered** (one storage per deployment).
- Contract (implemented by the plugin): `put(key, body, { contentType, size })`, `get(key)` (stream), `head`, `delete`, `list(prefix, cursor)`,
  `presignGet(key, ttl)`, `presignPut(key, { contentType, maxSize, ttl })`. Large uploads and downloads go from the browser straight to the storage through presigned URLs, not relayed by the kernel.
- Default implementation `plugins/object-store-s3`: the official `@aws-sdk/client-s3`, supporting `forcePathStyle`. One implementation covers MinIO, Ceph, SeaweedFS,
  and Alibaba OSS and Volcano TOS, which offer S3-compatible interfaces; a native interface gets its own plugin when needed.
- Platform capability `ctx.storage`: the same shape as `object-store@1`, but **keys are automatically prefixed** with `plugins/<plugin name>/<orgId>/…` (the kernel itself uses `kernel/…`),
  so a plugin can neither see nor write other parties' objects, similar to `ctx.db`'s separate schema. All methods require `orgId`.
- Org data export and deletion (architecture spec 8.8) cover object storage by prefix.
- The kernel is a consumer too: attachments, sandbox file import and export (M5). M3's output archive was already decided to live in PG and is unaffected.
- When no provider is installed: a plugin that declares `storage` cannot load, and kernel features that depend on object storage are unavailable with a notice in the admin console. The dev compose (`docker/compose.dev.yaml`) ships SeaweedFS (changed from MinIO to SeaweedFS on 2026-10-21).

> **M5 implementation note**: `presignPut` returns `PresignedUpload { method: "PUT" | "POST", url, headers, fields? }` (Ruling M3): a presigned PUT cannot limit size, so the S3 implementation uses a POST policy (exact key, `content-length-range`, `Content-Type` conditions), and the storage side rejects anything over `maxSize`; a key cannot contain `${` (POST would replace `${filename}` with the uploader's file name). `presignGet` gained `downloadName` / `disposition` / `responseContentType` (Ruling M9). `ctx.storage` is now provided (no longer a reserved item), and using it requires declaring `permissions.storage` (`perm-storage`). After an org is deleted, a maintenance job cleans up by prefix (`storage.purgeDeletedOrgsAfterDays`). For how to write one see `skills/writing-object-store-providers`.

## 6. Config and secrets

Three things kept apart:

| | What is stored | Where | Who changes it |
|---|---|---|---|
| **Startup config** (`config-source@1`) | Database, Redis, master key, plugins to load | File / Nacos / env vars (needed before connecting to the database) | The deployer |
| **Plugin config** (deployment-level, org-level) | A plugin's business config, such as client id, region, switches | PG, namespaced by plugin name | Enterprise admin / org admin (admin console UI) |
| **Secrets** (`secret-store@1`) | client secret, token | PG envelope encryption by default; can be swapped for a Vault / cloud KMS plugin | Same, write-only and never echoed |

- **Plugin config always has a schema** (manifest `config.deployment` / `config.org`, zod): validated on write, the UI generates forms from the schema,
  `secret()` fields are handed to the secret store automatically, and it can be shown in the manifest. Schema-less free key-value config is not provided; plugin runtime state uses `ctx.kv` (a TTL is required), and business data uses `ctx.db`.
- Org-level plugin config is already in PG (M1). **Change: deployment-level plugin config is also stored in PG**, edited by the enterprise admin in the admin console, and the platform handles validation, encryption, audit and effect across replicas:
  - `extensionConfig.<plugin name>` in the startup config is kept as the **values managed by the deployment files**: fields that appear in the file / Nacos / env vars are read-only in the UI with their source marked,
    and fields that don't appear are managed by the UI. This allows both GitOps and editing in the UI, and the same field never has two sources.
  - Effect across replicas: after a write it is broadcast through `ctx.bus`; fields marked `hot: true` in the schema field's meta by the plugin (the same notation as kernel config) take effect on each replica immediately
    (the plugin reads the new value through `ctx.config`; interface details are settled in the implementation plan), and the UI tells the user the other fields "take effect after restart".
- This way Nacos carries only the startup config, and plugins' complex business config no longer piles up in Nacos.

## 7. Permission manifest

### 7.1 Principle

A plugin **declares everything it will use**, the enterprise admin sees and confirms it at install time, and **anything not declared is forbidden**: the kernel builds each plugin's `ctx` from the manifest, and a platform capability that was not declared does not exist
(access throws `ExtensionPermissionError`, with a message saying what to declare in the manifest).

### 7.2 What is declared and how it is shown

Things derivable from existing fields are not declared again; the new `permissions` field holds only the parts that cannot be derived.

| Item | Source | Level | Shown at install time |
|---|---|---|---|
| Provided capabilities | `provides` | — | "This plugin provides: model provider, channel, ..." |
| Used capabilities | `requires` / `optional` | Normal | "This plugin uses: directory, ..." |
| Config items | `config` schema | Normal | Deployment-level and org-level config fields, with secret fields marked |
| Data tables | `migrations` (the migration SQL is parsed) | Normal | Schema name, table names, SQL expandable |
| Basic platform capabilities | Granted automatically | Basic | `kv`, `lock`, `bus`, `queue`, `log`, its own `db`: listed but need no separate declaration |
| Models | `permissions.models` (purpose list, 4.2) | Normal | "Will call models: session summary (chat)" |
| Object storage | `permissions.storage` | Normal | "Will read and write object storage" |
| Secrets | `permissions.secrets` | **Sensitive** | "Will save secrets" |
| HTTP routes | `permissions.http` (route list, including whether public) | Public routes are **sensitive** | Route list (M4: `public` is only a declaration, and plugin routes still do not go through kernel auth, see the note below) |
| Tools | `permissions.tools` (tool name list) | **Sensitive** | Tool names and descriptions (tools can see conversation parameters) |
| Hooks | `permissions.hooks` (mount point list) | **Sensitive** if they can see conversation content | Mount points and descriptions |
| External network | `permissions.network` (domain list) | Display only (the MVP does not block, see section 11) | "Will access: open.feishu.cn ...", marked "declared, not blocked by the platform" |

Sensitive items are highlighted separately on the install confirmation page; an org admin enabling a plugin sees the same manifest.

> **M4 implementation note**: `permissions.http[].public` is currently used only for display and the snapshot (Ruling A2): plugin routes, whether or not they declare `public`, still bypass kernel auth as since M0 and the plugin verifies signatures itself; having the kernel authenticate non-public plugin routes is a later decision (it will be a behavior change then). since M7 `hooks` is no longer reserved (see the M7 note below), `models` / `storage` are reserved items, and using them makes `check:plugin-permissions` report `perm-reserved` (since M5 `storage` is provided, see section 5; `models` is still a reserved item).

> **M7 implementation note**: `ctx.hooks` is live. Five mount points are registrable (`model.request`, `model.response`, `tool.preExecute`, `tool.postExecute`, `usage.report`); `session.*` and `agent.preStep` are still reserved. `permissions.hooks` lists the mount points; the new `permissions.policyHooks` lists the ones (only `model.request` / `tool.preExecute`) where the plugin registers `mode: "policy"` hooks, so deployment state can fail a call closed on a replica where such a plugin is not loaded. Both are sensitive at review (approval key `permissions.hooks.policy:<mount>` for the policy declarations), and `check:plugin-permissions` reports an undeclared registration as `perm-hooks`. Hooks observe or deny, never rewrite, and fire only for orgs that enabled the plugin. Details: `.agents/skills/writing-extensions/SKILL.md`, "Hooks".

### 7.3 Approval and upgrades

- The kernel records each plugin's **approved permission snapshot** in PG. When a plugin first appears, or after an upgrade its manifest has any item beyond the snapshot, the plugin is **not loaded**,
  the admin console shows "pending approval", and it takes effect after the enterprise admin confirms; an upgrade with fewer or unchanged permissions takes effect directly.
- Before the admin console UI (before M6) the CLI is used: `capybara extensions review` / `capybara extensions approve <name>`.
- For development and trials, `extensionPermissions.autoApprove: true` can be turned on explicitly in the startup config (`plugins` is still the array of plugin names to load, Ruling A4); it approves automatically at startup and logs a warn; it is off by default in production.
- **M4 implementation note**: the snapshot also constrains `capybara migrate` (an unapproved plugin runs no migrations and creates no tables; `plugins review` runs the kernel migrations first); auto-approval writes a snapshot (source auto) but writes no audit; a plugin older than the snapshot version (an old replica restarted during a rolling upgrade, a rollback) loads as usual as long as its permissions do not exceed the snapshot, and the snapshot is not shrunk; "beyond the snapshot" is compared per entry, so changing a public route to non-public or a secret field to a normal field also counts as a new entry; data tables are parsed from `CREATE TABLE` only (`ALTER … RENAME` and views do not enter the snapshot). "The admin console shows pending approval" comes with the M6 admin console; M4 has only the CLI and startup logs.

### 7.4 Automatic checks

- `defineExtension` validates the `permissions` format (purpose key prefix, route format, mount point names).
- A new check `check:plugin-permissions`: statically scans a plugin's source for `ctx.<x>` usage, tool names of `ctx.tools.register` and routes of `ctx.http.route`,
  and compares them with the manifest; using something undeclared fails. As usual it comes with a test where a violating fixture makes it fail.
- Runtime backstop: an undeclared access throws `ExtensionPermissionError` and is audited.

### 7.5 Boundary: this is not a sandbox

A plugin is trusted code running in-process; it can `import pg` and connect to the database itself, send network requests directly, and read env vars, and none of this can be stopped inside the process. Android permissions work because of process isolation, and we do not have that layer.
So the permission manifest does the following:

- **Really blocks platform resources**: models, credentials, object storage and conversation content are all held by the kernel and cannot be obtained without a declaration;
- **Transparency and audit**: admins know what an installed plugin wants and what an upgrade asks for extra;
- **Constrains honest plugin authors**: the automatic check makes "forgot to declare" fail in CI.

The defense against malicious code is still architecture spec 2.5 / 7.4: only enterprise admins can install, npm provenance, automatic checks and review in the public marketplace; untrusted extensions are built as external apps.
For items the platform cannot block, such as "external network", the install page honestly marks them as "declared" and does not create a false sense of security.

## 8. Impact on existing code and docs

| Location | Change |
|---|---|
| `packages/plugin-sdk/src/define-extension.ts` | Manifest gains `optional`, `permissions`; validation |
| `packages/plugin-sdk/src/extension-point.ts` | Registry gains `brokered`; new capability `object-store` (single-select, brokered), reserved `embedding-provider` / `rerank-provider` |
| `packages/plugin-sdk/src/ctx.ts` | Add `capabilities`, `storage`; reserve `models`; platform capabilities can be omitted per the manifest |
| `packages/kernel/src/ctx/create-ctx.ts`, `extensions/host.ts` | Build `ctx` per the manifest; permission snapshot and "pending approval"; check dependencies at org enablement |
| `packages/kernel/src/extensions/org-config.ts` | Deployment-level plugin config into PG, source marking, broadcast to take effect |
| `skills/writing-extensions` | Permission manifest, capability consumption, call context |
| Architecture spec §2.1–§2.3, §4.5, §7.3, §8.1, §8.2 | Merge the conclusions of this document (see section 10) |

## 9. Phasing

| Content | When | Reason |
|---|---|---|
| Ark dialect (`openai-compatible` gains `ark`) | Any time, after M2 | Small change, independent of this document |
| Manifest format (`optional`, `permissions`) + building `ctx` per the manifest + `ctx.extensionPoints` + `check:plugin-permissions` + permission snapshot and CLI approval | **First task group of M4** | M4 brings in multi-capability plugins such as Slack and Lark all at once, so the manifest format must be fixed before them; channels, identity and directory start consuming each other |
| `object-store@1` + `object-store-s3` + `ctx.storage` | **Start of M5** (done) | The first consumers are attachments and sandbox files |
| Media input contract | **M5** (done: images and PDF) | Depends on object storage and attachments |
| Deployment-level plugin config into PG, install confirmation page, purpose → model config page | **M6** (admin console) | The UI is in M6; the manifest format must be stable before M6's "SDK public API snapshot check" |
| `ctx.hooks` (observe / policy hooks) + `usage.report` metering | **M7** (done) | The permission manifest and the SDK API snapshot were stable; hooks are the first extension point that can deny model and tool calls |
| `ctx.models`, embedding, rerank | After the MVP, with the first consumer | No consumer within the MVP (memory and knowledge bases are not built) |

M3 needs no change: `ctx.tools` and `ToolCallContext` already conform to section 3; when M4 introduces the permission manifest, `tools` just needs to be included in the declaration.

## 10. Merging into the architecture spec

The M3 branch is modifying architecture spec §2.1, §2.3 and §5.4. To avoid conflicts, this document stands alone first; after M3 is merged, a separate documentation commit merges the conclusions of sections 2, 4, 5, 6 and 7 into the corresponding chapters of the architecture spec,
and this document is kept as the decision record.

## 11. Decisions made (confirmed with the user on 2026-10-19)

1. Optional dependencies use a **separate `optional` field**, not an `optional: true` on `requires` entries: the "required / optional" two columns of the install confirmation page map directly to the two fields.
2. Hot update of deployment-level plugin config **reuses the kernel config's `hot` marker**: a plugin marks `hot: true` in a schema field's meta, marked fields take effect immediately after a change,
   and the plugin only needs to handle the fields it marked `hot`; unmarked fields get a UI hint "takes effect after restart".
3. Permissions are **approved by the enterprise admin** (at install and upgrade); an org admin enabling a plugin sees the same manifest but does not approve separately.
4. External network domains are **display only in the MVP**, with the install page marking "declared, not blocked by the platform"; when a deployment enables an egress proxy later, the manifest is used to allow traffic, as a follow-up enhancement.
