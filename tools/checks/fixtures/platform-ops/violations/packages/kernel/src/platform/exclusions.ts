export const PLATFORM_EXCLUSIONS = [
  // platform-op-exclusion-reason: empty reason
  { route: "GET /api/v1/orgs/:orgId/skills/a", category: "internal", reason: "" },
  // platform-op-exclusion-reason: later without an issue
  { route: "GET /api/v1/orgs/:orgId/skills/b", category: "later", reason: "Later." },
  // platform-op-orphan: no such route
  { route: "GET /api/v1/orgs/:orgId/ghost", category: "internal", reason: "Gone." },
  // platform-op-double: mirrored by skills.list and excluded too
  { route: "GET /api/v1/orgs/:orgId/skills", category: "internal", reason: "Both." },
  // platform-op-literal: route is not a literal
  { route: ROUTE, category: "internal", reason: "Dynamic." },
];
