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
  {
    route: "GET /api/v1/orgs/:orgId/conversations/:id/permissions",
    category: "human-only",
    reason: "Interactive owner session permission selection and device-bound consent",
  },
  {
    route: "PATCH /api/v1/orgs/:orgId/conversations/:id/permissions",
    category: "human-only",
    reason: "Interactive owner session permission selection and device-bound consent",
  },
  {
    route: "GET /api/v1/orgs/:orgId/conversation-permission-preview",
    category: "human-only",
    reason: "Interactive owner session permission selection and device-bound consent",
  },
  {
    route: "POST /api/v1/orgs/:orgId/conversations/first-message",
    category: "human-only",
    reason: "Interactive owner session permission selection and device-bound consent",
  },
  // platform-admin: every route is an operation (Task 7)
  // extensions-admin
  {
    route: "GET /api/v1/admin/extensions/:name/org-overrides",
    category: "secret",
    reason:
      "Delivers other orgs' config copies of an extension (which differ, which secrets each holds) to the super admin's browser; an agent works in its own org",
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
      "Points an extension at a package from the package store (a new install or a version change); the package comes from an npm import or a stored package whose permissions a person reviews, and new permissions wait for that person's approval, so the install stays with the review the person confirms",
  },
  {
    route: "POST /api/v1/admin/extensions/packages/npm",
    category: "human-only",
    reason:
      "Fetches an extension package and returns its permission review; installing it means confirming those permissions, which only a person does (spec §6.4)",
  },
  // meta
  {
    route: "GET /api/v1/meta",
    category: "transport",
    reason: "Pre-sign-in discovery for native clients: platform name, icon and protocol ranges",
  },
  // native-app sign-in (desktop client spec §6.5)
  {
    route: "POST /api/v1/app-auth/authorize",
    category: "human-only",
    reason: "A person consents in the browser to sign a native app in",
  },
  {
    route: "POST /api/v1/app-auth/token",
    category: "transport",
    reason: "A native app exchanges a one-time sign-in code; nothing for an agent",
  },
  // setup
  {
    route: "GET /api/v1/setup",
    category: "internal",
    reason:
      "First-run setup status the web app reads before any login, with no org and no actor yet; no operation gives it, an agent exists only after setup",
  },
  {
    route: "POST /api/v1/setup",
    category: "human-only",
    reason: "Creates the first super admin account and password",
  },
  // agents
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
  {
    route: "POST /api/v1/admin/agents/:agentId/owner",
    category: "human-only",
    reason:
      "Transfers ownership of an org's agent to another person on the platform's behalf, as the org's own transfer route",
  },
  // accounts
  {
    route: "GET /api/v1/accounts/:accountId/avatar",
    category: "transport",
    reason: "Redirects to the avatar image for <img>; no agent use",
  },
  // background
  {
    route: "GET /api/v1/orgs/:orgId/conversations/:id/background-tasks/:taskId/output",
    category: "transport",
    reason: "Streams raw task output bytes",
  },
  // catalog-admin
  {
    route: "POST /api/v1/admin/catalog/imports/:stagingId/confirm",
    category: "human-only",
    reason: "Confirms an import review, an approval decision by the super admin",
  },
  {
    route: "POST /api/v1/admin/catalog/imports/:stagingId/update",
    category: "human-only",
    reason:
      "Confirms an import review together with the platform update it applies, an approval decision by the super admin",
  },
  {
    route: "GET /api/v1/admin/catalog/items/:id/icon",
    category: "transport",
    reason: "Serves icon image bytes",
  },
  {
    route: "GET /api/v1/admin/catalog/:itemId/guides/:guideId",
    category: "internal",
    reason:
      "The super admin's preview of a plugin's setup guide for the admin console, with no org and no target; no operation gives it, agents assist with the org guides an org member sees (channels.schema, connectors.kinds)",
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
  // marketplaces
  {
    route: "GET /api/v1/admin/marketplaces/:id/icons/:sha256",
    category: "transport",
    reason: "Serves icon image bytes",
  },
  {
    route: "GET /api/v1/orgs/:orgId/marketplaces/:id/icons/:sha256",
    category: "transport",
    reason: "Serves icon image bytes",
  },
  // org-catalog
  {
    route: "GET /api/v1/orgs/:orgId/catalog/:itemId/icon",
    category: "transport",
    reason: "Serves icon image bytes",
  },
  {
    route: "POST /api/v1/orgs/:orgId/catalog-requests/network",
    category: "human-only",
    reason:
      "A member asks org admins to allow a domain from a blocked command's card; agents never file network requests",
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
  // org-uploads
  {
    route: "POST /api/v1/orgs/:orgId/catalog/uploads/:stagingId/confirm",
    category: "human-only",
    reason:
      "Confirms a staged plugin review (reached by the link card of the staged plugin), a trust decision by the person",
  },
  // channels
  // attachments
  {
    route: "GET /api/v1/orgs/:orgId/attachments/limits",
    category: "internal",
    reason:
      "The composer's size check for a person's file into a conversation; an agent gets files by file reference, not by attaching",
  },
  {
    route: "POST /api/v1/orgs/:orgId/attachments",
    category: "internal",
    reason:
      "Registers a person's file into a conversation from the composer; an agent gets files by file reference (fileId), not through attachments",
  },
  {
    route: "POST /api/v1/orgs/:orgId/attachments/:id/finalize",
    category: "internal",
    reason:
      "Finishes a person's file into a conversation from the composer; an agent gets files by file reference (fileId), not through attachments",
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
  // git gateway (sandbox git credentials spec §5): `GET` / `POST /git/v1/*` is git smart-HTTP for
  // sandboxes, authenticated by run tickets, not an API; it is a raw api-role Fastify route
  // (`git/gateway.route.ts`), not a Nest controller, so it is not listed (like the webhook)
  // devices (personal cloud devices, environments design phase 1)
  // connected machines (environments design phase 2): device sign-in by the program and on the
  // confirmation page, and disconnecting a machine. The machine's WebSocket (`GET /device/connect`)
  // is a raw gateway-role route, not a Nest controller, so it is not listed (like the webhook)
  {
    route: "DELETE /api/v1/orgs/:orgId/devices/:id/machine",
    category: "human-only",
    reason:
      "Disconnects a person's own machine (revokes its credential); a trust decision taken on the device's page",
  },
  {
    route: "POST /api/v1/orgs/:orgId/devices/:id/policy",
    category: "human-only",
    reason:
      "A person narrows their own machine's sandbox (hosts, network, running outside the sandbox) on its device page; widening happens on the machine, never through an agent",
  },
  {
    route: "POST /api/v1/device/authorize",
    category: "transport",
    reason:
      "Issues a sign-in code pair to the capybara-device program, which has no credential yet",
  },
  {
    route: "POST /api/v1/device/token",
    category: "transport",
    reason: "The capybara-device program polls for its machine credential",
  },
  {
    route: "GET /api/v1/device/pending/:userCode",
    category: "human-only",
    reason: "Shows the machine behind a code the person read off their own machine",
  },
  {
    route: "POST /api/v1/device/confirm",
    category: "human-only",
    reason:
      "Lets a machine run commands for the person; only the person, signed in on the web, confirms it",
  },
  {
    route: "POST /api/v1/device/deny",
    category: "human-only",
    reason: "Refuses a machine's sign-in code on the confirmation page",
  },
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
  // shares of conversation files (file sharing spec §10); listing and revoking are operations
  {
    route: "POST /api/v1/orgs/:orgId/conversations/:id/files/:fileId/shares",
    category: "human-only",
    reason: "Publishing a file outside the conversation is a person's act",
  },
  {
    route: "POST /api/v1/orgs/:orgId/shares/:shareId/refresh",
    category: "human-only",
    reason: "Publishing a file outside the conversation is a person's act",
  },
  {
    route: "GET /api/v1/orgs/:orgId/conversations/:id/files/:fileId/shares",
    category: "internal",
    reason: "The right panel's per-file view; conversations.list-shares lists the same shares",
  },
  // the HTML document (file sharing spec §4, §10)
  {
    route: "POST /api/v1/orgs/:orgId/conversations/:id/files/:fileId/html-token",
    category: "transport",
    reason: "Mints the HTML document's load token for the web panel",
  },
  {
    route: "GET /api/v1/html/*",
    category: "transport",
    reason: "Serves a sandboxed HTML document",
  },
  // public share links (file sharing spec §3, §10): the link's code is the authority
  {
    route: "GET /api/v1/s/:code",
    category: "transport",
    reason: "Public share link: the shared file's metadata for the share page",
  },
  {
    route: "GET /api/v1/s/:code/content",
    category: "transport",
    reason: "Public share link: streams the shared snapshot's bytes",
  },
  {
    route: "GET /api/v1/s/:code/text",
    category: "transport",
    reason: "Public share link: the shared text for the share page's preview",
  },
  {
    route: "GET /api/v1/s/:code/inline",
    category: "transport",
    reason: "Public share link: the shared image shown in place",
  },
  {
    route: "GET /api/v1/s/:code/html",
    category: "transport",
    reason: "Public share link: redirects to the sandboxed HTML document",
  },
  {
    route: "POST /api/v1/s/:code/embed-token/:plugin/:previewerId",
    category: "transport",
    reason: "Public share link: a share-scoped embed token for the share page's embed previewer",
  },
  {
    route: "GET /api/v1/s/:code/previews/:plugin/:previewerId",
    category: "transport",
    reason: "Public share link: a view previewer rendered for the shared snapshot",
  },
  // identity
  {
    route: "POST /api/v1/orgs/:orgId/approvals/:approvalId/initial-password",
    category: "secret",
    reason:
      "Returns a generated initial password once, on the web, to the person who approved the account creation",
  },
  {
    route: "POST /api/v1/orgs/:orgId/approvals/:approvalId/invitation-link",
    category: "secret",
    reason:
      "Returns an invitation link once, on the web, to the person who approved the orgs.invite call",
  },
  { route: "POST /api/v1/auth/login", category: "human-only", reason: "Password login" },
  { route: "POST /api/v1/auth/refresh", category: "human-only", reason: "Rotates a refresh token" },
  { route: "POST /api/v1/auth/logout", category: "human-only", reason: "Ends the login session" },
  {
    route: "GET /api/v1/me",
    category: "internal",
    reason:
      "Account profile the web app loads for its own session; platform.me gives an agent the same facts",
  },
  {
    route: "PUT /api/v1/me/current-org",
    category: "human-only",
    reason: "Switches the web session's current org",
  },
  {
    route: "PATCH /api/v1/me/profile",
    category: "human-only",
    reason: "Changes the person's own name and avatar",
  },
  {
    route: "POST /api/v1/me/avatar/uploads",
    category: "human-only",
    reason: "The person's own avatar: only the person sets it, an agent never does",
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
    route: "POST /api/v1/me/push-registrations",
    category: "human-only",
    reason: "Registers the person's own app install for push; a device action of the person's app",
  },
  {
    route: "DELETE /api/v1/me/push-registrations/:id",
    category: "human-only",
    reason:
      "Removes one of the person's app installs from push (sign-out, profile removal, settings)",
  },
  {
    route: "GET /api/v1/me/push-registrations",
    category: "human-only",
    reason: "Lists the person's own app installs that receive push, for the settings page",
  },
  {
    route: "GET /api/v1/auth/sources",
    category: "internal",
    reason:
      "Login source list the web sign-in page renders before a session exists; no operation gives it, a signed-in agent has nothing to choose",
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
  // approvals
  {
    route: "POST /api/v1/orgs/:orgId/approvals/:id/decision",
    category: "human-only",
    reason:
      "Decides a tool permission approval or a network ask; only the person decides (spec §6.4); a person must decide network access on their own device; reading what waits is approvals.waiting / approvals.get",
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
      "Feeds the slash menu of the web input box: prompt templates of remote servers, written for a person to fill in and send; no operation gives them, an agent has no one to send them to",
  },
  {
    route: "GET /api/v1/orgs/:orgId/connectors/resources",
    category: "internal",
    reason:
      "Feeds the @ reference picker of the web input box; no operation gives it, an agent reads connector resources through its connector tools",
  },
  {
    route: "POST /api/v1/orgs/:orgId/connectors/:connectorId/prompts/:name",
    category: "internal",
    reason:
      "Renders a remote server's prompt into text for the web input box, for the person to send; it calls the server with the person's own credential",
  },
  {
    route: "POST /api/v1/orgs/:orgId/connectors/:connectorId/tools/:name/review",
    category: "human-only",
    reason: "Reviews a connector tool change, an approval decision",
  },
  {
    route: "GET /api/v1/orgs/:orgId/connectors/:connectorId/tool-policies/me",
    category: "internal",
    reason:
      "Display list of the connector card's 权限 sheet; connectors.get gives an agent the tools and their org defaults",
  },
  {
    route: "PUT /api/v1/orgs/:orgId/connectors/:connectorId/tool-policies/me",
    category: "human-only",
    reason:
      "A member's own tool policies decide what agents may call with their connection without asking; an agent must never loosen them for itself",
  },
  {
    route: "GET /api/v1/orgs/:orgId/tools/extensions",
    category: "internal",
    reason:
      "Display list of the agent form's tools picker; extensions.tools gives an agent the same facts",
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
    reason:
      "Navigation entries of the web shell (panels, pages, embeds); ui.slots gives an agent the slots, nothing else here is acted on",
  },
  {
    route: "GET /api/v1/orgs/:orgId/ui/arrangement",
    category: "internal",
    reason:
      "Listing for the 界面位置 page; the arrangement is read and written through org-settings / admin settings",
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
  {
    route: "GET /api/v1/admin/ui/contributions",
    category: "internal",
    reason:
      "Navigation entries of the admin console (platform pages); ui.slots gives an agent the slots, nothing else here is acted on",
  },
  {
    route: "GET /api/v1/admin/ui/arrangement",
    category: "internal",
    reason:
      "Listing for the 界面位置 page; the arrangement is read and written through org-settings / admin settings",
  },
  {
    route: "GET /api/v1/admin/ui/views/:plugin/:id",
    category: "transport",
    reason: "Renders an extension UI view for the web app",
  },
  {
    route: "POST /api/v1/admin/ui/actions/:plugin/:id",
    category: "transport",
    reason: "Runs an extension UI action from the web app",
  },
  {
    route: "POST /api/v1/admin/ui/embeds/:plugin/:id/token",
    category: "transport",
    reason: "Issues an embed token for an iframe",
  },
  {
    route: "GET /api/v1/admin/ui/stream",
    category: "transport",
    reason: "Server-sent event stream of UI invalidations",
  },
  // client extensions (client extensions spec §9.2-§9.3)
  {
    route: "GET /api/v1/client/:plugin/:build/*",
    category: "transport",
    reason: "Serves a plugin's client code, stylesheets and assets to the browser that runs them",
  },
  {
    route: "GET /api/v1/orgs/:orgId/ui/client",
    category: "internal",
    reason:
      "The web shell's list of client code to load (file URLs and integrity); no operation gives it, nothing an agent acts on",
  },
  {
    route: "GET /api/v1/admin/ui/client",
    category: "internal",
    reason:
      "The admin console's list of platform page client code to load; no operation gives it, nothing an agent acts on",
  },
  {
    route: "POST /api/v1/orgs/:orgId/ui/client/reports",
    category: "transport",
    reason: "Fire-and-forget crash report sent by the browser that ran the client code",
  },
  {
    route: "POST /api/v1/admin/ui/client/reports",
    category: "transport",
    reason: "Fire-and-forget crash report sent by the admin console that ran the client code",
  },
  // themes (themes spec §8-§9)
  {
    route: "GET /api/v1/themes/:id/:version/:revision/theme.css",
    category: "transport",
    reason: "Serves a theme version's stylesheet to the browser; an agent reads themes.list",
  },
  {
    route: "GET /api/v1/themes/:id/:version/assets/:file",
    category: "transport",
    reason: "Serves a theme version's font and logo bytes to the browser",
  },
  // the platform icon (mobile layout spec §10.2.1)
  {
    route: "GET /api/v1/platform/icon/:purpose",
    category: "transport",
    reason: "Public image delivery for the manifest and favicons",
  },
  {
    route: "GET /api/v1/platform/theme",
    category: "transport",
    reason: "The platform default theme for the web's pages before sign-in; no session to act for",
  },
];
