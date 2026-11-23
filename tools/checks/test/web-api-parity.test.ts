import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  type AllowEntry,
  checkWebApiParity,
  type KernelRoute,
  matchRoute,
} from "../src/web-api-parity.js";

const fixture = (name: string) =>
  fileURLToPath(new URL(`../fixtures/web-api-parity/${name}`, import.meta.url));

const run = (web: string, allow: readonly AllowEntry[] = []) =>
  checkWebApiParity({
    kernel: { tsconfig: fixture("kernel/tsconfig.json"), src: fixture("kernel/src") },
    web: { tsconfig: fixture(`${web}/tsconfig.json`), src: fixture(`${web}/src`) },
    allow,
  });

/** `<rule> <route> <field>` of each finding (the route and field lead the message). */
const brief = (r: ReturnType<typeof run>) =>
  r.findings.map((f) => `${f.rule} ${f.message.split(": ")[0]}`).sort();

describe("check:web-api-parity", () => {
  it("passes web types that match the routes they call, and says what it compared", () => {
    const r = run("web-clean");
    expect(r.findings).toEqual([]);
    expect(r.compared.map((c) => c.route).sort()).toEqual([
      "GET /api/v1/orgs/:orgId/things",
      "GET /api/v1/orgs/:orgId/things/:id",
      "GET /api/v1/orgs/:orgId/things/archived",
      "POST /api/v1/orgs/:orgId/things",
      "PUT /api/v1/orgs/:orgId/things/:id/name",
    ]);
    expect(r.uncovered).toEqual([]);
  });

  it("fails on every drift, naming the route and the field", () => {
    const r = run("web-drift");
    expect(brief(r)).toEqual([
      "web-api-body-enum POST /api/v1/orgs/:orgId/things kind",
      "web-api-body-field POST /api/v1/orgs/:orgId/things color",
      "web-api-body-required POST /api/v1/orgs/:orgId/things name",
      "web-api-body-type POST /api/v1/orgs/:orgId/things note",
      "web-api-enum GET /api/v1/orgs/:orgId/things things[].kind",
      "web-api-enum GET /api/v1/orgs/:orgId/things things[].kind",
      "web-api-field-gone GET /api/v1/orgs/:orgId/things things[].color",
      "web-api-route-gone POST /api/v1/orgs/*/things/*/gone",
      "web-api-type GET /api/v1/orgs/:orgId/things/:id thing.createdAt",
      "web-api-type GET /api/v1/orgs/:orgId/things/:id thing.meta",
      "web-api-type GET /api/v1/orgs/:orgId/things/:id thing.ownerId",
    ]);
    const messages = r.findings.map((f) => f.message).join("\n");
    expect(messages).toContain(
      'the kernel can return "c" at `things[].kind`, the web type lacks it',
    );
    expect(messages).toContain(
      'the web type lists "d" at `things[].kind`, which the kernel never returns',
    );
    expect(messages).toContain("the web reads `things[].color`, the kernel no longer returns it");
    expect(messages).toContain("the kernel can return null at `thing.ownerId`");
    expect(messages).toContain("the web sends `color`, the kernel route does not accept it");
    // the finding points at the web call
    expect(r.findings.every((f) => f.file.endsWith("web-drift/src/lib/things.ts"))).toBe(true);
  });

  it("an allow entry hides its finding, and a stale one fails", () => {
    const allow: AllowEntry[] = [
      {
        route: "POST /api/v1/orgs/:orgId/things",
        field: "color",
        rule: "web-api-body-field",
        reason: "fixture",
      },
    ];
    expect(brief(run("web-drift", allow))).not.toContain(
      "web-api-body-field POST /api/v1/orgs/:orgId/things color",
    );
    expect(brief(run("web-clean", allow))).toEqual([
      "web-api-allow-stale allow entry POST /api/v1/orgs/:orgId/things color (web-api-body-field) matches no finding",
    ]);
  });
});

describe("matchRoute", () => {
  const route = (method: string, path: string): KernelRoute => ({
    method,
    path,
    key: `${method} ${path}`,
    file: "x.ts",
    line: 1,
  });
  const routes = [
    route("GET", "/api/v1/orgs/:orgId/conversations/:id"),
    route("GET", "/api/v1/orgs/:orgId/conversations/groups"),
  ];

  it("an unknown part is a param, a literal is the literal route", () => {
    expect(matchRoute(routes, "GET", "/api/v1/orgs/*/conversations/*")?.path).toBe(
      "/api/v1/orgs/:orgId/conversations/:id",
    );
    expect(matchRoute(routes, "GET", "/api/v1/orgs/*/conversations/groups")?.path).toBe(
      "/api/v1/orgs/:orgId/conversations/groups",
    );
    // a query string built at runtime glues onto the last segment
    expect(matchRoute(routes, "GET", "/api/v1/orgs/*/conversations/groups*")?.path).toBe(
      "/api/v1/orgs/:orgId/conversations/groups",
    );
    expect(matchRoute(routes, "POST", "/api/v1/orgs/*/conversations/*")).toBeUndefined();
  });
});
