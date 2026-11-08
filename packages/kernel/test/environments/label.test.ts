import { describe, expect, it } from "vitest";
import { environmentLabel } from "../../src/environments/label.js";

/** The environment names the IM `/env` list and the `Platform` tool show. */
describe("environmentLabel", () => {
  const docker = { zh: "Docker 沙箱", en: "Docker sandbox" };
  const demoted = (displayName: typeof docker | null, ordinal = 1) => ({
    name: null,
    demotedFrom: { provider: "sandbox-docker", displayName, ordinal },
  });

  it("a demoted default is the default's name plus the provider's display name", () => {
    expect(environmentLabel(demoted(docker), "zh")).toBe("个人环境（Docker 沙箱）");
    expect(environmentLabel(demoted(docker), "en")).toBe("Personal (Docker sandbox)");
    expect(environmentLabel(demoted(docker, 2), "en")).toBe("Personal (Docker sandbox) 2");
    // no display name (the plugin is gone): the plugin id
    expect(environmentLabel(demoted(null), "zh")).toBe("个人环境（sandbox-docker）");
  });

  it("a given name wins; the default is Personal", () => {
    expect(environmentLabel({ name: "Build box", demotedFrom: null }, "zh")).toBe("Build box");
    expect(environmentLabel({ name: null, demotedFrom: null }, "zh")).toBe("个人环境");
    expect(environmentLabel({ name: null, demotedFrom: null }, "en")).toBe("Personal");
  });
});
