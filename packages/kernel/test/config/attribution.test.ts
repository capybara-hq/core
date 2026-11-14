import { describe, expect, it } from "vitest";
import {
  type AgentAttribution,
  ATTRIBUTION_DEFAULTS,
  conversationLink,
  effectiveAttribution,
  type PlatformAttribution,
  parseStoredPlatformAttribution,
  resolvePlatformAttribution,
} from "../../src/attribution/platform-attribution.js";
import { runConfig } from "../helpers/runs.js";

const config = runConfig({ pg: "postgres://x", redis: "redis://x" });
const DEFAULT_LINK = "https://capybara.example.com/chat/c1";

describe("platform attribution defaults", () => {
  it("the startup config has no defaults, so the admin console's choice applies; the effective default is Capybara's", () => {
    expect(config.attribution).toEqual({});
    expect(resolvePlatformAttribution(config.attribution, {})).toEqual(ATTRIBUTION_DEFAULTS);
  });

  it("the startup config overrides each field; an empty string turns a line off", () => {
    const parsed = runConfig(
      { pg: "postgres://x", redis: "redis://x" },
      {
        attribution: {
          commit: "Signed-off-by: Acme <dev@acme.example>",
          pr: "",
          sessionUrl: true,
        },
      },
    );
    expect(resolvePlatformAttribution(parsed.attribution, { commit: "from the db" })).toEqual({
      commit: "Signed-off-by: Acme <dev@acme.example>",
      pr: "",
      sessionUrl: true,
    });
  });

  it("the stored choice fills the fields the startup config leaves out", () => {
    expect(resolvePlatformAttribution(config.attribution, { pr: "PR: Acme" })).toEqual({
      commit: ATTRIBUTION_DEFAULTS.commit,
      pr: "PR: Acme",
      sessionUrl: false,
    });
  });

  it("an invalid stored choice reads as the defaults (a visible line, never a security change)", () => {
    expect(parseStoredPlatformAttribution({ commit: 42 })).toEqual({});
    expect(parseStoredPlatformAttribution(undefined)).toEqual({});
  });

  it("a line with a line break is refused, in the startup config and the stored choice", () => {
    expect(() =>
      runConfig({ pg: "postgres://x", redis: "redis://x" }, { attribution: { commit: "a\nb" } }),
    ).toThrow();
    expect(parseStoredPlatformAttribution({ commit: "a\nb" })).toEqual({});
  });
});

describe("the effective attribution of a run", () => {
  const platform: PlatformAttribution = {
    commit: "Co-Authored-By: Platform <p@example.com>",
    pr: "Generated with Platform",
    sessionUrl: true,
  };

  it("inherit (or absent) follows the platform", () => {
    expect(effectiveAttribution(platform, undefined, DEFAULT_LINK)).toEqual({
      commit: platform.commit,
      pr: platform.pr,
      sessionUrl: DEFAULT_LINK,
    });
    expect(effectiveAttribution(platform, { mode: "inherit" }, DEFAULT_LINK)).toEqual({
      commit: platform.commit,
      pr: platform.pr,
      sessionUrl: DEFAULT_LINK,
    });
  });

  it("custom uses the agent's values; a field it leaves out follows the platform", () => {
    expect(
      effectiveAttribution(
        platform,
        { mode: "custom", commit: "Co-Authored-By: Agent <a@example.com>", sessionUrl: false },
        DEFAULT_LINK,
      ),
    ).toEqual({
      commit: "Co-Authored-By: Agent <a@example.com>",
      pr: platform.pr,
      sessionUrl: null,
    });
    // an empty string turns that line off, not back to the platform's
    expect(
      effectiveAttribution(platform, { mode: "custom", commit: "" }, DEFAULT_LINK).commit,
    ).toBe("");
  });

  it("off adds nothing, whatever the platform says", () => {
    expect(
      effectiveAttribution(platform, { mode: "off", commit: "ignored" }, DEFAULT_LINK),
    ).toEqual({ commit: "", pr: "", sessionUrl: null });
  });

  it("an invalid stored mode reads as inherit, the same value the agent page shows", () => {
    // stored definitions are not re-validated: fail to the platform, never to a silent custom
    expect(
      effectiveAttribution(
        platform,
        { mode: "bogus" } as unknown as AgentAttribution,
        DEFAULT_LINK,
      ),
    ).toEqual({
      commit: platform.commit,
      pr: platform.pr,
      sessionUrl: DEFAULT_LINK,
    });
  });

  it("the conversation link is added only with publicUrl, and only when the source asks for it", () => {
    expect(conversationLink(undefined, "c1")).toBeNull();
    expect(conversationLink("https://capybara.example.com", "c1")).toBe(
      "https://capybara.example.com/chat/c1",
    );
    expect(conversationLink("https://capybara.example.com/", "c1")).toBe(
      "https://capybara.example.com/chat/c1",
    );
    // without a deployment URL sessionUrl adds nothing
    expect(effectiveAttribution(platform, { mode: "inherit" }, null).sessionUrl).toBeNull();
    expect(
      effectiveAttribution(platform, { mode: "custom", sessionUrl: false }, DEFAULT_LINK)
        .sessionUrl,
    ).toBeNull();
  });
});
