export const PLATFORM_EXCLUSIONS = [
  {
    route: "DELETE /api/v1/orgs/:orgId/ghosts/:id",
    category: "human-only",
    reason: "The route was removed; its exclusion stayed behind.",
  },
];
