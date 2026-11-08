# Connector cards and a member's own tool policies

- Status: decided by the maintainer during the rc.4 acceptance (2026-11-09) and implemented on
  `fix/acceptance`. Amends `2026-11-08-tools-default-on-design.md` §2 (`toolPolicies` is no longer
  tighten-only for connector tools) and spec §9 of
  `2026-11-05-plugin-component-management-design.md` (the workspace 连接器 page).
- Markers: **(decided)** is the maintainer's; **(designer's call)** may be overturned in review.

## 1. Why

Slack 0.1.0-rc.4 ships a connector template with `defaultEnabled: false` (OAuth code flow, personal
credentials, a manual OAuth client). The workspace `/connectors` page hid it completely: the only
way in was 插件 → Slack → the component switch. Once a member connected, nothing let them say which
of the connector's tools agents may call with their connection without asking.

## 2. The 连接器 page is cards (decided)

- One card per connector of the org, and one per connector template of a plugin on in the org that
  has no connector there yet, **switched off or not**. A template whose plugin is off in the org has
  no card (the plugin page turns it on). Each card shows its plugin's icon (a template without an
  icon of its own uses its plugin's; the share gate of `PluginIcons` holds).
- Template card, org admins: 未启用 with **启用** (the component switch, `PUT …/components/
  connector_template/:id/switch`), which then leads straight to entering the template's input (OAuth
  client id / secret, endpoint) with the existing 补充配置 wizard
  (`/plugins/<item>/connectors?from=connectors`, `POST …/catalog/:itemId/connectors`); 需要配置
  with **配置** for a template on without its connector. The wizard keeps a slot above the template's
  input for its setup guide (setup guides v2, a later task). Members read these cards without
  actions; guests see connector cards only (the template list is a catalog read).
- Connector card of a personal-credential connector: the viewer's own state. 未连接 with **连接**
  (OAuth: `POST …/connectors/:id/connect`, back to `/connectors`; static credentials: 我的连接);
  once connected, 已连接 with **权限** (§3). Org admins see the same for their own connection.

## 3. 权限: a member's own tool policies (decided)

- Per member (option B): the 权限 sheet edits the viewer's own policy per tool, 允许 / 询问 / 禁止,
  for **their own connection** of that connector. It applies to every agent the member uses. The
  default is marked; picking it clears the setting, so the tool follows the org default **(designer's
  call)**. Tools the org switched off, or set to deny, are shown locked. The sheet says that an agent
  can override the settings except a 禁止.
- Only personal-credential connectors have it (an org-credential connector: 409
  `connector.not_personal`); calls with an org credential are not "made with a member's connection".
- Storage: `capybara.connector_tool_account_policies` (migration 0104), one row per (connector,
  account, tool name), cascading with the connector, the account and the org.
- Routes: `GET` / `PUT /api/v1/orgs/:orgId/connectors/:connectorId/tool-policies/me`
  (`connectors.use`). The account is always the session's; there is no route that reads or writes
  another account's rows. `PUT { tools: { <name>: "allow" | "ask" | "deny" | null } }`; unknown tool
  -> 404 `connector.tool_not_found`; audited as `connector.member_policies_changed`.
- Platform tool: both routes are exclusions. The read is `internal` (the sheet's display list;
  `connectors.get` gives an agent the tools and their org defaults); the write is `human-only`: a
  member's own policies decide what agents may call with their connection without asking, and an
  agent must never loosen them for itself.

## 4. Resolution for one connector tool call (decided)

Highest first (`tools/policy.ts` `connectorPolicy`):

1. the org switched the tool off -> the tool is unavailable (as before);
   the org's default is `deny` -> denied **(designer's call: an org admin's deny was absolute
   before and stays a lock)**;
2. the member's own 禁止 -> denied: a floor no agent can lift;
3. the agent's setting for the tool (its tools page, `definition.toolPolicies`) -> that;
4. the member's own 允许 / 询问 -> that;
5. the org default `connector_tools.default_policy`: the annotation default unless an org admin
   changed it. `readOnlyHint: true` allows; write and delete tools (`readOnlyHint` false or absent,
   `destructiveHint` true) and tools with no annotations ask.

After this, as before: fixed asks (R3, `requiresUserInteraction`) make it at least ask, a `requiredRole`
escalates, and a remembered grant may let an ask through (never a deny).

- "The member" is the acting account of the call, `ctx.accountId`: the same account whose personal
  credential the pipeline injects. A sub-agent acts for its tree's account; a channel-triggered run
  acts for the sender's account (agent map spec §7). Another account's settings never apply.
- The agent's setting is the stricter of the set ones among the run's version, the agent's current
  version and (an org agent sub-agent) the parent agent's current version. An `allow` the owner
  removed from the current version stops applying at once (removing it tightens).
- `toolPolicies` accepts `allow` only on a connector tool key; on any other key it is refused at save
  (400 `validation_failed` at `toolPolicies.<key>`), and other tools stay tighten-only. Agent
  templates stay tighten-only: saving an agent as a template drops its `allow` entries, and a
  sub-agent's effective definition keeps only `ask` / `deny` (the parent's `allow` reaches the child
  through the parent's current version).
- The agent's tools page offers 允许 for connector tools and says that a member's own 禁止 still
  blocks the tool for that member.
- `approval_requested.policy` gains `member` (the member's own 询问 asked).
