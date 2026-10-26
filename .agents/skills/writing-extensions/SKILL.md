---
name: writing-extensions
description: 'Use when creating or changing a Capybara extension under plugins/*: manifest fields, the permission manifest and approval (capybara extensions review / approve, extensionPermissions.autoApprove), the trust model (in-process, full trust; approval is governance, not a sandbox), ctx.extensionPoints and orgScoped, deployment-level (including stored in PG) / org-level / channel-connection config, the ctx items, patterns forbidden under multiple replicas (timers, module-level state), extension packages (pnpm pack-plugin) and the no-restart lifecycle (install / enable / disable / upgrade / uninstall, dispose, ctx.signal, drain, expand-only migrations, bootstrap plugins), hooks (ctx.hooks: model.request / tool.preExecute / usage.report, observe vs policy, permissions.policyHooks, fail-closed), publishing to npm (provenance), and dual-replica tests. For web UI (ctx.ui) see writing-extension-ui; for plugins (plugin.json, skills, connector templates, dependencies, catalog import, org install) see writing-plugins.'
---

# Writing extensions

## What this skill covers

Creating or changing a Capybara extension under plugins/*: manifest fields, the permission manifest and approval (admin console, capybara extensions review / approve, extensionPermissions.autoApprove, migration warning digest), the trust model (extensions run in-process with full trust, approval is governance not a sandbox), extension point consumption ctx.extensionPoints and orgScoped, deployment-level (including stored in PG from the admin console) / org-level / channel-connection config, how to use each ctx item, patterns forbidden under multiple replicas (timers, module-level state) and their alternatives, extension packages (pnpm pack-plugin, the host provides only the SDK and zod) and the no-restart lifecycle (install / enable / disable / upgrade / uninstall, ledger revocation, dispose, ctx.signal, drain limit, dependents reloading, expand-only migrations, bootstrap plugins (`bootstrap.json`, `capybara bootstrap`, required plugins) and config-declared extensions, CLI), hooks (ctx.hooks: model.request / model.response / tool.preExecute / tool.postExecute / usage.report, observe vs policy, permissions.hooks / permissions.policyHooks, perm-hooks, fail-closed policy hooks, usage.report idempotent by eventId), publishing an extension to npm (repository field, provenance), and the template for writing tests with the dual-replica harness. For adding UI to the web app (ctx.ui) see writing-extension-ui; for writing plugins (the bundle: `.capybara-plugin/plugin.json`, skills, connector templates, dependencies, catalog import and org install) see writing-plugins.

Terms: an **extension** is the in-process code (`defineExtension`, `ctx`, the permission manifest, approval); it **provides** or **consumes** **extension points** (versioned contracts such as `channel@1`). A **plugin** is the install and distribution unit (a bundle that may hold one extension, connector templates and skills; see `.agents/skills/writing-plugins`). Each official package under `plugins/*` (`@capybara-hq/plugin-<name>`) holds one extension of the same name, so the extension's name is its plugin's name.

Reference implementation: `plugins/example-counter` (db transaction + queue idempotent job + provide; copy it to get started; for kv usage see "Durable counters and idempotency" below). For model provider extensions (`model-provider@2`) see also `.agents/skills/writing-model-providers`; for giving agents tools (`ctx.tools`) or connectors (`connector@1`) see also `.agents/skills/writing-tools`; for IM channels, third-party login and directory sync (`channel@1` / `identity-source@1` / `directory@1`) see also `.agents/skills/writing-channels` (reference `plugins/slack`, `plugins/lark`); for adding UI to the web app (`ctx.ui`: schema-rendered views and embeds) see also `.agents/skills/writing-extension-ui` (reference `plugins/todo`, `plugins/example-board`).

## Hard constraints (read this first)

| Rule | Check | Rule id |
|---|---|---|
| May only import `@capybara-hq/plugin-sdk`, `zod` and other third-party npm packages; **may not** import `@capybara-hq/kernel` or files outside the extension directory. Tests may use the devDependency `@capybara-hq/testing` | `pnpm check:deps` | `plugin-imports-kernel`, `plugin-imports-outside` |
| Must not use `setTimeout` / `setInterval` / `setImmediate` / `node:timers` | `pnpm check:extension-state` | `plugin-timer` |
| No top-level `let` / `var` / `new Map/Set/WeakMap/WeakSet` / array literals at module level | `pnpm check:extension-state` | `plugin-module-state` |
| `ctx.secrets` / `ctx.storage` / `ctx.http.route` / `ctx.tools.register` / `ctx.extensionPoints` / `ctx.ui.view` / `ctx.ui.action` used in `setup(ctx)` must be declared in the manifest; `ctx.models` is not provided yet | `pnpm check:extension-permissions` | `perm-secrets`, `perm-storage`, `perm-http`, `perm-tools`, `perm-extension-point`, `perm-ui`, `perm-reserved` |
| `ctx.kv` writes must carry `ttlSeconds` (enforced at the type level) | `pnpm typecheck` | — |
| Queue names and job ids contain no `:` (a BullMQ limit) | Runtime: `ctx.queue.define` / `add` throw `TypeError` directly | — |

`pnpm check` runs them all at once.

### Why timers and module-level state are banned

Production runs multiple replicas, and the writer and the reader may not be in the same process. An in-process Map / timer exists only in the process that created it: other replicas cannot read it or stop it. A single-process dev setup cannot expose this, so avoid it while writing the code.

| What you want | Not this | This |
|---|---|---|
| Share state across requests | A module-level `Map` | Durable data in `ctx.db`; temporary / expiring state in `ctx.kv` (with TTL) |
| Delayed / periodic work | `setTimeout` / `setInterval` | `ctx.queue.add(name, data, { delayMs })` |
| An abortable wait within a single request (backoff, streaming interval, timeout) | A Promise wrapping `setTimeout` | `AbortSignal.timeout(ms)`, listened to together with the caller's `signal` (see `defaultSleep` in `plugins/model-fake`) |
| Notify other replicas | In-process events / callback tables | `ctx.bus.publish` / `subscribe` |
| "Whoever opens closes" pairing | The opener holds a handle in memory | The opener expires itself (TTL) + the closer broadcasts |

`AbortSignal.timeout(ms)` is only for waits **within this request** that end when the request ends: it schedules no work outside the request. Any need of the form "do something after a while / at intervals", however short, goes through `ctx.queue` (`delayMs`), because when the time comes another replica may be the one handling it, and the originating process may be gone.

Only truly read-only constants (such as regex tables or fixed lookup tables) are exempt: write `// capybara:allow-module-state <reason>` at the **end of the same line** as the declaration or on the **line immediately above**; the reason cannot be empty (an empty reason still reports `plugin-module-state`).

## Trust model (know this before writing or installing an extension)

- **An extension package runs in the kernel process with full trust**: extension code is in the same process as the kernel with the same privileges, and migration SQL runs over the kernel's database connection. In-process code cannot be stopped from connecting to the database directly, reading environment variables or making network requests; so **only an enterprise admin can install an extension into a deployment**, and untrusted extensions are built as external apps (calling the kernel over HTTP).
- **The permission manifest, allowlists and approval are governance, not a sandbox**: what the manifest really blocks is the resources the kernel holds (`ctx.secrets`, `ctx.storage`, tools, routes, extension point consumption, UI); the rest (network domains and so on) is only transparency and audit. Before approving, review the extension as code that can do anything (source, publisher, migration SQL).
- Review only looks at the static manifest and migration SQL in the package and does not execute extension code; statements in a migration that write outside the extension's own schema, change permissions / roles, create functions / triggers or control transactions (`foreign_schema`), destructive statements (`destructive_migration`) and `DO` blocks (`dynamic_sql`) are listed as sensitive warnings (not rejected). **The digest of the warnings counts toward the permission snapshot** (permission key `migration.warnings:<digest>`, Ruling P4): a new version whose permissions are unchanged but whose migration warnings changed (such as a newly added `GRANT`) also needs re-approval.
- **Do not run `pnpm pack-plugin` on untrusted source**: packing uses esbuild, resolving against the extension's `node_modules` and bundling dependencies, and then `import`s the bundled entry module to generate the static manifest, so the extension's module top-level code executes on your machine.
- Unpacking on the kernel side always goes through `extractExtensionPackage` (`packages/kernel/src/extensions/package.ts`, with the same path / type / entry count / unpacked size limits as `readExtensionPackage`; validate with the latter first); do not write your own `tar -x` or use a third-party unpacker.

## Manifest (defineExtension)

```ts
import { defineExtension } from "@capybara-hq/plugin-sdk";
import { z } from "zod";

export default defineExtension({
  name: "my-plugin",          // ^[a-z][a-z0-9-]{1,40}$, the name kernel is reserved; the PG schema is plugin_my_plugin
  version: "0.1.0",           // semver
  sdk: "^0.1.0",              // compatible SDK version range
  provides: ["counter@1"],    // extension points provided, of the form name@major, must be registered in the SDK
  requires: [],               // extension points of other extensions depended on (optional; cannot duplicate provides)
  optional: [],               // optional dependencies: loads even when the provider is missing, list is empty on use
  permissions: {              // permission manifest: what is not declared is forbidden, see below
    http: [{ method: "POST", path: "/inc" }],
  },
  config: {
    deployment: z.object({ step: z.number().int().positive().default(1) }), // deployment level
    // org: z.object({...}),                                                // org level
  },
  migrations: "../migrations", // relative to the directory of the entry file; under both src/ and dist/ it points to the package root migrations/
  setup(ctx) { /* see below */ },
});
```

`defineExtension` validates the manifest at load time and throws directly if it is invalid.

**Permission manifest (`permissions`)**: the kernel builds `ctx` from the manifest; access to a platform API that is not declared throws `ExtensionPermissionError` (the message says which manifest item to declare it in) and records the audit event `extension.permission_denied`.

- Granted automatically, no declaration needed: `kv`, `lock`, `bus`, `queue`, `log`, `db`, `config`, `provide`.
The items (all governance information, which the deployer sees when approving):

| Item | Form | Description |
|---|---|---|
| `secrets` | `secrets: true` | Required to use `ctx.secrets` |
| `http` | `[{ method, path, public? }]` | Every `ctx.http.route` must be listed; `method` is GET / POST / PUT / DELETE and `path` starts with `/`; `public: true` means no login is needed and is highlighted. **For now `public` is only a declaration** (Ruling A2): extension routes bypass kernel authentication whether or not they are `public`, see "Plugin route matching semantics" below |
| `tools` | `["write"]` | The name of each `ctx.tools.register` tool (the local name, without the `<extension name>__` prefix); tools can see conversation content and are highlighted |
| `network` | `["api.example.com"]` | Fixed domains that will be accessed; display only, the platform does not block; omit when endpoints are all configured by the admin; wildcards are not supported |
| `ui` | `{ views: ["tasks"], embeds: ["board"] }` | Corresponds one-to-one with the manifest's top-level `ui` (UI contributions): those of kind view are listed in `views` (recorded in the snapshot, **do not block loading**), those of kind embed are listed in `embeds` (block loading, need approval, sensitive). Details in `.agents/skills/writing-extension-ui` |
| `storage` | `storage: true` | Required to use `ctx.storage` (object storage: the first parameter of every method is `orgId` (must be a UUID, normalized to lower case), and keys are automatically confined under `plugins/<plugin name>/<orgId>/`; a key must not be empty, must not start with `/`, and must not have `.` / `..` segments, `\`, control characters or `${`, and after the prefix is added it must be <= 1024 bytes, otherwise `StorageKeyError` is thrown; the presigned `ttlSeconds` is clamped to 1..604800; the keys `list` returns have the prefix stripped. `presignPut` returns `{ method, url, headers, fields? }`: the S3 implementation is a direct `POST` form upload, and the size is limited by the store); using it undeclared reports `perm-storage`. When the deployment has no `object-store@1` provider installed (such as `object-store-s3`), an extension that declares it **does not load** (pending, reason dependency) |
| `hooks` | `["model.request", "usage.report"]` | Mount points of `ctx.hooks.on` (five are registrable, see `HOOKS_AVAILABLE`); sensitive at review. `check:extension-permissions` reports an undeclared mount as `perm-hooks`. See "Hooks" below |
| `policyHooks` | `["model.request"]` | Mount points where the extension registers `mode: "policy"` hooks: only `model.request` / `tool.preExecute`, each also listed in `hooks`. Deployment state reads it to fail calls closed where the extension is not loaded (see "Hooks"); a policy hook on an undeclared mount throws `ExtensionPermissionError` and is reported as `perm-hooks` |
| `models` | — | Reserved (`ctx.models` is not provided yet; using it makes `check:extension-permissions` report `perm-reserved`) |

**Extension point consumption (`requires` / `optional`)**: `ctx.extensionPoints.get / list(ref)` can only take refs declared in `requires` / `optional` (or the extension's own `provides`); any other ref reports `perm-extension-point`. Only pass-through extension points (`channel`, `directory`, `identity-source` and so on) can be taken; brokered extension points (model providers, connectors, sandboxes, secret stores, object stores) can only be used through platform API, and taking one directly throws a plain `Error` (declaring it does not help and no audit is recorded). If the provider of a `requires` is missing, this extension does not load; if an `optional` is missing it loads as usual, and on use `list` is empty and `get` throws `ExtensionPointUnavailableError`. For a multi-select extension point, `get` must be given the provider name.

**`orgScoped` extension points and org variants**: an extension point registered as `orgScoped` (`channel`, `directory`; see the registry in `packages/plugin-sdk/src/extension-point.ts`) means that whether it is available depends on whether the org has enabled the provider extension. `identity-source` is not: login is deployment-level and is enabled by the kernel config `auth.loginSources`. When an org enables an extension, every `orgScoped` extension point it `requires` must have at least one enabled provider in that org (otherwise `extension.dependency_missing`); disabling is rejected if it would leave an enabled extension without its only provider (`extension.has_dependents`, can be forced). Without an `orgId` it is the deployment-level view, returns synchronously, and does not filter by org; with `{ orgId }` it is the async variant, returns a Promise and filters by that org's enablement state (queried each time, not cached):

```ts
// Deployment level (in setup): synchronous
const providers = ctx.extensionPoints.list<Directory>("directory@1");
// The view of one org (at the call site): async; when that org has not enabled the provider, get rejects with ExtensionPointUnavailableError
const dir = await ctx.extensionPoints.get<Directory>("directory@1", "lark", { orgId });
const enabled = await ctx.extensionPoints.list<Directory>("directory@1", { orgId });
```

**Call context principle**: what `setup(ctx)` receives is the **deployment-level** context, which cannot see any org, account or conversation. When the kernel calls an extension implementation it puts the context of this call into the call parameters, with contents decided by the extension point: tool execution carries the org, account, agent and conversation (`ToolCallContext`); a channel (`channel@1`) carries the `connectionId` and connection config of that channel connection (the org and account are resolved by the kernel from the connection and the speaker, and the extension cannot see them); a directory carries that org's org-level config; login (`identity-source`) carries the deployment-level config and the authentication request, without a session; a queue job has only what you wrote into the job data when enqueuing (usually with `orgId`; the kernel checks that the extension is enabled in that org). So **do not store org / conversation / identity in module variables or the ctx closure to pass between calls**; take them from the parameters of this call; conversation-related data that must be kept across calls goes into your own `ctx.db`.

**Static check (`pnpm check:extension-permissions`)**: scans the `ctx` parameter of `setup` in `defineExtension({...})` (including local aliases, and a ctx passed by position to functions **in the same file**, such as `mount(ctx)`), and compares `ctx.secrets`, `ctx.http.route(method, path)`, `ctx.tools.register({ name })`, `ctx.extensionPoints.get|list(ref)`, `ctx.ui.view|action(id)`, `ctx.storage` and `ctx.models` with the manifest; using anything undeclared fails. Route paths, tool names, extension point refs and UI ids must be written as string literals (or point to a const in the same file); a dynamic value reports "Cannot statically confirm"; for ones that are truly only known at runtime (and have been reviewed), write `// capybara:allow-dynamic-permission <reason>` at the end of that line or on the line immediately above; the reason cannot be empty; that comment only waives "cannot statically confirm", and undeclared literal access and `perm-reserved` cannot be waived. When ctx is passed to a function in another file the check cannot follow it (the runtime `ExtensionPermissionError` is the backstop), so put the code that uses platform API in the same file as `setup`.
**Approval**: the kernel records the approved permission snapshot in PG (the items above, plus provides / requires / optional, config fields and the table names of `CREATE TABLE` in migrations). An extension does not load when it first appears, or when after an upgrade it has any item more than the snapshot, and extensions that `requires` it do not load either; an enterprise admin approves in the admin console (`POST /api/v1/admin/extensions/:name/approve`, carrying the `sha256` and `reviewHash` from the time of review, snapshot source web, no restart needed: this replica loads it right away and other replicas converge through `kernel.plugins.changed`), or with `capybara extensions review` / `capybara extensions approve <name>` (covering config-declared extensions and install records; after the CLI writes PG it publishes `kernel.plugins.changed` through Redis, running replicas likewise load without restart, and when publishing fails they wait for the next cycle); when permissions shrink or stay the same it loads directly. Bootstrap plugins (`openai-compatible`, `object-store-s3`, pinned in `packages/kernel/bootstrap.json`) are approved by the bootstrap step itself (snapshot source `bootstrap`, audited `extension.permissions_approved` with `source: "bootstrap"`); after that they follow the same rules as any install record. Extensions that provide `sandbox@1`, `object-store@1`, `channel@1`, `directory@1` or `identity-source@1` are marked sensitive on the review page and in the CLI (display only). So **every extra item you ask for in a release makes the deployer stop and approve**; do not declare extra items casually. An extension older than the snapshot's version (an old replica restarted during a rolling upgrade, or a deliberate rollback) loads as usual as long as its permissions do not exceed the snapshot, but **the snapshot keeps the contents of the newer version and does not shrink**; after a rollback, items the old version has beyond the snapshot still need approval. For development and testing use the config option `extensionPermissions.autoApprove: true` (for the env var derivation rules see `.agents/skills/adding-config`; the dual-replica harness enables it by default): at startup it automatically approves the extra permissions of a new or upgraded extension, for development and trials only, do not enable it in production. Auto-approval also writes the snapshot (source auto) and logs a warn, but writes no audit.

Approval details:

- `capybara migrate` and the migrations at startup are likewise bound by the snapshot: an unapproved extension does not run its migrations (no tables are created). `capybara extensions review` connects to PG directly and first runs the kernel migrations.
- "One more item" is compared per entry: changing a route from `public` to non-public, or a config field from secret to ordinary, also counts as a new entry and needs approval again.
- Table names in migrations are obtained by parsing `CREATE TABLE`; `ALTER TABLE … RENAME`, views and so on do not enter the snapshot, so look at the SQL when reviewing.

**`setup` must return**: extensions run setup serially in dependency order. Extensions loaded from install records (packages installed from the admin console / CLI) are untrusted, and their setup is always limited to `extensionHost.reloadSetupTimeoutSeconds` (default 60 seconds, also at startup); a timeout is recorded as `failed` (`setup_failed`), the kernel starts as usual and retries on the next reconcile; their migrations are limited to `extensionHost.migrationTimeoutSeconds` (default 300 seconds; the migration session also sets `statement_timeout` / `lock_timeout`), and a timeout terminates the session, releases the migration lock and records `migration_failed`. Config-declared extensions are trusted and are **not time-limited** at startup: when setup never resolves (for example waiting for an external connection that never comes, or `await`ing a Promise nobody resolves), the kernel `start()` **hangs forever**, HTTP does not listen and later extensions do not load; in that case shutdown (`stop()`) still closes that extension's ctx immediately and releases connections. Whatever the source, when you need to wait for an external dependency to be ready, set a timeout yourself in setup and throw, or move the wait into a queue job.

**Revocation and reloading (no restart, C17)**: an extension instance can be revoked while the process is running (disabled, uninstalled, replaced by a new instance on upgrade, or the provider it `requires` / `optional`s got a new instance). The kernel keeps a ledger for each instance: every registration made through ctx (tools, routes, queue workers, bus subscriptions, leases taken with `ctx.lock`, UI views / actions, `provide`) is revoked item by item on revocation, so **the extension does not need to unsubscribe or release anything itself**. The revocation order: stop accepting new calls -> wait for in-flight tool calls and queue jobs to finish (at most `extensionHost.drainSeconds`, default 30 seconds; tool calls that have not finished are handed to the model as an English error result, queue jobs that have not finished are forced to stay in the queue and, once the lock expires, **run again** on the new instance; queue jobs are at-least-once anyway, so the handler must be idempotent) -> abort `ctx.signal` (calls and jobs that finish within the drain limit never see the abort) -> revoke every item on the ledger -> call the optional `dispose(ctx)` in the manifest (at most `extensionHost.disposeTimeoutSeconds`, default 10 seconds; on timeout the kernel logs and continues). So: long-running tasks you start yourself (polling, long connections) must listen to `ctx.signal` and wrap up; resources you build outside ctx (clients or connection pools you `new` yourself) are closed in `dispose`; do not register through ctx again inside `dispose`. On revocation or replacement, the `req.signal` of in-progress requests on extension routes (SSE and so on) is aborted; after that the extension's `/plugins/<name>/*` returns 503 `extension.unavailable` (404 only when the deployment has no such extension). When reloading while running, setup gets at most `extensionHost.reloadSetupTimeoutSeconds` (default 60 seconds), and on timeout the old instance is kept. The old version's module code stays in memory until the process restarts, so **module-level state is not reset**, which is yet another reason module-level state is banned. When setup throws, `dispose` is not called, and whatever was registered is revoked by the kernel.

- **Dependents are reloaded**: when an extension's instance is replaced (upgrade, reload), the extensions that `requires` / `optional`s an extension point it provides are reloaded on this replica too (a new setup, in dependency order); when a required extension point is gone (the provider was disabled / uninstalled / failed to load), the dependent is unloaded with it (replica status `unloaded`, reason `dependency`, shown in the admin console as `dependency`), and is reloaded automatically when the provider returns. So **do not cache another extension's extension point implementation in setup** across instances; the extension points the kernel itself consumes (models, connectors, sandboxes, storage) are looked up live from the registry on every call.
- When upgrades (switching to a new package) within the same process accumulate to more than 20, the kernel logs a warn, suggesting a restart of that replica to release the old code.

The `sdk` range is validated by the kernel against `SDK_VERSION` (equal to the package version of `@capybara-hq/plugin-sdk`, pinned by a test). In the 0.x stage `^0.1.0` only matches `0.1.x`: **when the SDK bumps minor (such as 0.2.0), the `sdk` range of every extension in the repository must be changed in sync**, otherwise the kernel refuses to load them.

## Two-level config

- **Deployment level** (`config.deployment`): operators supply it in the kernel config under `extensionConfig.<extension name>` (pass JSON through the env var `CAPYBARA_EXTENSION_CONFIG`, or field by field with `CAPYBARA_EXTENSION_CONFIG__<EXTENSION NAME UPPER-CASED, - AS _>__<FIELD>`, for example `CAPYBARA_EXTENSION_CONFIG__EXAMPLE_COUNTER__POOL_SIZE=3` corresponds to `poolSize` of `example-counter`). The value of a deployment-level field marked `secret` is automatically added to the log redaction set once it passes validation (nested arrays / objects are expanded to all the scalars in them; numbers are converted to strings before redaction, booleans are not redacted; values shorter than 4 characters are not redacted). Redaction is only a backstop, **do not deliberately write secrets into logs**. The kernel validates against the schema, and `ctx.config` is the validated value; its type is `unknown`, so `parse` it once with the same schema in `setup` to get the type.
  - **It can also be configured from the admin console (D8 / C10)**: values an enterprise admin fills in the admin console (`GET / PUT /api/v1/admin/extensions/<name>/config`; the `PUT` body is `{ values: { "<field dot path>": value | null } }`, `null` clears, omitted leaves unchanged) are stored in PG `extension_deployment_configs`, and `secret()` fields are each stored encrypted in `capybara.secrets` (namespace `kernel`, org `_deployment`, key `plugin-deployment-config:<plugin>:<dot path>`); the response only says "set", and the audit event `extension.deployment_config_updated` records only paths. Precedence: **env var > file / Nacos > PG > schema default**, merged per field; fields present in the startup config are read-only in the admin console and show their source (`env` / `file` / `nacos`), and a `PUT` to one returns 409 `extension.config_readonly`; if validation fails after merging it returns 400 `extension.config_invalid`, but **a problem in a read-only field itself does not block `PUT`** (the admin console cannot change it: the save goes through anyway, the extension stays pending configuration, and the startup config has to be changed). When the view's `validated` is false (this replica has not loaded that install record and only has the static manifest from the package), `valid` is not a validation result. Config-declared and install-record (including bootstrap) extensions are all the same.
  - **Invalid = pending configuration, not a startup failure**: when the deployment config lacks a required field or is invalid, the extension does not load (replica status `pending / config`, admin console `pending_config`) and the kernel starts as usual; once configured (saved in the admin console, or the startup config changed and restarted), the next reconcile loads it without a restart. Extensions that depend on an extension point it provides become pending with it (`dependency`) and load together when it loads.
  - **`hot` fields and reloading**: a field marked `.meta({ hot: true })` means the extension can accept the new value while running. After a save, each replica re-reads and validates over the bus (`kernel.plugin-deployment-config`): when only hot fields changed, the value is **replaced in place**: `ctx.config` is a getter, and **reading it at the point of use** (for example reading `(ctx.config as Cfg).timeoutMs` on each request) is what gets the new value, so do not copy hot fields into a closure in setup; when a non-hot field changed, the kernel **reloads the instance** (a new setup, new first then old, draining in-flight calls, see "Revocation and reloading" above); when the new value is invalid the current value is kept and a warning is logged. A lost message is backstopped by the periodic reconcile re-reading.
- **Org level** (`config.org`): each org's own enablement state and config, set by the org admin through the kernel API (`GET /api/v1/orgs/:orgId/extensions`, `PUT /api/v1/orgs/:orgId/extensions/:extension`); the kernel validates and stores it against that schema, with the rules in the next section.
- Secrets the extension produces itself while running (such as a token obtained from an OAuth exchange) go through `ctx.secrets` (encrypted storage); do not put them in ordinary config.
- **Channel connection config** (`connectionSchema` of `channel@1`) is a third kind: an org can create multiple channel connections, each with one config (bot credentials and so on), filled in by the org admin under "Channels" in the web app; secret fields likewise use `secret()`, are stored encrypted and only echo "set"; when calling `verify` / `connect` / `send` the kernel passes the validated value in as `config`.
- Which level to pick: what only the deployer can decide and is shared by the whole deployment (the client id / secret for login, platform addresses) goes at deployment level; what each org has of its own (directory credentials) goes at org level; what each bot has one of goes in the channel connection config. When credentials all come through config and are passed in by the kernel, the extension does not need `permissions.secrets` (the Slack and Lark extensions declare none).
- **When an extension point's fields in the org-level config are optional** (the same extension provides several extension points and an org uses only some of them), use the "is it configured" hook that extension point provides to tell the kernel, rather than returning an empty result at call time: for example when `Directory.configured(orgConfig)` returns false the kernel treats the directory as unconfigured and neither scans nor syncs it (see `.agents/skills/writing-channels` for details). It must be a pure function.

### Org-level config and the storage and echo of `secret()` fields

- Mark sensitive fields with `secret(schema)` (`import { secret } from "@capybara-hq/plugin-sdk"`). The kernel traverses `config.org` with `configFields`, and leaves whose `meta.secret` is true are recognized as secret fields by dot path (such as `webhook.token`). Marking an object `secret` applies to all its descendant leaves.
- **Only object paths are supported**: `secret()` can only be placed on nodes reachable from the root through object fields (and the `default` / `prefault` / `optional` / `nullable` / `readonly` / `catch` wrappers). A `secret()` placed inside a union / discriminatedUnion / intersection / transform / pipe / lazy / array element / record value / tuple and the like (both `config.org` and `config.deployment` count) makes the **extension fail to load**, with the error naming the extension and the path (such as `plugin x: config.org: secret() at "auth<union#1>.token" ...`). When needed, mark the whole enclosing object field (or the whole array field) `secret`, and its value is stored encrypted as a whole.
- Storage: the non-secret part (the validated value, including defaults) is stored in `capybara.extension_org_configs.config`; each secret field is stored encrypted separately in `capybara.secrets` (namespace `kernel`, key `plugin-config:<plugin name>:<dot path>`, value JSON-encoded), written in the same transaction as the config row. `kernel` is therefore a reserved extension name.
- Echo: the `config` in API responses never contains secret fields and only gives `secrets: [{ path, set }]` to say whether each is set; the audit records only `{ enabled, changedPaths }`.
- Update (`config` of `PUT`): non-secret fields are replaced as a whole by the passed value; for secret fields **omitted = keep the old value**, `null` = clear, any other value = the new value. The merged full object is validated again against the schema, and on failure it returns `extension.config_invalid` with `details` as `{ path, message }[]` (values are not echoed). Passing only `enabled: true` also validates the existing config, and one that does not satisfy the schema cannot be enabled.
- Redaction: the secret values of org-level config are added by that replica to a separate bounded redaction set (at most 10000, evicting the oldest when full) on write (`PUT`, after the transaction commits) and on decrypted read; the source is the org admin, so only values of length >= 12 are registered, and they are redacted only in log fields and the log message is left alone, to keep one tenant from masking another tenant's logs.
- Read: the kernel's `orgExtensionConfigs.get(orgId, extension)` decrypts and validates and then returns the full config. **When upgrading an extension, changes to the org schema must be compatible with old values** (give new fields a default or make them optional): when the stored config no longer satisfies the new schema, `get` throws directly, and the org admin has to save the config again.

## When to use each ctx item

| Item | Purpose | Notes |
|---|---|---|
| `ctx.kv` | **Temporary, expiring** state: rate-limit counters, short caches, idempotency keys | `set` / `incr` must carry `{ ttlSeconds }`; `incr` adds only 1 each time, there is no `incrBy`. **Do not put durable data (business counters, accounting) in kv**: it is gone when the TTL is up, and dual-writing with db cannot guarantee consistency |
| `ctx.db` | Durable data | Kysely, already switched to this extension's schema; write table names **without** a schema prefix; tables are created by `migrations/`, see `.agents/skills/writing-migrations`. **Note**: raw SQL `` sql`...`.execute(ctx.db) `` does not go through `withSchema` and lands on the connection's default search_path (`public`): either use the query builder, or write the full `plugin_<name>.<table>` in the SQL |
| `ctx.queue` | Delayed / asynchronous / periodic jobs | `define(name, handler)` is registered in `setup`; `add(name, data, { delayMs, jobId })`; a job may run on any replica, and delivery is **at-least-once** (retried on failure, at most 3 times), so the handler must be idempotent (see below); names and jobId contain no `:` |
| `ctx.lock` | Mutual exclusion | `acquire(key, { ttlMs })` returns a lease or `null`; long jobs must `renew()`, and `release()` when done |
| `ctx.bus` | Cross-replica broadcast | `publish` / `subscribe`, a subscription returns a cancel function; messages can be lost, so do not treat them as the only end signal |
| `ctx.http.route` | External interface | Actually mounted at `/plugins/<name><path>`; matching and body semantics in the next section, bypasses kernel authentication |
| `ctx.provide` | Expose an extension point implementation | Must match the manifest `provides` |
| `ctx.tools` | Provide tools to agents | `register(spec, handler)` can only be called in `setup`; the model-visible name is `<extension name>__<spec.name>`; **only available in orgs that enabled this extension** (the org admin `PUT /api/v1/orgs/:orgId/extensions/<name> {"enabled": true}`); when not enabled the runtime treats it as an unavailable tool. For the rules on descriptions and error text, default policy, `ToolError` and `InputRequired` see `.agents/skills/writing-tools`, reference `plugins/todo` |
| `ctx.ui` | Right-panel tabs on the conversation page / org pages under "Extensions" in the top bar | `view` / `action` (render schema views; can only be registered in `setup`; `render` and `action` must respond to `signal` and have a 5-second timeout), `invalidate` (refreshes across replicas through the bus), `verifyEmbedToken` (the data routes of an embed verify the token first). For how to write them, the building blocks, the limits and the security rules of embeds see `.agents/skills/writing-extension-ui`, reference `plugins/todo`, `plugins/example-board` |
| `ctx.storage` | Files, large objects (isolated per org) | Needs the manifest `permissions.storage` (`perm-storage`); the first parameter of every method is `orgId`, and keys land under `plugins/<plugin name>/<orgId>/`, invisible to other extensions and the kernel (`kernel/<orgId>/`) and vice versa. Use `presignPut` for browser uploads (returns `{ method, url, headers, fields? }`; send a PUT or a POST form according to `method`) and `presignGet` for downloads (user-uploaded content uses `inline` only for images / PDF); after an org is deleted its objects are cleaned up periodically by the kernel. When there is no store provider the extension does not load. For writing store providers see `.agents/skills/writing-object-store-providers` |
| `ctx.secrets` | Store and fetch secrets per org | Stored encrypted |
| `ctx.config` / `ctx.log` | Deployment config / logs | `ctx.config` is a getter, so read hot fields at the point of use; do not print secrets in logs |

### Connectors (`connector@1`)

`provides: [CONNECTOR_EXTENSION_POINT]`, and in `setup` `ctx.provide(CONNECTOR_EXTENSION_POINT, connector)` connects a kind of remote service as a "connector" in an org (the tool snapshot, credentials and approval are all managed by the kernel). Connectors are deployment-level and do not need to be enabled per org. Key points: open a session per use and close it when done, do not cache connections; call `auth()` before every outbound request; on 401, retry once after `onUnauthorized()`; do not follow redirects; do not write credentials into errors or logs. For details see `.agents/skills/writing-connectors`, reference `plugins/connector-mcp`, `plugins/connector-openapi`.

### Sandboxes and object storage (`sandbox@1` / `object-store@1`)

Both are single-select, brokered extension points: a deployment installs only one provider, other extensions cannot `requires` them, and they are consumed by the kernel (sandboxes through `SandboxService` and the builtin `sandbox_*` tools, storage through `ctx.storage` and kernel features). A provider only implements the primitives; the lifecycle, locks, prefix isolation and cleanup are all in the kernel. For details see `.agents/skills/writing-sandbox-providers` (reference `plugins/sandbox-docker`, `plugins/sandbox-e2b`) and `.agents/skills/writing-object-store-providers` (reference `plugins/object-store-s3`).

### Channels, login, directory (`channel@1` / `identity-source@1` / `directory@1`)

The extension for an IM platform usually provides all three: in `setup`, `ctx.provide(CHANNEL_EXTENSION_POINT, …)`, `ctx.provide(IDENTITY_SOURCE_EXTENSION_POINT, …)` and `ctx.provide(DIRECTORY_EXTENSION_POINT, …)` respectively. Channels and directories are only available after an org enables the extension, and login is enabled through the kernel config `auth.loginSources`. Long connections (including multi-replica leader election), inbound dedup and durable queueing, outbound redelivery and authorization of card actions are all done by the kernel; the extension only handles protocol conversion. Key points: the identity key `<plugin name>:<tenant id>` + platform user id must be consistent in all three places; only acknowledge to the platform after `onEvent` resolves; escape model text to prevent @everyone; a directory that cannot be listed completely must throw. For details see `.agents/skills/writing-channels`, reference `plugins/slack`, `plugins/lark`.

### Extension route matching semantics (`ctx.http.route`)

The signature is fixed: `ctx.http.route(method, path, (req: Request) => Promise<Response>)`; extensions **do not depend on Nest** and write no controllers. The kernel takes `/plugins/*` in a separate encapsulated scope of Fastify and converts it to a Web `Request` for you:

- **Path syntax is the same as Fastify** (find-my-way): `path` is relative to the extension prefix, for example `route("GET", "/items/:id", …)` matches `/plugins/<name>/items/42`; the wildcard `*` is also supported. Matching looks only at the path, not the query string.
- **The handler only receives a Web `Request` and gets no parsed path parameters**: take them yourself from `new URL(req.url).pathname` (the query string via `new URL(req.url).searchParams`).
- **The body is raw bytes**: no JSON / form parsing is done in the scope, any content-type is passed on as is, and you parse with `await req.text()` / `req.json()` / `req.arrayBuffer()` yourself (webhook signature verification can use the raw bytes directly). GET / HEAD carry no body.
- **The request body limit is 1 MiB** (the Fastify default bodyLimit); beyond it the response is 413 `payload_too_large` directly (the kernel error envelope) and the handler is never reached. Other 4xx produced by Fastify itself in the scope are likewise mapped by the kernel's general error code table (such as 415 `unsupported_media_type`, 400 `validation_failed`).
- **HEAD is treated as GET**: when there is no dedicated HEAD route, a HEAD request is handed to the GET handler of the same path (`req.method` is still `"HEAD"`), and the response returns only status and headers, with no body.
- A request that cannot be converted to a Web `Request` (such as a malformed `Host` header) -> 400 `validation_failed`, and the handler is never reached.
- Sensitive to trailing slashes: `/count` and `/count/` are two routes.
- Unmatched -> 404 `not_found`; the handler throws -> 500 `internal` (the error is logged, with the path in the log redacted: path segments starting with `cap_` are replaced by `:redacted`; it is not echoed to the client).
- **Extension routes bypass kernel authentication**: there is no AuthGuard, no CSRF header check, and no caller identity available (not provided yet; the manifest's `public` is currently only a declaration, Ruling A2). A webhook exposed externally must verify signatures itself.
- **The kernel session cookies are stripped**: before forwarding, `cap_at` / `cap_rt` are removed from the `Cookie` header (other cookies are kept as they are; when only these two exist, no `Cookie` header is sent), so the extension cannot get the user's kernel session.
- The response's status and headers (including multiple `set-cookie`) are returned to the client as they are, and the body supports streaming.
- `req.signal` aborts only when the client disconnects before the response has been fully written (it does not abort on a normal finish): a long-connection (SSE) handler uses it to unsubscribe and wrap up.
- **On shutdown the kernel aborts all in-progress extension requests** (`req.signal` aborts all together, and requests arriving afterwards are aborted from the start): a handler must either end quickly or tolerate abort (end the stream and abandon unfinished work on receiving abort; put whatever must be finished into a queue). A long connection that does not respond to the signal occupies the http shutdown budget and is forcibly disconnected when it runs out.
- The routes of embeds live under `/ui/`, and the web app accesses them through the same-origin proxy `/plugin-ui/<plugin>/...`; the proxy only forwards the embed token and rewrites response headers and caching, see `.agents/skills/writing-extension-ui`.

### UI (views and embeds)

An extension adding UI to the web app (right-panel tabs on the conversation page, org pages under "Extensions" in the top bar) has two tiers: schema-rendered views (`ctx.ui.view`, reference `plugins/todo`) and embeds in a sandboxed iframe (routes under the extension's `/ui/` + `ctx.ui.verifyEmbedToken`, reference `plugins/example-board`). The manifest, approval rules, building blocks and limits, embed tokens, the `/plugin-ui` proxy, the message bridge and how to write tests are all in `.agents/skills/writing-extension-ui`.

### Hooks (`ctx.hooks`)

`ctx.hooks.on(mount, handler, { mode })`, only during `setup`, on mount points declared in
`permissions.hooks` (and, for `mode: "policy"`, in `permissions.policyHooks`). Hooks observe or deny;
they never rewrite a request or a result. They fire only for organizations that enabled the extension,
only in chat conversations, never in eval replays (the one exception is `usage.report`, below).
Payloads are deep-frozen copies.

- **Registration.** The five mount points are `model.request`, `model.response`, `tool.preExecute`,
  `tool.postExecute` and `usage.report` (`HOOKS_AVAILABLE`); `session.*` and `agent.preStep` still
  validate in a manifest but cannot be registered. `ctx.hooks.on` throws when called after `setup`,
  for a mount point that is not available, with a handler that is not a function, without a `mode`
  of `"observe"` or `"policy"`, or with `mode: "policy"` on a mount outside `model.request` /
  `tool.preExecute`. A mount missing from `permissions.hooks`, or a policy hook missing from
  `permissions.policyHooks`, throws `ExtensionPermissionError`; `check:extension-permissions` reports both
  as `perm-hooks`. Hooks are sensitive at review (they see conversation content).
- **Order.** Policy hooks of several extensions run serially by extension name (registration order within a
  extension); the first deny, error or timeout stops the chain. `hooks.timeoutMs` (hot) limits every
  hook call, including each `usage.report` call.

- **Policy hooks** (`model.request`, `tool.preExecute`) run serially by extension name before the call;
  `{ deny: reason }`, an error or a timeout (`hooks.timeoutMs`) blocks it. The model sees your reason
  (sanitized, at most 500 characters) or a generic sentence for an error or a timeout; the raw error
  goes only to the `hook.denied` audit row.
- **Policy hooks fail closed.** While your extension is enabled and approved, and its approved snapshot
  lists a mount in `permissions.policyHooks`, a replica where it is not loaded (setup failed, pending
  configuration, import failed, unloaded for a dependency) denies every call on that mount for
  organizations that enabled it, with the generic reason `The <plugin> policy check is unavailable`.
  The `hook.denied` audit row has `notLoaded: true`, and the replica logs a throttled warning naming
  the extension; fix it from the extension's status in the admin console. Observe hooks of an extension that
  is not loaded are simply skipped. So declare `policyHooks` exactly for the mounts you register
  policy hooks on.
- **Observe hooks** are fire-and-forget (the call never waits), capped at 64 in flight per extension and
  replica (extra calls are dropped), and also run for denied calls. Their verdicts, errors and
  timeouts are ignored (throttled warnings).
- **Denials are logged.** A denial writes a `hook.denied` audit row (with the raw error for an error
  or timeout) and, on a tool call or a model step, a `hook_denied` event in the conversation log; it
  is sticky: a resumed or retried step or call is denied again without rerunning the hooks. An abort
  (the user stopped the run) is never a denial.
- **`model.request`** fires once per attempt of a step (`purpose: "step"`) and once per compaction
  call (`purpose: "compaction"`, `attempt` 1): compaction sends earlier history to the same provider,
  so DLP and budget policies see it too. A denied compaction only skips compaction (the step's own
  request then meets your hook). The payload's request carries **no media bytes and no attachment
  ids**: every image or document block is a placeholder
  `{ type: "media_omitted", kind, mediaType, size }`.
- **`model.response`** fires after a sent call finished or failed (step attempts and compaction
  calls). It does **not** fire for a call the user aborted mid-stream, nor for a call that was never
  sent (denied, or failed before sending); pair it with `model.request` accordingly.
- **`usage.report`** gets every logged `usage` event at least once (retries on any replica), so the
  handler must be idempotent by `eventId`; `purpose` tells a step call from a compaction call (both
  are billed). Targets come from deployment state and organization enablement. An extension that is
  loaded but registered no `usage.report` handler is dropped as a target, and a target still
  undelivered on the last attempt is dropped only when it is definitely unservable (replicas report
  it, none has it loaded or still serves an older version). A drop is never silent: the job ends
  failed (kept, capped) with the dropped extensions in its failedReason, plus a throttled warning,
  even when the drop happened on an earlier attempt; its `pending` then lists only the dropped
  extensions, so a manual retry of the job reaches them and never the extensions already served.
  Declare `usage.report` only when you always register the handler.
- **`tool.preExecute`** runs after the tool policy and approval and before `tool_call_started`; a
  denial becomes the call's `tool_result` (text `Tool call blocked by the "<plugin>" policy hook:
  ...`). **`tool.postExecute`** gets the result as the model sees it (after output spilling), and is
  observe-only.
- **`usage.report` also covers full-run eval replays** (`conversationKind: "eval"`); single-step
  replays and judge calls are not reported, and no other hook fires in a replay.
- Hooks live on the extension instance: an upgrade or disable drains in-flight hook calls like tool
  calls, and a policy hook whose instance was revoked mid-call reruns once on the extension's new
  generation instead of failing the call.


### Durable counters and idempotency (reference example-counter)

- Durable counters go in `ctx.db`, and multi-step changes within one request are wrapped in one transaction: `ctx.db.transaction().execute(async (trx) => { ... })`. An atomic counter that needs "add N at once" uses SQL (`n = n + N`); do not loop `kv.incr`.
- A reasonable use of kv (with TTL):

  ```ts
  await ctx.kv.set(`seen:${eventId}`, "1", { ttlSeconds: 600 }); // short-lived idempotency key / rate limit / short cache
  ```

- Idempotent queue handlers: generate a `jobId` when enqueuing (`crypto.randomUUID()`, no `:`) and put it in both the data and `opts.jobId`; give `job_id` a unique constraint on the table; the handler does `INSERT ... ON CONFLICT (job_id) DO NOTHING RETURNING id` in one transaction, and **only performs the business side effects if the row was really inserted**, so a duplicate delivery does nothing.

Any lasting side effect that "ends by relying on some signal" must have a maximum lifetime (TTL) and end itself when it is up.

## Test template (dual-replica)

Use `createDualReplicaHarness` from `@capybara-hq/testing`: two **independent child-process** replicas, with requests strictly alternating (the 1st, 3rd, 5th… go to replica 0). Anything that puts state in process memory is bound to fail here.

```ts
import { fileURLToPath } from "node:url";
import { createDualReplicaHarness, type Harness, startTestPostgres } from "@capybara-hq/testing";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";

const PLUGIN = fileURLToPath(new URL("../src/index.ts", import.meta.url));
let pgc: Awaited<ReturnType<typeof startTestPostgres>>;
const harnesses: Harness[] = [];

beforeAll(async () => { pgc = await startTestPostgres(); });
afterEach(async () => { await Promise.all(harnesses.splice(0).map((h) => h.stop())); });
afterAll(async () => { await pgc?.stop(); });

it("alternating requests to the two replicas give a consistent result", async () => {
  const h = await createDualReplicaHarness({
    extensions: [PLUGIN],
    pgUrl: pgc.url,
    extensionConfig: { "my-plugin": { step: 2 } }, // optional: deployment-level config
  });
  harnesses.push(h);
  for (let i = 0; i < 5; i++) await h.request("/plugins/my-plugin/inc", { method: "POST" });
  const r = await h.request("/plugins/my-plugin/count");
  expect(((await r.json()) as { count: number }).count).toBe(10);
});
```

Key points: the return value of `h.request` carries `replica` (0 / 1, taken from the response header `x-capybara-replica`; the harness sets `http.replicaId` on each replica); when you `fetch` a specific replica directly by `h.replicas[i].port`, use `replicaOf(res)` to confirm where it landed (such as an SSE long connection). `h.kill(i)` sends SIGKILL to replica i to simulate a hard crash (afterwards requests sent to it through `h.request` throw), used to test "the other replica takes over". The `config` option deep-merges extra kernel config into both replicas (such as `config: { auth: { cookieSecure: false } }`, passed over IPC); each harness comes with its own Redis container, and `stop()` when done; passing `pgUrl` (an admin connection string) lets several harnesses reuse the same PG container; queue jobs run asynchronously, so when asserting, poll until the expected value arrives, do not just `sleep` a fixed time; test files go in the extension root's `test/` directory (`pnpm test` collects them). **When running a single test, run it from the repository root** with `pnpm exec vitest run plugins/<name>/test/<file>`, and do not use `pnpm --filter <package> exec vitest`: the root config provides the `@capybara-hq/source` condition, which dual-replica tests need to load the extension from source (`src/index.ts`) and to resolve the relative `.js` paths it imports; otherwise the child-process replicas fail to load.

**Through a real kernel** (sign-in, orgs, agents, conversations driven by model-fake): `@capybara-hq/testing` also has `startTestKernel(testKernelConfig(urls, { extensions }), { resolveFrom })` for one in-process kernel (`k.http.inject`), `createLocalAccount`, `login`, `joinOrg`, `createOrg` / `createAgent` / `createConversation` / `postMessage`, `eventsOf` / `waitForEvent` / `waitForTerminal` / `waitFor`, `cardRecorded`, `truncateTables`, `openSse`, `pidOwningLocalPort`, `createDb` + `kernelDb` (the kernel's tables, typed) and kernel texts to assert on (`UNKNOWN_RESULT_TEXT`, the sandbox notices, queue names). Load model-fake by package name (`"@capybara-hq/plugin-model-fake"`, a devDependency of the plugin) with `resolveFrom` set to the plugin directory; `model-fake`'s `tool:<key>:<json>` message makes the model call a tool. A plugin test imports only the SDK, `@capybara-hq/testing`, model-fake and the plugin's own files (`pnpm check`, rule `plugin-test-imports`); examples: `plugins/todo/test/kernel.http.test.ts`, `plugins/example-board/test/board-events.dual.test.ts`, `plugins/slack/test/kernel/`.

Shared test containers: the root vitest config's node project has a `globalSetup`
(`@capybara-hq/testing/global-setup`) that starts one PostgreSQL 17 and one Valkey per run. There
`startTestPostgres()` returns a fresh random database on the shared server (`stop()` drops it), and a
harness without `pgUrl` also uses it. Redis stays one container per caller by default, because bus
channels ignore the database number; pass `startTestRedis({ shared: true })` (a logical database of the
shared Valkey, `stop()` = `FLUSHDB`) only in files where nothing subscribes to the bus (no kernel, no
extension host loading subscribing extensions). Never query cluster-wide views (`pg_stat_activity`,
`pg_locks`) without filtering to `current_database()`. `CAPYBARA_TEST_NO_SHARED=1` restores per-file
containers for debugging. Under the globalSetup at most 4 containers start at once across the run
(`CAPYBARA_TEST_CONTAINER_STARTS` changes it; slots live in the shared Valkey): unthrottled, a full run
overloads Docker Desktop and testcontainers' fixed 30 s port-bind wait times out.


## Extension packages (npm-pack tgz)

Extensions live outside the core image and are installed as plugin packages (C11): an npm-pack tgz whose `.capybara-plugin/plugin.json` carries an `extension` section (layout and manifest fields: `.agents/skills/writing-plugins`). The plugin directory **must have a source `.capybara-plugin/plugin.json`** (`schemaVersion`, `name` equal to the extension name, `version`, `publisher`, `description`, …; without `extension`, which the packer writes); packing fails without it. `pnpm pack-plugin plugins/<name> [--out <dir>]` packs one, and `pnpm pack-plugins` packs all of them (default output `artifacts/plugins/`, uploaded by CI as a build artifact); the "plugin packing" step in `pnpm check` (`check:plugin-pack`) requires every official plugin to pack and pass the kernel readers (`readPluginPackage`, `readExtensionPackage`). A tgz in the pre-0.1.0 format (a `capybara` section in `package.json`) is refused with `extension.legacy_format`; a plugin without an extension cannot be installed on the deployment (`extension.no_extension`: import it into the catalog instead). When writing an extension, note:

- esbuild bundles `src/index.ts` into a single-file ESM `dist/index.mjs`, with all third-party dependencies bundled in; only `@capybara-hq/plugin-sdk` and `zod` (including subpaths) are provided by the host, and Node built-in modules are always rewritten to `node:*`. A dependency that cannot be bundled in (not installed, a native module `*.node`) is a packing failure.
- **Dynamic `import()` only allows literals**; `import(variable)` is rejected by both packing and installation.
- The manifest `version` must equal the `package.json` `version` and the `plugin.json` `version`, and the manifest `name` equals the plugin name; when `migrations` is declared it must resolve to the plugin root's `migrations/` (such as `"../migrations"`), and is recorded as `extension.migrations: "./migrations"`; when the plugin root has `ui/` it is carried as is (`extension.ui: "./ui"`). The entry is `extension.entry: "./dist/index.mjs"`, and the generated `package.json` has `peerDependencies` equal to the manifest's `sdk` range (which needs an upper bound) and no `capybara` section.
- `extension.manifest` in `plugin.json` is the result of `staticManifestOf(manifest)`: review looks only at it and the migration SQL and does not execute extension code; at load time it is checked again against the real module, and a mismatch is `manifest_mismatch`. So the manifest (permissions, the secret / hot of config fields) cannot depend on the runtime environment.
- The package also carries `README.md`, `LICENSE` (the extension's own, else the repository's), the `NOTICE` next to that `LICENSE` if there is one, every plain root file listed in `package.json` `files` (e.g. slack's `app-manifest.yaml`), and `THIRD-PARTY-NOTICES.txt` with the license notices of the bundled npm dependencies. Other `files` entries (directories, globs) are not shipped: `check:plugin-pack` reports them (`plugin-pack-dropped`). The generated `package.json` passes `description` / `repository` / `homepage` / `keywords` through (npm provenance needs `repository.directory`).
- **Publishing to npm**: the release workflow (maintainers, `docs/deploy/release.md`) publishes every `plugins/*` package except `example-*` as the packed tgz, with npm provenance. For that the extension's `package.json` needs a `repository` field with `url` `git+https://github.com/capybara-hq/core.git` and `directory: "plugins/<name>"` (provenance rejects a mismatch), plus `description`, `license` and an https `homepage` (`check:release-metadata` enforces all of this), and a `version` equal to the manifest's. A new official extension is picked up automatically; a version bump goes through a changeset.
- The generated package carries no install scripts, `dependencies` or `node_modules/`; at install time the kernel rejects these (and path escapes, links, oversize packages) according to the rules of `readExtensionPackage`.

**Install, enable, disable, upgrade, uninstall (no restart, C16 / C18)**: a package is first imported into package storage (admin console upload / npm, or `capybara extensions install <file.tgz | npm:<name>[@<version>]>`; packages imported by the CLI are always stored in PG), and then an install record points to it (`POST /api/v1/admin/extensions/:name/install {sha256}`; a new install is disabled); `…/enable`, `…/disable` and `DELETE …/:name` (must be disabled first) change the desired state; the CLI equivalents are `capybara extensions list | enable | disable | uninstall <name>`. The admin console and CLI **only write the desired state in PG** and publish `kernel.plugins.changed`, and each replica converges by reconcile (the maintenance job `plugins-reconcile` publishes `kernel.plugins.reconcile` every `extensionHost.reconcileIntervalSeconds` seconds as a backstop, so it converges even if a message is lost). The load state is each replica's own (`extension_replica_status`; replicas whose heartbeat is older than 3 reconcile cycles are not counted), and the admin console summarizes it as `enabled` / `converging` / `pending_approval` / `pending_config` / `pending_migration` / `dependency` / `failed` and so on.

CLI (connects to PG directly, and after writing publishes `kernel.plugins.changed` through Redis, so running replicas take effect without a restart; a failed publish only warns, and waits for the next reconcile cycle):

| Command | Effect |
|---|---|
| `capybara extensions list` | The extensions on the deployment and their state |
| `capybara extensions install <file.tgz \| npm:<name>[@<version>]> [--yes]` | Stores the package in the PG package storage, shows the permission review, then installs or switches to that version (a new install is disabled) |
| `capybara extensions enable \| disable \| uninstall <name>` | Changes the desired state; uninstalling requires disabling first, and data is kept |
| `capybara extensions review` / `approve <name> [--yes]` | Extensions awaiting approval and their new permissions / approve (covers install records, bootstrap plugins included, and config-declared extensions) |
| `capybara bootstrap [--dir <path>] [--manifest <path>]` | The bootstrap step (see "Bootstrap plugins" below); run by compose's `init` after `migrate` |

What to know when writing an extension:

- When switching versions, **the new version is loaded first and the old version is revoked after** (the old instance drains in-flight calls in the background); if the new version fails to load on some replica (`sync_failed` / `sha_mismatch` / `import_failed` / `manifest_mismatch` / `setup_failed` / `migration_failed`), that replica keeps running the old version, records the state `failed`, and retries every cycle afterwards. When the new version's permissions exceed the snapshot it awaits approval, and the old version runs as usual.
- **Migrations are expand-only** (add tables, columns, indexes; deletes and changes take two steps, see `.agents/skills/writing-migrations`): old and new versions run at the same time on different replicas. When uploading / importing a package, destructive statements in migrations (drop table / drop column, TRUNCATE, DELETE, RENAME, change column type, `destructive_migration`), `DO` blocks whose content is not statically checked (`dynamic_sql`) and statements that write outside the extension's own schema / change permission roles / create function triggers / control transactions (`foreign_schema`) are listed one by one as sensitive warnings in the review result's `warnings` (not rejected), and the deployer sees them; when the warnings change, re-approval is needed (see "Trust model"); do not use `DO` blocks, and touch only the `plugin_<name>` schema. A migration is run once by the first replica to take the advisory lock (`ensureMigrated`), and other replicas do not switch before it finishes (`pending_migration`). The migrations directory is taken only from the `extension.migrations` reviewed in the package.
- **Downgrade** can only go back to a version whose "migration files have all been run (same file names and contents)", otherwise 409 `extension.downgrade_unsupported`.
- Disabling / uninstalling does not delete data: the extension schema, secrets, org config and permission snapshot are all kept and used again after reinstalling. When an extension is disabled on the deployment, the enablement switches in orgs are unchanged, and the org page shows "unavailable".
- Package storage: when there is an object store, packages go in `deployment/plugins/blobs/<sha256>.tgz` (`extension_packages.blob_store = object`), otherwise (and for packages imported by the CLI) in PG `extension_blobs`. **If you change the object store's bucket (or endpoint) without migrating the objects**, packages with `blob_store = object` can no longer be fetched: sync fails when the local extension directory has been emptied or a new replica starts (`sync_failed`). Before changing the bucket, move the objects under the `deployment/` prefix along with it; or upload those packages again. The same goes for the files of catalog entries (`deployment/directory/…`).
- Packages stored before the 0.1.0 plugin format (a `capybara` section in `package.json`) are not read: the admin console shows such an extension as `legacy_format` ("Repack needed"), every replica records it `failed` (`sync_failed`, with the legacy message) and approving returns 422 `extension.legacy_format`; reinstall it from a tgz repacked with `pnpm pack-plugin`. Config-declared extensions load from module paths and are unaffected.
- The two sources of an extension (`packages/kernel/src/extensions/sources.ts`): `config` (the startup config `extensions` list: development mode and existing deployments, read-only in the admin console, changing the list needs a restart; when the name clashes with an install record the install endpoint returns 409 `extension.config_declared`, and at startup the config wins with a warning) and `install` (PG install records, including the bootstrap plugins: install source `bootstrap`, see below). On a name clash config > install. Development mode still loads straight from the workspace `plugins/*` as before (`config`). There is no `builtin` source any more: `KernelOptions.builtinExtensions` was removed in phase A2 and the CLI no longer depends on any plugin package.
- **Bootstrap plugins** (package ecosystem spec §7; `packages/kernel/src/extensions/bootstrap.ts`): `packages/kernel/bootstrap.json` (schema `packages/plugin-sdk/schemas/bootstrap.v1.schema.json`, parser `parseBootstrapManifest` in the SDK) pins the plugins every deployment installs, each by exact version and sha512. Until phase A3 publishes the official plugins every entry is `"source": "workspace"` (`plugins/<name>`, packed byte-reproducibly by `packages/plugin-tools`); A3 switches them to `"source": "npm"`. The kernel image bakes the packs into `/app/bootstrap/<name>-<version>.tgz` (`pnpm pack-bootstrap`, a stale pin fails the build), and `capybara bootstrap` (compose's `init`; or `capybara start`, which runs it when `/app/bootstrap` or `--bootstrap-dir` exists and it is not done) installs them without touching the network:
  - every file is checked against its sha512 before anything is written (`bootstrap.missing_file` / `bootstrap.integrity_mismatch`, naming the plugin); the run holds the PG advisory lock `capybara.bootstrap`, so replicas starting together run it once; "done" is a `bootstrap_runs` row for the manifest's sha256 (written with the audit `bootstrap.completed` only when every entry succeeded);
  - an entry not installed is imported into the catalog (source `bootstrap`, ref `bootstrap:<name>@<version>`), installed, approved and enabled; one installed from `bootstrap` at a lower version is upgraded (new permissions pre-approved and audited) keeping the desired state the admin chose; one at a higher version, from another source or declared in the config `extensions` list is left alone (never downgraded); a declarative entry is only imported into the catalog; only entries new to the manifest are installed, so an optional plugin an enterprise admin uninstalled stays uninstalled; an entry removed from the manifest is not uninstalled, it only loses `required`;
  - `"required": true` (both current entries): `extension_installs.required`; enabled in every org, existing and future, without org config rows (`enabledExtensionsQuery` in `extensions/enabled.ts` is the one query every reader uses), and disabling it at org or deployment level or uninstalling it returns 409 `extension.required`; its org config can still be set and an enterprise admin can still upgrade it. `required: false` plugins are managed like any other install.
  - Any entry that still fails (after a second pass, once the first one installed the object store a declarative entry needs) makes `capybara bootstrap` exit 1, so compose's `init` fails and nothing is recorded as done; in `capybara start` a failed required entry keeps the kernel from listening, while a failed optional one is logged and retried on the next start.
  - When a pinned plugin or one of its dependencies changes (its code, the lockfile, `packages/plugin-tools`), the pin goes stale: `pnpm check:bootstrap` (part of `pnpm check`) fails, and `pnpm check:bootstrap --write` rewrites the version and integrity.
- **An extension name belongs to its npm package**: an extension name belongs to the npm package that first installed it (the `name` in `package.json`, recorded in `extension_name_owners`; a package that was only uploaded and not installed does not take the name), and an extension of the same name can only come from that package. The same holds after uninstalling (uninstalling does not delete the ownership): data, secrets, approval snapshot and org enablement are all still there, and another npm package installing with the same extension name is rejected (409 `extension.name_conflict`, noting which package used the name before), to keep a different publisher from taking over this data; the original package can be reinstalled. So **changing the npm package name amounts to changing the extension**, and the extension name must change too.
  - Config-declared extensions also take names: at kernel startup the ownership is written by the `name` in the nearest `package.json` of the directory the module is in (an existing one is left alone; when the existing ownership is another package a warn is logged). If they are later removed from the config list, another package cannot install an extension of the same name either.
  - When a name **has no ownership but data is left behind** (a permission snapshot, a deployment config, any org's config, or the `plugin_<name>` schema; for example an extension that predates the ownership table), installing likewise returns `extension.name_conflict`: it is not known which package this data belongs to.
  - Manual remediation (when the operator has confirmed that the data really should go to the new package, or is really not wanted): either change the extension name; or delete the leftover data: the extension's rows in `extension_permission_snapshots`, `extension_deployment_configs` and `extension_org_configs`, secrets such as `plugin-deployment-config:<name>:*` in `capybara.secrets`, and `DROP SCHEMA plugin_<name> CASCADE`; or, after confirming the handover, insert (or change) a row directly in `extension_name_owners` to give the name to the new package.
- Provider calls consumed by the kernel (from `open` to session `close` for `connector@1`, `sandbox@1`, and every call and stream of `model-provider@*`) count toward the instance's in-flight count just like extension tools: on disable / upgrade they are drained first and aborted at the time limit (the `AbortSignal` in the parameters is aborted). A provider implementation must honor the signal passed in.

## New extension checklist

1. Copy `plugins/example-counter`, and change the package name `@capybara-hq/plugin-<name>`, `name` (in the manifest and in `.capybara-plugin/plugin.json`) and the PG tables.
2. Add an entry to `references` in the root `tsconfig.json`.
3. Write migrations per `.agents/skills/writing-migrations`.
4. `pnpm lint && pnpm typecheck && pnpm check && pnpm test`.
5. Changes that affect a release get a changeset (`pnpm changeset`).
