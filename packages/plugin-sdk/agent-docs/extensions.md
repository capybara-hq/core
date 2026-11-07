# Writing an extension

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
- Declare every capability you use (`ctx.secrets`, `ctx.storage`, `ctx.tools`, `ctx.ui`, hooks)
  in `permissions`. `capybara-plugin check` verifies this.
- Hooks observe or deny; they never rewrite.

## Extension points

An extension *provides* a point (`provides`) or *consumes* one (`requires`, or `optional`). Refs
look like `channel@1`: name and major version. The registered points:

<!-- generated:extension-points -->
| Extension point | Providers | Per org | What it is |
|---|---|---|---|
| `sandbox` | single | no | Runs an environment's instance and keeps its files for agents' commands (Docker, E2B). |
| `config-source` | single | no | Supplies deployment configuration from an external store such as Nacos. |
| `secret-store` | single | no | Stores and resolves secrets (connector credentials, secret config) outside the database. |
| `object-store` | single | no | Stores files and artifacts in S3-compatible object storage, with presigned uploads. |
| `channel` | multi | yes | Connects an instant-messaging platform (Slack, Lark): inbound events, replies and cards. |
| `model-provider` | multi | no | Calls a model vendor's API and streams the result back to the runtime. |
| `identity-source` | multi | no | Signs people in through an external identity provider (SSO). |
| `directory` | multi | yes | Syncs members and departments from an external company directory. |
| `counter` | multi | no | Counts usage so quotas and reports can be built on it. |
| `connector` | multi | no | Speaks one protocol (MCP, OpenAPI) to external systems and exposes their tools to agents. |
| `file-preview` | multi | yes | Renders previews of files of given types in the conversation UI. |
| `web-search` | multi | yes | Searches the web for the WebSearch tool; each org picks a default provider. |
| `web-fetch` | multi | yes | Fetches and extracts web pages for the WebFetch tool; each org picks a default provider. |
<!-- /generated -->

Read `extension-points/<name>` for each one. Which points a deployment actually has loaded, and
which plugins are installed, come from `Platform` operations, not from these docs.
