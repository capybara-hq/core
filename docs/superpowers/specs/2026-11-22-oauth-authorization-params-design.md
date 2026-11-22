# Extra OAuth authorization parameters on `oauth_code`

Issue: #552. Status: draft for review. Written against `main` at `487f40590`.

Related: Google plugin spec in capybara-hq/plugins (`docs/superpowers/specs/2026-11-22-google-plugin-design.md`
§5 and §9.1, D14: phase 2 waits for this change); `startFakeOAuthServer({ refreshTokenOnlyWith })`
(core#551, merged); the writing-connectors skill ("What the flow sends").

## 1. Problem

`OAuthFlow.start` (`packages/kernel/src/tools/oauth/flow.ts`) builds the authorize URL from the
kernel's own parameters only, and the `oauth_code` branch of `ConnectorAuthSchema`
(`packages/plugin-sdk/src/connector-auth.ts`) is strict, so a template cannot ask for more. Google
returns no refresh token without `access_type=offline` and re-issues one on a reconnect only with
`prompt=consent`; without them every member's Google connection dies after one hour. Slack's
`team=` (noted in the skill) is the same gap.

One finding while reading the code: with `discovery: "manual"` the kernel keeps a query string in
`authorizationUrl` (`new URL(client.authorizationEndpoint)` and then `searchParams.set` for its own
names), so `…/auth?access_type=offline&prompt=consent` already works by accident. That path is
undocumented, unavailable with `discovery: "mcp"`, and unchecked (a `response_mode` or `request_uri`
rides along; a kernel-owned name is silently overwritten). This design gives the need a proper
field and closes that path (§3.3).

## 2. Decision in one paragraph

`oauth_code` gets an optional `authorizationParams: Record<string, string>`, part of the auth preset
like `scopes`: set by the template author in `connectors/<id>.json`, or by an org admin in the
custom-connector install API (`POST …/connectors`, who already sets `authorizationUrl` and
`scopes`). It is fixed with the connector: no editable path, no per-member input. The kernel appends
the entries to the authorize URL after its own parameters, on every connect and reconnect, and
nowhere else. The schema refuses the names the kernel owns, with an actionable message naming the
parameter.

## 3. Details

### 3.1 Schema (SDK)

```ts
authorizationParams: z.record(ParamName, ParamValue).optional()  // max 10 entries
```

- Names: `/^[a-z][a-z0-9_]{0,39}$/` (covers `access_type`, `prompt`, `include_granted_scopes`,
  `login_hint`, `hd`, `team`, `audience`, `domain_hint`, `token_access_type`).
- Values: 1–200 characters of printable ASCII `[\x20-\x7E]` (space allowed: `prompt=consent
  select_account`). Plain strings only; no templating, no `{{variables}}`.
- At most 10 entries (worst case ≈ 2.4 KB on the URL).
- Refused names (`superRefine`, message `"<name>" is set by the kernel and cannot be an
  authorization parameter`, path `authorizationParams.<name>`):
  - set by `flow.ts` today: `response_type`, `client_id`, `redirect_uri`, `state`,
    `code_challenge`, `code_challenge_method`, `scope` (use `scopes`), `resource` (from discovery);
  - would change what the callback or the token exchange relies on: `response_mode` (the callback
    reads a GET query), `request`, `request_uri` (JAR / PAR objects replace the reviewed
    parameters), `nonce` (reserved for an OIDC mode of the connector flow), `dpop_jkt` (binds to a
    key the kernel does not hold), `authorization_details` (RFC 9396 grants beyond the reviewed
    `scopes`);
  - credentials and token-endpoint names that never belong on a URL: `client_secret`,
    `client_assertion`, `client_assertion_type`, `code`, `code_verifier`, `grant_type`,
    `refresh_token`.

  The list is one exported constant in the SDK (`OAUTH_RESERVED_AUTHORIZATION_PARAMS`) that the
  schema and the kernel both use.
- `oauth_client` gets nothing: the client-credentials flow has no authorize request.

The template JSON Schema (`schemas/connector-template.v1.schema.json`) does not change: `auth` is
an open object there and the import checks it with `ConnectorAuthSchema`
(`plugin-package.ts`). `AuthHint` (inspect) does not change.

### 3.2 Kernel

- `OAuthFlow.start` reads `authorizationParams` from the connector row's `auth` (already loaded as
  `app.auth`), not the client record, and appends each entry with `searchParams.set` after the
  kernel's own. It re-checks the reserved list before appending (a row written by older code, or by
  hand, cannot override a kernel name), skipping the entry and logging its name only.
- Sent on the authorize request only: never on the code exchange, the refresh or the setup check's
  token probe. Token-endpoint extras are out of scope until a provider needs them.
- Reconnect: every `start` sends the same parameters, so `prompt=consent` makes Google re-issue a
  refresh token; the callback replaces the member's token record as today. A refresh keeps the
  stored refresh token when the answer omits it (already so in `tokens.ts`; Google omits it).

### 3.3 The query in `authorizationUrl`

The schema refuses a reserved name in the query of a manual `authorizationUrl` with the same
message; any other query stays (RFC 6749 §3.1 lets an endpoint carry one). Discovered endpoints are
the authorization server's own and are not checked. Templates should use `authorizationParams`;
the skill says so.

