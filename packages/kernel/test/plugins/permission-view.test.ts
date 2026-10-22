import { describe, expect, it } from "vitest";
import type { PermissionSet } from "../../src/plugins/permission-set.js";
import {
  derivePluginStatus,
  isSensitivePermissionKey,
  permissionGroups,
  SENSITIVE_CAPABILITIES,
  type StatusInput,
} from "../../src/plugins/permission-view.js";

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
    ui: { views: [], embeds: [] },
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
        ui: { views: [], embeds: [] },
      },
    });
    const by = Object.fromEntries(groups.map((g) => [g.category, g]));
    expect(by.provides).toEqual({ category: "provides", sensitive: true, items: ["channel@1"] });
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

  it("提供 channel@1、directory@1 或 identity-source@1 时「提供」一组标为敏感（收到组织对话 / 能加人进组织 / 能登录成别人）", () => {
    for (const cap of ["channel@1", "directory@1", "identity-source@1"]) {
      const [g] = permissionGroups({ ...base, provides: ["counter@1", cap] });
      expect(g, cap).toEqual({
        category: "provides",
        sensitive: true,
        items: ["counter@1", cap],
      });
    }
    const [plain] = permissionGroups({ ...base, provides: ["counter@1", "model-provider@2"] });
    expect(plain?.sensitive).toBe(false);
  });

  it("D10 + 计划扩展：提供 sandbox@1 或 object-store@1 时「提供」一组同样标为敏感，CLI 逐项标记", () => {
    expect([...SENSITIVE_CAPABILITIES].sort()).toEqual(
      ["channel@1", "directory@1", "identity-source@1", "object-store@1", "sandbox@1"].sort(),
    );
    for (const cap of ["sandbox@1", "object-store@1"]) {
      const [g] = permissionGroups({ ...base, provides: [cap] });
      expect(g, cap).toEqual({ category: "provides", sensitive: true, items: [cap] });
      expect(isSensitivePermissionKey(`provides:${cap}`), cap).toBe(true);
      // 只影响展示：依赖它不算敏感
      expect(isSensitivePermissionKey(`requires:${cap}`), cap).toBe(false);
    }
  });
});

describe("derivePluginStatus", () => {
  const SHA = "a".repeat(64);
  const OLD = "b".repeat(64);
  const loaded = { state: "loaded", reason: null, sha256: SHA };
  const install = (over: Partial<StatusInput> = {}): StatusInput => ({
    source: "install",
    desired: { sha256: SHA, state: "enabled" },
    pendingApproval: false,
    configValid: true,
    migratedSha: SHA,
    replicas: [loaded, loaded],
    ...over,
  });

  it("安装记录：全部副本加载了目标包 → enabled；停用且没有副本还加载着 → disabled", () => {
    expect(derivePluginStatus(install())).toBe("enabled");
    expect(
      derivePluginStatus(
        install({
          desired: { sha256: SHA, state: "disabled" },
          replicas: [{ state: "unloaded", reason: null, sha256: SHA }],
        }),
      ),
    ).toBe("disabled");
  });

  it("converging：有副本还没换到目标包、还没有副本、或停用后仍有副本加载着", () => {
    expect(derivePluginStatus(install({ replicas: [loaded, { ...loaded, sha256: OLD }] }))).toBe(
      "converging",
    );
    expect(derivePluginStatus(install({ replicas: [] }))).toBe("converging");
    expect(derivePluginStatus(install({ desired: { sha256: SHA, state: "disabled" } }))).toBe(
      "converging",
    );
  });

  it("优先级：failed > dependency > pending_approval > pending_config > pending_migration > converging", () => {
    const failed = { state: "failed", reason: "setup", sha256: SHA };
    const dep = { state: "pending", reason: "dependency", sha256: SHA };
    const all = {
      pendingApproval: true,
      configValid: false,
      migratedSha: null,
      replicas: [failed, dep],
    };
    expect(derivePluginStatus(install(all))).toBe("failed");
    expect(derivePluginStatus(install({ ...all, replicas: [dep] }))).toBe("dependency");
    expect(derivePluginStatus(install({ ...all, replicas: [] }))).toBe("pending_approval");
    expect(derivePluginStatus(install({ ...all, pendingApproval: false, replicas: [] }))).toBe(
      "pending_config",
    );
    expect(
      derivePluginStatus(
        install({ ...all, pendingApproval: false, configValid: true, replicas: [] }),
      ),
    ).toBe("pending_migration");
  });

  it("旧包的 failed 行不算 failed（期望已换新包，该副本仍在收敛）；随提供方卸下（unloaded / dependency）算 dependency", () => {
    expect(
      derivePluginStatus(
        install({ replicas: [loaded, { state: "failed", reason: "sync", sha256: OLD }] }),
      ),
    ).toBe("converging");
    expect(
      derivePluginStatus(
        install({ replicas: [{ state: "unloaded", reason: "dependency", sha256: SHA }] }),
      ),
    ).toBe("dependency");
  });

  it("待批准与期望状态无关（F-N）：停用的安装记录同样 pending_approval；停用时不看迁移", () => {
    expect(
      derivePluginStatus(
        install({
          desired: { sha256: SHA, state: "disabled" },
          pendingApproval: true,
          replicas: [],
        }),
      ),
    ).toBe("pending_approval");
    expect(
      derivePluginStatus(
        install({ desired: { sha256: SHA, state: "disabled" }, migratedSha: null, replicas: [] }),
      ),
    ).toBe("disabled");
  });

  it("内置 / 配置声明：始终期望启用，不看 sha 与迁移记录", () => {
    const declared: StatusInput = {
      source: "builtin",
      desired: null,
      pendingApproval: false,
      configValid: true,
      migratedSha: null,
      replicas: [{ state: "loaded", reason: null, sha256: null }],
    };
    expect(derivePluginStatus(declared)).toBe("enabled");
    expect(derivePluginStatus({ ...declared, configValid: false, replicas: [] })).toBe(
      "pending_config",
    );
    expect(derivePluginStatus({ ...declared, source: "config", replicas: [] })).toBe("converging");
  });
});
