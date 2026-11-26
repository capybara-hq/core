import { describe, expect, it } from "vitest";
import type {
  DeploymentConfigField,
  DeploymentConfigView,
} from "../../src/extensions/deployment-config.js";
import {
  configGuides,
  LOGIN_SOURCE_NEXT,
  platformConfigNext,
} from "../../src/platform/ops/extensions-admin.ops.js";

// `extensions.platform-config` lists the extension's platform setup guides (id and title only) and
// names `extensions.platform-guides` as the next step while the config still needs setting up.

const field = (over: Partial<DeploymentConfigField>): DeploymentConfigField => ({
  path: "clientId",
  secret: false,
  hot: false,
  source: "db",
  readonly: false,
  value: "x",
  level: "platform",
  ...over,
});

const view = (over: Partial<DeploymentConfigView> = {}): DeploymentConfigView => ({
  plugin: "slack",
  displayName: null,
  version: "1.0.0",
  configurable: true,
  fields: [field({})],
  schema: { type: "object", required: ["clientId"] },
  valid: true,
  validated: true,
  issues: [],
  orgMustConfigure: [],
  ...over,
});

const GUIDE = { id: "slack-sign-in", title: "Set up Slack sign-in", blocks: ["long body"] };

describe("configGuides", () => {
  it("lists id and title only, without a next step when the config is complete", () => {
    expect(configGuides(view(), [GUIDE])).toEqual({
      guides: [{ id: "slack-sign-in", title: "Set up Slack sign-in" }],
    });
  });

  it("names extensions.platform-guides when the config is invalid", () => {
    const r = configGuides(view({ valid: false }), [GUIDE]);
    expect(r.next).toContain("extensions.platform-guides");
  });

  it("names it when a required field has no value, though the view could not validate", () => {
    const unset = view({
      validated: false,
      fields: [field({ source: "unset", value: undefined })],
    });
    expect(configGuides(unset, [GUIDE]).next).toContain("extensions.platform-guides");
    const secret = view({
      validated: false,
      fields: [field({ secret: true, set: false, value: undefined })],
    });
    expect(configGuides(secret, [GUIDE]).next).toContain("extensions.platform-guides");
  });

  it("names it when a required overridable field is left for the orgs", () => {
    const r = configGuides(view({ orgMustConfigure: ["baseUrl"] }), [GUIDE]);
    expect(r.next).toContain("extensions.platform-guides");
  });

  it("gives no next step without a guide, whatever the config", () => {
    expect(configGuides(view({ valid: false }), [])).toEqual({ guides: [] });
  });
});

describe("platformConfigNext", () => {
  const SETUP = "Read the setup guides.";

  it("guide and login source: the guide's step, then the login step", () => {
    expect(platformConfigNext(SETUP, true)).toBe(`${SETUP} ${LOGIN_SOURCE_NEXT}`);
  });

  it("login source only: the login step", () => {
    expect(platformConfigNext(undefined, true)).toBe(LOGIN_SOURCE_NEXT);
  });

  it("guide only: the guide's step", () => {
    expect(platformConfigNext(SETUP, false)).toBe(SETUP);
  });

  it("neither: no next step", () => {
    expect(platformConfigNext(undefined, false)).toBeUndefined();
  });
});
