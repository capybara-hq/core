import { describe, expect, expectTypeOf, it } from "vitest";
import {
  type AvailableHook,
  HOOK_MOUNT_POINTS,
  HOOKS_AVAILABLE,
  type HookHandler,
  type HookVerdict,
  type PluginContext,
  POLICY_HOOKS,
  type ToolPreHookPayload,
  validatePermissions,
} from "../src/index.js";

describe("hook mount points", () => {
  it("the five registrable mount points are a subset of the manifest mount points", () => {
    expect([...HOOKS_AVAILABLE]).toEqual([
      "model.request",
      "model.response",
      "tool.preExecute",
      "tool.postExecute",
      "usage.report",
    ]);
    for (const h of HOOKS_AVAILABLE) expect(HOOK_MOUNT_POINTS).toContain(h);
  });

  it("session.* and agent.preStep stay reserved: valid in a manifest, not registrable", () => {
    for (const h of ["session.start", "session.end", "agent.preStep"]) {
      expect(HOOKS_AVAILABLE as readonly string[]).not.toContain(h);
      expect(validatePermissions("p", { hooks: [h] })).toEqual([]);
    }
  });

  it("only model.request and tool.preExecute accept policy hooks", () => {
    expect([...POLICY_HOOKS]).toEqual(["model.request", "tool.preExecute"]);
    for (const h of POLICY_HOOKS) expect(HOOKS_AVAILABLE).toContain(h);
  });

  it("ctx.hooks.on types the payload by mount point", () => {
    expectTypeOf<
      Parameters<HookHandler<"tool.preExecute">>[0]
    >().toEqualTypeOf<ToolPreHookPayload>();
    expectTypeOf<ReturnType<HookHandler<AvailableHook>>>().toEqualTypeOf<
      Promise<HookVerdict> | HookVerdict
    >();
    expectTypeOf<PluginContext["hooks"]["on"]>().toBeFunction();
  });
});
