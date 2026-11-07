import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { ActorFacts } from "../../src/platform/actor.js";
import { availability } from "../../src/platform/availability.js";
import {
  type ConfirmClass,
  defineOperation,
  type OperationAuthz,
  type PlatformOperation,
} from "../../src/platform/operation.js";

/** An operation with the given authorization and confirmation class (the rest is filler). */
function op(authz: OperationAuthz, confirm: ConfirmClass): PlatformOperation {
  return defineOperation({
    id: "skills.create",
    description: "Create an org skill.",
    input: z.object({}),
    example: {},
    authz,
    mirrors: [],
    confirm,
    ...(confirm !== "read" && { summary: () => ({ zh: "新建技能", en: "Create a skill" }) }),
    run: async () => null,
  }) as PlatformOperation;
}

const facts = (over: Partial<ActorFacts> = {}): ActorFacts => ({
  role: "admin",
  isSuperAdmin: false,
  personPresent: true,
  agentPrivateToActor: false,
  setting: "on",
  ...over,
});

const manageSkills = op({ orgAction: "skills.manage" }, "org");
const readSkills = op({ orgAction: "skills.read" }, "read");

describe("availability", () => {
  it("refuses a member an admin action and names an org admin", () => {
    const r = availability(manageSkills, facts({ role: "member" }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("org admin");
  });

  it("allows an org admin the admin action", () => {
    expect(availability(manageSkills, facts({ role: "admin" }))).toEqual({ ok: true });
  });

  it("refuses an actor who is not a member any more", () => {
    const r = availability(readSkills, facts({ role: null }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("not a member");
  });

  it("refuses a platform operation outside the super admin's own private agent", () => {
    const platform = op({ superAdmin: true }, "platform");
    const r = availability(platform, facts({ isSuperAdmin: true, agentPrivateToActor: false }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("private agent");
    expect(
      availability(platform, facts({ isSuperAdmin: true, agentPrivateToActor: true })),
    ).toEqual({ ok: true });
  });

  it("refuses a platform operation to anyone but the super admin", () => {
    const r = availability(
      op({ superAdmin: true }, "read"),
      facts({ role: "owner", agentPrivateToActor: true }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("the super admin");
  });

  it("refuses a write when no person is present, and allows a read", () => {
    const r = availability(manageSkills, facts({ personPresent: false }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("no person is present");
    expect(availability(readSkills, facts({ personPresent: false }))).toEqual({ ok: true });
  });

  it("refuses writes when the org set the tool to read-only, and allows reads", () => {
    const r = availability(manageSkills, facts({ setting: "read-only" }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("read-only");
    expect(availability(readSkills, facts({ setting: "read-only" }))).toEqual({ ok: true });
  });

  it("refuses everything when the org turned the tool off", () => {
    const r = availability(readSkills, facts({ setting: "off" }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("off");
  });
});
