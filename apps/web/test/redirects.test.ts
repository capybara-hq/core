import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
// @ts-expect-error the config is plain ESM without types
import config from "../next.config.mjs";

type Redirect = { source: string; destination: string; permanent: boolean };

describe("next.config redirects", () => {
  it("/ redirects (temporarily) to /chat: the new conversation is the home, there is no home page", async () => {
    const redirects = (await config.redirects()) as Redirect[];
    expect(redirects).toContainEqual({ source: "/", destination: "/chat", permanent: false });
    // nothing else claims `/`
    expect(redirects.filter((r) => r.source === "/")).toHaveLength(1);
  });

  it("no page serves / any more (the redirect is the only answer)", () => {
    const app = join(dirname(fileURLToPath(import.meta.url)), "../src/app/(app)");
    expect(existsSync(join(app, "page.tsx"))).toBe(false);
  });

  it("old personal settings paths redirect permanently to /account/…", async () => {
    const redirects = (await config.redirects()) as Redirect[];
    for (const page of ["connections", "grants", "identities"]) {
      expect(redirects).toContainEqual({
        source: `/settings/${page}`,
        destination: `/account/${page}`,
        permanent: true,
      });
      expect(redirects).toContainEqual({
        source: `/:locale(zh|en)/settings/${page}`,
        destination: `/:locale/account/${page}`,
        permanent: true,
      });
    }
  });

  it("智能体模板 moved into /agents (ruling P4-14): the list to its 模板 tab, a detail to the template page", async () => {
    const redirects = (await config.redirects()) as Redirect[];
    for (const [source, destination] of [
      ["/agent-templates", "/agents?tab=templates"],
      ["/:locale(zh|en)/agent-templates", "/:locale/agents?tab=templates"],
      ["/agent-templates/:id", "/agents/templates/:id"],
      ["/:locale(zh|en)/agent-templates/:id", "/:locale/agents/templates/:id"],
    ]) {
      // temporary (307): the old path never shipped, so no browser keeps the move
      expect(redirects).toContainEqual({ source, destination, permanent: false });
    }
    // no page answers there any more: the redirects are the only answer
    const app = join(dirname(fileURLToPath(import.meta.url)), "../src/app/(app)");
    expect(existsSync(join(app, "agent-templates"))).toBe(false);
  });

  it("/agents/templates without an id goes to the 模板 tab (307)", async () => {
    const redirects = (await config.redirects()) as Redirect[];
    for (const [source, destination] of [
      ["/agents/templates", "/agents?tab=templates"],
      ["/:locale(zh|en)/agents/templates", "/:locale/agents?tab=templates"],
    ]) {
      expect(redirects).toContainEqual({ source, destination, permanent: false });
    }
  });

  it("keeps the connector install redirect", async () => {
    const redirects = (await config.redirects()) as Redirect[];
    expect(redirects.some((r) => r.source === "/:locale(zh|en)/apps/new")).toBe(true);
  });
});
