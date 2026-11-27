export const PLATFORM_EXCLUSIONS = [
  // platform-op-exclusion-reason: empty reason
  { route: "GET /api/v1/orgs/:orgId/skills/a", category: "internal", reason: "" },
  // platform-op-later: a route is an operation or excluded for good
  { route: "GET /api/v1/orgs/:orgId/skills/b", category: "later", reason: "Later." },
  // platform-op-later: later, even with an issue URL (there is no allow-list)
  {
    route: "GET /api/v1/orgs/:orgId/skills/c",
    category: "later",
    reason: "Waits.",
    issue: "https://github.com/capybara-hq/core/issues/1",
  },
  // platform-op-orphan: no such route
  { route: "GET /api/v1/orgs/:orgId/ghost", category: "internal", reason: "Gone." },
  // platform-op-double: mirrored by skills.list and excluded too
  { route: "GET /api/v1/orgs/:orgId/skills", category: "internal", reason: "Both." },
  // platform-op-session-only: a session-only route excluded as internal
  { route: "POST /api/v1/orgs/:orgId/sessions/internal", category: "internal", reason: "Web only." },
  { route: "POST /api/v1/orgs/:orgId/sessions/human", category: "human-only", reason: "A person." },
  { route: "GET /api/v1/orgs/:orgId/sessions/secret", category: "secret", reason: "A secret." },
  // platform-op-upload: "upload" is no reason (reason, then category)
  { route: "POST /api/v1/orgs/:orgId/skills/d", category: "transport", reason: "Uploads the file as multipart bytes." },
  { route: "POST /api/v1/orgs/:orgId/skills/e", category: "upload", reason: "Takes a file." },
  // platform-op-upload: reworded (presigned / file content), and a transport route of /uploads
  {
    route: "POST /api/v1/orgs/:orgId/skills/g",
    category: "transport",
    reason: "Accepts the file content in one request.",
  },
  {
    route: "POST /api/v1/orgs/:orgId/skills/uploads",
    category: "transport",
    reason: "Takes bytes.",
  },
  // platform-op-upload: a file upload route is internal and names a person's file into a conversation
  { route: "POST /api/v1/orgs/:orgId/files", category: "transport", reason: "Creates a presigned upload" },
  // platform-op-upload: the attachment routes are exempt no more ("upload" is no reason there either)
  { route: "POST /api/v1/orgs/:orgId/attachments", category: "internal", reason: "Registers a person's file into a conversation as an upload" },
  // platform-op-literal: route is not a literal
  { route: ROUTE, category: "internal", reason: "Dynamic." },
];
