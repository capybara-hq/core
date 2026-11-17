# Plugin safe fetch (`ctx.net.fetch`)

Status: draft for maintainer review. Source: design review 2026-11-16, finding
`sdk-has-no-safe-fetch` (high, security, recurring since 2026-11-12).

## Intent

An org admin or member can type a URL that a plugin then requests from inside the shared kernel
process: a connector endpoint (`connector-mcp`, `connector-openapi`), a model provider base URL
(an org-overridable `baseUrl`, e.g. `deepseek`), and similar fields. Today those plugins call the global
`fetch`, so a URL such as `http://169.254.169.254/…` or an internal service reaches the kernel's
network: server-side request forgery across tenants.

The kernel already has one guarded client, `src/net/safe-fetch.ts` (`safeFetch`): https only,
private / loopback / link-local addresses refused unless listed, the address checked at connect
time (no DNS-rebinding window), the deployment's egress proxy honoured. Plugins cannot reach it
(`ctx` has no network item). This design gives plugins that client.

## Goals

- A plugin requests a URL that came from a person (admin, member, org config) through one SDK
  call that applies the kernel's network rules, with the same exemptions and proxy.
- The official plugins that request person-supplied URLs use it.
- A refused request surfaces as an actionable error to whoever supplied the URL.
- An org that needs an internal endpoint gets it from a super admin, for that org only.

## Non-goals

- Governing all plugin egress (fixed vendor hosts such as Slack, Lark, Telegram, the model
  vendors' official endpoints keep the global `fetch`). Maintainer choice 2026-11-17: the narrow
  scope.
- Enforcing `permissions.network` as an allowlist. It stays a declaration.
- Sandbox / device network policy (another line).

## Anti-goals

- A second set of network rules for plugins that drifts from the kernel's.
- Breaking streaming: MCP over SSE / streamable HTTP and model streams must keep streaming.
- A check-time-only guard (resolve on save, connect later), which DNS rebinding defeats.

## Approaches

| | What | Trade-off |
|---|---|---|
| **A (chosen)** | `ctx.net.fetch` in the SDK, implemented by the kernel with `safeFetch` | SDK addition and a plugin release; the only option that closes the rebinding window |
| B | Validate URLs when they are saved | No SDK change, but a host that later resolves to a private address passes |
| C | The kernel proxies every plugin request | Largest change; alters streaming and timeouts |

The maintainer picked A on 2026-11-17.

## Design

### SDK

- `ctx.net.fetch(url: string, init?: RequestInit & { signal?: AbortSignal }): Promise<Response>`,
  the global `fetch` signature. `signal` defaults to `ctx.signal` combined with the caller's.
- `NetDeniedError` (exported from the SDK; plugins test `err.name === "NetDeniedError"`, not
  `instanceof`, which fails across package copies) with `code`
  (`net.insecure_url` | `net.private_address` | `net.dns_failed` | …, the codes `safeFetch`
  already uses) and an English message naming the host. Plugins map it to their own actionable
  error (a connector's `ToolError` kind `invalid_input` / setup check failure; a provider's
  `ModelError` kind `invalid_request`).
- No new permission: `ctx.net.fetch` is strictly safer than the global `fetch` the plugin can
  already call, so gating it would only push plugins back to `fetch`.
- Documented rule (writing-* skills in both repositories): a URL whose host comes from a person
  or from config goes through `ctx.net.fetch`; a fixed vendor host may use `fetch`.

### Kernel

- `ctx.net` is built in `ctx/create-ctx.ts` on `safeFetch`: https only, private / loopback /
  link-local addresses refused, the address pinned at connect time, `net.httpsProxy` /
  `net.noProxy` honoured like the kernel's own outbound calls (the proxy is the deployment's
  egress control; with a proxy the proxy resolves hosts, IP literals are still checked).
