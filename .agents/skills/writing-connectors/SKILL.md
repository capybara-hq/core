---
name: writing-connectors
description: 'Use when changing the kernel side of connector@1 (packages/kernel/src/tools: connectors, preview, drift, elicitation, OAuth, redaction) or the contract in the SDK: the terms "connector / connector extension / connector template", no stdio MCP support, endpointSchema validation and the credential checks, the per-call open / close session lifecycle, auth() before every request and a single onUnauthorized retry, ToolError kind and the circuit breaker, connectorData and routing by the reviewed definition (ctx.spec), inspect and the install preview, onToolsChanged and drift checks, onElicit and elicitation resumption, resources / prompts, connector templates and their setup guides (guide_ack, the token endpoint probe), OAuth and credentials, redaction, and kernel tests with the fake-connector / fake-openapi extensions and startFakeMcpServer / startFakeOpenApiServer / startFakeOAuthServer. To write a connector extension (connector-mcp, connector-openapi) see writing-connectors in capybara-hq/plugins.'
---

# Connectors: the kernel side of `connector@1`

This skill covers what core owns: the contract as the kernel calls it, endpoint validation and the install preview, routing by the reviewed definition, drift review and the circuit breaker, elicitation resumption, resources / prompts, connector templates as the catalog checks them, OAuth and credentials, redaction, and the kernel tests on the `fake-connector` extension of `@capybara-hq/testing` (and `fake-openapi`, kind `openapi`, for the web install wizard's OpenAPI flow in `apps/web/e2e/connector-openapi-wizard.spec.ts`). **Writing a connector extension** (protocol handling, outbound request code, its tests and live acceptance) is in [writing-connectors in capybara-hq/plugins](https://github.com/capybara-hq/plugins/tree/main/.agents/skills/writing-connectors).

A connector extension connects a kind of remote service as a "connector" in an org (a remote service instance: an MCP server, an HTTP API described by OpenAPI, and so on; called an "app" before D17). The extension declares `provides: [CONNECTOR_EXTENSION_POINT]` and calls `ctx.provide(CONNECTOR_EXTENSION_POINT, connector)` in `setup`.

**Terms (D17)**:

| Term | Meaning | Example |
|---|---|---|
| connector | A remote service instance installed in an org: endpoint + auth + tool snapshot, table `connectors` | the "Docs" MCP server |
| connector extension | An extension implementing one protocol, providing the extension point `connector@1` (the extension point name is unchanged); deployment-level, no per-org enablement needed | `connector-mcp`, `connector-openapi` |
| connector template | A component of a plugin (`connectors/<id>.json`): references a connector extension and presets the endpoint and auth (no credentials), the endpoint fields an org may edit and the default policies; the org supplies credentials and a connector is created | the "Lark Docs" template |
| plugin | The install unit: a bundle of at most one extension + connector templates + skills, possibly depending on other plugins (`.capybara-plugin/plugin.json`; called an "app bundle" before the 2026-10-24 rename) | Lark extension + docs template + skills |

For general extension authoring (manifest, config, multi-replica prohibitions) see `.agents/skills/writing-extensions`; for general tool rules (naming, English descriptions and errors, policy, approval) see `.agents/skills/writing-tools`. This skill covers only what is specific to connectors.

The official connector extensions are [`connector-mcp`](https://github.com/capybara-hq/plugins/tree/main/plugins/connector-mcp) (MCP over Streamable HTTP, with elicitation, prompts, resources, list_changed) and [`connector-openapi`](https://github.com/capybara-hq/plugins/tree/main/plugins/connector-openapi) (OpenAPI 3.0 / 3.1, one tool per operation, implements `inspect` and `connectorData` routing) in capybara-hq/plugins. The contract is in `packages/plugin-sdk/src/connector.ts`; a change there is an SDK change and must keep both working.

By convention a connector extension's deployment-level config has `allowInsecureLoopback` (default `false`; for development / testing only, allows plain http to `127.0.0.1` / `localhost` / `[::1]`), given per extension name in `CAPYBARA_EXTENSION_CONFIG`, e.g. `{"connector-mcp":{"allowInsecureLoopback":true}}` (the core fakes default it to `true`). Connectors are deployment-level and need no per-org enablement.

**stdio MCP is not supported**: connectors only connect to remote services (MCP uses Streamable HTTP). The kernel runs as multiple replicas and does not spawn local processes server-side for an org, so do not write a connector that spawns child processes; wrap a local MCP server as an HTTP endpoint first, then connect it.

**Naming (D17)**: the management surface says "connector" (HTTP `/api/v1/orgs/:orgId/connectors*`, `OrgAction` `connectors.manage` / `connectors.use`, error codes `connector.*`, tables `connectors` / `connector_tools`, column `connector_id`, `{kind:"connector", connectorId, tools}` in agent definitions). For log determinism and stored data, these places keep the old name (C27): model-visible English text (the `ToolSearch` description, tool-unavailable reasons, the resources tool descriptions and so on still say app); the event payload fields `connection_required.appId` / `appName` and `user_message.attachments[].appId` / `appName`; `{kind:"app", appId}` in stored agent versions (normalized to the connector form when read); the secrets key `credentials:app:*`; old audit records `app.*` (queries by action use the explicit mapping in `auditActionAliases`). Slugs are unchanged, and so are tool keys `<slug>__<tool>`.

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

- When mapping the remote tool list, keep `annotations` (the kernel derives the default policy from them: `readOnlyHint` -> allow, everything else ask); if the description is missing, fall back to title / name and warn. Pass a human title the remote declares as `ToolSpec.title` (e.g. the MCP `title`, else `annotations.title`, trimmed and cut to 80), and optionally `keyArgs` (up to 3 input property names): both are display only, never sent to the model and outside the definition fingerprint, so they never cause drift review; an invalid one is dropped from the snapshot (see "Display metadata" in `.agents/skills/writing-tools`). A connector tool key is `<connectorSlug>__<tool>` and the whole must match `^[a-zA-Z0-9_-]{1,64}$` (see `.agents/skills/writing-tools`); if it is too long / contains illegal characters the kernel neither truncates nor guesses, it disables the tool and writes the reason in `issues`. Tool names come from the connector: normalize remote names to a reasonable length and guarantee uniqueness within one connector (openapi replaces illegal characters in operationId with underscores and cuts to 40 characters; duplicates are reported in the preview).
- **`ToolSpec.connectorData`** (Ruling A21, security): the routing information needed for a call goes in this opaque, JSON-serializable field (OpenAPI: method, path template, parameter locations / styles, request body media type, the resolved server address). The kernel stores it in the snapshot and counts it in `spec_hash` (a change means drift, pending review), and **never sends it to the model**.
- On a call the kernel hands back the tool's **reviewed** definition (`connector_tools.spec`, not the pending `pending_spec`) as the 4th argument of `callTool`, `ctx.spec`. A remote description can be changed (rug-pull), so route by `ctx.spec` and **do not re-read the remote description**; when `ctx` is missing (older kernel) raise an error telling the admin to refresh. A connector like MCP where the remote routes by name may ignore `ctx`.
- What to do when the remote description changes is not the connector's job: the kernel re-runs `listTools` on a schedule (`tools.driftIntervalHours`), on receiving `onToolsChanged`, and when an admin refreshes, and compares with the snapshot; new or changed tools are pending review and unusable until reviewed (see the drift section of `.agents/skills/writing-tools`). So the output of `listTools` should be **deterministic**: the same remote description gives the same spec every time (stable field order, no timestamps / random values), otherwise it triggers review again and again.

## `inspect` and the install preview (Ruling A20)

`inspect({ endpoint, signal })` reads the endpoint's description without credentials and returns `authHints` (the auth methods the remote declares, mapped to the kernel's AppAuth shapes: `bearer` / `basic` / `api_key{in,name}` / `oauth_client{tokenUrl,scopes}` / `oauth_code{authorizationUrl,tokenUrl,scopes}`, with a `scheme` name and an optional `description`; list only the methods the kernel supports) and optional `operations` (`id` is the id used for selection in the endpoint, `method` upper case, `path`, `summary?`). On failure throw an English `ToolError`.

The kernel's `POST /api/v1/orgs/:orgId/connectors/preview` (`connectors.manage`, writes nothing) and the web install wizard work from this: with `inspect` they return `authHints` / `operations`; when `auth: none` is given, or static auth comes with credentials, or the client-credentials flow comes with a client, `listTools` is run and `tools` (key, default policy, `issue`) and `issues` are returned, otherwise `tools: null` (the authorization-code flow is not listed, to avoid dynamic registration). A connector that needs no prefill (such as MCP) does not implement `inspect`, and the kernel null-checks it.

The wizard's first step reads `GET /api/v1/orgs/:orgId/connectors/kinds` (`connectors.manage`): the `kind`s of the loaded `connector@1` implementations whose extension is enabled in the org, each with its `plugin` (the first implementation of a kind, as connector lookup picks it). It offers only those it can build an endpoint for (`mcp`, `openapi`) and, with none, points the org admin to Plugins. Creating and previewing still check only that the kind is loaded on the deployment.

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

A connector template spares the org from endpoint details: a super admin imports a plugin carrying the template into the catalog, an org admin installs that plugin from the catalog and fills in only the credentials (static credentials via `credential`, OAuth via `client`) and the endpoint fields listed in the template's `editableEndpoint`; the kernel assembles the install input from the template and goes through the same `ConnectorsService.create` as manual install (the endpoint is re-checked by `endpointSchema` and the credential rules, and default policies are recorded with `policy_source 'template'`). For the template file format and how to write `editableEndpoint` and `defaultToolPolicies`, see `.agents/skills/writing-plugins`. What this asks of a connector extension:

- Template import and org install both validate against the connector extension **loaded on this replica** and its `Connector.kind` (not loaded -> import rejected with `catalog.invalid_manifest`, unless the connector is the importing plugin's own extension or comes from one of its dependencies, in which case only the static checks run at import / install `catalog.not_deployed`); the paths in `editableEndpoint` must be findable in your `endpointSchema` (`schemaHasPath` in `catalog/schema-path.ts`: walks object fields, records, union / intersection branches, strips wrappers such as optional / default / the input side of pipe, and **does not enter array elements**). So put fields an org may need to change on object paths and keep field names stable: renaming invalidates already published templates.
- No credentials in the endpoint (a template's presets are visible to every org); anything that needs a credential goes through the auth settings.
- When the deployment setting `customConnectors` is `deny`, an org can create connectors only from the catalog (templates), and manual install returns 403 `catalog.custom_disabled`.

### Connector template setup guides (spec `2026-11-09-setup-guides-v2-design.md` §9.3, §10, §11)

A template's plugin may ship a `connector-template` guide (`setupGuides` entry with `template`,
writing-plugins). The template's plugin (slack) is usually not the connector extension
(connector-mcp); the guide, its checks and its drift belong to the template, not to the protocol.

- **Places**: admin audience (`connectors.manage`) above the template's input in the install wizard
  and on 补充配置 / `/connectors/install?template=` (no target, rows "checked after saving"), and on
  `/connectors/<id>` (接入指南 tab: live checks, drift notice and ack); member audience
  (`connectors.use`) on `/account/connections`, the connector row's 如何连接 sheet. Variables:
  `oauthCallbackUrl`, `signInCallbackUrl`, `templateId`, `templateName`, `connectorName`.
- **How a page finds the guide**: org catalog templates (`connectors.templates`, `GET
  …/catalog/:itemId`) carry `guide: { itemId, guideId } | null`; connector views carry `setupGuide`
  and `guideDrift`, resolved through `connectors.platform_template_id` to the template.
- **Drift**: `connectors.guide_ack` (migration 0105) records `{ guideId, version, hash, mode: null }`
  when a connector is created from the template, and `POST
  /api/v1/orgs/:orgId/connectors/:connectorId/guide-ack { hash }` (`connectors.manage`, 409
  `connector.guide_changed`, audited `connector.guide_confirmed`; a `human-only` Platform exclusion)
  confirms the app was updated. Only the admin audience has drift.
- **Checks never get a secret**: a plugin check on a connector gets the connector id, the template
  id, a manual client's **id** and (member checks) the viewing account id; never the client secret
  or a member's token, which stay with the kernel and the connector extension's `auth()`. Kernel
  checks: `capybara:oauth-client` (manual client id and secret stored), `capybara:connector-tools`
  (a tool snapshot exists), `capybara:connector-connected` (member: the viewer holds a credential)
  and `capybara:oauth-token-endpoint` (the probe below). Results are redacted by
  `Credentials.checkMaterial`, which lists the stored values and the forms they are sent in.

## A member's own tool policies (decision 2026-11-09)

Spec `docs/superpowers/specs/2026-11-09-connector-cards-and-member-policies-design.md`. On a
personal-credential connector each member sets their own 允许 / 询问 / 禁止 per tool for their own
connection (`connector_tool_account_policies`, `tools/connector-account-policies.ts`, routes
`GET` / `PUT …/connectors/:connectorId/tool-policies/me`, always the session's account; an
org-credential connector -> 409 `connector.not_personal`; both routes are Platform exclusions, the
write `human-only`). A personal-credential connector's tool call resolves highest first
(`connectorPolicy` in `tools/policy.ts`): the org switched the tool off (unavailable) or its default
is `deny`; the member's 禁止 (a floor no agent lifts); the agent's `toolPolicies` setting (`allow`
allowed for connector tools only); the member's 允许 / 询问; the org default
(`connector_tools.default_policy`, the annotation default unless an admin changed it). An
org-credential connector's tool keeps the org default with the agent's tightening only: a stored
`allow` changes nothing there (its calls act as the whole org and no member floor exists). An
`agents.update` / `agents.create` that adds an `allow` is confirmed every time, never remembered. "The member" is `ctx.accountId`, the account
whose personal credential the pipeline injects (a sub-agent: its tree's account; a channel run: the
sender's). Fixed asks, role escalation and grants apply after this. Tests:
`test/tools/member-policies.test.ts` (levels, locks, defaults, isolation, acting accounts) and the
`tool-policies/me` cases of `test/tools/connectors.http.test.ts`.

## OAuth and credentials: all in the kernel

A connector only needs to follow "call `auth()` before every request, call `onUnauthorized()` once on 401" above; OAuth itself (`packages/kernel/src/tools/oauth/`) is not in the connector:

- The Bearer returned by `auth()` is refreshed by the kernel 60 seconds before expiry; `onUnauthorized()` forces a refresh inside the Redis lock `capk:oauth-refresh:<orgId>:<connectorId>:<owner>` (if another replica already refreshed, the new token is used directly, with no concurrent refresh); when the refresh is rejected -> the credential is deleted and the call gets "connection required".
- Auth method `oauth_code` (personal; `discovery: "mcp"` uses RFC 9728 -> RFC 8414 discovery, `discovery: "manual"` supplies `authorizationUrl` / `tokenUrl`; `client: "dcr"` registers per RFC 7591 at install, and if the authorization server does not support DCR -> 502 `connector.connect_failed` with `dcr_unsupported`, switch to `client: "manual"` + `credential: { clientId, clientSecret? }`) and `oauth_client` (org, client-credentials flow). Both require `http.publicUrl` to be configured; optional `tokenAuthMethod` (`client_secret_basic` default / `client_secret_post`).
- **Token types**: a token response's `token_type` must be `Bearer` or `user` (Slack's `oauth.v2.user.access`), case-insensitive, or one the auth settings list in `tokenTypes` (on `oauth_code` / `oauth_client`, at most 5, never `DPoP`: the schema refuses it in any case); every accepted token is stored and sent as `Authorization: Bearer`. Any other type (`DPoP`, `mac`, ...) fails with `unsupported_token_type`.
- **Token endpoint errors**: a 400 / 401 with an RFC 6749 `error` code, or an HTTP 200 whose body has `ok: false` (Slack reports every error this way) or an `error` code and no `access_token`, is a refusal with that code (`ok: false` wins over an `access_token` in the same body: nothing is stored). A token is invalidated (credential deleted, the person sees "connection required") only for `invalid_grant` / `invalid_client` / `unauthorized_client` and Slack's `invalid_refresh_token` / `token_revoked` / `token_expired`; other refusal codes (`invalid_scope`, Slack's `invalid_arguments`, ...) keep the credential and report "ask an administrator to check the app". 429, other 4xx, responses without a parsable code and the transient codes in a 200 body (RFC 6749's `temporarily_unavailable` / `server_error`, Slack's `ratelimited`, `service_unavailable`, `internal_error`, `fatal_error`, `request_timeout`) are all treated as temporarily unavailable and the credential is kept.
- **What the flow sends** (`flow.ts`): the authorize URL always carries PKCE S256 (also for a confidential client), `scope` space-joined (template `scopes`, else the scopes from discovery), `resource` when discovery found one (also on the code exchange and refresh); the callback checks RFC 9207 `iss` only when the authorization server sends it and discovery recorded an issuer. No extra authorize parameters (such as Slack's `team=`).
- **The setup check probe** (`capybara:oauth-token-endpoint`, `packages/kernel/src/setup/oauth-token-probe.ts`): for a manual client the kernel posts one authorization-code exchange with the stored client record (its `tokenEndpoint` and auth method, as the callback would) and the fixed invalid code `capybara-setup-probe`, through `packages/kernel/src/net` (`safeFetch`: no redirects, `net.httpsProxy`, `marketplaces.allowPrivateHosts`, loopback http only under `tools.oauthAllowInsecureLoopback`) with the run's signal. It reads the answer only with `parseTokenRefusal` (the one refusal parser, shared with `tokenRequest`): `invalid_grant` / `invalid_code` ok, a refused client or any 401 failing, `redirect_uri_mismatch` / `bad_redirect_uri` failing with the kernel-built callback URL, anything else (a 2xx token included, never stored) unknown; fixed texts only, nothing logged or written.
- An authorization-code connector does not `listTools` at install (after the first member connects via `POST /orgs/:orgId/connectors/:connectorId/connect` -> authorization server -> `GET /api/v1/oauth/callback`, the tool list is refreshed with their token). To rotate the client secret: `PUT .../credentials/org` with `{ clientId, clientSecret }`.

## Redaction is the kernel's job

Before writing events / archives, the kernel redacts connector tool results and errors (`[REDACTED]`) using the **credential values actually injected** for this call, and logs are redacted too. But the connector still must not write credentials into error messages, logs or tool results on its own: **do not echo request headers**, do not put a URL containing credentials into an error, do not `JSON.stringify` the whole request. In tests use fixtures that "echo the credential" (`echoKey`, `intercept`) to confirm nothing leaks.

## Testing

All from `@capybara-hq/testing` (connector extensions use it as a devDependency):

- `startFakeMcpServer({ tools, resources?, prompts?, sessions?, requireBearer?, verifyBearer?, protectedResource?, unauthorizedTimes?, onCall?, intercept?, sseResponses? })`: simulates slowness, errors, 401, echoed credentials (`calls[].headers`), oversized output, redirects; the `tools` array is re-read on every request, so changing it in a test simulates drift; with `sseResponses: true` a handler can call `ctx.notifyToolsChanged()` to send list_changed mid-call; with `sessions: true` (stateful sessions) a handler can call `ctx.elicit(params)` to initiate an elicitation (recorded in `server.elicitations`).
- `startFakeOpenApiServer({ apiKey?, apiKeyIn?, echoKey?, specRedirect?, spec? })`: `/openapi.json` serves the pet CRUD document `defaultFakeOpenApiSpec`, and `/v1/*` implements it (API key check, 404 / 500 / 302, plain text and binary responses); `setSpec` simulates a document update.
- `startFakeOAuthServer({ dcr?, metadata?, accessTokenTtl?, clients?, tokenDelayMs?, dialect?, tokenType? })`: auto-approving authorization endpoint, PKCE check, refresh rotation, client_credentials, DCR switch, `revokeAccessTokens` / `revokeRefreshTokens`, `failTokenRequests(n, status, body)` (e.g. `200` + `{ ok: false, error: "token_revoked" }`); `dialect: "slack"` answers like Slack's `oauth.v2.user.access` (`ok: true`, `token_type: "user"`, every error HTTP 200 `{ ok: false, error }` with `invalid_code` / `invalid_refresh_token` / `invalid_client_id`), `tokenRequests[].error` records the code sent; use together with `startFakeMcpServer({ verifyBearer: (t) => as.verify(t), protectedResource: { authorizationServers: [as.issuer], advertise: "header" | "well-known" } })`; the kernel needs `tools.oauthAllowInsecureLoopback: true` and `http.publicUrl`.

Kernel tests run on the core fakes: `fake-connector` (kind `fake`, or `mcp` through its deployment config `kind`: an MCP client for `startFakeMcpServer` with auth, one 401 retry, `connectorData` routes, onToolsChanged, onElicit incl. `-32042`, resources, prompts, inspect) and `fake-openapi` (kind `openapi`). Cases: `packages/kernel/test/tools/mcp-e2e.test.ts`, `mcp-interaction-e2e.test.ts`, `connector-preview.test.ts`, `endpoint.test.ts`, `drift.test.ts`, `elicitation.test.ts`, `breaker.test.ts`, `redact.test.ts`, `oauth/`, and the dual-replica `m3-segment1.dual.test.ts` / `m3-segment2.dual.test.ts`. A kernel change that the official connectors depend on (the `callTool` `ctx`, `onElicit`, preview, `auth()` / `onUnauthorized()`) also needs their tests run in capybara-hq/plugins, which use these same helpers from `@capybara-hq/testing`; changing a helper's behaviour changes their tests too.
