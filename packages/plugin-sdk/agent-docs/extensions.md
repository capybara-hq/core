# Authoring: writing an extension

An extension is TypeScript code a plugin ships. It runs in the platform's process with full
trust: approval by the super admin is governance, not a sandbox. It sees only the SDK's `ctx`
(never kernel internals). Use an extension only when skills, templates and connectors cannot do
the job.

```ts
import { defineExtension } from "@capybara-hq/plugin-sdk";

export default defineExtension({
  name: "my-plugin",
  version: "0.1.0",
  sdk: "^0.1.0-rc.0",
  provides: [],            // extension points it implements
  permissions: { tools: true },
  setup(ctx) {
    ctx.tools.register(/* ... */);
  },
});
```

The plugin's `name` equals the extension's `name`. Put code in `src/index.ts`; `capybara-plugin
pack` bundles it. Depend only on `@capybara-hq/plugin-sdk`, `zod` and third-party packages.

## Rules for multiple replicas

The platform runs several replicas, so:

- No timers (`setTimeout`, `setInterval`) and no module-level state (top-level `let`, `Map`,
  `Set`, arrays). Use `ctx.db` (durable), `ctx.kv` (every write has a TTL), `ctx.queue` (delayed
  and periodic work) and `ctx.bus`.
- Queue names and job ids contain no `:`.
- Migrations are plain SQL under `migrations/`, in the schema `plugin_<name>`, expand-only.
- Declare every capability you use (`ctx.secrets`, `ctx.storage`, `ctx.tools`, `ctx.ui`, hooks,
  `ctx.setup.check` ids in `permissions.setupChecks`) in `permissions`. `capybara-plugin check`
  verifies this.
- Hooks observe or deny; they never rewrite.

## Config

An extension declares one config schema, `config: { deployment: z.object({ ... }) }`. The super
admin sets it for the platform. Every top-level field is **overridable** by default: an org
follows the platform's value until an org admin saves the org's own copy. Mark a field the platform
alone sets, and orgs never see, with `platformOnly(...)`; `platformOnly(z.object({ ... }))` marks
the whole schema (for a plugin with no work done for an org). The mark goes on the root or on a
top-level field only; a nested field has its top-level key's level.

```ts
import { configUrlFetch, platformOnly, secret } from "@capybara-hq/plugin-sdk";
import { z } from "zod";

config: {
  deployment: z.object({
    baseUrl: z.string().url().default("https://api.example.com"), // overridable
    apiKey: secret(z.string()),                                    // overridable secret
    adminKey: platformOnly(secret(z.string()).optional()),         // platform only
  }),
},

// In work done for an org (`config` is the call's effective config, `orgId` the org's id):
const client = new VendorClient({
  baseURL: config.baseUrl,
  apiKey: config.apiKey,
  fetch: configUrlFetch(ctx.net, {
    url: config.baseUrl,
    platform: (ctx.config as { baseUrl: string }).baseUrl, // read at call time
    orgId,
  }),
});
```

- Work done for an org reads the call's `config` (the effective config: platform config with the
  org's copy applied to the overridable fields), never `ctx.config` (the platform's values).
- An org that saves a copy brings its own value for every overridable secret. Platform-only
  secrets stay in the effective config; never send one to an endpoint taken from an overridable
  field, because an org could point that endpoint at a server it controls.
- Every URL under an overridable field reaches the network through `configUrlFetch(ctx.net, { url,
  platform, orgId })`: the platform's own value (read from `ctx.config` each time) gets the global
  `fetch`, any other value (set by an org) goes through the kernel's guarded `ctx.net.fetch`. Pass
  the result as the vendor SDK's `fetch` and use it. Declare such a field as a URL (`z.url()` or
  `.url()`); a URL that only the platform should set is marked `platformOnly` instead.
  `capybara-plugin check` fails an overridable URL no `configUrlFetch` call reads, and an
  overridable string named like a URL (`…Url`, `…Endpoint`, `…Host`) not declared as one
  (`plugin-org-url-net`).

## Setup checks

A setup guide's `::check <id> <label>` line (see `plugin-format`) runs a check of the plugin's
extension:

```ts
ctx.setup.check("bot-token", {
  place: "channel-connection",
  run: async ({ target, config, mode, signal }) => {
    // one or two read calls, passing signal; return ok, failing (with reason and fix) or unknown
    return { status: "ok", reason: { en: "The platform accepted the token." } };
  },
});
```

- Register in `setup` and list each id in `permissions.setupChecks` (`^[a-z0-9][a-z0-9-]{0,47}$`).
- A check never writes (at the third party or in the platform), never retries, and never puts a
  secret in its `reason` or `fix` (plain text, `{ en, zh? }`, at most 300 / 500 characters).
- A channel connection target carries the connection config; a connector target carries ids and a
  manual OAuth client id, never the client secret or a member's token.
- The platform runs checks only when a person or an agent asks, caches results for five minutes,
  times a run out after 10 seconds and redacts known secrets from results.

## Extension points

An extension *provides* a point (`provides`) or *consumes* one (`requires`, or `optional`). Refs
look like `channel@1`: name and major version. The registered points:

<!-- generated:extension-points -->
| Extension point | Providers | Per org | What it is |
|---|---|---|---|
| `device-provider` | multi | yes | Provides devices (an instance plus kept files) agents run commands in: containers, microVMs, connected machines. |
| `config-source` | single | no | Supplies deployment configuration from an external store such as Nacos. |
| `secret-store` | single | no | Stores and resolves secrets (connector credentials, secret config) outside the database. |
| `object-store` | single | no | Stores files and artifacts in S3-compatible object storage, with presigned uploads. |
| `channel` | multi | yes | Connects an instant-messaging platform (Slack, Lark): inbound events, replies and cards. |
| `model-provider` | multi | no | Calls a model vendor's API and streams the result back to the runtime. |
| `identity-source` | multi | no | Signs people in through an external identity provider (SSO). |
| `directory` | multi | yes | Syncs members and departments from an external company directory. |
| `counter` | multi | no | Counts usage so quotas and reports can be built on it. |
| `connector` | multi | no | Speaks one protocol (MCP, OpenAPI) to external systems and exposes their tools to agents. |
| `file-preview` | multi | yes | Renders previews of files of given types: conversation files, shared files and skill files. |
| `web-search` | multi | yes | Searches the web for the WebSearch tool; each org picks a default provider. |
| `context` | multi | yes | Adds text to the model's context at run start in conversations of orgs that enable it. |
| `web-fetch` | multi | yes | Fetches and extracts web pages for the WebFetch tool; each org picks a default provider. |
| `push-provider` | multi | no | Delivers push notifications to people's mobile apps through one channel (APNs, FCM, an aggregator). |
<!-- /generated -->

Read `extension-points/<name>` for each one. Which points a deployment actually has loaded, and
which plugins are installed, come from `Platform` operations, not from these docs.
