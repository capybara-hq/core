import { describe, expect, it } from "vitest";
import type { ConversationEvent } from "../../../src/conversations/events.js";
import { COMPACTION_SETTINGS } from "../../../src/identity/settings.js";
import type { CacheExpiry } from "../../../src/runtime/context/cache-expiry.js";
import {
  type IdleArmFacts,
  type IdleFireFacts,
  idleArmDecision,
  idleFireDecision,
  idleMinTokens,
  isIdleNeutralEvent,
} from "../../../src/runtime/context/idle-compaction-rules.js";

const settings = COMPACTION_SETTINGS.parse({});
const T0 = 1_000_000;
const NOW = 5_000_000;
const expiry: CacheExpiry = {
  callSeq: 7,
  t0: T0,
  ttl: 3600,
  expiresAt: T0 + 3_600_000,
  fireAt: T0 + 3_240_000,
  isMinimum: false,
};

describe("idleMinTokens", () => {
  it.each([
    [128_000, 200_000],
    [200_000, 200_000],
    [256_000, 200_000],
    [400_000, 200_000],
    [1_000_000, 300_000],
  ])("window %i gives %i with the defaults", (window, expected) => {
    expect(idleMinTokens(window, settings)).toBe(expected);
  });

  it("honors a lower floor", () => {
    expect(idleMinTokens(400_000, { idleMinTokensFloor: 50_000, idleMinWindowRatio: 0.1 })).toBe(
      50_000,
    );
  });
});

function armFacts(over: Partial<IdleArmFacts> = {}): IdleArmFacts {
  return {
    conversationKind: "chat",
    trigger: "message",
    automationRunId: null,
    outcome: "completed",
    settings,
    mode: "cache",
    now: NOW,
    personalOff: false,
    expiry,
    lastCall: {
      provider: "p",
      model: "m",
      window: 400_000,
      input: 10_000,
      cacheRead: 250_000,
      cacheWrite: 0,
      output: 1_000,
    },
    inContextAllowed: true,
    fitPlan: false,
    settled: true,
    ...over,
  };
}

describe("idleArmDecision", () => {
  it("arms at the expiry's fire time", () => {
    expect(idleArmDecision(armFacts())).toEqual({
      arm: true,
      mode: "cache",
      runAt: T0 + 3_240_000,
      expiresAt: T0 + 3_600_000,
      cacheCallSeq: 7,
    });
  });

  it.each([undefined, "background_task", "subagent"] as const)("arms for trigger %s", (trigger) => {
    expect(idleArmDecision(armFacts({ trigger })).arm).toBe(true);
  });

  const skips: [string, Partial<IdleArmFacts>][] = [
    ["kind", { conversationKind: "subagent" }],
    ["kind", { conversationKind: "eval" }],
    ["trigger", { trigger: "schedule" }],
    ["trigger", { trigger: "automation_event" }],
    ["trigger", { trigger: "compact" }],
    ["automation", { trigger: "background_task", automationRunId: "ar1" }],
    ["outcome", { outcome: "budget" }],
    ["disabled", { settings: { ...settings, idleEnabled: false } }],
    ["disabled", { settings: { ...settings, enabled: false } }],
    ["personal_off", { personalOff: true }],
    ["no_cache", { expiry: null }],
    ["short_ttl", { expiry: { ...expiry, ttl: 300 } }],
    [
      "small",
      {
        lastCall: {
          provider: "p",
          model: "m",
          window: 200_000,
          input: 150_000,
          cacheRead: 0,
          cacheWrite: 0,
          output: 49_000,
        },
      },
    ],
    ["quality_gate", { inContextAllowed: false }],
    ["fit_plan", { fitPlan: true }],
    ["unsettled", { settled: false }],
  ];
  it.each(skips)("skips with %s", (reason, over) => {
    expect(idleArmDecision(armFacts(over))).toEqual({ arm: false, reason });
  });

  it("skips with no_cache when there is no last call, even with an expiry", () => {
    expect(idleArmDecision(armFacts({ lastCall: null, expiry }))).toEqual({
      arm: false,
      reason: "no_cache",
    });
  });

  it("arms at exactly the threshold", () => {
    expect(
      idleArmDecision(
        armFacts({
          lastCall: {
            provider: "p",
            model: "m",
            window: 400_000,
            input: 100_000,
            cacheRead: 50_000,
            cacheWrite: 30_000,
            output: 20_000,
          },
        }),
      ).arm,
    ).toBe(true);
  });

  it("reports the earlier skip when two fail", () => {
    expect(idleArmDecision(armFacts({ trigger: "schedule", personalOff: true }))).toEqual({
      arm: false,
      reason: "trigger",
    });
  });
});

const EXPIRES = 10_000_000;
function fireFacts(over: Partial<IdleFireFacts> = {}): IdleFireFacts {
  return {
    live: true,
    stale: false,
    busy: false,
    enabled: true,
    now: EXPIRES - 60_000,
    expiresAt: EXPIRES,
    backoff: false,
    modelReady: true,
    mode: "cache",
    probe: { estimate: 250_000, window: 400_000, growth: 50_000, planned: true },
    inContext: true,
    settings,
    ...over,
  };
}

