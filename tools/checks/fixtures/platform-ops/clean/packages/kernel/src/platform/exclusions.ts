export const PLATFORM_EXCLUSIONS = [
  {
    route: "GET /api/v1/orgs/:orgId/skills/export",
    category: "transport",
    reason: "Streams a binary archive; the tool returns JSON only.",
  },
  {
    route: "GET /api/v1/orgs/:orgId/skills/later",
    category: "internal",
    reason: "Serves the web's own refresh.",
  },
];
