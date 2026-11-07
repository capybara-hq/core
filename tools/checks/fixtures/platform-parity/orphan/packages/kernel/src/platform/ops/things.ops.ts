export const ops = [
  defineOperation({
    id: "skills.list",
    description: "List the org's skills.",
    input: z.object({}),
    example: {},
    authz: { orgAction: "skills.read" },
    mirrors: ["GET /api/v1/orgs/:orgId/skills"],
    confirm: "read",
    run: async () => [],
  }),
  defineOperation({
    id: "things.ghost",
    description: "Read the ghosts; their route was removed.",
    input: z.object({}),
    example: {},
    authz: { orgAction: "skills.read" },
    mirrors: ["GET /api/v1/orgs/:orgId/ghosts"],
    confirm: "read",
    run: async () => [],
  }),
];
