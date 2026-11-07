import { z } from "zod";

/** A route both cases mirror: `name` a bounded string, `visibility` required. */
export const route = {
  route: "POST /api/v1/orgs/:orgId/things",
  body: z
    .object({
      name: z.string().min(1).max(80),
      visibility: z.enum(["private", "org"]),
      note: z.string().max(1000).optional(),
    })
    .strict(),
};

const op = (id: string, input: z.ZodType, more: { omits?: string[]; extras?: string[] } = {}) => ({
  id,
  input,
  mirrors: [route.route],
  ...more,
});

/** Same fields and types, bounds no looser, the left-out field declared. */
export const clean = op(
  "things.create",
  z
    .object({ name: z.string().min(1).max(40), visibility: z.enum(["private"]), cursor: z.string() })
    .strict(),
  { omits: ["note"], extras: ["cursor"] },
);

/** (a) `name` is a number in the operation, a string in the route. */
export const typeMismatch = op(
  "things.type",
  z.object({ name: z.number(), visibility: z.enum(["private", "org"]) }).strict(),
  { omits: ["note"] },
);

/** (b) the route's required `visibility` is left out and not in `omits`. */
export const undeclaredOmission = op(
  "things.omission",
  z.object({ name: z.string().min(1).max(80) }).strict(),
  { omits: ["note"] },
);

/** (c) `cursor` is not a route field and `extras` is empty. */
export const undeclaredExtra = op(
  "things.extra",
  z
    .object({
      name: z.string().min(1).max(80),
      visibility: z.enum(["private", "org"]),
      cursor: z.string().optional(),
    })
    .strict(),
  { omits: ["note"], extras: [] },
);

/** A bound looser than the route's: `name` up to 200 where the route allows 80. */
export const looserBound = op(
  "things.bound",
  z.object({ name: z.string().min(1).max(200), visibility: z.enum(["private", "org"]) }).strict(),
  { omits: ["note"] },
);

/** (d) mirrors a route that is neither registered nor a controller route. */
export const orphan = {
  id: "things.ghost",
  input: z.object({}).strict(),
  mirrors: ["GET /api/v1/orgs/:orgId/ghosts"],
};
