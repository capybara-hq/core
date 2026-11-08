export const PLATFORM_EXCLUSIONS = [
  // platform-op-exclusion-reason: empty reason
  { route: "GET /api/v1/orgs/:orgId/skills/a", category: "internal", reason: "" },
  // platform-op-later: later without an issue
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
  // platform-op-literal: route is not a literal
  { route: ROUTE, category: "internal", reason: "Dynamic." },
];
