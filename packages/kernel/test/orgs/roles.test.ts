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
};

describe("roles", () => {
  it("ORG_ROLES 由低到高", () => {
    expect(ORG_ROLES).toEqual(["guest", "member", "admin", "owner"]);
    expect(roleAtLeast("admin", "member")).toBe(true);
    expect(roleAtLeast("member", "member")).toBe(true);
    expect(roleAtLeast("guest", "member")).toBe(false);
  });

  it("ACTION_MIN_ROLE 覆盖全部 9 个动作", () => {
    expect(Object.keys(ACTION_MIN_ROLE).sort()).toEqual(Object.keys(EXPECTED).sort());
  });

  const cases = ORG_ROLES.flatMap((role) =>
    (Object.keys(EXPECTED) as OrgAction[]).map(
      (action) => [role, action, EXPECTED[action].includes(role)] as const,
    ),
  );
  it("真值表共 4×9 = 36 个组合", () => {
    expect(cases.length).toBe(36);
  });
  it.each(cases)("can(%s, %s) = %s", (role, action, allowed) => {
    expect(can(role, action)).toBe(allowed);
  });

  it("HUMAN_ONLY 是除 org.read、org.members.read 外的全部动作", () => {
    expect(HUMAN_ONLY.has("org.read")).toBe(false);
    expect(HUMAN_ONLY.has("org.members.read")).toBe(false);
    const rest = (Object.keys(EXPECTED) as OrgAction[]).filter(
      (a) => a !== "org.read" && a !== "org.members.read",
    );
    for (const a of rest) expect(HUMAN_ONLY.has(a)).toBe(true);
    expect(HUMAN_ONLY.size).toBe(rest.length);
  });
});
