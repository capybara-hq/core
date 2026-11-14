import { describe, expect, it } from "vitest";
import {
  isPolicyGrantKey,
  isTierGrantKey,
  tierGrantRefusal,
} from "../../src/schedules/grant-rules.js";

/**
 * Sandbox-level task grants are gone (auto mode spec §4.4): a stale `tier:<...>` key is still
 * recognized as a policy key so the grant paths can refuse it, never as a tool grant.
 */
describe("tierGrantRefusal", () => {
  it("refuses every tier grant as not grantable", () => {
    for (const key of ["tier:open", "tier:dev", "tier:strict"]) {
      expect(tierGrantRefusal(key)).toMatchObject({ code: "not_grantable" });
      expect(isTierGrantKey(key)).toBe(true);
      expect(isPolicyGrantKey(key)).toBe(true);
    }
    expect(tierGrantRefusal("Bash")).toBeNull();
    expect(tierGrantRefusal("network:a.example.com")).toBeNull();
    expect(isPolicyGrantKey("network:a.example.com")).toBe(true);
    expect(isPolicyGrantKey("Bash")).toBe(false);
  });
});
