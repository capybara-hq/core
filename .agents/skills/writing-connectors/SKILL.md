---
name: writing-connectors
description: 'Use when creating or changing a connector extension (provides connector@1, e.g. plugins/connector-mcp, plugins/connector-openapi): the terms "connector / connector extension / connector template", no stdio MCP support, endpointSchema, the per-call open / close session lifecycle, auth() before every request and a single onUnauthorized retry, no redirect following and https only (allowInsecureLoopback), ToolError kind and the circuit breaker, connectorData and routing by the reviewed definition (ctx.spec), inspect and the install preview, onToolsChanged, onElicit and elicitation resumption, optional resources / prompts methods, redaction is the kernel''s job, and writing tests with startFakeMcpServer / startFakeOpenApiServer / startFakeOAuthServer.'
---

# Writing connectors

**Where this goes after the repository split** (phase A3b, spec §6.2): the official plugins move to `capybara-hq/plugins` and the author half of this skill moves with them; author tooling is `capybara-plugin pack | check` (`@capybara-hq/plugin-tools`, `.agents/skills/writing-plugins` "Toolchain"; in core `pnpm pack-plugin` and `pnpm check`). **Stays in core**: "OAuth and credentials: all in the kernel", "Redaction is the kernel's job", the install preview, routing by the reviewed definition, drift review and the circuit breaker (kernel side), connector templates as the catalog checks them; tested on the `fake-connector` extension of `@capybara-hq/testing` (and `fake-openapi`, kind `openapi`, for the web install wizard's OpenAPI flow in `apps/web/e2e/connector-openapi-wizard.spec.ts`). Moves: the extension rules (contract, `endpointSchema`, session lifecycle, outbound requests, `onElicit`, resources / prompts) and the protocol tests in `plugins/connector-mcp/test`, `plugins/connector-openapi/test`.

A connector extension connects a kind of remote service as a "connector" in an org (a remote service instance: an MCP server, an HTTP API described by OpenAPI, and so on; called an "app" before D17). The extension declares `provides: [CONNECTOR_EXTENSION_POINT]` and calls `ctx.provide(CONNECTOR_EXTENSION_POINT, connector)` in `setup`.

**Terms (D17)**:

| Term | Meaning | Example |
|---|---|---|
| connector | A remote service instance installed in an org: endpoint + auth + tool snapshot, table `connectors` | the "Docs" MCP server |
| connector extension | An extension implementing one protocol, providing the extension point `connector@1` (the extension point name is unchanged); deployment-level, no per-org enablement needed | `connector-mcp`, `connector-openapi` |
| connector template | A component of a plugin (`connectors/<id>.json`): references a connector extension and presets the endpoint and auth (no credentials), the endpoint fields an org may edit and the default policies; the org supplies credentials and a connector is created | the "Lark Docs" template |
| plugin | The install unit: a bundle of at most one extension + connector templates + skills, possibly depending on other plugins (`.capybara-plugin/plugin.json`; called an "app bundle" before the 2026-10-24 rename) | Lark extension + docs template + skills |

For general extension authoring (manifest, config, multi-replica prohibitions) see `.agents/skills/writing-extensions`; for general tool rules (naming, English descriptions and errors, policy, approval) see `.agents/skills/writing-tools`. This skill covers only what is specific to connectors.

Reference implementations: `plugins/connector-mcp` (MCP over Streamable HTTP, with elicitation, prompts, resources, list_changed) and `plugins/connector-openapi` (OpenAPI 3.0 / 3.1, one tool per operation, implements `inspect` and `connectorData` routing). The contract is in `packages/plugin-sdk/src/connector.ts`.

The deployment-level config of both official connectors is only `allowInsecureLoopback` (default `false`; for development / testing only, allows plain http to `127.0.0.1` / `localhost` / `[::1]`); give it per extension name in `CAPYBARA_EXTENSION_CONFIG`, e.g. `{"connector-mcp":{"allowInsecureLoopback":true}}`. Connectors are deployment-level and need no per-org enablement.

**stdio MCP is not supported**: connectors only connect to remote services (MCP uses Streamable HTTP). The kernel runs as multiple replicas and does not spawn local processes server-side for an org, so do not write a connector that spawns child processes; wrap a local MCP server as an HTTP endpoint first, then connect it.

**Naming (D17)**: the management surface says "connector" (HTTP `/api/v1/orgs/:orgId/connectors*`, `OrgAction` `connectors.manage` / `connectors.use`, error codes `connector.*`, tables `connectors` / `connector_tools`, column `connector_id`, `{kind:"connector", connectorId, tools}` in agent definitions). For log determinism and stored data, these places keep the old name (C27): model-visible English text (the `tool_search` description, tool-unavailable reasons, the resources tool descriptions and so on still say app); the event payload fields `connection_required.appId` / `appName` and `user_message.attachments[].appId` / `appName`; `{kind:"app", appId}` in stored agent versions (normalized to the connector form when read); the secrets key `credentials:app:*`; old audit records `app.*` (queries by action use the explicit mapping in `auditActionAliases`). Slugs are unchanged, and so are tool keys `<slug>__<tool>`.

## Contract

```ts
interface Connector {
  kind: string;                 // stored in connectors.connector, e.g. "mcp", "openapi"
  endpointSchema: ZodTypeAny;   // validates the connector endpoint (called by the kernel on install / preview)
  open(args: ConnectorOpenArgs): Promise<ConnectorSession>;
  inspect?(args: { endpoint; signal }): Promise<{ authHints: AuthHint[]; operations?: ConnectorOperation[] }>;
}
interface ConnectorOpenArgs {
  endpoint: unknown;                        // already validated against endpointSchema
  auth(): Promise<AuthInjection>;           // { headers, query? }
  onUnauthorized(): Promise<void>;
  signal: AbortSignal;
  onToolsChanged?(): void;                  // optional
  onElicit?(req: ElicitationRequest): Promise<ElicitationResponse>;   // optional
}
interface ConnectorSession {
  listTools(): Promise<ToolSpec[]>;
  callTool(name, input, signal, ctx?: { spec: ToolSpec }): Promise<ToolResult>;
  listResources?(); readResource?(uri);     // optional
  listPrompts?(); getPrompt?(name, args);   // optional
  close(): Promise<void>;
}
```

Null-check every optional callback and method: an older kernel does not provide the callbacks, and an extension point the connector does not support simply has no method implemented.

## `endpointSchema`

- The kernel validates `endpoint` with it on install / preview / create (failure -> 400 `validation_failed`); `open` receives the validated value (the connector still calls `schema.parse` once to get the type).
- URLs accept https only; only when the deployment config `allowInsecureLoopback` is on are the three exact loopback http host names allowed (`localhost.evil.com` and the like do not count). Write validation messages in English and state the rule.
- Endpoint config is visible to org members and **must not contain credentials**: fixed headers must not include credential headers such as `Authorization` / `Cookie` (credentials go through the connector auth settings and are stored encrypted); on install the kernel runs one more check by header name / query name / URL userinfo and rejects with 400 (`x-api-key`, `*-token`, `*-secret`, queries such as `key` / `token` / `access_token`). String fields whose top-level name is `url` or `*Url` are all checked as URLs for credentials; someone without `connectors.manage` who reads a connector sees only the URL without its query and the header names.
- Large fields (such as OpenAPI's `specText`, <= 2 MB): connector list / detail do not echo the full text of `text` / `*Text` fields, only `<field>Bytes` and `<field>Sha256`; the request body limit of the install and preview routes is raised to 6 MiB, other routes stay at 1 MiB.

## Session lifecycle: open per call

For every `listTools` (install / refresh / drift check), every tool call, and every resource or prompt read, the kernel does `open` -> use -> `close`. The connector **does not cache connections and holds no in-process session** (with multiple replicas the next call may land on another replica, so no in-process state at all). `close` should return quickly: the kernel waits at most 5 seconds, and an error only logs a warn without affecting the result. Respect `signal` (both `open`'s and `callTool`'s); the timeout is decided by the kernel's `tools.timeoutMs`, so set any SDK-built-in request timeout long enough that it does not fire before the kernel's.

## Rules for outbound requests

- **Call `auth()` before every request** and merge the returned `headers` / `query` into the request; do not fetch it once at session start and reuse it (credentials may refresh). The kernel decrypts credentials and they appear only at this moment; the connector does not store, log or echo them.
- **On 401, call `onUnauthorized()` once and retry once with a fresh `auth()`**; if it is still 401, throw `ToolError("Authentication failed for this app; ask the user to reconnect it.")`. Do not loop; do not retry other errors inside the extension either: retry and the circuit breaker belong to the kernel.
- **Do not follow redirects** (`fetch(…, { redirect: "manual" })`, any 3xx is an error): following would carry the request body and the injected credential headers to another origin. Fetching a remote description document (OpenAPI's `specUrl`) also carries no credentials and follows no redirects.
- Reject any outbound address that is not https (loopback excepted), including server addresses declared in documents.
- Remote content is untrusted: the kernel sanitizes the `inputSchema` in a remote description before validation (removes `pattern` / `patternProperties` / `format`; when these constraints appear under `not` / `oneOf` / `if` / `then` / `else`, or the schema uses `unevaluatedProperties` / `unevaluatedItems`, removing them is not necessarily a relaxation and the whole schema is not validated; schemas over 64 KB or nested deeper than 32 levels are not validated; each schema gets its own Ajv instance); the connector also limits response body size and read time itself (openapi: document 2 MB / 30 seconds, response body 5 MB).

## `ToolError`, `kind` and the circuit breaker

- Throw `ToolError(message)`: the message goes to the model **verbatim**, must be English and actionable (contain one of `use` / `call` / `retry` / `check` / `ask` / `pass` / `provide`; the `tool-error-actionable` check of `pnpm check`). When a preview / install fails, the same message (redacted by the injected credentials) is carried into the description of the 502 `connector.connect_failed`, so write it so admins can understand it too.
- `new ToolError(message, { kind: "unavailable" })` means the **remote is unavailable** (cannot connect, HTTP 5xx): it counts toward the connector circuit breaker. The default `kind: "error"` (bad arguments, business errors, still failing after the 401 retry, redirects, 4xx, JSON-RPC business errors) means the remote is reachable, and like an `isError` result it resets the count.
- The circuit breaker lives in the kernel (after `tools.breakerFailures` consecutive failures it opens for `tools.breakerOpenSeconds` seconds); only timeouts, transport / connection errors (exceptions that are not `ToolError`) and `kind: "unavailable"` count. The connector just throws / returns honestly.
- Throwing any other exception: the model sees only `Tool <key> failed (<ErrorName>)…`, and details go into the redacted log. For an upstream HTTP error the model gets only the status code; the body is truncated and logged as a warn.
- A result with `isError: true` means "the call succeeded but the content is an error" (such as MCP's `isError`, or an OpenAPI non-2xx body).

## `listTools`, `connectorData` and routing by the reviewed definition

- When mapping the remote tool list, keep `annotations` (the kernel derives the default policy from them: `readOnlyHint` -> allow, everything else ask); if the description is missing, fall back to title / name and warn. Pass a human title the remote declares as `ToolSpec.title` (connector-mcp keeps the MCP `title`, else `annotations.title`, trimmed and cut to 80), and optionally `keyArgs` (up to 3 input property names): both are display only, never sent to the model and outside the definition fingerprint, so they never cause drift review; an invalid one is dropped from the snapshot (see "Display metadata" in `.agents/skills/writing-tools`). A connector tool key is `<connectorSlug>__<tool>` and the whole must match `^[a-zA-Z0-9_-]{1,64}$` (see `.agents/skills/writing-tools`); if it is too long / contains illegal characters the kernel neither truncates nor guesses, it disables the tool and writes the reason in `issues`. Tool names come from the connector: normalize remote names to a reasonable length and guarantee uniqueness within one connector (openapi replaces illegal characters in operationId with underscores and cuts to 40 characters; duplicates are reported in the preview).
- **`ToolSpec.connectorData`** (Ruling A21, security): the routing information needed for a call goes in this opaque, JSON-serializable field (OpenAPI: method, path template, parameter locations / styles, request body media type, the resolved server address). The kernel stores it in the snapshot and counts it in `spec_hash` (a change means drift, pending review), and **never sends it to the model**.
- On a call the kernel hands back the tool's **reviewed** definition (`connector_tools.spec`, not the pending `pending_spec`) as the 4th argument of `callTool`, `ctx.spec`. A remote description can be changed (rug-pull), so route by `ctx.spec` and **do not re-read the remote description**; when `ctx` is missing (older kernel) raise an error telling the admin to refresh. A connector like MCP where the remote routes by name may ignore `ctx`.
- What to do when the remote description changes is not the connector's job: the kernel re-runs `listTools` on a schedule (`tools.driftIntervalHours`), on receiving `onToolsChanged`, and when an admin refreshes, and compares with the snapshot; new or changed tools are pending review and unusable until reviewed (see the drift section of `.agents/skills/writing-tools`). So the output of `listTools` should be **deterministic**: the same remote description gives the same spec every time (stable field order, no timestamps / random values), otherwise it triggers review again and again.

## `inspect` and the install preview (Ruling A20)

`inspect({ endpoint, signal })` reads the endpoint's description without credentials and returns `authHints` (the auth methods the remote declares, mapped to the kernel's AppAuth shapes: `bearer` / `basic` / `api_key{in,name}` / `oauth_client{tokenUrl,scopes}` / `oauth_code{authorizationUrl,tokenUrl,scopes}`, with a `scheme` name and an optional `description`; list only the methods the kernel supports) and optional `operations` (`id` is the id used for selection in the endpoint, `method` upper case, `path`, `summary?`). On failure throw an English `ToolError`.

The kernel's `POST /api/v1/orgs/:orgId/connectors/preview` (`connectors.manage`, writes nothing) and the web install wizard work from this: with `inspect` they return `authHints` / `operations`; when `auth: none` is given, or static auth comes with credentials, or the client-credentials flow comes with a client, `listTools` is run and `tools` (key, default policy, `issue`) and `issues` are returned, otherwise `tools: null` (the authorization-code flow is not listed, to avoid dynamic registration). A connector that needs no prefill (such as MCP) does not implement `inspect`, and the kernel null-checks it.

## `onToolsChanged`

When the remote reports that the tool list changed (MCP `notifications/tools/list_changed`), call `args.onToolsChanged?.()`: do not wait, an error only logs a warn, it does not affect the current call, and it may be called multiple times. The kernel uses it to enqueue one drift check for that connector (maintenance queue, deduplicated by jobId `drift-<connectorId>-<minute bucket>`). The connector must not re-fetch the list itself.

**Known limitation (drift checks and personal credentials)**:

- The background drift check of a personal-credential connector (static personal credential or `oauth_code`) has no initiator; the kernel tries in turn the credentials of up to 3 current members who wrote credentials most recently (Ruling A19), so the credential used may differ from check to check, rotating among the most recently active members.
- Therefore a service that returns a different tool set per user (the tool list depends on who is logged in) makes tools flip between "gone" and "pending review": this time A's credential does not see a tool -> recorded as gone and disabled; next time B's credential sees it again -> it enters pending review as newly added. For such services, use an org credential instead, or make the server return the same tool list to all members.

## `onElicit`: the remote asks the user for input mid-call

For MCP `elicitation/create` (form and URL modes), call `args.onElicit?.(request)` and return the resulting `ElicitationResponse` to the remote unchanged. **When the kernel did not provide `onElicit`, do not declare the elicitation extension point** (the remote will then not initiate it). URL mode may also appear as the error `-32042` (URL elicitation required): hand them to `onElicit` one by one, and once all are `accept`ed retry the call once.

**The connector must not wait for the user and must not cache answers.** The kernel cannot hold a remote call while waiting for a person (the run pauses, the session closes), so when it needs to ask the user it aborts the `callTool` signal and makes `onElicit` reject with an error; the connector lets that error end this call as is. The kernel turns the request into a generic input request (`packages/kernel/src/tools/elicitation.ts`: a form maps `requestedSchema` to an InputForm subset; URL mode is a form carrying `url` plus a "done" switch), and after the user answers it **re-issues the call with the same input**; when the remote initiates the **same** elicitation again (a form matched by `requestedSchema` + text, a URL by origin + path + text), `onElicit` answers immediately with the answer.

Limitations (Ruling A24, accepted): if the remote does not ask a second time / changes the schema, the answer goes unused (the latter asks again, at most 3 rounds); side effects before the elicitation are performed again with the re-issued call; the URL completion notification (`notifications/elicitation/complete`) is not received, the user's confirmation is authoritative; a form beyond the subset is `decline`d immediately, with an English note appended to the tool result.

## Optional: resources and prompts

- When the session implements `listResources` / `readResource`, the kernel adds two tools `<slug>__list_resources` / `<slug>__read_resource` (both marked `readOnlyHint`, default allow; admins can disable them) and supports `@` references in the web input box (message API `attachments: [{ connectorId, uri }]`; the kernel reads with the sender's credentials, redacts, limits length, and attaches the result as an extra text block of the user message). Resource reads (lists and attachments) honor the admin's enable / disable of that connector's `read_resource` tool (Ruling A23: disabled -> not listed, attachment 409 `connector.resources_disabled`).
- When `listPrompts` / `getPrompt` are implemented, the kernel provides `GET /orgs/:orgId/connectors/prompts` and `POST /orgs/:orgId/connectors/:connectorId/prompts/:name`, and the web input box gets `/<connector>:<prompt name>` slash commands. When `getPrompt` fails, throw an English `ToolError` without credentials.
- Both kinds are initiated by the user personally with their own credentials and do not go through tool policy. Code is in `packages/kernel/src/tools/connector-content.ts`.

## Connector templates (C30)

A connector template spares the org from endpoint details: an enterprise admin imports a plugin carrying the template into the catalog, an org admin installs that plugin from the catalog and fills in only the credentials (static credentials via `credential`, OAuth via `client`) and the endpoint fields listed in the template's `editableEndpoint`; the kernel assembles the install input from the template and goes through the same `ConnectorsService.create` as manual install (the endpoint is re-checked by `endpointSchema` and the credential rules, and default policies are recorded with `policy_source 'template'`). For the template file format and how to write `editableEndpoint` and `defaultToolPolicies`, see `.agents/skills/writing-plugins`. What this asks of a connector extension:

- Template import and org install both validate against the connector extension **loaded on this replica** and its `Connector.kind` (not loaded -> import rejected with `catalog.invalid_manifest`, unless the connector is the importing plugin's own extension or comes from one of its dependencies, in which case only the static checks run at import / install `catalog.not_deployed`); the paths in `editableEndpoint` must be findable in your `endpointSchema` (`schemaHasPath` in `catalog/schema-path.ts`: walks object fields, records, union / intersection branches, strips wrappers such as optional / default / the input side of pipe, and **does not enter array elements**). So put fields an org may need to change on object paths and keep field names stable: renaming invalidates already published templates.
- No credentials in the endpoint (a template's presets are visible to every org); anything that needs a credential goes through the auth settings.
- When the deployment setting `customConnectors` is `deny`, an org can create connectors only from the catalog (templates), and manual install returns 403 `catalog.custom_disabled`.

## OAuth and credentials: all in the kernel

A connector only needs to follow "call `auth()` before every request, call `onUnauthorized()` once on 401" above; OAuth itself (`packages/kernel/src/tools/oauth/`) is not in the connector:

- The Bearer returned by `auth()` is refreshed by the kernel 60 seconds before expiry; `onUnauthorized()` forces a refresh inside the Redis lock `capk:oauth-refresh:<orgId>:<connectorId>:<owner>` (if another replica already refreshed, the new token is used directly, with no concurrent refresh); when the refresh is rejected -> the credential is deleted and the call gets "connection required".
- Auth method `oauth_code` (personal; `discovery: "mcp"` uses RFC 9728 -> RFC 8414 discovery, `discovery: "manual"` supplies `authorizationUrl` / `tokenUrl`; `client: "dcr"` registers per RFC 7591 at install, and if the authorization server does not support DCR -> 502 `connector.connect_failed` with `dcr_unsupported`, switch to `client: "manual"` + `credential: { clientId, clientSecret? }`) and `oauth_client` (org, client-credentials flow). Both require `http.publicUrl` to be configured; optional `tokenAuthMethod` (`client_secret_basic` default / `client_secret_post`).
- A token is invalidated only when the token endpoint returns `invalid_grant` / `invalid_client` / `unauthorized_client` with 400 / 401; 429, other 4xx and responses without an error code are all treated as temporarily unavailable and the credential is kept.
- An authorization-code connector does not `listTools` at install (after the first member connects via `POST /orgs/:orgId/connectors/:connectorId/connect` -> authorization server -> `GET /api/v1/oauth/callback`, the tool list is refreshed with their token). To rotate the client secret: `PUT .../credentials/org` with `{ clientId, clientSecret }`.

## Redaction is the kernel's job

Before writing events / archives, the kernel redacts connector tool results and errors (`[REDACTED]`) using the **credential values actually injected** for this call, and logs are redacted too. But the connector still must not write credentials into error messages, logs or tool results on its own: **do not echo request headers**, do not put a URL containing credentials into an error, do not `JSON.stringify` the whole request. In tests use fixtures that "echo the credential" (`echoKey`, `intercept`) to confirm nothing leaks.

## Testing

All from `@capybara-hq/testing` (connector extensions use it as a devDependency):

- `startFakeMcpServer({ tools, resources?, prompts?, sessions?, requireBearer?, verifyBearer?, protectedResource?, unauthorizedTimes?, onCall?, intercept?, sseResponses? })`: simulates slowness, errors, 401, echoed credentials (`calls[].headers`), oversized output, redirects; the `tools` array is re-read on every request, so changing it in a test simulates drift; with `sseResponses: true` a handler can call `ctx.notifyToolsChanged()` to send list_changed mid-call; with `sessions: true` (stateful sessions) a handler can call `ctx.elicit(params)` to initiate an elicitation (recorded in `server.elicitations`).
- `startFakeOpenApiServer({ apiKey?, apiKeyIn?, echoKey?, specRedirect?, spec? })`: `/openapi.json` serves the pet CRUD document `defaultFakeOpenApiSpec`, and `/v1/*` implements it (API key check, 404 / 500 / 302, plain text and binary responses); `setSpec` simulates a document update.
- `startFakeOAuthServer({ dcr?, metadata?, accessTokenTtl?, clients?, tokenDelayMs? })`: auto-approving authorization endpoint, PKCE check, refresh rotation, client_credentials, DCR switch, `revokeAccessTokens` / `revokeRefreshTokens`; use together with `startFakeMcpServer({ verifyBearer: (t) => as.verify(t), protectedResource: { authorizationServers: [as.issuer], advertise: "header" | "well-known" } })`; the kernel needs `tools.oauthAllowInsecureLoopback: true` and `http.publicUrl`.

Test checklist (follow `plugins/connector-mcp/test/` and `plugins/connector-openapi/test/`): endpoint validation (non-https, credential headers), `auth()` fetched before every request, 401 retried once and only once, redirects rejected, `ToolError` `kind`, credentials not in errors, no leftover connections after `close`, `signal` abort; for a connector with `connectorData`, also test "the call still goes by `ctx.spec` after the description changes". Through a real kernel: `plugins/connector-mcp/test/kernel/mcp-e2e.test.ts` and `plugins/connector-openapi/test/kernel/openapi-e2e.test.ts` (`startTestKernel` + model-fake from `@capybara-hq/testing`); the kernel side on the core fake `fake-connector`: `packages/kernel/test/tools/mcp-e2e.test.ts`, `mcp-interaction-e2e.test.ts`, `connector-preview.test.ts`, `drift.test.ts`, `oauth/`.

Live-service acceptance is in `plugins/connector-mcp/test/live/m3.live.test.ts` (DeepWiki MCP, GitHub MCP) and `plugins/connector-openapi/test/live/m3.live.test.ts` (Petstore OpenAPI): it runs only when `CAPYBARA_TEST_LIVE_TOOLS=1` is explicitly set (a plain `pnpm test` does not touch the external network); GitHub also needs `CAPYBARA_TEST_GITHUB_MCP_TOKEN` and `CAPYBARA_TEST_GITHUB_REPO` (owner/name), and it opens an issue and closes it in `finally` through the GitHub REST API. After changing a connector's outbound requests or protocol handling, run it locally once with `CAPYBARA_TEST_LIVE_TOOLS=1 pnpm exec vitest run plugins/connector-mcp/test/live plugins/connector-openapi/test/live -t live`.
