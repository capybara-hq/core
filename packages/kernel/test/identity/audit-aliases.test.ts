import { describe, expect, it } from "vitest";
import { auditActionAliases, LEGACY_AUDIT_ACTIONS } from "../../src/identity/audit.js";

describe("审计 action 同义（D17 / F-X）", () => {
  it("改名前的连接器审计与新 action 互为同义，两个方向都能查到", () => {
    expect(auditActionAliases("connector.created")).toEqual(["connector.created", "app.created"]);
    expect(auditActionAliases("app.credential.cleared")).toEqual([
      "connector.credential.cleared",
      "app.credential.cleared",
    ]);
  });

  it("显式映射覆盖八项（含 tool_reviewed 与凭据两项）", () => {
    expect(Object.keys(LEGACY_AUDIT_ACTIONS).sort()).toEqual([
      "app.created",
      "app.credential.cleared",
      "app.credential.set",
      "app.deleted",
      "app.tool_reviewed",
      "app.tools_drifted",
      "app.tools_refreshed",
      "app.updated",
    ]);
  });

  it("infers nothing from a prefix: bundle actions and other actions alias only themselves", () => {
    expect(auditActionAliases("app.installed")).toEqual(["app.installed"]);
    expect(auditActionAliases("plugin.org_installed")).toEqual(["plugin.org_installed"]);
    expect(auditActionAliases("org.member.role_changed")).toEqual(["org.member.role_changed"]);
  });
});
