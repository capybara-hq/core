# Tools and connectors (MCP / OpenAPI)

Agents act through "tools". Tools come from three sources: builtin (`AskUserQuestion`, `ReadToolOutput`, `Platform`, and `ToolSearch`, which is added automatically when there are many tools), extensions (such as the task-list tool of `@capybara-hq/plugin-todo`), and **connectors** (which bring a remote MCP service or an HTTP API described by OpenAPI into an org). Write operations trigger approval by default; the run pauses until confirmed and doesn't hold the conversation lock.

Install the connector extensions (deployment level, no per-org enablement needed):

```bash
export CAPYBARA_EXTENSIONS='["@capybara-hq/plugin-model-fake"]'
for p in connector-mcp connector-openapi todo; do
  pnpm capybara extensions install npm:@capybara-hq/plugin-$p --yes
  pnpm capybara extensions approve $p --yes
  pnpm capybara extensions enable $p
done
# production accepts only https endpoints; turn on allowInsecureLoopback only for local integration (plain-http 127.0.0.1 / localhost / [::1])
export CAPYBARA_EXTENSION_CONFIG='{"connector-mcp":{"allowInsecureLoopback":true},"connector-openapi":{"allowInsecureLoopback":true}}'
```

**Web wizard** (org admins): after logging in, open "Connectors" → "Install" (`/connectors/install`): pick the endpoint type (MCP service / OpenAPI document) → fill in the endpoint (for OpenAPI, give a document URL or upload JSON / YAML, up to 2 MB; `baseUrl` can override the document's servers) → pick the auth (for OpenAPI it is prefilled from the `securitySchemes` the document declares, and the operations are listed for you to tick) → preview the tools and default policies → install. On the installed connector's detail page you can enable or disable each tool, adjust its default policy, and review drift (see below). Select the connector's tools in the agent form; the agent won't use them otherwise.

**API** (with the admin's session cookie or a token; write requests carry `X-Capybara-Csrf: 1`):

```bash
# install an MCP connector (static Bearer, one credential shared by the org)
curl -s -X POST localhost:8080/api/v1/orgs/$ORG/connectors -b cookies.txt \
  -H 'Content-Type: application/json' -H 'X-Capybara-Csrf: 1' \
  -d '{"name":"Docs","slug":"docs","connector":"mcp",
       "endpoint":{"url":"https://mcp.example.com/mcp"},
       "auth":{"type":"bearer","ownership":"org"},
       "credential":{"token":"<token>"}}'

# install an OpenAPI connector (API key in a header; omitting operations = all operations)
curl -s -X POST localhost:8080/api/v1/orgs/$ORG/connectors -b cookies.txt \
  -H 'Content-Type: application/json' -H 'X-Capybara-Csrf: 1' \
  -d '{"name":"Petstore","slug":"pets","connector":"openapi",
       "endpoint":{"specUrl":"https://api.example.com/openapi.json","operations":["listPets","getPet"]},
       "auth":{"type":"api_key","ownership":"org","in":"header","name":"X-Api-Key"},
       "credential":{"token":"<key>"}}'

# preview (writes nothing): returns the auth methods the document declares, the operation list and a tool preview
curl -s -X POST localhost:8080/api/v1/orgs/$ORG/connectors/preview -b cookies.txt \
  -H 'Content-Type: application/json' -H 'X-Capybara-Csrf: 1' \
  -d '{"connector":"openapi","endpoint":{"specUrl":"https://api.example.com/openapi.json"}}'
```

A connector tool's name as the model sees it is `<slug>__<tool name>` (such as `docs__search`). An agent definition selects tools by reference: `"tools":[{"kind":"connector","connectorId":"<id>","tools":"all"}]` (`"all"` = all currently enabled tools of that connector; you can also give an array of tool names).

**Auth methods** (`auth.type`; when `ownership` is `org`, the whole org shares one credential, and when it is `personal`, each member connects on their own, filling it in or authorizing under "Settings → My connections"):

| `auth.type` | Description | Credential |
|---|---|---|
| `none` | No authentication | — |
| `bearer` / `basic` / `api_key{in,name}` / `headers{names}` | Static credentials, stored encrypted and injected only at request time | `credential`: `{token}` / `{username,password}` / `{headers:{…}}`; after install, rotate with `PUT .../connectors/:connectorId/credentials/org` (personal credentials use `.../credentials/me`) |
| `oauth_code` (personal) | Authorization code + PKCE: each member clicks "Connect" and is redirected to log in at the authorization server; `discovery: "mcp"` discovers the authorization server automatically, and `client: "dcr"` registers the client automatically at install | If the authorization server doesn't support DCR, use `client: "manual"` and give `credential: {clientId, clientSecret?}` at install; you can also use `discovery: "manual"` and give `authorizationUrl` / `tokenUrl` |
| `oauth_client` (org) | Client credentials flow: the org shares one OAuth client to obtain tokens, verified at install | `credential: {clientId, clientSecret}`; rotate with `PUT .../credentials/org` |

- **OAuth needs `http.publicUrl`** (`CAPYBARA_HTTP__PUBLIC_URL`): set it to the **externally reachable origin of the web app (`apps/web`)**, such as `https://capybara.example.com`, not the kernel's own address. The callback URL is `<publicUrl>/api/v1/oauth/callback` and must be registered with the authorization server; it goes through the web app's `/api` proxy to the kernel. The binding cookie set when a connection starts is also set on the web origin through this proxy, and after the callback completes the user is redirected back to a web page under `<publicUrl>`, so all three must share one origin. When it isn't set, installing an OAuth app is rejected. Tokens are refreshed by the kernel automatically before they expire; if a refresh is rejected the credential is invalidated, and the member sees a "connection needed" card in the conversation.
- Credentials never enter the event log, the model context or audit; credential values that appear in tool results and errors are masked by the kernel. An endpoint's fixed headers and URL query can't contain credentials.

**Approval and the inbox**: the policy (`allow` / `ask` / `deny`) is derived from tool annotations by default (read-only → `allow`, everything else → `ask`); admins can change it per tool, and an agent can also tighten a tool. A call set to `ask` shows an approval card in the conversation and is also collected in the web app's "Inbox" (`/inbox`); when approving you can choose "this once / this conversation / always allow", and "always allow" grants can be viewed and revoked under "Settings → Remembered approvals" and become invalid as soon as the tool definition changes. An approval that goes past `tools.approvalTimeoutHours` (default 24) is treated as denied; an agent can't approve by itself. When a remote tool asks the user for input mid-call (MCP elicitation), an input card appears in the conversation. API: `/api/v1/orgs/:orgId/approvals`, `/questions`, `/me/tool-grants`.

**Tool definition drift**: the kernel re-reads a connector's tool list every `tools.driftIntervalHours` hours (default 24), when it receives a `list_changed` notification from the remote, and when an admin clicks "Refresh". New tools, and tools whose definition changed in any way, first go to "pending review", and the model can't use them until they are reviewed (approved / rejected); this prevents a remote from quietly changing tool descriptions.

**`ToolSearch`**: when an agent has more than `tools.searchThresholdTools` (30) tools available, or an estimated more than `tools.searchThresholdTokens` (8000) tokens of them, the kernel stops putting every definition into each request; it gives a tool catalog instead, and the model loads what it needs with `ToolSearch` by keyword. Org admins can turn it off under "Settings → Organization" (`PATCH /api/v1/orgs/:orgId/settings {"toolSearch":"off"}`).

**The `Platform` tool**: a builtin every new agent gets by default (`{"kind":"builtin","name":"Platform"}`). It lets an agent do what the person who started the run can do on the web: browse and read the org's skills, agents, plugins, connectors, models, conversations, approvals and inbox, and, for admins, the org's settings and the admin console. It always acts as that person, with their role re-read on every call. Reads run without asking. Every write shows an approval card with a summary written by the kernel (naming what changes); changes to your own things (your private agent, your conversations) can be remembered, org and platform changes are confirmed every time, and deletions are confirmed every time. A change known to fail (a taken name, an extension still missing its deployment config) is refused before the card, with the reason and the next step for your role. Never offered to an agent: deciding approvals and requests, confirming extension permissions, tokens and credential or secret values, roles and the super-admin flag (their state can be read, never the values). The super admin uses admin-console operations only through their own private agent; when it creates an account, the kernel generates a one-time password that only the approver sees once on the web, and the new user must change it at first sign-in. Org admins limit the tool under "Settings → Organization" (`PATCH /api/v1/orgs/:orgId/settings {"platformTool":"read-only"}`, or `"off"`; default `"on"`). Every write is audited as done through the agent.

**Extension tools must be enabled in the org first**: an extension's tools (such as `todo__write`) are available only in orgs that enabled that extension (connectors don't need this). For org admins:

```bash
curl -s -X PUT localhost:8080/api/v1/orgs/$ORG/extensions/todo -b cookies.txt \
  -H 'Content-Type: application/json' -H 'X-Capybara-Csrf: 1' -d '{"enabled":true}'
```

To write tools, see [.agents/skills/writing-tools](../../.agents/skills/writing-tools/SKILL.md); to write connectors, see [.agents/skills/writing-connectors](../../.agents/skills/writing-connectors/SKILL.md); for the related config (`tools.*`, `http.publicUrl`), see [docs/config.md](../config.md).
