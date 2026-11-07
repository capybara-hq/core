import { describe, expect, it } from "vitest";
import {
  canConfigureModels,
  canViewTrajectory,
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

  it("the model-service fix entry: super admins only, for a model setup error", () => {
    expect(canConfigureModels(me("member", { superAdmin: true }))).toBe(true);
    expect(canConfigureModels(me("owner"))).toBe(false);
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
