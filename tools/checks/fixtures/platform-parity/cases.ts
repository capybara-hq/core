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

/** A second route: a path param, a pattern, a nested object (fix round 1 cases). */
export const route2 = {
  route: "PUT /api/v1/orgs/:orgId/things/:id",
  params: z.object({ id: z.string().min(1).max(100) }),
  body: z
    .object({
      code: z.string().regex(/^[a-z]{3}$/),
      spec: z.object({ title: z.string().min(1).max(10), note: z.string().optional() }).strict(),
    })
    .strict(),
};

const op2 = (id: string, shape: z.ZodRawShape, more: Record<string, unknown> = {}) => ({
  id,
  input: z.object(shape).strict(),
  mirrors: [route2.route],
  ...more,
});
const Code = z.string().regex(/^[a-z]{3}$/);
const Spec = z.object({ title: z.string().min(1).max(10) }).strict();

/** Clean: `thingId` renamed to `:id`, `title` flattened from `spec.title`, nested spec compared. */
export const clean2 = op2(
  "things.update",
  { thingId: z.string().min(1).max(100), code: Code, title: z.string().min(1).max(10), spec: Spec },
  { renames: { thingId: "id", title: "spec.title" } },
);

/** (e) required-ness: the route requires `code`, the operation makes it optional. */
export const requiredLoosened = op2("things.required", {
  thingId: z.string().min(1).max(100),
  code: Code.optional(),
  spec: Spec,
}, { renames: { thingId: "id" } });

/** (f) pattern: `code` lost the route's pattern, undeclared. */
export const patternLoosened = op2("things.pattern", {
  thingId: z.string().min(1).max(100),
  code: z.string().min(1).max(3),
  spec: Spec,
}, { renames: { thingId: "id" } });

/** (f') the same loosening, declared with a reason: no finding. */
export const patternDeclared = { ...patternLoosened, id: "things.declared", loosens: { code: "also takes `none`" } };

/** (f'') a `loosens` entry on a field that is not looser: stale. */
export const staleLoosens = { ...clean2, id: "things.stale", loosens: { code: "not needed" } };

/** (g) rename mismatch: `thingId` is a number, the route's `:id` a string. */
export const renameMismatch = op2("things.rename", {
  thingId: z.number(),
  code: Code,
  spec: Spec,
}, { renames: { thingId: "id" } });

/** (h) nested: `spec.title` up to 20 where the route allows 10. */
export const nestedLooser = op2("things.nested", {
  thingId: z.string().min(1).max(100),
  code: Code,
  spec: z.object({ title: z.string().min(1).max(20) }).strict(),
}, { renames: { thingId: "id" } });

/** (h') a flattened field compared at its route path: `title` (`spec.title`) unbounded. */
export const flattenedLooser = op2("things.flat", {
  thingId: z.string().min(1).max(100),
  code: Code,
  title: z.string().min(1),
  spec: Spec,
}, { renames: { thingId: "id", title: "spec.title" } });
