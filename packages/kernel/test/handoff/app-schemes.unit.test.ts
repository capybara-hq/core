import { describe, expect, it } from "vitest";
import { ApiError } from "../../src/errors.js";
import { appSchemes, assertReturnSchemeAllowed } from "../../src/handoff/app-schemes.js";
import { HANDOFF_DONE_PATH, handoffDonePath } from "../../src/handoff/handoff-paths.js";

/** The shell schemes a browser handoff may return to, and the done page path (spec §1, §3). */

const URIS = [
  "capybara://auth/callback",
  "capy-dev://auth/callback",
  "https://x/cb",
  "capybara://other",
];
const cfg = (publicUrl: string | undefined, appRedirectUris = URIS) => ({
  http: { publicUrl },
  auth: { appRedirectUris },
});

describe("appSchemes", () => {
  it("lists the schemes whose auth callback is an allowed app redirect URI", () => {
    expect(appSchemes(cfg("https://cap.example"))).toEqual(["capybara", "capy-dev"]);
  });

  it("is empty without http.publicUrl", () => {
    expect(appSchemes(cfg(undefined))).toEqual([]);
  });

  it("skips entries whose scheme is not a plain lowercase scheme, and duplicates", () => {
    const uris = ["Cap://auth/callback", "x y://auth/callback", "a://auth/callback"];
    expect(appSchemes(cfg("https://c", [...uris, "a://auth/callback"]))).toEqual(["a"]);
  });
});

describe("assertReturnSchemeAllowed", () => {
  const on = cfg("https://cap.example");
  const code = (f: () => void) => {
    try {
      f();
    } catch (e) {
      return e instanceof ApiError ? e.code : "other";
    }
    return "none";
  };

  it("passes without a scheme and for a listed one", () => {
    expect(code(() => assertReturnSchemeAllowed(on, undefined))).toBe("none");
    expect(code(() => assertReturnSchemeAllowed(on, "capybara"))).toBe("none");
  });

  it("refuses an unlisted scheme, matching exactly", () => {
    expect(code(() => assertReturnSchemeAllowed(on, "evil"))).toBe("handoff.scheme_not_allowed");
    expect(code(() => assertReturnSchemeAllowed(on, "CAPYBARA"))).toBe(
      "handoff.scheme_not_allowed",
    );
  });

  it("refuses every scheme without http.publicUrl", () => {
    expect(code(() => assertReturnSchemeAllowed(cfg(undefined), "capybara"))).toBe(
      "handoff.scheme_not_allowed",
    );
  });
});

describe("handoffDonePath", () => {
  it("names the connector, the original page and the scheme", () => {
    const p = handoffDonePath({
      kind: "connector",
      accountId: "a1",
      orgId: "o1",
      connectorId: "c1",
      returnTo: "/en/settings/connectors?x=1",
      returnScheme: "capybara",
    });
    expect(p).toBe(
      `${HANDOFF_DONE_PATH}?kind=connector&org=o1&connector=c1&returnTo=%2Fen%2Fsettings%2Fconnectors%3Fx%3D1&scheme=capybara`,
    );
  });

  it("names the login method and leaves the scheme out when there is none", () => {
    const p = handoffDonePath({
      kind: "identity-link",
      accountId: "a1",
      plugin: "fake-idp",
      returnTo: "/account/identities",
    });
    expect(p).toBe(
      "/handoff/done?kind=identity-link&plugin=fake-idp&returnTo=%2Faccount%2Fidentities",
    );
  });
});
