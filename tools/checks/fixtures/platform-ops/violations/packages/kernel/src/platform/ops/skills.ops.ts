const dynamicMirrors = ["GET /api/v1/orgs/:orgId/skills"];

export const ops = [
  // get is not mirrored anywhere, and list's authz is right
  defineOperation({
    id: "skills.list",
    description: "List.",
    input: z.object({}),
    example: {},
    authz: { orgAction: "skills.read" },
    mirrors: ["GET /api/v1/orgs/:orgId/skills"],
    confirm: "read",
    run: async () => [],
  }),
  // platform-op-authz: the route needs skills.manage, the op says skills.read
  defineOperation({
    id: "skills.create",
    description: "Create.",
    input: z.object({}),
    example: {},
    authz: { orgAction: "skills.read" },
    mirrors: ["POST /api/v1/orgs/:orgId/skills"],
    confirm: "org",
    summary: () => ({ zh: "x", en: "x" }),
    run: async () => ({}),
  }),
  // platform-op-authz: service-enforced but the role is lower than the route's (member < admin)
  defineOperation({
    id: "skills.update",
    description: "Update.",
    input: z.object({}),
    example: {},
    authz: { orgAction: "skills.read" },
    authzNote: "service-enforced",
    mirrors: ["PUT /api/v1/orgs/:orgId/skills/:id"],
    confirm: "org",
    summary: () => ({ zh: "x", en: "x" }),
    run: async () => ({}),
  }),
  // platform-op-orphan: no such route
  // platform-op-describe: no example, and a write without a summary
  defineOperation({
    id: "skills.remove",
    description: "Remove.",
    input: z.object({}),
    authz: { orgAction: "skills.manage" },
    mirrors: ["DELETE /api/v1/orgs/:orgId/skills/:id", "DELETE /api/v1/orgs/:orgId/nothing"],
    confirm: "org",
    run: async () => ({}),
  }),
  // platform-op-literal: mirrors is not a literal
  defineOperation({
    id: "skills.patch",
    description: "Patch.",
    input: z.object({}),
    example: {},
    authz: { orgAction: "skills.manage" },
    mirrors: dynamicMirrors,
    confirm: "read",
    run: async () => ({}),
  }),
];
