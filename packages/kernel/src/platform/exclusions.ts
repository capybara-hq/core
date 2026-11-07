export type ExclusionCategory = "human-only" | "secret" | "transport" | "internal" | "later";

/**
 * Kernel HTTP routes the `Platform` tool does not mirror, each with a reason (spec §9);
 * `check:platform-ops` fails a route that is neither mirrored by an operation nor listed here.
 * `later` needs an `issue` URL.
 */

export const PLATFORM_EXCLUSIONS: readonly {
  route: string;
  category: ExclusionCategory;
  reason: string;
  issue?: string;
}[] = [
  // platform-admin
  {
    route: "GET /api/v1/admin/overview",
    category: "later",
    reason: "Platform dashboard totals an agent could read once admin reads are mirrored",
    issue: "https://github.com/capybara-hq/core/issues/91",
  },
  {
    route: "GET /api/v1/admin/accounts",
    category: "human-only",
    reason: "Lists every account with email addresses, a super admin console view",
  },
  {
    route: "POST /api/v1/admin/accounts",
    category: "human-only",
    reason: "Creates a login account with an initial password",
  },
  {
    route: "PATCH /api/v1/admin/accounts/:accountId",
    category: "human-only",
    reason: "Changes another account's status or super-admin flag",
  },
  {
    route: "GET /api/v1/admin/orgs",
    category: "later",
    reason: "Platform-wide org listing an agent could read once admin reads are mirrored",
    issue: "https://github.com/capybara-hq/core/issues/91",
  },
  {
    route: "GET /api/v1/admin/settings",
    category: "later",
    reason: "Deployment settings read that an agent could mirror later",
    issue: "https://github.com/capybara-hq/core/issues/91",
  },
  {
    route: "PUT /api/v1/admin/settings",
    category: "later",
    reason: "Deployment settings write that an agent could mirror later behind confirmation",
    issue: "https://github.com/capybara-hq/core/issues/91",
  },
  {
    route: "GET /api/v1/admin/models",
    category: "later",
    reason: "Platform model catalog read that an agent could mirror later",
    issue: "https://github.com/capybara-hq/core/issues/91",
  },
  {
    route: "GET /api/v1/admin/model-prices",
    category: "later",
    reason: "Model price table read that an agent could mirror later",
    issue: "https://github.com/capybara-hq/core/issues/91",
  },
  {
    route: "PUT /api/v1/admin/model-prices",
    category: "later",
    reason: "Model price write that an agent could mirror later behind confirmation",
    issue: "https://github.com/capybara-hq/core/issues/91",
  },
  {
    route: "GET /api/v1/admin/model-purposes",
    category: "later",
    reason: "Platform default model per purpose, readable by an agent later",
    issue: "https://github.com/capybara-hq/core/issues/91",
  },
  {
    route: "PUT /api/v1/admin/model-purposes/:purpose",
    category: "later",
    reason: "Platform default model per purpose, settable by an agent later",
    issue: "https://github.com/capybara-hq/core/issues/91",
  },
  // extensions-admin
  {
    route: "GET /api/v1/admin/extensions",
    category: "later",
    reason: "Installed extension list an agent could read later",
    issue: "https://github.com/capybara-hq/core/issues/91",
  },
  {
    route: "GET /api/v1/admin/extensions/:name",
    category: "later",
    reason: "Extension detail an agent could read later",
    issue: "https://github.com/capybara-hq/core/issues/91",
  },
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
    route: "POST /api/v1/admin/extensions/:name/approve",
    category: "human-only",
    reason: "Approves an extension's permission manifest, a trust decision",
  },
  {
    route: "POST /api/v1/admin/extensions/:name/install",
    category: "later",
    reason: "Installs an extension; mirrored once extension lifecycle ops exist",
    issue: "https://github.com/capybara-hq/core/issues/91",
  },
  {
    route: "POST /api/v1/admin/extensions/:name/enable",
    category: "later",
    reason: "Enables an extension; mirrored once extension lifecycle ops exist",
    issue: "https://github.com/capybara-hq/core/issues/91",
  },
  {
    route: "POST /api/v1/admin/extensions/:name/disable",
    category: "later",
    reason: "Disables an extension; mirrored once extension lifecycle ops exist",
    issue: "https://github.com/capybara-hq/core/issues/91",
  },
  {
    route: "DELETE /api/v1/admin/extensions/:name",
    category: "later",
    reason: "Uninstalls an extension; mirrored once extension lifecycle ops exist",
    issue: "https://github.com/capybara-hq/core/issues/91",
  },
  {
    route: "POST /api/v1/admin/extensions/packages/file",
    category: "transport",
    reason: "Uploads a package file as multipart bytes",
  },
  {
    route: "POST /api/v1/admin/extensions/packages/npm",
    category: "later",
    reason: "Installs a package from npm; mirrored once extension lifecycle ops exist",
    issue: "https://github.com/capybara-hq/core/issues/91",
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
    route: "PATCH /api/v1/orgs/:orgId/agents/:agentId/profile",
    category: "later",
    reason: "Agent profile edit an agent could do later",
    issue: "https://github.com/capybara-hq/core/issues/91",
  },
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
    route: "DELETE /api/v1/orgs/:orgId/agents/:agentId",
    category: "later",
    reason: "Agent deletion an agent could request later behind confirmation",
    issue: "https://github.com/capybara-hq/core/issues/91",
  },
  {
    route: "POST /api/v1/orgs/:orgId/agents/:agentId/owner",
    category: "human-only",
    reason: "Transfers ownership of an agent to another person",
  },
  {
    route: "GET /api/v1/orgs/:orgId/agents/:agentId/versions",
    category: "later",
    reason: "Agent version history an agent could read later",
    issue: "https://github.com/capybara-hq/core/issues/91",
  },
  {
    route: "GET /api/v1/orgs/:orgId/models",
    category: "later",
    reason: "Model list available to the org, readable by an agent later",
    issue: "https://github.com/capybara-hq/core/issues/91",
  },
  {
    route: "POST /api/v1/orgs/:orgId/agents/:agentId/pending-connectors/:key/bind",
    category: "later",
    reason: "Binds a pending connector to an agent, mirrored later",
    issue: "https://github.com/capybara-hq/core/issues/91",
  },
  {
    route: "POST /api/v1/orgs/:orgId/agents/:agentId/pending-connectors/request",
    category: "later",
    reason: "Sending a setup request to the org admins is not a decision; mirrored later",
    issue: "https://github.com/capybara-hq/core/issues/91",
  },
  {
    route: "GET /api/v1/orgs/:orgId/agents/:agentId/pending-connectors/request",
    category: "later",
    reason: "Setup request status an agent could read later",
    issue: "https://github.com/capybara-hq/core/issues/91",
  },
  {
    route: "GET /api/v1/orgs/:orgId/readiness",
    category: "later",
    reason: "Org readiness checklist an agent could read later",
    issue: "https://github.com/capybara-hq/core/issues/91",
  },
  {
    route: "PUT /api/v1/orgs/:orgId/agent-templates/:id",
    category: "later",
    reason: "Org agent template edit an agent could do later",
    issue: "https://github.com/capybara-hq/core/issues/91",
  },
  {
    route: "GET /api/v1/orgs/:orgId/agent-templates/:id/delete-preview",
    category: "later",
    reason: "Template delete preview an agent could read later",
    issue: "https://github.com/capybara-hq/core/issues/91",
  },
  {
    route: "DELETE /api/v1/orgs/:orgId/agent-templates/:id",
    category: "later",
    reason: "Template deletion an agent could request later behind confirmation",
    issue: "https://github.com/capybara-hq/core/issues/91",
  },
  {
    route: "PUT /api/v1/orgs/:orgId/agent-templates/:id/shareable",
    category: "later",
    reason: "Sharing an org template with other orgs, mirrored later",
    issue: "https://github.com/capybara-hq/core/issues/91",
  },
  // background
  {
    route: "GET /api/v1/orgs/:orgId/conversations/:id/background-tasks",
    category: "later",
    reason: "Background task list an agent could read later",
    issue: "https://github.com/capybara-hq/core/issues/91",
  },
  {
    route: "POST /api/v1/orgs/:orgId/conversations/:id/background-tasks/:taskId/stop",
    category: "later",
    reason: "Stopping a background task, mirrored later",
    issue: "https://github.com/capybara-hq/core/issues/91",
  },
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
    route: "POST /api/v1/admin/catalog/import/npm",
    category: "later",
    reason: "Plugin import from npm, mirrored with the import review later",
    issue: "https://github.com/capybara-hq/core/issues/91",
  },
  {
    route: "POST /api/v1/admin/catalog/import/git",
    category: "later",
    reason: "Plugin import from git, mirrored with the import review later",
    issue: "https://github.com/capybara-hq/core/issues/91",
  },
  {
    route: "GET /api/v1/admin/catalog/imports/:stagingId",
    category: "later",
    reason: "Import review read, mirrored with the import review later",
    issue: "https://github.com/capybara-hq/core/issues/91",
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
    route: "POST /api/v1/admin/catalog/items/:id/scope/preview",
    category: "later",
    reason: "Scope change preview, mirrored later",
    issue: "https://github.com/capybara-hq/core/issues/91",
  },
  {
    route: "PUT /api/v1/admin/catalog/items/:id/scope",
    category: "later",
    reason: "Scope change for a catalog item, mirrored later",
    issue: "https://github.com/capybara-hq/core/issues/91",
  },
  {
    route: "PUT /api/v1/admin/catalog/items/:id/disabled",
    category: "later",
    reason: "Disabling a catalog item, mirrored later",
    issue: "https://github.com/capybara-hq/core/issues/91",
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
  {
    route: "PUT /api/v1/admin/catalog/items/:id/shown",
    category: "later",
    reason: "Showing or hiding a catalog item, mirrored later",
    issue: "https://github.com/capybara-hq/core/issues/91",
  },
  {
    route: "DELETE /api/v1/admin/catalog/items/:id",
    category: "later",
    reason: "Removing a catalog item, mirrored later behind confirmation",
    issue: "https://github.com/capybara-hq/core/issues/91",
  },
  // components
  {
    route: "POST /api/v1/admin/components/skill/:id/versions",
    category: "later",
    reason: "Publishing a platform skill version, mirrored later",
    issue: "https://github.com/capybara-hq/core/issues/91",
  },
  {
    route: "POST /api/v1/admin/components/agent_template/:id/versions",
    category: "later",
    reason: "Publishing a platform agent template version, mirrored later",
    issue: "https://github.com/capybara-hq/core/issues/91",
  },
  {
    route: "GET /api/v1/admin/components",
    category: "later",
    reason: "Platform component list an agent could read later",
    issue: "https://github.com/capybara-hq/core/issues/91",
  },
  {
    route: "GET /api/v1/admin/components/:kind/:id/versions",
    category: "later",
    reason: "Component version history an agent could read later",
    issue: "https://github.com/capybara-hq/core/issues/91",
  },
  {
    route: "POST /api/v1/admin/components/:kind/:id/scope/preview",
    category: "later",
    reason: "Component scope preview, mirrored later",
    issue: "https://github.com/capybara-hq/core/issues/91",
  },
  {
    route: "PUT /api/v1/admin/components/:kind/:id/scope",
    category: "later",
    reason: "Component scope change, mirrored later",
    issue: "https://github.com/capybara-hq/core/issues/91",
  },
  {
    route: "PUT /api/v1/admin/components/:kind/:id/disabled",
    category: "later",
    reason: "Disabling a component, mirrored later",
    issue: "https://github.com/capybara-hq/core/issues/91",
  },
  {
    route: "PUT /api/v1/admin/components/:kind/:id/shown",
    category: "later",
    reason: "Showing or hiding a component, mirrored later",
    issue: "https://github.com/capybara-hq/core/issues/91",
  },
  {
    route: "PUT /api/v1/orgs/:orgId/components/:kind/:id/switch",
    category: "later",
    reason: "Org switch for a platform component, mirrored later",
    issue: "https://github.com/capybara-hq/core/issues/91",
  },
  // marketplaces
  {
    route: "GET /api/v1/admin/marketplaces/entries",
    category: "later",
    reason: "Marketplace entry list an agent could read later",
    issue: "https://github.com/capybara-hq/core/issues/91",
  },
  {
    route: "PATCH /api/v1/admin/marketplaces/:id",
    category: "later",
    reason: "Marketplace edit, mirrored later",
    issue: "https://github.com/capybara-hq/core/issues/91",
  },
  {
    route: "DELETE /api/v1/admin/marketplaces/:id",
    category: "later",
    reason: "Marketplace removal, mirrored later behind confirmation",
    issue: "https://github.com/capybara-hq/core/issues/91",
  },
  {
    route: "POST /api/v1/admin/marketplaces/:id/refresh",
    category: "later",
    reason: "Marketplace refresh, mirrored later",
    issue: "https://github.com/capybara-hq/core/issues/91",
  },
  {
    route: "POST /api/v1/admin/marketplaces/:id/entries/:name/import",
    category: "later",
    reason: "Importing a marketplace entry, mirrored with the import review later",
    issue: "https://github.com/capybara-hq/core/issues/91",
  },
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
    route: "GET /api/v1/orgs/:orgId/plugin-installs",
    category: "later",
    reason: "Org plugin install list an agent could read later",
    issue: "https://github.com/capybara-hq/core/issues/91",
  },
  {
    route: "DELETE /api/v1/orgs/:orgId/plugin-installs/:installId",
    category: "later",
    reason: "Uninstalling a plugin from an org, mirrored later",
    issue: "https://github.com/capybara-hq/core/issues/91",
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
    route: "GET /api/v1/admin/catalog/requests",
    category: "later",
    reason: "Platform catalog request list an agent could read later",
    issue: "https://github.com/capybara-hq/core/issues/91",
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
  {
    route: "GET /api/v1/orgs/:orgId/extensions/:extension/tools",
    category: "later",
    reason: "An extension's tools with the org's on/off switches, readable by an agent later",
    issue: "https://github.com/capybara-hq/core/issues/91",
  },
  {
    route: "PUT /api/v1/orgs/:orgId/extensions/:extension/tools/:tool",
    category: "later",
    reason: "Turns one extension tool on or off in the org; an org-class write for later",
    issue: "https://github.com/capybara-hq/core/issues/91",
  },
  // org-uploads
  {
    route: "POST /api/v1/orgs/:orgId/catalog/uploads/file",
    category: "transport",
    reason: "Uploads a plugin archive as multipart bytes",
  },
  {
    route: "GET /api/v1/orgs/:orgId/catalog/uploads/:stagingId",
    category: "later",
    reason: "Upload review read, mirrored with the import review later",
    issue: "https://github.com/capybara-hq/core/issues/91",
  },
  {
    route: "POST /api/v1/orgs/:orgId/catalog/uploads/:stagingId/confirm",
    category: "human-only",
    reason: "Confirms an upload review, an approval decision",
  },
  {
    route: "PUT /api/v1/orgs/:orgId/owned-plugins/:id/shareable",
    category: "later",
    reason: "Sharing an org-owned plugin with other orgs, mirrored later",
    issue: "https://github.com/capybara-hq/core/issues/91",
  },
  {
    route: "POST /api/v1/orgs/:orgId/owned-plugins/:id/delete/preview",
    category: "later",
    reason: "Owned plugin delete preview, mirrored later",
    issue: "https://github.com/capybara-hq/core/issues/91",
  },
  {
    route: "POST /api/v1/orgs/:orgId/owned-plugins/:id/delete",
    category: "later",
    reason: "Owned plugin deletion, mirrored later behind confirmation",
    issue: "https://github.com/capybara-hq/core/issues/91",
  },
  {
    route: "DELETE /api/v1/orgs/:orgId/owned-plugins/:id/pending",
    category: "later",
    reason: "Dropping a pending owned plugin upload, mirrored later",
    issue: "https://github.com/capybara-hq/core/issues/91",
  },
  // channels
  {
    route: "GET /api/v1/orgs/:orgId/channels",
    category: "later",
    reason: "Channel connection list an agent could read later",
    issue: "https://github.com/capybara-hq/core/issues/91",
  },
  {
    route: "GET /api/v1/orgs/:orgId/channels/schema/:plugin",
    category: "later",
    reason: "Channel config schema an agent could read later",
    issue: "https://github.com/capybara-hq/core/issues/91",
  },
  {
    route: "POST /api/v1/orgs/:orgId/channels",
    category: "secret",
    reason: "Creates a channel connection with app secrets",
  },
  {
    route: "GET /api/v1/orgs/:orgId/channels/:connectionId",
    category: "secret",
    reason: "Returns a channel connection whose config holds secret fields",
  },
  {
    route: "PATCH /api/v1/orgs/:orgId/channels/:connectionId",
    category: "secret",
    reason: "Writes channel config that includes secret fields",
  },
  {
    route: "DELETE /api/v1/orgs/:orgId/channels/:connectionId",
    category: "later",
    reason: "Removing a channel connection, mirrored later behind confirmation",
    issue: "https://github.com/capybara-hq/core/issues/91",
  },
  // attachments
  {
    route: "GET /api/v1/orgs/:orgId/attachments/limits",
    category: "later",
    reason: "Attachment limits an agent could read later",
    issue: "https://github.com/capybara-hq/core/issues/91",
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
    category: "later",
    reason: "Starting a conversation, mirrored later",
    issue: "https://github.com/capybara-hq/core/issues/91",
  },
  {
    route: "PATCH /api/v1/orgs/:orgId/conversations/:id",
    category: "later",
    reason: "Renaming or editing a conversation, mirrored later",
    issue: "https://github.com/capybara-hq/core/issues/91",
  },
  {
    route: "DELETE /api/v1/orgs/:orgId/conversations/:id",
    category: "later",
    reason: "Deleting a conversation, mirrored later behind confirmation",
    issue: "https://github.com/capybara-hq/core/issues/91",
  },
  {
    route: "GET /api/v1/orgs/:orgId/conversations",
    category: "later",
    reason: "Conversation list an agent could read later",
    issue: "https://github.com/capybara-hq/core/issues/91",
  },
  {
    route: "GET /api/v1/orgs/:orgId/conversations/groups",
    category: "later",
    reason: "Conversation groups an agent could read later",
    issue: "https://github.com/capybara-hq/core/issues/91",
  },
  {
    route: "GET /api/v1/orgs/:orgId/conversations/:id",
    category: "later",
    reason: "Conversation detail an agent could read later",
    issue: "https://github.com/capybara-hq/core/issues/91",
  },
  {
    route: "GET /api/v1/orgs/:orgId/conversations/:id/events",
    category: "later",
    reason: "Event log read an agent could do later",
    issue: "https://github.com/capybara-hq/core/issues/91",
  },
  {
    route: "GET /api/v1/orgs/:orgId/conversations/:id/subagents",
    category: "later",
    reason: "Sub-agent list an agent could read later",
    issue: "https://github.com/capybara-hq/core/issues/91",
  },
  {
    route: "GET /api/v1/orgs/:orgId/conversations/:id/agent-tree",
    category: "later",
    reason: "Agent tree an agent could read later",
    issue: "https://github.com/capybara-hq/core/issues/91",
  },
  {
    route: "GET /api/v1/orgs/:orgId/conversations/:id/usage",
    category: "later",
    reason: "Usage totals an agent could read later",
    issue: "https://github.com/capybara-hq/core/issues/91",
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
    route: "GET /api/v1/orgs/:orgId/conversations/:id/files",
    category: "later",
    reason: "Conversation file list an agent could read later",
    issue: "https://github.com/capybara-hq/core/issues/91",
  },
  {
    route: "GET /api/v1/orgs/:orgId/conversations/:id/files/:fileId/content",
    category: "transport",
    reason: "Serves sandbox file bytes",
  },
  {
    route: "GET /api/v1/orgs/:orgId/conversations/:id/environment",
    category: "later",
    reason: "The conversation's environment and its instance state, an agent could read later",
    issue: "https://github.com/capybara-hq/core/issues/91",
  },
  // environments (personal cloud environments, environments design phase 1)
  {
    route: "GET /api/v1/orgs/:orgId/environments",
    category: "later",
    reason: "The person's environments, an agent could list later",
    issue: "https://github.com/capybara-hq/core/issues/91",
  },
  {
    route: "POST /api/v1/orgs/:orgId/environments",
    category: "later",
    reason: "Creates a personal cloud environment; an agent could do it later behind confirmation",
    issue: "https://github.com/capybara-hq/core/issues/91",
  },
  {
    route: "GET /api/v1/orgs/:orgId/environments/:id",
    category: "later",
    reason: "One environment's details, an agent could read later",
    issue: "https://github.com/capybara-hq/core/issues/91",
  },
  {
    route: "PATCH /api/v1/orgs/:orgId/environments/:id",
    category: "later",
    reason: "Renames an environment; an agent could do it later behind confirmation",
    issue: "https://github.com/capybara-hq/core/issues/91",
  },
  {
    route: "DELETE /api/v1/orgs/:orgId/environments/:id",
    category: "human-only",
    reason: "Deletes an environment and its files",
  },
  {
    route: "POST /api/v1/orgs/:orgId/environments/:id/files/reset",
    category: "human-only",
    reason: "Wipes an environment's files to start with an empty workspace",
  },
  {
    route: "GET /api/v1/orgs/:orgId/conversations/:id/tools",
    category: "later",
    reason: "Tool list of a conversation, readable by an agent later",
    issue: "https://github.com/capybara-hq/core/issues/91",
  },
  {
    route: "POST /api/v1/orgs/:orgId/conversations/:id/messages",
    category: "later",
    reason: "Sending a user message, mirrored later",
    issue: "https://github.com/capybara-hq/core/issues/91",
  },
  {
    route: "GET /api/v1/orgs/:orgId/conversations/:id/queue",
    category: "later",
    reason: "Message queue read an agent could do later",
    issue: "https://github.com/capybara-hq/core/issues/91",
  },
  {
    route: "POST /api/v1/orgs/:orgId/conversations/:id/queue",
    category: "later",
    reason: "Queueing a message, mirrored later",
    issue: "https://github.com/capybara-hq/core/issues/91",
  },
  {
    route: "POST /api/v1/orgs/:orgId/conversations/:id/queue/resume",
    category: "later",
    reason: "Resuming a paused queue, mirrored later",
    issue: "https://github.com/capybara-hq/core/issues/91",
  },
  {
    route: "PATCH /api/v1/orgs/:orgId/conversations/:id/queue/:itemId",
    category: "later",
    reason: "Editing a queued message, mirrored later",
    issue: "https://github.com/capybara-hq/core/issues/91",
  },
  {
    route: "DELETE /api/v1/orgs/:orgId/conversations/:id/queue/:itemId",
    category: "later",
    reason: "Removing a queued message, mirrored later",
    issue: "https://github.com/capybara-hq/core/issues/91",
  },
  {
    route: "POST /api/v1/orgs/:orgId/conversations/:id/queue/:itemId/send",
    category: "later",
    reason: "Sending a queued message now, mirrored later",
    issue: "https://github.com/capybara-hq/core/issues/91",
  },
  {
    route: "POST /api/v1/orgs/:orgId/conversations/:id/abort",
    category: "later",
    reason: "Aborting a run, mirrored later",
    issue: "https://github.com/capybara-hq/core/issues/91",
  },
  // evals
  {
    route: "POST /api/v1/orgs/:orgId/eval-sets/:setId/runs/estimate",
    category: "later",
    reason: "Eval run cost estimate, mirrored later",
    issue: "https://github.com/capybara-hq/core/issues/91",
  },
  {
    route: "POST /api/v1/orgs/:orgId/eval-sets/:setId/runs",
    category: "later",
    reason: "Starting an eval run, mirrored later behind confirmation",
    issue: "https://github.com/capybara-hq/core/issues/91",
  },
  {
    route: "GET /api/v1/orgs/:orgId/eval-sets/:setId/runs",
    category: "later",
    reason: "Eval run list an agent could read later",
    issue: "https://github.com/capybara-hq/core/issues/91",
  },
  {
    route: "GET /api/v1/orgs/:orgId/eval-runs/:runId",
    category: "later",
    reason: "Eval run detail an agent could read later",
    issue: "https://github.com/capybara-hq/core/issues/91",
  },
  {
    route: "GET /api/v1/orgs/:orgId/eval-runs/:runId/results",
    category: "later",
    reason: "Eval results an agent could read later",
    issue: "https://github.com/capybara-hq/core/issues/91",
  },
  {
    route: "GET /api/v1/orgs/:orgId/eval-runs/:runId/results/:resultId",
    category: "later",
    reason: "Eval result detail an agent could read later",
    issue: "https://github.com/capybara-hq/core/issues/91",
  },
  {
    route: "POST /api/v1/orgs/:orgId/eval-runs/:runId/cancel",
    category: "later",
    reason: "Cancelling an eval run, mirrored later",
    issue: "https://github.com/capybara-hq/core/issues/91",
  },
  {
    route: "PUT /api/v1/orgs/:orgId/eval-results/:resultId/label",
    category: "later",
    reason: "Labelling an eval result, mirrored later",
    issue: "https://github.com/capybara-hq/core/issues/91",
  },
  {
    route: "POST /api/v1/orgs/:orgId/eval-sets",
    category: "later",
    reason: "Creating an eval set, mirrored later",
    issue: "https://github.com/capybara-hq/core/issues/91",
  },
  {
    route: "GET /api/v1/orgs/:orgId/eval-sets",
    category: "later",
    reason: "Eval set list an agent could read later",
    issue: "https://github.com/capybara-hq/core/issues/91",
  },
  {
    route: "GET /api/v1/orgs/:orgId/eval-sets/:setId",
    category: "later",
    reason: "Eval set detail an agent could read later",
    issue: "https://github.com/capybara-hq/core/issues/91",
  },
  {
    route: "PATCH /api/v1/orgs/:orgId/eval-sets/:setId",
    category: "later",
    reason: "Editing an eval set, mirrored later",
    issue: "https://github.com/capybara-hq/core/issues/91",
  },
  {
    route: "DELETE /api/v1/orgs/:orgId/eval-sets/:setId",
    category: "later",
    reason: "Deleting an eval set, mirrored later behind confirmation",
    issue: "https://github.com/capybara-hq/core/issues/91",
  },
  {
    route: "POST /api/v1/orgs/:orgId/eval-sets/:setId/cases",
    category: "later",
    reason: "Adding an eval case, mirrored later",
    issue: "https://github.com/capybara-hq/core/issues/91",
  },
  {
    route: "POST /api/v1/orgs/:orgId/eval-sets/:setId/cases/sample",
    category: "later",
    reason: "Sampling eval cases from conversations, mirrored later",
    issue: "https://github.com/capybara-hq/core/issues/91",
  },
  {
    route: "GET /api/v1/orgs/:orgId/eval-sets/:setId/cases/:caseId",
    category: "later",
    reason: "Eval case detail an agent could read later",
    issue: "https://github.com/capybara-hq/core/issues/91",
  },
  {
    route: "DELETE /api/v1/orgs/:orgId/eval-sets/:setId/cases/:caseId",
    category: "later",
    reason: "Removing an eval case, mirrored later",
    issue: "https://github.com/capybara-hq/core/issues/91",
  },
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
  {
    route: "GET /api/v1/orgs/:orgId/extension-points",
    category: "later",
    reason: "Extension point defaults an agent could read later",
    issue: "https://github.com/capybara-hq/core/issues/91",
  },
  {
    route: "GET /api/v1/orgs/:orgId/extension-points/available",
    category: "later",
    reason: "Available extension point providers an agent could read later",
    issue: "https://github.com/capybara-hq/core/issues/91",
  },
  {
    route: "PUT /api/v1/orgs/:orgId/extension-points/:point/default",
    category: "later",
    reason: "Choosing the default provider for a point, mirrored later",
    issue: "https://github.com/capybara-hq/core/issues/91",
  },
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
  {
    route: "GET /api/v1/orgs/:orgId/file-previewers",
    category: "later",
    reason: "File previewer settings an agent could read later",
    issue: "https://github.com/capybara-hq/core/issues/91",
  },
  {
    route: "PUT /api/v1/orgs/:orgId/file-previewers",
    category: "later",
    reason: "File previewer settings an agent could change later",
    issue: "https://github.com/capybara-hq/core/issues/91",
  },
  // identity
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
  // inbox
  {
    route: "GET /api/v1/admin/inbox",
    category: "later",
    reason: "Platform inbox list an agent could read later",
    issue: "https://github.com/capybara-hq/core/issues/91",
  },
  {
    route: "GET /api/v1/admin/inbox/count",
    category: "later",
    reason: "Platform inbox badge count, readable later",
    issue: "https://github.com/capybara-hq/core/issues/91",
  },
  {
    route: "POST /api/v1/admin/inbox/notices/:id/dismiss",
    category: "later",
    reason: "Dismissing a platform notice, mirrored later",
    issue: "https://github.com/capybara-hq/core/issues/91",
  },
  // health
  { route: "GET /healthz", category: "transport", reason: "Liveness probe for the orchestrator" },
  { route: "GET /readyz", category: "transport", reason: "Readiness probe for the orchestrator" },
  // models
  {
    route: "GET /api/v1/orgs/:orgId/model-purposes",
    category: "later",
    reason: "Org model per purpose, readable by an agent later",
    issue: "https://github.com/capybara-hq/core/issues/91",
  },
  {
    route: "PUT /api/v1/orgs/:orgId/model-purposes/:purpose",
    category: "later",
    reason: "Org model per purpose, settable by an agent later",
    issue: "https://github.com/capybara-hq/core/issues/91",
  },
  // orgs
  {
    route: "POST /api/v1/orgs/:orgId/extensions/:extension/directory/sync",
    category: "later",
    reason: "Triggering a directory sync, mirrored later",
    issue: "https://github.com/capybara-hq/core/issues/91",
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
    category: "later",
    reason: "Org list an agent could read later",
    issue: "https://github.com/capybara-hq/core/issues/91",
  },
  {
    route: "GET /api/v1/orgs/:orgId",
    category: "later",
    reason: "Org detail an agent could read later",
    issue: "https://github.com/capybara-hq/core/issues/91",
  },
  {
    route: "PATCH /api/v1/orgs/:orgId",
    category: "later",
    reason: "Org profile edit, mirrored later",
    issue: "https://github.com/capybara-hq/core/issues/91",
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
    route: "GET /api/v1/orgs/:orgId/members",
    category: "later",
    reason: "Member list an agent could read later",
    issue: "https://github.com/capybara-hq/core/issues/91",
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
  {
    route: "GET /api/v1/orgs/:orgId/settings",
    category: "later",
    reason: "Org settings read an agent could do later",
    issue: "https://github.com/capybara-hq/core/issues/91",
  },
  {
    route: "PATCH /api/v1/orgs/:orgId/settings",
    category: "later",
    reason: "Org settings write, mirrored later behind confirmation",
    issue: "https://github.com/capybara-hq/core/issues/91",
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
    route: "GET /api/v1/orgs/:orgId/skill-changes/:id",
    category: "later",
    reason: "Skill change detail an agent could read later",
    issue: "https://github.com/capybara-hq/core/issues/91",
  },
  {
    route: "POST /api/v1/orgs/:orgId/skill-changes/:id/decide",
    category: "human-only",
    reason: "Decides a proposed skill change",
  },
  {
    route: "GET /api/v1/orgs/:orgId/agents/:agentId/skills",
    category: "later",
    reason: "Skills attached to an agent, readable later",
    issue: "https://github.com/capybara-hq/core/issues/91",
  },
  {
    route: "DELETE /api/v1/orgs/:orgId/agents/:agentId/skills/:skillId",
    category: "later",
    reason: "Detaching a skill from an agent, mirrored later",
    issue: "https://github.com/capybara-hq/core/issues/91",
  },
  {
    route: "GET /api/v1/orgs/:orgId/inbox",
    category: "later",
    reason: "Org inbox list an agent could read later",
    issue: "https://github.com/capybara-hq/core/issues/91",
  },
  {
    route: "POST /api/v1/orgs/:orgId/inbox/notices/:id/dismiss",
    category: "later",
    reason: "Dismissing an org notice, mirrored later",
    issue: "https://github.com/capybara-hq/core/issues/91",
  },
  {
    route: "GET /api/v1/orgs/:orgId/agents/:agentId/invocable-skills",
    category: "later",
    reason: "Invocable skill list an agent could read later",
    issue: "https://github.com/capybara-hq/core/issues/91",
  },
  {
    route: "POST /api/v1/orgs/:orgId/skills/uploads",
    category: "transport",
    reason: "Uploads a skill archive as multipart bytes",
  },
  {
    route: "PUT /api/v1/orgs/:orgId/skills/:id/shareable",
    category: "later",
    reason: "Sharing an org skill with other orgs, mirrored later",
    issue: "https://github.com/capybara-hq/core/issues/91",
  },
  {
    route: "GET /api/v1/orgs/:orgId/skills/:id/delete-preview",
    category: "later",
    reason: "Skill delete preview an agent could read later",
    issue: "https://github.com/capybara-hq/core/issues/91",
  },
  {
    route: "DELETE /api/v1/orgs/:orgId/skills/:id",
    category: "later",
    reason: "Skill deletion, mirrored later behind confirmation",
    issue: "https://github.com/capybara-hq/core/issues/91",
  },
  // approvals
  {
    route: "GET /api/v1/orgs/:orgId/approvals",
    category: "human-only",
    reason: "Lists approvals awaiting a person's decision",
  },
  {
    route: "GET /api/v1/orgs/:orgId/approvals/:id",
    category: "human-only",
    reason: "Shows an approval awaiting a person's decision",
  },
  {
    route: "POST /api/v1/orgs/:orgId/approvals/:id/decision",
    category: "human-only",
    reason: "Decides a tool permission approval",
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
    category: "later",
    reason: "Connector prompt list an agent could read later",
    issue: "https://github.com/capybara-hq/core/issues/91",
  },
  {
    route: "GET /api/v1/orgs/:orgId/connectors/resources",
    category: "later",
    reason: "Connector resource list an agent could read later",
    issue: "https://github.com/capybara-hq/core/issues/91",
  },
  {
    route: "POST /api/v1/orgs/:orgId/connectors/:connectorId/prompts/:name",
    category: "later",
    reason: "Rendering a connector prompt, mirrored later",
    issue: "https://github.com/capybara-hq/core/issues/91",
  },
  {
    route: "GET /api/v1/orgs/:orgId/connectors/kinds",
    category: "later",
    reason: "Connector kinds an agent could read later",
    issue: "https://github.com/capybara-hq/core/issues/91",
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
    route: "DELETE /api/v1/orgs/:orgId/connectors/:connectorId",
    category: "later",
    reason: "Deleting a connector, mirrored later behind confirmation",
    issue: "https://github.com/capybara-hq/core/issues/91",
  },
  {
    route: "POST /api/v1/orgs/:orgId/connectors/:connectorId/refresh",
    category: "later",
    reason: "Refreshing a connector's tool list, mirrored later",
    issue: "https://github.com/capybara-hq/core/issues/91",
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
    category: "later",
    reason: "Extension-provided tool list an agent could read later",
    issue: "https://github.com/capybara-hq/core/issues/91",
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
    category: "later",
    reason: "Extension UI contribution list, readable later",
    issue: "https://github.com/capybara-hq/core/issues/91",
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