- **Internal hosts are allowed per org** (maintainer choice 2026-11-17, option b: tenants must not
  share each other's internal reach). A super admin grants an org a list of internal endpoints;
  `ctx.net.fetch` made for an org-bound call (connector calls, org-scoped provider calls) allows a
  private address only when the target matches that org's list. Entries:
  - a host or a `*.domain` wildcard (https, any port), or
  - an origin `http://host:port` / `https://host:port` (allows exactly that origin, including plain
    http, which internal MCP and model servers often use).
  Validation reuses `privateHostEntryProblem` / the CIDR rules of `net/public-address.ts`
  (IP / CIDR entries allowed within its minimum prefix). Link-local (cloud metadata) stays refused
  whatever the list says.
- Storage (builder's call recorded here): a table `org_network_allowances (org_id FK ON DELETE
  CASCADE, entry, created_by, created_at, unique (org_id, entry))`, written only by a super admin
  (`@SuperAdmin` route under `/api/v1/admin/orgs/:orgId/network-allowances`, audited
  `org.network_allowance_added/removed` with the org id, a Platform operation mirroring it; org
  admins read their org's list read-only so a refusal they see is explainable). The refusal error
  names the host and says "ask a super admin to allow this internal endpoint for the
  organization".
- A call that is not org-bound (deployment-level work) gets public addresses only.
- The kernel's own outbound calls keep `marketplaces.allowPrivateHosts` / their current policies;
  the org lists do not widen them, and that list does not widen plugin requests.
- Testing: one switch `net.allowInsecureLoopback` (tests only, documented as such) lets
  `ctx.net.fetch` reach http on loopback; the connector plugins' own `allowInsecureLoopback`
  deployment config is removed (their e2e tests and core's `fake-connector` / `fake-openapi`
  fixtures set the kernel key instead).
- Redirects: never followed. With `redirect: "manual"` a 3xx response is returned to the plugin
  as is (the connectors already turn it into their own message); with the default `follow` a 3xx
  fails with `net.redirect`. Following redirects would need cross-origin header stripping and
  body replay, which no caller needs.
- Streaming: no body size cap by default (`safeFetch` streams when `maxBytes` is unset).
- Connections: one pinned agent per request, as `safeFetch` does today; pooling is out of scope.
- Logging: a refusal is logged at `warn` with plugin, org, host and code (never the full URL query
  or headers).
- Multi-replica: the org list is read from PG per call (small indexed read; no in-process cache).
  `net.*` config fields stay restart-applied (not hot).
### Official plugins (capybara-hq/plugins)

Move every request whose host an org admin or member can set to `ctx.net.fetch`: connector
endpoints (`connector-mcp` `session.ts`, `connector-openapi` `http.ts`) and org-overridable base
URLs (`deepseek` `baseUrl` and any other field declared with `orgAccess` that holds a URL; grep
config schemas). URLs only a super admin can set (platform-only `baseUrl` of `openai-compatible`,
`anthropic`, `openai`, `sandbox-e2b` `apiUrl`, `object-store-s3` `endpoint`, channel `apiUrl`s)
carry the kernel config's trust and keep `fetch`. Unit tests that call plugin factories directly
inject the fetch function. Map `NetDeniedError` to each plugin's
actionable error and add a test per plugin that a private address is refused. Raise the
manifests' minimum `sdk` to the release that ships `ctx.net`.

### Tests

- Kernel: `ctx.net.fetch` refuses a private / loopback / link-local address and an http URL,
  allows an exempted host, re-checks a redirect to a private address, streams a chunked
  response, honours the proxy (existing proxy test fixtures), aborts with the signal.
- Test stacks that run fake servers on 127.0.0.1 (connectors, providers) exempt loopback the way
  kernel tests do today (`allowInsecureLoopback` / the exemption list in the test config), so
  existing plugin tests keep working.

## AGENTS.md rules touched

- **Plugins and the catalog: every admin-supplied URL goes through `packages/kernel/src/net`.**
  This design extends that rule to URLs plugins request on a person's behalf, through the same
  module.
- **SDK public API: `pnpm gen:sdk-api` plus a changeset bumping `@capybara-hq/plugin-sdk`.**
  Applies (new `ctx.net`, `NetDeniedError`).
- **Config: env prefix, nesting, strict.** New `net.allowInsecureLoopback` (tests only); the
  connector plugins' own `allowInsecureLoopback` goes (docs/config.md regenerated).
- **Migrations.** New table `org_network_allowances` (plain SQL, `IF NOT EXISTS`).
- **Platform tool: a new route gets a Platform operation.** The super admin route does.
- **Web UI: roles everywhere.** Super admin edits the list on the org's admin page; org admins see
  it read-only; members see nothing.
- **Extensions: in-process, full trust.** Unchanged: `ctx.net` is a safety net for person-supplied
  URLs, not a sandbox.
- **Multi-replica discipline.** No state introduced.
- **Before 0.1.0: no compatibility layers.** The removed plugin config key is not aliased.

## Left to the builder

- Exact SDK typing of `init` (`RequestInit` from undici vs DOM lib) consistent with the SDK's
  other types.
- Which further official plugins have configurable base URLs.
- How each plugin words its refusal message (English, names the host and what to change).
