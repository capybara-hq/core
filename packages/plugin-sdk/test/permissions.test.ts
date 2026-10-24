import { describe, expect, it } from "vitest";
import {
  EXTENSION_POINT_CARDINALITY,
  EXTENSION_POINTS,
  ExtensionPermissionError,
  ExtensionPointUnavailableError,
  validatePermissions,
} from "../src/index.js";

describe("EXTENSION_POINTS", () => {
  it("marks brokered / orgScoped per ruling", () => {
    for (const n of ["model-provider", "connector", "sandbox", "secret-store", "object-store"]) {
      expect(EXTENSION_POINTS[n]?.brokered).toBe(true);
    }
    for (const n of ["channel", "identity-source", "directory", "counter", "config-source"]) {
      expect(EXTENSION_POINTS[n]?.brokered).toBe(false);
    }
    expect(EXTENSION_POINTS.channel?.orgScoped).toBe(true);
    expect(EXTENSION_POINTS.directory?.orgScoped).toBe(true);
    expect(EXTENSION_POINTS["identity-source"]?.orgScoped).toBe(false);
    expect(EXTENSION_POINTS["object-store"]?.cardinality).toBe("single");
  });
  it("derives EXTENSION_POINT_CARDINALITY", () => {
    expect(EXTENSION_POINT_CARDINALITY.sandbox).toBe("single");
    expect(EXTENSION_POINT_CARDINALITY.channel).toBe("multi");
  });
});

describe("errors", () => {
  it("names plugin and manifest item", () => {
    const e = new ExtensionPermissionError("slack", "permissions.secrets");
    expect(e.message).toMatch(/slack/);
    expect(e.message).toMatch(/permissions\.secrets/);
    expect(e.name).toBe("ExtensionPermissionError");
    expect(new ExtensionPointUnavailableError("x").name).toBe("ExtensionPointUnavailableError");
  });
});

describe("validatePermissions", () => {
  it("accepts undefined and a full valid manifest", () => {
    expect(validatePermissions("slack", undefined)).toEqual([]);
    expect(
      validatePermissions("slack", {
        secrets: true,
        http: [
          { method: "POST", path: "/events", public: true },
          { method: "GET", path: "/events" },
        ],
        tools: ["a"],
        hooks: ["session.start", "tool.preExecute"],
        models: [{ purpose: "slack.summary", kind: "chat", label: { zh: "摘要", en: "Summary" } }],
        storage: true,
        network: ["slack.com", "api.slack.com"],
      }),
    ).toEqual([]);
  });
  it("rejects unknown keys", () => {
    expect(validatePermissions("slack", { bogus: true }).join()).toMatch(/bogus/);
  });
  it("rejects non-object", () => {
    expect(validatePermissions("slack", 3)).not.toEqual([]);
  });
  it("rejects bad model purpose prefix and kind", () => {
    const errs = validatePermissions("slack", {
      models: [{ purpose: "other.x", kind: "chat", label: { zh: "a", en: "b" } }],
    });
    expect(errs.join()).toMatch(/slack\./);
    expect(
      validatePermissions("slack", {
        models: [{ purpose: "slack.x", kind: "image", label: { zh: "a", en: "b" } }],
      }),
    ).not.toEqual([]);
    expect(
      validatePermissions("slack", {
        models: [{ purpose: "slack.x", kind: "chat", label: { zh: "", en: "b" } }],
      }),
    ).not.toEqual([]);
  });
  it("rejects duplicate purposes", () => {
    const m = { purpose: "slack.x", kind: "chat", label: { zh: "a", en: "b" } };
    expect(validatePermissions("slack", { models: [m, m] }).join()).toMatch(/duplicate/);
  });
  it("rejects bad and duplicate routes", () => {
    expect(validatePermissions("p", { http: [{ method: "GET", path: "x" }] })).not.toEqual([]);
    expect(validatePermissions("p", { http: [{ method: "PATCH", path: "/x" }] })).not.toEqual([]);
    expect(
      validatePermissions("p", {
        http: [
          { method: "GET", path: "/x" },
          { method: "GET", path: "/x" },
        ],
      }).join(),
    ).toMatch(/duplicate/);
  });
  it("rejects invalid domains", () => {
    for (const d of ["http://a.com", "a.com/path", "nodot", "a b.com", ""]) {
      expect(validatePermissions("p", { network: [d] })).not.toEqual([]);
    }
  });
  it("rejects wrong types and duplicate tools", () => {
    expect(validatePermissions("p", { secrets: "yes" })).not.toEqual([]);
    expect(validatePermissions("p", { storage: 1 })).not.toEqual([]);
    expect(validatePermissions("p", { tools: ["a", "a"] }).join()).toMatch(/duplicate/);
    expect(validatePermissions("p", { tools: [1] })).not.toEqual([]);
  });
  it("accepts only the closed list of hook mount points", () => {
    const all = [
      "session.start",
      "session.end",
      "agent.preStep",
      "model.request",
      "model.response",
      "tool.preExecute",
      "tool.postExecute",
      "usage.report",
    ];
    expect(validatePermissions("p", { hooks: all })).toEqual([]);
    expect(validatePermissions("p", { hooks: ["x"] }).join()).toMatch(/hook "x"/);
    expect(validatePermissions("p", { hooks: ["session.Start"] })).not.toEqual([]);
  });
  it("rejects non-boolean http.public", () => {
    expect(
      validatePermissions("p", { http: [{ method: "POST", path: "/x", public: "yes" }] }),
    ).not.toEqual([]);
  });
  it("rejects a model purpose with an empty suffix", () => {
    expect(
      validatePermissions("slack", {
        models: [{ purpose: "slack.", kind: "chat", label: { zh: "a", en: "b" } }],
      }).join(),
    ).toMatch(/slack\./);
  });
});
