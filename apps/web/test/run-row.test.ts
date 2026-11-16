import { describe, expect, it } from "vitest";
import { modelConfigHref, modelConfigViewer } from "../src/lib/model-config";
import {
  canViewTrajectory,
  configureModelsHref,
  isModelSetupError,
  runParts,
} from "../src/lib/run-row";
import type { RunData } from "../src/lib/timeline";

const me = (role: string, opts: { id?: string; superAdmin?: boolean } = {}) => ({
  account: { id: opts.id ?? "a1", isSuperAdmin: opts.superAdmin ?? false },
  currentOrgId: "o1",
  memberships: [{ orgId: "o1", role }],
});

describe("run row role gating (the kernel's rules)", () => {
  it("the trajectory link: org admins and owners, or the agent's owner who is at least a member", () => {
    expect(canViewTrajectory(me("owner"), "someone")).toBe(true);
    expect(canViewTrajectory(me("admin"), "someone")).toBe(true);
    expect(canViewTrajectory(me("member"), "a1")).toBe(true);
    expect(canViewTrajectory(me("member"), "someone")).toBe(false);
    // a guest never reads trajectories, even of an agent it owns
    expect(canViewTrajectory(me("guest"), "a1")).toBe(false);
    // the owner is unknown (no agent): only admins
    expect(canViewTrajectory(me("member"), undefined)).toBe(false);
    expect(canViewTrajectory(me("admin"), undefined)).toBe(true);
  });

  it("the one model-config rule: not_enabled for org admins, the platform's side for super admins", () => {
    const v = (superAdmin: boolean, orgAdmin: boolean) => ({ superAdmin, orgAdmin });
    expect(modelConfigHref("not_enabled", v(false, true))).toBe("/settings/models");
    expect(modelConfigHref("not_enabled", v(true, true))).toBe("/settings/models");
    expect(modelConfigHref("not_enabled", v(true, false))).toBeNull();
    expect(modelConfigHref("platform", v(true, false))).toBe("/admin/models");
    expect(modelConfigHref("platform", v(true, true))).toBe("/admin/models");
    expect(modelConfigHref("platform", v(false, true))).toBeNull();
    expect(modelConfigHref("platform", v(false, false))).toBeNull();
    // failed credentials: the org's admins first (their own copy), else a super admin
    expect(modelConfigHref("credentials", v(false, true))).toBe("/settings/models");
    expect(modelConfigHref("credentials", v(true, true))).toBe("/settings/models");
    expect(modelConfigHref("credentials", v(true, false))).toBe("/admin/models");
    expect(modelConfigHref("credentials", v(false, false))).toBeNull();
    expect(modelConfigViewer(me("owner", { superAdmin: true }))).toEqual(v(true, true));
    expect(modelConfigViewer(me("member"))).toEqual(v(false, false));
  });

  it("the model-service fix entry of a failed run: where its error is fixed, for a viewer who can", () => {
    const fix = (role: string, code: string, superAdmin = false) =>
      configureModelsHref(modelConfigViewer(me(role, { superAdmin })), code);
    // a model not on in the org: the org's admins
    expect(fix("admin", "run.model_unavailable")).toBe("/settings/models");
    expect(fix("owner", "run.model_unavailable", true)).toBe("/settings/models");
    expect(fix("member", "run.model_unavailable", true)).toBeNull();
    // failed credentials: an org admin fixes the org's copy on /settings/models; a super admin who
    // is not one goes to the platform's
    expect(fix("admin", "model.auth")).toBe("/settings/models");
    expect(fix("owner", "model.auth", true)).toBe("/settings/models");
    expect(fix("member", "model.auth", true)).toBe("/admin/models");
    expect(fix("member", "model.auth")).toBeNull();
    // a purpose without a model: super admins
    expect(fix("owner", "model.unconfigured", true)).toBe("/admin/models");
    expect(fix("member", "model.unconfigured")).toBeNull();
    // not a model setup error
    expect(fix("owner", "model.timeout", true)).toBeNull();
    for (const code of ["model.auth", "model.unconfigured", "run.model_unavailable"])
      expect(isModelSetupError(code)).toBe(true);
    for (const code of ["model.timeout", "model.rate_limited", "run.hook_denied", "conflict"])
      expect(isModelSetupError(code)).toBe(false);
  });
});

describe("runParts", () => {
  const base: RunData = {
    runId: "r1",
    status: "ok",
    model: { provider: "p", model: "deepseek-flash" },
    durationMs: 3_700,
    tokens: { input: 1000, output: 200, cacheRead: 34, cacheWrite: 0, total: 1234 },
    at: "2026-11-03T00:00:00.000Z",
  };
  const tokens = (n: string) => `${n} tokens`;

  it("model · duration · tokens, unknown parts left out", () => {
    expect(runParts(base, "en", tokens)).toEqual(["deepseek-flash", "3.7s", "1,234 tokens"]);
    expect(
      runParts({ ...base, model: null, durationMs: null, tokens: null }, "en", tokens),
    ).toEqual([]);
  });
});
