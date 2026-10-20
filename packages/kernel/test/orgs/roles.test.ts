import { describe, expect, it } from "vitest";
import {
  ACTION_MIN_ROLE,
  can,
  HUMAN_ONLY,
  ORG_ROLES,
  type OrgAction,
  type OrgRole,
  roleAtLeast,
} from "../../src/orgs/roles.js";

const G = "guest";
const M = "member";
const A = "admin";
const O = "owner";

/** 每个动作允许的角色（与 brief 的定义逐一对应）。 */
const EXPECTED: Record<OrgAction, OrgRole[]> = {
  "org.read": [G, M, A, O],
  "org.members.read": [M, A, O],
  "org.update": [A, O],
  "org.members.manage": [A, O],
  "org.invitations.manage": [A, O],
  "org.tokens.manage": [A, O],
  "org.plugins.manage": [A, O],
  "org.delete": [O],
  "org.transfer": [O],
  "agents.create": [M, A, O],
  "agents.use": [G, M, A, O],
  "agents.manage": [A, O],
  "apps.manage": [A, O],
  "apps.use": [G, M, A, O],
  "approvals.decide": [G, M, A, O],
  "channels.manage": [A, O],
  "ui.use": [G, M, A, O],
};

/** 服务令牌可执行的动作（不在 HUMAN_ONLY 中）。 */
const SERVICE_OK: OrgAction[] = ["org.read", "org.members.read", "agents.use"];

describe("roles", () => {
  it("ORG_ROLES 由低到高", () => {
    expect(ORG_ROLES).toEqual(["guest", "member", "admin", "owner"]);
    expect(roleAtLeast("admin", "member")).toBe(true);
    expect(roleAtLeast("member", "member")).toBe(true);
    expect(roleAtLeast("guest", "member")).toBe(false);
  });

  it("ACTION_MIN_ROLE 覆盖全部 17 个动作", () => {
    expect(Object.keys(ACTION_MIN_ROLE).sort()).toEqual(Object.keys(EXPECTED).sort());
  });

  const cases = ORG_ROLES.flatMap((role) =>
    (Object.keys(EXPECTED) as OrgAction[]).map(
      (action) => [role, action, EXPECTED[action].includes(role)] as const,
    ),
  );
  it("真值表共 4×17 = 68 个组合", () => {
    expect(cases.length).toBe(68);
  });
  it.each(cases)("can(%s, %s) = %s", (role, action, allowed) => {
    expect(can(role, action)).toBe(allowed);
  });

  it("HUMAN_ONLY 是除 org.read、org.members.read、agents.use 外的全部动作", () => {
    for (const a of SERVICE_OK) expect(HUMAN_ONLY.has(a)).toBe(false);
    expect(HUMAN_ONLY.has("agents.create")).toBe(true);
    for (const a of [
      "apps.manage",
      "apps.use",
      "approvals.decide",
      "channels.manage",
      "ui.use",
    ] as const)
      expect(HUMAN_ONLY.has(a)).toBe(true);
    const rest = (Object.keys(EXPECTED) as OrgAction[]).filter((a) => !SERVICE_OK.includes(a));
    for (const a of rest) expect(HUMAN_ONLY.has(a)).toBe(true);
    expect(HUMAN_ONLY.size).toBe(rest.length);
  });
});
