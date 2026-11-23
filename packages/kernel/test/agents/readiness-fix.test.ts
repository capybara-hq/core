import { describe, expect, it } from "vitest";
import { fixOf } from "../../src/agents/readiness.service.js";
import type { OrgExtensionView } from "../../src/extensions/org-config.js";

const view = (over: Partial<OrgExtensionView>): OrgExtensionView => ({
  plugin: "provider",
  version: "1.0.0",
  enabled: true,
  configurable: true,
  permissions: [],
  available: true,
  status: "enabled",
  required: false,
  catalogItem: null,
  switchable: true,
  overrideState: "following",
  needsConfig: false,
  ...over,
});

describe("readiness: what an org admin can fix", () => {
  it("needs_config only when the org can configure it (an overridable field)", () => {
    expect(fixOf(view({ needsConfig: true }))).toBe("needs_config");
    // nothing the org can override: only the super admin can help
    expect(fixOf(view({ configurable: false, overrideState: "none", needsConfig: true }))).toBe(
      null,
    );
    expect(fixOf(view({ enabled: false, configurable: false, needsConfig: true }))).toBe(null);
    expect(fixOf(view({ enabled: false }))).toBe("not_enabled");
  });
});
