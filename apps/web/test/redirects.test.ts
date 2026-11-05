import { describe, expect, it } from "vitest";
// @ts-expect-error the config is plain ESM without types
import config from "../next.config.mjs";

type Redirect = { source: string; destination: string; permanent: boolean };

describe("next.config redirects", () => {
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

  it("keeps the connector install redirect", async () => {
    const redirects = (await config.redirects()) as Redirect[];
    expect(redirects.some((r) => r.source === "/:locale(zh|en)/apps/new")).toBe(true);
  });
});
