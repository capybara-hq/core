// @vitest-environment jsdom
// Management pages are desktop-only on touch (mobile touch plan Task 29, maintainer decision 4):
// the route table flags them and a web test pins the prefixes. Presentation only.
import { describe, expect, it } from "vitest";
import { DESKTOP_ONLY_PREFIXES, matchRoute, ROUTES } from "../src/lib/query/routes";

const under = (path: string, prefix: string) => path === prefix || path.startsWith(`${prefix}/`);
const concrete = (pattern: string) =>
  pattern.replace(/\[\.\.\.(\w+)\]/g, "x/y").replace(/\[(\w+)\]/g, "x");

describe("desktopOnly routes", () => {
  it("pins the seven prefixes", () => {
    expect([...DESKTOP_ONLY_PREFIXES]).toEqual([
      "/plugins",
      "/extensions",
      "/channels",
      "/settings",
      "/evals",
      "/trajectories",
      "/admin",
    ]);
  });

  it("every route under a prefix is flagged, and no other route is", () => {
    for (const entry of ROUTES) {
      const flagged = DESKTOP_ONLY_PREFIXES.some((p) => under(entry.pattern, p));
      expect(entry.desktopOnly === true, entry.pattern).toBe(flagged);
    }
    // the table has routes under every prefix
    for (const p of DESKTOP_ONLY_PREFIXES)
      expect(
        ROUTES.some((r) => under(r.pattern, p)),
        p,
      ).toBe(true);
  });

  it.each([
    "/",
    "/chat/c1",
    "/conversations",
    "/inbox",
    "/agents",
    "/schedules",
    "/files",
    "/skills",
    "/connectors",
    "/devices",
    "/p/x/y",
    ...ROUTES.filter((r) => under(r.pattern, "/account")).map((r) => concrete(r.pattern)),
  ])("%s is not desktop-only", (path) => {
    expect(matchRoute(path)?.entry.desktopOnly).not.toBe(true);
  });

  it.each([
    "/plugins",
    "/plugins/x/enable",
    "/extensions",
    "/channels/new",
    "/settings/members",
    "/settings/organization",
    "/evals/s/cases/c",
    "/trajectories/c1",
    "/admin",
    "/admin/plugins/import",
    "/admin/p/x/y",
  ])("%s is desktop-only", (path) => {
    expect(matchRoute(path)?.entry.desktopOnly).toBe(true);
  });
});
