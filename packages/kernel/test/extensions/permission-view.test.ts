import { describe, expect, it } from "vitest";
import type { PermissionSet } from "../../src/extensions/permission-set.js";
import {
  deriveExtensionStatus,
  extensionNeedsAction,
  isSensitivePermissionKey,
  migrationWarnings,
  permissionGroups,
  permissionKeyItems,
  reviewHash,
  SENSITIVE_EXTENSION_POINTS,
  type StatusInput,
  warningsDigest,
} from "../../src/extensions/permission-view.js";

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
    expect(by.provides).toEqual({
      category: "provides",
      sensitive: true,
      items: ["channel@1"],
      entries: [{ value: "channel@1", sensitive: true, reason: "channel" }],
    });
    expect(by.config?.items).toEqual(["org:token", "org:id"]);
    expect(by.secrets).toEqual({
      category: "secrets",
      sensitive: true,
      items: ["secret store", "token"],
      entries: [
        { value: "secret store", sensitive: true, reason: "secrets" },
        { value: "token", sensitive: true, reason: "secrets" },
      ],
    });
    expect(by.http).toEqual({
      category: "http",
      sensitive: false,
      items: ["GET /a"],
      entries: [{ value: "GET /a", sensitive: false }],
    });
    expect(by.publicRoutes).toEqual({
      category: "publicRoutes",
      sensitive: true,
      items: ["POST /events"],
      entries: [{ value: "POST /events", sensitive: true, reason: "public_routes" }],
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
        entries: [
          { value: "counter@1", sensitive: false },
          { value: cap, sensitive: true, reason: cap.split("@")[0]?.replaceAll("-", "_") },
        ],
      });
    }
    const [plain] = permissionGroups({ ...base, provides: ["counter@1", "model-provider@2"] });
    expect(plain?.sensitive).toBe(false);
  });

  it("D10 + 计划扩展：提供 sandbox@1 或 object-store@1 时「提供」一组同样标为敏感，CLI 逐项标记", () => {
    expect([...SENSITIVE_EXTENSION_POINTS].sort()).toEqual(
      ["channel@1", "directory@1", "identity-source@1", "object-store@1", "sandbox@1"].sort(),
    );
    for (const cap of ["sandbox@1", "object-store@1"]) {
      const [g] = permissionGroups({ ...base, provides: [cap] });
      expect(g, cap).toEqual({
        category: "provides",
        sensitive: true,
        items: [cap],
        entries: [{ value: cap, sensitive: true, reason: cap.split("@")[0]?.replaceAll("-", "_") }],
      });
      expect(isSensitivePermissionKey(`provides:${cap}`), cap).toBe(true);
      // 只影响展示：依赖它不算敏感
      expect(isSensitivePermissionKey(`requires:${cap}`), cap).toBe(false);
    }
  });
});

describe("deriveExtensionStatus", () => {
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
    expect(deriveExtensionStatus(install())).toBe("enabled");
    expect(
      deriveExtensionStatus(
        install({
          desired: { sha256: SHA, state: "disabled" },
          replicas: [{ state: "unloaded", reason: null, sha256: SHA }],
        }),
      ),
    ).toBe("disabled");
  });

  it("converging：有副本还没换到目标包、还没有副本、或停用后仍有副本加载着", () => {
    expect(deriveExtensionStatus(install({ replicas: [loaded, { ...loaded, sha256: OLD }] }))).toBe(
      "converging",
    );
    expect(deriveExtensionStatus(install({ replicas: [] }))).toBe("converging");
    expect(deriveExtensionStatus(install({ desired: { sha256: SHA, state: "disabled" } }))).toBe(
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
    expect(deriveExtensionStatus(install(all))).toBe("failed");
    expect(deriveExtensionStatus(install({ ...all, replicas: [dep] }))).toBe("dependency");
    expect(deriveExtensionStatus(install({ ...all, replicas: [] }))).toBe("pending_approval");
    expect(deriveExtensionStatus(install({ ...all, pendingApproval: false, replicas: [] }))).toBe(
      "pending_config",
    );
    expect(
      deriveExtensionStatus(
        install({ ...all, pendingApproval: false, configValid: true, replicas: [] }),
      ),
    ).toBe("pending_migration");
  });

  it("旧包的 failed 行不算 failed（期望已换新包，该副本仍在收敛）；随提供方卸下（unloaded / dependency）算 dependency", () => {
    expect(
      deriveExtensionStatus(
        install({ replicas: [loaded, { state: "failed", reason: "sync", sha256: OLD }] }),
      ),
    ).toBe("converging");
    expect(
      deriveExtensionStatus(
        install({ replicas: [{ state: "unloaded", reason: "dependency", sha256: SHA }] }),
      ),
    ).toBe("dependency");
  });

  it("待批准与期望状态无关（F-N）：停用的安装记录同样 pending_approval；停用时不看迁移", () => {
    expect(
      deriveExtensionStatus(
        install({
          desired: { sha256: SHA, state: "disabled" },
          pendingApproval: true,
          replicas: [],
        }),
      ),
    ).toBe("pending_approval");
    expect(
      deriveExtensionStatus(
        install({ desired: { sha256: SHA, state: "disabled" }, migratedSha: null, replicas: [] }),
      ),
    ).toBe("disabled");
  });

  it("配置声明：始终期望启用，不看 sha 与迁移记录", () => {
    const declared: StatusInput = {
      source: "config",
      desired: null,
      pendingApproval: false,
      configValid: true,
      migratedSha: null,
      replicas: [{ state: "loaded", reason: null, sha256: null }],
    };
    expect(deriveExtensionStatus(declared)).toBe("enabled");
    expect(deriveExtensionStatus({ ...declared, configValid: false, replicas: [] })).toBe(
      "pending_config",
    );
    expect(deriveExtensionStatus({ ...declared, replicas: [] })).toBe("converging");
  });
});

