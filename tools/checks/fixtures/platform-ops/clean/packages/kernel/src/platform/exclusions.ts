export const PLATFORM_EXCLUSIONS = [
  {
    route: "GET /api/v1/orgs/:orgId/skills/export",
    category: "transport",
    reason: "Streams an archive; the tool returns JSON only.",
  },
  {
    route: "GET /api/v1/orgs/:orgId/skills/later",
    category: "internal",
    reason: "Serves the web's own refresh.",
  },
  {
    route: "GET /api/v1/orgs/:orgId/attachments/limits",
    category: "internal",
    reason: "The composer's size check for a person's file into a conversation.",
  },
  {
    route: "POST /api/v1/orgs/:orgId/attachments",
    category: "internal",
    reason: "Registers a person's file into a conversation; an agent gets files by reference.",
  },
  {
    route: "POST /api/v1/orgs/:orgId/attachments/:id/finalize",
    category: "internal",
    reason: "Finishes a person's file into a conversation.",
  },
];
