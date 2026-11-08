export type ExclusionCategory = "human-only" | "secret" | "transport" | "internal";

/**
 * Kernel HTTP routes the `Platform` tool does not mirror, each with a reason (spec §9);
 * `check:platform-ops` fails a route that is neither mirrored by an operation nor listed here.
 * Every exclusion is for good: there is no "later" (rule `platform-op-later`).
 */

export const PLATFORM_EXCLUSIONS: readonly {
  route: string;
  category: ExclusionCategory;
  reason: string;
}[] = [
  // platform-admin: every route is an operation (Task 7)
  // extensions-admin
  {
    route: "GET /api/v1/admin/extensions/:name/org-overrides",
    category: "secret",
    reason: "Lists every org's config copy of an extension: cross-org config state",
  },
  {
    route: "GET /api/v1/admin/extensions/:name/config",
    category: "secret",
    reason: "Returns deployment config that can include secret fields",
  },
  {
    route: "PUT /api/v1/admin/extensions/:name/config",
    category: "secret",
    reason: "Writes deployment config that can include secret fields",
  },
  {
    route: "DELETE /api/v1/admin/extensions/:name/config",
    category: "secret",
    reason: "Clears deployment config including secret values; done on the web",
  },
  {
    route: "POST /api/v1/admin/extensions/:name/approve",
    category: "human-only",
    reason: "Approves an extension's permission manifest, a trust decision",
  },
  {
    route: "POST /api/v1/admin/extensions/:name/install",
    category: "human-only",
    reason:
      "Points an extension at a package from the package store (a new install or a version change); the package comes from an upload or npm import whose permissions a person reviews, and new permissions wait for that person's approval, so the install stays with the review on the web",
  },
  {
    route: "POST /api/v1/admin/extensions/packages/file",
    category: "transport",
    reason: "Uploads a package file as multipart bytes",
  },
  {
    route: "POST /api/v1/admin/extensions/packages/npm",
    category: "human-only",
    reason:
      "Fetches an extension package and returns its permission review; installing it means confirming those permissions, which only a person does (spec §6.4)",
  },
  // setup
  {
    route: "GET /api/v1/setup",
    category: "internal",
    reason: "First-run setup status used by the web app before any login",
  },
  {
    route: "POST /api/v1/setup",
    category: "human-only",
    reason: "Creates the first super admin account and password",
  },
  // agents
  {
    route: "POST /api/v1/orgs/:orgId/agents/:agentId/avatar/uploads",
    category: "transport",
    reason: "Creates a presigned avatar upload",
  },
  {
    route: "GET /api/v1/orgs/:orgId/agents/:agentId/avatar",
    category: "transport",
    reason: "Streams avatar image bytes",
  },
  {
    route: "POST /api/v1/orgs/:orgId/agents/:agentId/owner",
    category: "human-only",
    reason: "Transfers ownership of an agent to another person",
  },
  // background
  {
    route: "GET /api/v1/orgs/:orgId/conversations/:id/background-tasks/:taskId/output",
    category: "transport",
    reason: "Streams raw task output bytes",
  },
  // catalog-admin
  {
    route: "POST /api/v1/admin/catalog/import/file",
    category: "transport",
    reason: "Uploads a plugin archive as multipart bytes",
  },
  {
    route: "POST /api/v1/admin/catalog/imports/:stagingId/confirm",
    category: "human-only",
    reason: "Confirms an import review, an approval decision by the super admin",
  },
  {
    route: "GET /api/v1/admin/catalog/items/:id/icon",
    category: "transport",
    reason: "Serves icon image bytes",
  },
  {
    route: "POST /api/v1/admin/catalog/items/:id/confirm",
    category: "human-only",
    reason: "Confirms a catalog item's reviewed changes, an approval decision",
  },
  {
    route: "POST /api/v1/admin/catalog/items/:id/reject",
    category: "human-only",
    reason: "Rejects a catalog item's reviewed changes, an approval decision",
  },
  // components
  {
    route: "POST /api/v1/admin/components/skill/:id/versions",
    category: "transport",
    reason: "Uploads a platform skill package as raw bytes",
  },
  // marketplaces
  // org-catalog
  {
    route: "GET /api/v1/orgs/:orgId/catalog/:itemId/icon",
    category: "transport",
    reason: "Serves icon image bytes",
  },
  {
    route: "POST /api/v1/orgs/:orgId/catalog/:itemId/install",
    category: "secret",
    reason:
      "Install body carries connector credentials, client secrets and extension config entered by a person",
  },
  {
    route: "POST /api/v1/orgs/:orgId/catalog/:itemId/connectors",
    category: "secret",
    reason: "Body carries connector credentials and client secrets entered by a person",
  },
  {
    route: "POST /api/v1/orgs/:orgId/connector-templates/:templateId/connectors",
    category: "secret",
    reason: "Body carries connector credentials and client secrets entered by a person",
  },
  {
    route: "POST /api/v1/orgs/:orgId/catalog-requests/:id/decide",
    category: "human-only",
    reason: "Decides another person's catalog request",
  },
  {
    route: "POST /api/v1/orgs/:orgId/catalog-requests/:id/dismiss",
    category: "human-only",
    reason: "Dismisses another person's catalog request",
  },
  {
    route: "POST /api/v1/admin/catalog/requests/:id/decide",
    category: "human-only",
    reason: "Decides an org's catalog request as super admin",
  },
  {
    route: "PUT /api/v1/orgs/:orgId/extensions/:extension",
    category: "secret",
    reason: "Org extension config may hold secret fields",
  },
  {
    route: "GET /api/v1/orgs/:orgId/extensions/:extension/overrides",
    category: "secret",
    reason: "The org's copy of an extension's deployment config, with secret fields as set or not",
  },
  {
    route: "PUT /api/v1/orgs/:orgId/extensions/:extension/overrides",
    category: "secret",
    reason: "Saves the org's config copy, including the org's own secrets entered in the same save",
  },
  {
    route: "DELETE /api/v1/orgs/:orgId/extensions/:extension/overrides",
    category: "secret",
    reason:
      "Drops the org's config copy and its secrets; part of the config-copy lifecycle on the web",
  },
  {
    route: "POST /api/v1/orgs/:orgId/extensions/:extension/overrides/take",
    category: "secret",
    reason: "Starts an org config copy whose secrets a person enters on the web",
  },
  // org-uploads
  {
    route: "POST /api/v1/orgs/:orgId/catalog/uploads/file",
    category: "transport",
    reason: "Uploads a plugin archive as multipart bytes",
  },
  {
    route: "POST /api/v1/orgs/:orgId/catalog/uploads/:stagingId/confirm",
    category: "human-only",
    reason: "Confirms an upload review, an approval decision",
  },
  // channels
  {
    route: "GET /api/v1/orgs/:orgId/channels/schema/:plugin",
    category: "internal",
    reason:
      "The config form schema of the create and credential routes, which stay on the web; an agent has no use for it",
  },
  {
    route: "POST /api/v1/orgs/:orgId/channels",
    category: "secret",
    reason: "Creates a channel connection with app secrets",
  },
  // attachments
  {
    route: "GET /api/v1/orgs/:orgId/attachments/limits",
    category: "internal",
    reason: "The composer's pre-upload check on the web; an agent does not upload attachments",
  },
  {
    route: "POST /api/v1/orgs/:orgId/attachments",
    category: "transport",
    reason: "Creates a presigned attachment upload",
  },
  {
    route: "POST /api/v1/orgs/:orgId/attachments/:id/finalize",
    category: "transport",
    reason: "Finishes a presigned attachment upload",
  },
  {
    route: "GET /api/v1/orgs/:orgId/attachments/:id/download",
    category: "transport",
    reason: "Serves attachment file bytes",
  },
  // conversations
  {
    route: "POST /api/v1/orgs/:orgId/conversations",
    category: "internal",
    reason:
      "Starting a conversation starts a run the person must watch and own; an agent cannot open conversations on their behalf, and the web does it on first send",
  },
  {
    route: "GET /api/v1/orgs/:orgId/conversations/groups",
    category: "internal",
    reason:
      "The sidebar's per-agent grouping of the same rows; conversations.list with its agentId filter returns the same data",
  },
  {
    route: "GET /api/v1/orgs/:orgId/conversations/:id/outputs/:outputId",
    category: "transport",
    reason: "Serves archived tool output bytes",
  },
  {
    route: "GET /api/v1/orgs/:orgId/conversations/:id/artifacts/:artifactId/download",
    category: "transport",
    reason: "Serves artifact file bytes",
  },
  {
    route: "GET /api/v1/orgs/:orgId/conversations/:id/artifacts/:artifactId/preview",
    category: "transport",
    reason: "Serves artifact preview bytes",
  },
  {
    route: "GET /api/v1/orgs/:orgId/conversations/:id/files/:fileId/content",
    category: "transport",
    reason: "Serves sandbox file bytes",
  },
  // environments (personal cloud environments, environments design phase 1)
  {
    route: "GET /api/v1/orgs/:orgId/conversations/:id/tools",
    category: "internal",
    reason:
      "Titles and key arguments for the web's tool rows, derived from the event log that conversations.events returns",
  },
  {
    route: "POST /api/v1/orgs/:orgId/conversations/:id/messages",
    category: "internal",
    reason:
      "Sending a message to a conversation starts a run in the person's name; runs are started by the person, not by another run",
  },
  {
    route: "GET /api/v1/orgs/:orgId/conversations/:id/queue",
    category: "internal",
    reason:
      "Deprecated message queue the web no longer uses; leftover items drain until the table is dropped",
  },
  {
    route: "POST /api/v1/orgs/:orgId/conversations/:id/queue",
    category: "internal",
    reason: "Deprecated alias of POST messages, which stays with the person",
  },
  {
    route: "POST /api/v1/orgs/:orgId/conversations/:id/queue/resume",
    category: "internal",
    reason:
      "Deprecated message queue the web no longer uses; leftover items drain until the table is dropped",
  },
  {
    route: "PATCH /api/v1/orgs/:orgId/conversations/:id/queue/:itemId",
    category: "internal",
    reason:
      "Deprecated message queue the web no longer uses; leftover items drain until the table is dropped",
  },
  {
    route: "DELETE /api/v1/orgs/:orgId/conversations/:id/queue/:itemId",
    category: "internal",
    reason:
      "Deprecated message queue the web no longer uses; leftover items drain until the table is dropped",
  },
  {
    route: "POST /api/v1/orgs/:orgId/conversations/:id/queue/:itemId/send",
    category: "internal",
    reason: "Deprecated queue item send; sending a message stays with the person",
  },
  // evals
  {
    route: "GET /api/v1/orgs/:orgId/trajectories",
    category: "human-only",
    reason: "Lists other people's conversation trajectories, audited as a human review",
  },
  {
    route: "GET /api/v1/orgs/:orgId/trajectories/:conversationId",
    category: "human-only",
    reason: "Reads a full trajectory of someone's conversation, audited as a human review",
  },
  // extension-points
  // previewers
  {
    route: "GET /api/v1/orgs/:orgId/conversations/:id/files/:fileId/previewers",
    category: "transport",
    reason: "Previewer lookup feeding the file viewer",
  },
  {
    route: "GET /api/v1/orgs/:orgId/conversations/:id/files/:fileId/previews/:plugin/:previewerId",
    category: "transport",
    reason: "Serves a rendered file preview",
  },
  // identity
  {
    route: "POST /api/v1/orgs/:orgId/approvals/:approvalId/initial-password",
    category: "secret",
    reason:
      "Returns a generated initial password once, on the web, to the person who approved the account creation",
  },
  { route: "POST /api/v1/auth/login", category: "human-only", reason: "Password login" },
  { route: "POST /api/v1/auth/refresh", category: "human-only", reason: "Rotates a refresh token" },
  { route: "POST /api/v1/auth/logout", category: "human-only", reason: "Ends the login session" },
  {
    route: "GET /api/v1/me",
    category: "internal",
    reason:
      "Account profile the web app loads for its own session; not an operation an agent needs",
  },
  {
    route: "PUT /api/v1/me/current-org",
    category: "human-only",
    reason: "Switches the web session's current org",
  },
  {
    route: "GET /api/v1/me/preferences",
    category: "internal",
    reason:
      "The person's time zone setting the web's preferences page reads; the run context already gives the agent the zone in effect",
  },
  {
    route: "PUT /api/v1/me/preferences",
    category: "human-only",
    reason: "A person's own time zone setting, chosen on their preferences page",
  },
  {
    route: "PUT /api/v1/me/password",
    category: "human-only",
    reason: "Changes the account password",
  },
  {
    route: "POST /api/v1/me/tokens",
    category: "human-only",
    reason: "Creates a personal access token",
  },
  {
    route: "GET /api/v1/me/tokens",
    category: "human-only",
    reason: "Lists personal access tokens",
  },
  {
    route: "DELETE /api/v1/me/tokens/:tokenId",
    category: "human-only",
    reason: "Revokes a personal access token",
  },
  {
    route: "GET /api/v1/auth/sources",
    category: "internal",
    reason: "Login source list the web sign-in page renders; no agent use",
  },
  {
    route: "GET /api/v1/auth/sso/:plugin/start",
    category: "secret",
    reason: "Starts an SSO login with state and PKCE",
  },
  {
    route: "GET /api/v1/auth/sso/:plugin/callback",
    category: "secret",
    reason: "Completes an SSO login from the identity provider",
  },
  {
    route: "GET /api/v1/bind/:token",
    category: "human-only",
    reason: "Shows a one-time identity binding link",
  },
  {
    route: "POST /api/v1/bind/:token",
    category: "human-only",
    reason: "Binds an external identity to an account",
  },
  {
    route: "GET /api/v1/me/identities",
    category: "human-only",
    reason: "Lists the account's linked login identities",
  },
  {
    route: "DELETE /api/v1/me/identities/:source/:externalId",
    category: "human-only",
    reason: "Unlinks a login identity",
  },
  // health
  { route: "GET /healthz", category: "transport", reason: "Liveness probe for the orchestrator" },
  { route: "GET /readyz", category: "transport", reason: "Readiness probe for the orchestrator" },
  // models
  // orgs
  {
    route: "POST /api/v1/orgs/:orgId/extensions/:extension/directory/sync",
    category: "human-only",
    reason: "Adds and removes org members from the directory; only an admin, by hand, starts it",
  },
  {
    route: "POST /api/v1/orgs/:orgId/invitations",
    category: "human-only",
    reason: "Invites a person into the org",
  },
  {
    route: "GET /api/v1/orgs/:orgId/invitations",
    category: "human-only",
    reason: "Lists invitations with their tokens",
  },
  {
    route: "DELETE /api/v1/orgs/:orgId/invitations/:id",
    category: "human-only",
    reason: "Revokes an invitation",
  },
  {
    route: "GET /api/v1/invitations/:token",
    category: "human-only",
    reason: "Shows an invitation to its recipient",
  },
  {
    route: "POST /api/v1/invitations/:token/accept",
    category: "human-only",
    reason: "Accepts an invitation into an org",
  },
  {
    route: "POST /api/v1/orgs",
    category: "human-only",
    reason: "Creates an org and makes the caller its owner",
  },
  {
    route: "GET /api/v1/orgs",
    category: "internal",
    reason:
      "The web's org switcher across the caller's orgs; an agent works in its conversation's org (orgs.current)",
  },
  { route: "DELETE /api/v1/orgs/:orgId", category: "human-only", reason: "Deletes the whole org" },
  {
    route: "POST /api/v1/orgs/:orgId/transfer",
    category: "human-only",
    reason: "Transfers org ownership",
  },
  {
    route: "POST /api/v1/orgs/:orgId/leave",
    category: "human-only",
    reason: "Removes the caller from the org",
  },
  {
    route: "PATCH /api/v1/orgs/:orgId/members/:accountId",
    category: "human-only",
    reason: "Changes a member's role",
  },
  {
    route: "DELETE /api/v1/orgs/:orgId/members/:accountId",
    category: "human-only",
    reason: "Removes a member from the org",
  },
  {
    route: "POST /api/v1/orgs/:orgId/service-tokens",
    category: "human-only",
    reason: "Creates a service token",
  },
  {
    route: "GET /api/v1/orgs/:orgId/service-tokens",
    category: "human-only",
    reason: "Lists service tokens",
  },
  {
    route: "DELETE /api/v1/orgs/:orgId/service-tokens/:tokenId",
    category: "human-only",
    reason: "Revokes a service token",
  },
  // runtime
  {
    route: "GET /api/v1/orgs/:orgId/conversations/:id/runs/:runId/draft",
    category: "transport",
    reason: "Streams the in-progress draft of a run",
  },
  {
    route: "GET /api/v1/orgs/:orgId/conversations/:id/stream",
    category: "transport",
    reason: "Server-sent event stream of a conversation",
  },
  // skills
  {
    route: "POST /api/v1/orgs/:orgId/skill-changes/:id/decide",
    category: "human-only",
    reason: "Decides a proposed skill change",
  },
  {
    route: "POST /api/v1/orgs/:orgId/skills/uploads",
    category: "transport",
    reason: "Uploads a skill archive as multipart bytes",
  },
  // approvals
  {
    route: "POST /api/v1/orgs/:orgId/approvals/:id/decision",
    category: "human-only",
    reason:
      "Decides a tool permission approval; only the person decides (spec §6.4); reading what waits is approvals.waiting / approvals.get",
  },
  {
    route: "GET /api/v1/orgs/:orgId/me/tool-grants",
    category: "human-only",
    reason: "Lists the caller's standing permission grants",
  },
  {
    route: "DELETE /api/v1/orgs/:orgId/me/tool-grants/:agentId/:toolKey",
    category: "human-only",
    reason: "Revokes a standing permission grant",
  },
  // connectors
  {
    route: "GET /api/v1/orgs/:orgId/connectors/prompts",
    category: "internal",
    reason:
      "Feeds the slash menu of the web input box: prompt templates of remote servers, written for a person to fill in and send; an agent has no one to send them to",
  },
  {
    route: "GET /api/v1/orgs/:orgId/connectors/resources",
    category: "internal",
    reason:
      "Feeds the @ reference picker of the web input box; an agent reads connector resources through its connector tools",
  },
  {
    route: "POST /api/v1/orgs/:orgId/connectors/:connectorId/prompts/:name",
    category: "internal",
    reason:
      "Renders a remote server's prompt into text for the web input box, for the person to send; it calls the server with the person's own credential",
  },
  {
    route: "GET /api/v1/orgs/:orgId/connectors/kinds",
    category: "internal",
    reason:
      "The protocols the web's create-connector form offers; creating a connector stays on the web (secret credentials)",
  },
  {
    route: "POST /api/v1/orgs/:orgId/connectors",
    category: "secret",
    reason: "Creates a connector whose endpoint config can carry credentials",
  },
  {
    route: "POST /api/v1/orgs/:orgId/connectors/preview",
    category: "secret",
    reason: "Preview body carries a connector credential entered by a person",
  },
  {
    route: "PATCH /api/v1/orgs/:orgId/connectors/:connectorId",
    category: "secret",
    reason: "Edits connector endpoint config that can carry credentials",
  },
  {
    route: "POST /api/v1/orgs/:orgId/connectors/:connectorId/tools/:name/review",
    category: "human-only",
    reason: "Reviews a connector tool change, an approval decision",
  },
  {
    route: "PUT /api/v1/orgs/:orgId/connectors/:connectorId/credentials/org",
    category: "secret",
    reason: "Writes the org's connector credentials",
  },
  {
    route: "PUT /api/v1/orgs/:orgId/connectors/:connectorId/credentials/me",
    category: "secret",
    reason: "Writes the caller's connector credentials",
  },
  {
    route: "DELETE /api/v1/orgs/:orgId/connectors/:connectorId/credentials/me",
    category: "secret",
    reason: "Deletes the caller's connector credentials",
  },
  {
    route: "GET /api/v1/orgs/:orgId/tools/extensions",
    category: "internal",
    reason:
      "Display list of the agent form's tools picker; extensions.tools gives an agent the same facts",
  },
  {
    route: "POST /api/v1/orgs/:orgId/connectors/:connectorId/connect",
    category: "secret",
    reason: "Starts a connector OAuth flow",
  },
  {
    route: "GET /api/v1/oauth/callback",
    category: "secret",
    reason: "Receives the OAuth authorization code",
  },
  {
    route: "GET /api/v1/orgs/:orgId/questions/:id",
    category: "human-only",
    reason: "Shows a question put to a person by an agent",
  },
  {
    route: "POST /api/v1/orgs/:orgId/questions/:id/answer",
    category: "human-only",
    reason: "Answers a question put to a person",
  },
  // ui
  {
    route: "GET /api/v1/orgs/:orgId/ui/contributions",
    category: "internal",
    reason: "Navigation entries of the web shell (panels, pages, embeds); nothing an agent acts on",
  },
  {
    route: "GET /api/v1/orgs/:orgId/ui/views/:plugin/:id",
    category: "transport",
    reason: "Renders an extension UI view for the web app",
  },
  {
    route: "POST /api/v1/orgs/:orgId/ui/actions/:plugin/:id",
    category: "transport",
    reason: "Runs an extension UI action from the web app",
  },
  {
    route: "POST /api/v1/orgs/:orgId/ui/embeds/:plugin/:id/token",
    category: "transport",
    reason: "Issues an embed token for an iframe",
  },
  {
    route: "GET /api/v1/orgs/:orgId/ui/stream",
    category: "transport",
    reason: "Server-sent event stream of UI invalidations",
  },
];