describe('extensionNeedsAction ("extensions to act on" in the admin overview)', () => {
  it("待批准、待配置、失败、依赖缺失与副本不一致（收敛中 / 待迁移）算；启用与停用不算", () => {
    expect(
      (
        [
          "enabled",
          "disabled",
          "pending_approval",
          "pending_config",
          "pending_migration",
          "converging",
          "failed",
          "dependency",
        ] as const
      ).filter(extensionNeedsAction),
    ).toEqual([
      "pending_approval",
      "pending_config",
      "pending_migration",
      "converging",
      "failed",
      "dependency",
    ]);
  });
});

describe("migrationWarnings：越出插件 schema 的语句（foreign_schema）", () => {
  it("内核表、GRANT / REVOKE、角色、函数 / 触发器、事务控制标 foreign_schema；自己 schema 里的普通语句不标", () => {
    const sql = [
      "CREATE TABLE IF NOT EXISTS notes (id int)",
      "INSERT INTO notes SELECT 1",
      "UPDATE capybara.accounts SET is_enterprise_admin = true",
      'INSERT INTO notes SELECT count(*) FROM "capybara".sessions',
      "GRANT ALL ON notes TO public",
      "REVOKE SELECT ON notes FROM public",
      "ALTER ROLE app SUPERUSER",
      "CREATE OR REPLACE FUNCTION f() RETURNS int AS $$ SELECT 1 $$ LANGUAGE sql",
      "CREATE TRIGGER t AFTER INSERT ON notes FOR EACH ROW EXECUTE FUNCTION f()",
      "COMMIT",
      "SELECT 'capybara.accounts'",
    ].join(";\n");
    const kinds = migrationWarnings([{ file: "0001_x.sql", sql }], "notes-plugin").map((w) => [
      w.line,
      w.kind,
    ]);
    expect(kinds).toEqual([
      [3, "foreign_schema"],
      [4, "foreign_schema"],
      [5, "foreign_schema"],
      [6, "foreign_schema"],
      [7, "foreign_schema"],
      [8, "foreign_schema"],
      [9, "foreign_schema"],
      [10, "foreign_schema"],
    ]);
  });

  it("reviewHash 并入警告：权限相同、警告不同 → 摘要不同；没有警告时与只看权限的摘要相同", () => {
    const w = migrationWarnings(
      [{ file: "0001_x.sql", sql: "GRANT ALL ON notes TO public;" }],
      "notes-plugin",
    );
    expect(w).toHaveLength(1);
    expect(reviewHash(base, [])).toBe(reviewHash(base));
    expect(reviewHash(base, w)).not.toBe(reviewHash(base));
    const w2 = migrationWarnings([{ file: "0002_y.sql", sql: "COMMIT;" }], "notes-plugin");
    expect(reviewHash(base, w2)).not.toBe(reviewHash(base, w));
  });
});

describe("foreign_schema：别的 schema、search_path、建 schema / 扩展、OWNER TO、COPY PROGRAM（Ruling P4 跟进）", () => {
  it("逐条标出；写自己 schema（plugin_notes_plugin.x）或不带 schema 的不标", () => {
    const sql = [
      "CREATE TABLE IF NOT EXISTS plugin_notes_plugin.items (id int)",
      "INSERT INTO items VALUES (1)",
      "CREATE INDEX IF NOT EXISTS items_idx ON plugin_notes_plugin.items (id)",
      "SET search_path TO public",
      "INSERT INTO public.audit VALUES (1)",
      "CREATE TABLE IF NOT EXISTS plugin_other.stolen (id int)",
      'UPDATE "plugin_other".t SET x = 1',
      "CREATE INDEX IF NOT EXISTS i ON public.t (id)",
      "CREATE SCHEMA IF NOT EXISTS extra",
      "CREATE EXTENSION IF NOT EXISTS pgcrypto",
      "ALTER TABLE items OWNER TO postgres",
      "COPY items FROM PROGRAM 'curl x'",
      "DROP TABLE IF EXISTS other_schema.t",
    ].join(";\n");
    const flagged = migrationWarnings([{ file: "0001_x.sql", sql }], "notes-plugin")
      .filter((w) => w.kind === "foreign_schema")
      .map((w) => w.line);
    expect(flagged).toEqual([4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
  });

  it("warningsDigest：无警告为空串；不含行号（只挪行不变），语句变了就变；摘要键标敏感", () => {
    const a = migrationWarnings([{ file: "0001_x.sql", sql: "GRANT ALL ON t TO public;" }], "p");
    const moved = migrationWarnings(
      [{ file: "0001_x.sql", sql: "\n\nGRANT ALL ON t TO public;" }],
      "p",
    );
    const b = migrationWarnings([{ file: "0001_x.sql", sql: "GRANT SELECT ON t TO public;" }], "p");
    expect(warningsDigest([])).toBe("");
    expect(warningsDigest(a)).toMatch(/^[0-9a-f]{16}$/);
    expect(warningsDigest(moved)).toBe(warningsDigest(a));
    expect(warningsDigest(b)).not.toBe(warningsDigest(a));
    expect(permissionKeyItems([`migration.warnings:${warningsDigest(a)}`])).toEqual([
      {
        value: `migration.warnings:${warningsDigest(a)}`,
        sensitive: true,
        reason: "migration_warnings",
      },
    ]);
  });
});