describe("idleFireDecision", () => {
  it("fires when every check passes", () => {
    expect(idleFireDecision(fireFacts())).toEqual({ fire: true });
  });

  const cases: [string, Partial<IdleFireFacts>][] = [
    ["gone", { live: false }],
    ["obsolete", { stale: true }],
    ["busy", { busy: true }],
    ["disabled", { enabled: false }],
    ["expired", { now: EXPIRES - 30_000 }],
    ["backoff", { backoff: true }],
    ["no_model", { modelReady: false }],
    ["small", { probe: null }],
    ["small", { probe: { estimate: 250_000, window: 400_000, growth: 50_000, planned: false } }],
    ["small", { probe: { estimate: 199_999, window: 400_000, growth: 50_000, planned: true } }],
    ["small", { probe: { estimate: 250_000, window: 400_000, growth: 19_999, planned: true } }],
    ["no_prefix", { inContext: false }],
  ];
  it.each(cases)("ends with %s", (outcome, over) => {
    expect(idleFireDecision(fireFacts(over))).toEqual({ fire: false, outcome });
  });

  it("is expired at exactly expiresAt - 30 s and not 1 ms earlier", () => {
    expect(idleFireDecision(fireFacts({ now: EXPIRES - 30_001 })).fire).toBe(true);
    expect(idleFireDecision(fireFacts({ now: EXPIRES - 30_000 }))).toEqual({
      fire: false,
      outcome: "expired",
    });
  });

  it("lets the earlier outcome win when two checks fail", () => {
    expect(idleFireDecision(fireFacts({ live: false, stale: true, busy: true })).fire).toBe(false);
    expect(idleFireDecision(fireFacts({ stale: true, busy: true }))).toEqual({
      fire: false,
      outcome: "obsolete",
    });
    expect(idleFireDecision(fireFacts({ backoff: true, probe: null }))).toEqual({
      fire: false,
      outcome: "backoff",
    });
    expect(idleFireDecision(fireFacts({ probe: null, inContext: false }))).toEqual({
      fire: false,
      outcome: "small",
    });
  });
});

describe("idleArmDecision in compaction-model mode", () => {
  const cm = (over: Partial<IdleArmFacts> = {}) => armFacts({ mode: "compaction_model", ...over });

  it("arms at now + idleDelayMinutes", () => {
    expect(idleArmDecision(cm({ expiry: null }))).toEqual({
      arm: true,
      mode: "compaction_model",
      runAt: NOW + 30 * 60_000,
    });
    expect(idleArmDecision(cm({ settings: { ...settings, idleDelayMinutes: 5 } }))).toEqual({
      arm: true,
      mode: "compaction_model",
      runAt: NOW + 5 * 60_000,
    });
  });

  it.each<[string, Partial<IdleArmFacts>]>([
    ["expiry null", { expiry: null }],
    ["ttl 300", { expiry: { ...expiry, ttl: 300 } }],
    ["no in-context", { inContextAllowed: false }],
    ["fit plan", { fitPlan: true }],
    ["unsettled", { settled: false }],
  ])("arms with %s", (_n, over) => {
    expect(idleArmDecision(cm(over)).arm).toBe(true);
  });

  it.each<[string, Partial<IdleArmFacts>]>([
    ["trigger", { trigger: "schedule" }],
    ["automation", { trigger: "background_task", automationRunId: "ar1" }],
    ["outcome", { outcome: "budget" }],
    ["disabled", { settings: { ...settings, idleEnabled: false } }],
    ["personal_off", { personalOff: true }],
    [
      "small",
      {
        lastCall: {
          provider: "p",
          model: "m",
          window: 200_000,
          input: 150_000,
          cacheRead: 0,
          cacheWrite: 0,
          output: 49_000,
        },
      },
    ],
    ["small", { lastCall: null }],
  ])("skips with %s", (reason, over) => {
    expect(idleArmDecision(cm(over))).toEqual({ arm: false, reason });
  });
});

describe("idleFireDecision in compaction-model mode", () => {
  const cm = (over: Partial<IdleFireFacts> = {}) =>
    fireFacts({ mode: "compaction_model", ...over });

  it("fires long after expiresAt, without a prefix", () => {
    expect(idleFireDecision(cm({ now: EXPIRES + 3_600_000 }))).toEqual({ fire: true });
    expect(idleFireDecision(cm({ inContext: false }))).toEqual({ fire: true });
  });

  it("ends no_model and small", () => {
    expect(idleFireDecision(cm({ modelReady: false }))).toEqual({
      fire: false,
      outcome: "no_model",
    });
    expect(
      idleFireDecision(
        cm({ probe: { estimate: 250_000, window: 400_000, growth: 19_999, planned: true } }),
      ),
    ).toEqual({ fire: false, outcome: "small" });
  });
});

describe("isIdleNeutralEvent", () => {
  const ev = (type: string, runId: string | null) =>
    ({ type, runId }) as Pick<ConversationEvent, "type" | "runId">;
  it("is true only for a run-less usage event", () => {
    expect(isIdleNeutralEvent(ev("usage", null))).toBe(true);
    expect(isIdleNeutralEvent(ev("usage", "r1"))).toBe(false);
    expect(isIdleNeutralEvent(ev("user_message", null))).toBe(false);
    expect(isIdleNeutralEvent(ev("model_switched", null))).toBe(false);
    expect(isIdleNeutralEvent(ev("permission_profile_changed", null))).toBe(false);
  });
});