### 3.4 Plugin upgrade

`credentialKey` (`catalog/plugin-upgrade.ts`) compares `oauth_code` auth by canonical JSON, so a
template update that only changes `authorizationParams` would clear every member's tokens and the
org's OAuth client. Proposed: leave `authorizationParams` out of that key. New values apply from
each member's next connect; existing tokens keep working until they expire or fail (then "connection
required" as today). See D3.

### 3.5 Audit, redaction, display

Values are not secrets and are never treated as such: they sit in `connectors.auth` in plain JSON,
are visible to org admins with the connector, in the import review of the template (covered by the
review hash with the rest of the file) and in the authorize URL the browser sees. The schema
description and the skill say "never put a secret here"; the kernel does not guess. No redaction
change. Audit: the `connector.created` / `connector.template_applied` rows are unchanged (they
already record the auth type and ownership); the flow logs neither the URL nor the values.

### 3.6 API, platform tool, web

- SDK public API changes (`ConnectorAuthSchema`, `ConnectorAuthPreset`, the new constant):
  `pnpm gen:sdk-api`, a changeset bumping `@capybara-hq/plugin-sdk`, and one on
  `@capybara-hq/kernel` (`check:api-changeset`).
- Platform tool: no route is added; `ConnectorCreateSchema` / `ConnectorPreviewSchema` already embed
  `ConnectorAuthSchema`, so the connector create and preview operations pick up the field from the
  shared schema and `platform-parity.test.ts` stays green. Not a secret, so no person field.
- Web: no install-wizard field in this change (templates are the users; the API accepts it). See D4.

### 3.7 Docs

The writing-connectors skill's "No extra authorize parameters" sentence is replaced by the field,
its limits and the reserved list; `packages/plugin-sdk/agent-docs/connector-templates.md` gets a
line under `auth`; the writing-connectors skill in capybara-hq/plugins (template authors) follows
when phase 2 lands.

## 4. Tests

- Unit (SDK, a new `packages/plugin-sdk/test/connector-auth.test.ts`): accepts the Google set;
  refuses each reserved name with its path, an uppercase or over-long name, an empty /
  non-printable / 201-character value, 11 entries, the field on `oauth_client`, and a reserved
  name in a manual `authorizationUrl` query.
- Unit (kernel, `credentialKey`): a change in `authorizationParams` alone gives `credentialsReset:
  false`.
- Kernel integration (`packages/kernel/test/tools/oauth/`, one app per file): a manual-client
  `oauth_code` connector with `authorizationParams: { access_type: "offline", prompt: "consent" }`
  against `startFakeOAuthServer({ refreshTokenOnlyWith: { access_type: "offline", prompt:
  "consent" } })` and `startFakeMcpServer({ verifyBearer })`: `authorizeRequests[0]` carries both and still the
  kernel's `state` / PKCE; the stored record has a refresh token; after the access token expires a
  tool call refreshes and the refresh token is kept; a reconnect gets a fresh one. Control: the same
  connector without the field stores no refresh token and the expired call reports "connection
  required". A `discovery: "mcp"` case shows the parameters work with discovery too.

## 5. Migration impact

None. No SQL migration: `connectors.auth` is JSONB and the field is optional; existing rows parse
unchanged. Existing connectors whose manual `authorizationUrl` carries a reserved name in its query
(none known) would fail validation only on their next create or template update, not at read time.

## 6. Decisions for the reviewer

- **D1 Where it lives.** Recommended: on the `oauth_code` auth preset (template author, or org
  admin through the custom install API), fixed per connector. Alternative: an org-editable connector
  setting, rejected: the parameters decide the grant the import reviewer approved.
- **D2 Reserved list as a denylist.** Recommended: denylist of §3.1 plus the name pattern, so
  `audience`, `domain_hint` etc. work without a core change. Alternative: an allowlist of known
  names (tighter, but every new provider needs a core release).
- **D3 Template update changing only `authorizationParams`.** Recommended: no credential reset
  (§3.4). Alternative: keep today's canonical-JSON key, forcing every member to reconnect and the
  org admin to re-enter the OAuth client.
- **D4 Web install wizard.** Recommended: API only now, a wizard field when a manual install needs
  it. Alternative: a key/value editor in the custom `oauth_code` form now.
- **D5 The query in `authorizationUrl`.** Recommended: refuse reserved names there (§3.3).
  Alternative: refuse any query on a manual `authorizationUrl` (stricter, breaks endpoints that
  legitimately carry one).
- **D6 Token-endpoint parameters.** Recommended: out of scope. Alternative: a sibling
  `tokenParams` now (no known need).

## AGENTS.md rules touched

None changed. Rules this design relies on: connectors are `connector@1` with OAuth owned by the
kernel; every admin-supplied URL goes through `packages/kernel/src/net` (unchanged: the parameters
add no new URL); public API reports need `gen:sdk-api` plus a changeset on
`@capybara-hq/plugin-sdk`; platform-tool parity through shared route schemas; "before 0.1.0, no
compatibility layers" (the `authorizationUrl` query check applies directly); applied migrations
immutable (none added).
