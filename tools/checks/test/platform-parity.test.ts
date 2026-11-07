import { fileURLToPath } from "node:url";
import {
  checkInputParity,
  inputParity,
  PLATFORM_OPERATION_PROVIDERS,
  PlatformOperations,
  ROUTE_SCHEMAS,
} from "@capybara-hq/kernel";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  clean,
  looserBound,
  orphan,
  route,
  typeMismatch,
  undeclaredExtra,
  undeclaredOmission,
} from "../fixtures/platform-parity/cases.js";
import { checkPlatformOps, kernelRoutes } from "../src/platform-ops.js";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const fixture = (name: string) =>
  fileURLToPath(new URL(`../fixtures/platform-parity/${name}`, import.meta.url));

/**
 * Every registered operation without a Nest app: each provider gets a fresh registry as its first
 * constructor argument and no services, which `onModuleInit` does not touch (handlers reach them
 * only when run, and nothing here runs one).
 */
function registeredOperations() {
  const registry = new PlatformOperations();
  for (const Provider of PLATFORM_OPERATION_PROVIDERS) {
    const ctor = Provider as unknown as new (r: PlatformOperations) => { onModuleInit(): void };
    new ctor(registry).onModuleInit();
  }
  return registry.all();
}

const brief = (fs: readonly { op: string; field?: string; message: string }[]) =>
  fs.map((f) => ({ op: f.op, field: f.field }));

describe("inputParity", () => {
  it("passes an operation with equal types, bounds no looser and declared omits / extras", () => {
    expect(inputParity(clean, route)).toEqual([]);
  });

  it("(a) reports a field whose type differs from the route's", () => {
    const got = inputParity(typeMismatch, route);
    expect(brief(got)).toEqual([{ op: "things.type", field: "name" }]);
    expect(got[0]?.message).toContain("type");
  });

  it("(b) reports a route field the operation leaves out without listing it in omits", () => {
    const got = inputParity(undeclaredOmission, route);
    expect(brief(got)).toEqual([{ op: "things.omission", field: "visibility" }]);
    expect(got[0]?.message).toContain("omits");
  });

  it("(c) reports an operation field the route lacks without listing it in extras", () => {
    const got = inputParity(undeclaredExtra, route);
    expect(brief(got)).toEqual([{ op: "things.extra", field: "cursor" }]);
    expect(got[0]?.message).toContain("extras");
  });

  it("reports a bound looser than the route's", () => {
    const got = inputParity(looserBound, route);
    expect(brief(got)).toEqual([{ op: "things.bound", field: "name" }]);
    expect(got[0]?.message).toContain("maxLength");
  });

  it("reports stale omits and extras", () => {
    const got = inputParity(
      { ...clean, omits: ["note", "gone"], extras: ["cursor", "name"] },
      route,
    );
    expect(brief(got)).toEqual([
      { op: "things.create", field: "gone" },
      { op: "things.create", field: "name" },
    ]);
  });

  it("(d) a mirror of a removed route: not registered here, an orphan for check:platform-ops", () => {
    expect(brief(checkInputParity([orphan], [route]))).toEqual([
      { op: "things.ghost", field: undefined },
    ]);
    const found = checkPlatformOps(fixture("orphan")).map((f) => [f.rule, f.message]);
    expect(found).toEqual([
      [
        "platform-op-orphan",
        "exclusion names a route that does not exist: `DELETE /api/v1/orgs/:orgId/ghosts/:id`",
      ],
      [
        "platform-op-orphan",
        "things.ghost: operation mirrors a route that does not exist: `GET /api/v1/orgs/:orgId/ghosts`",
      ],
    ]);
  });
});

describe("the real kernel tree", () => {
  const ops = registeredOperations();

  it("builds every registered operation", () => {
    expect(ops.length).toBeGreaterThan(30);
  });

  it("gives every operation that mirrors a route zero parity findings", () => {
    expect(checkInputParity(ops, ROUTE_SCHEMAS)).toEqual([]);
  });

  it("registers each route once, and only routes the controllers declare", () => {
    const keys = ROUTE_SCHEMAS.map((r) => r.route);
    expect(new Set(keys).size).toBe(keys.length);
    const routes = kernelRoutes(repoRoot);
    expect(keys.filter((k) => !routes.has(k))).toEqual([]);
  });

  it("declares each route's path params (but :orgId, the conversation's org) as its params", () => {
    const wrong = ROUTE_SCHEMAS.flatMap((r) => {
      const want = [...r.route.matchAll(/:([A-Za-z]+)/g)]
        .map((m) => m[1] as string)
        .filter((p) => p !== "orgId")
        .sort();
      const shape = r.params instanceof z.ZodObject ? Object.keys(r.params.shape).sort() : [];
      return JSON.stringify(want) === JSON.stringify(shape) ? [] : [{ route: r.route, shape }];
    });
    expect(wrong).toEqual([]);
  });

  it("goes red when a mirrored route gains a required field the operation lacks", () => {
    const op = ops.find((o) => o.id === "requests.create-import");
    const r = ROUTE_SCHEMAS.find((x) => x.route === op?.mirrors[0]);
    if (!op || !(r?.body instanceof z.ZodObject)) throw new Error("fixture route missing");
    const narrowed = { ...r, body: r.body.extend({ team: z.string().min(1).max(40) }) };
    expect(brief(inputParity(op, narrowed))).toEqual([
      { op: "requests.create-import", field: "team" },
    ]);
  });
});
