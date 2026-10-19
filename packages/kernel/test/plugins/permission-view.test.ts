import { describe, expect, it } from "vitest";
import type { PermissionSet } from "../../src/plugins/permission-set.js";
import { permissionGroups } from "../../src/plugins/permission-view.js";

const base: PermissionSet = {
  provides: [],
  requires: [],
  optional: [],
  config: { deployment: [], org: [] },
  tables: [],
  permissions: {
    secrets: false,
    storage: false,
    http: [],
    tools: [],
    hooks: [],
    models: [],
    network: [],
  },
};

describe("permissionGroups", () => {
  it("空集合没有分组", () => {
    expect(permissionGroups(base)).toEqual([]);
  });

  it("按类别分组，敏感项为密钥、公开路由、工具、hook（及下面的敏感能力）；公开路由与普通路由分开", () => {
    const groups = permissionGroups({
      ...base,
      provides: ["channel@1"],
      config: {
        deployment: [],
        org: [
          { path: "token", secret: true },
          { path: "id", secret: false },
        ],
      },
      tables: ["t"],
      permissions: {
        secrets: true,
        storage: true,
        http: [
          { method: "GET", path: "/a", public: false },
          { method: "POST", path: "/events", public: true },
        ],
        tools: ["write"],
        hooks: ["run.completed"],
        models: [{ purpose: "chat", kind: "llm" }],
        network: ["a.example.com"],
      },
    });
    const by = Object.fromEntries(groups.map((g) => [g.category, g]));
    expect(by.provides).toEqual({ category: "provides", sensitive: false, items: ["channel@1"] });
    expect(by.config?.items).toEqual(["org:token", "org:id"]);
    expect(by.secrets).toEqual({
      category: "secrets",
      sensitive: true,
      items: ["secret store", "token"],
    });
    expect(by.http).toEqual({ category: "http", sensitive: false, items: ["GET /a"] });
    expect(by.publicRoutes).toEqual({
      category: "publicRoutes",
      sensitive: true,
      items: ["POST /events"],
    });
    expect(by.tools?.sensitive).toBe(true);
    expect(by.hooks?.sensitive).toBe(true);
    expect(by.models?.items).toEqual(["chat (llm)"]);
    expect(by.network?.sensitive).toBe(false);
    expect(by.storage?.sensitive).toBe(false);
  });

  it("提供 directory@1 或 identity-source@1 时「提供」一组标为敏感（能加人进组织 / 能登录成别人）", () => {
    for (const cap of ["directory@1", "identity-source@1"]) {
      const [g] = permissionGroups({ ...base, provides: ["channel@1", cap] });
      expect(g, cap).toEqual({
        category: "provides",
        sensitive: true,
        items: ["channel@1", cap],
      });
    }
    const [plain] = permissionGroups({ ...base, provides: ["channel@1", "model-provider@2"] });
    expect(plain?.sensitive).toBe(false);
  });
});
