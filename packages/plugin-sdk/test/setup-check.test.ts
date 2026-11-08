import { describe, expect, it } from "vitest";
import {
  SETUP_CHECK_ID_RE,
  SETUP_CHECK_LIMITS,
  type SetupCheckTarget,
  validateSetupCheckResult,
} from "../src/index.js";

const problem = (x: unknown): string => {
  const r = validateSetupCheckResult(x);
  if (!("problem" in r)) throw new Error(`expected a problem for ${JSON.stringify(x)}`);
  return r.problem;
};

describe("SETUP_CHECK_LIMITS", () => {
  it("match spec §10.5", () => {
    expect(SETUP_CHECK_LIMITS).toEqual({
      timeoutMs: 10_000,
      reasonChars: 300,
      fixChars: 500,
      freshMs: 300_000,
      cooldownMs: 10_000,
      orgConcurrency: 8,
      perAccountPerMinute: 30,
      idsPerExtension: 32,
    });
    expect(Object.isFrozen(SETUP_CHECK_LIMITS)).toBe(true);
  });
  it("ids cannot claim the kernel's capybara: namespace", () => {
    expect(SETUP_CHECK_ID_RE.test("bot-token")).toBe(true);
    expect(SETUP_CHECK_ID_RE.test("capybara:public-url")).toBe(false);
  });
});

describe("validateSetupCheckResult", () => {
  it("accepts the three statuses", () => {
    expect(validateSetupCheckResult({ status: "ok" })).toEqual({ status: "ok" });
    expect(validateSetupCheckResult({ status: "unknown" })).toEqual({ status: "unknown" });
    const failing = {
      status: "failing",
      reason: { en: "Slack refused the token (invalid_auth).", zh: "Slack 拒绝了令牌。" },
      fix: { en: "Reinstall the app and copy the new token." },
    };
    expect(validateSetupCheckResult(failing)).toEqual(failing);
  });
  it("rejects other statuses", () => {
    for (const status of ["running", "not_run", "OK", "", undefined, 1, null]) {
      expect(problem({ status })).toMatch(/status/);
    }
  });
  it("rejects non-objects", () => {
    for (const x of [null, undefined, "ok", 1, [], [{ status: "ok" }]]) problem(x);
  });
  it("rejects extra keys (no data field)", () => {
    expect(problem({ status: "ok", data: { token: "xoxb-1" } })).toMatch(/data/);
    expect(problem({ status: "ok", details: "x" })).toMatch(/details/);
    expect(problem({ status: "ok", reason: { en: "a", raw: "xoxb-1" } })).toMatch(/raw/);
    expect(problem({ status: "ok", fix: { en: "a", fr: "b" } })).toMatch(/fr/);
    const sym = { status: "ok", [Symbol("x")]: "xoxb-1" };
    problem(sym);
    const hidden = { status: "ok" };
    Object.defineProperty(hidden, "data", { value: "xoxb-1", enumerable: false });
    expect(problem(hidden)).toMatch(/data/);
  });
  it("rejects non-plain objects", () => {
    class R {
      status = "ok";
    }
    problem(new R());
    problem(Object.assign(Object.create({ data: "xoxb-1" }), { status: "ok" }));
    expect(validateSetupCheckResult(Object.assign(Object.create(null), { status: "ok" }))).toEqual({
      status: "ok",
    });
  });
  it("rejects accessors and returns a fresh copy", () => {
    let reads = 0;
    const getter = {
      get status() {
        reads++;
        return "ok";
      },
    };
    problem(getter);
    expect(reads).toBe(0);
    const input = { status: "ok", reason: { en: "fine" } };
    const out = validateSetupCheckResult(input);
    expect(out).toEqual(input);
    expect(out).not.toBe(input);
    expect((out as { reason: unknown }).reason).not.toBe(input.reason);
  });
  it("rejects over-long reason / fix", () => {
    const r = SETUP_CHECK_LIMITS.reasonChars;
    const f = SETUP_CHECK_LIMITS.fixChars;
    expect(
      validateSetupCheckResult({ status: "ok", reason: { en: "a".repeat(r) } }),
    ).not.toHaveProperty("problem");
    expect(problem({ status: "ok", reason: { en: "a".repeat(r + 1) } })).toMatch(/reason/);
    expect(problem({ status: "ok", reason: { en: "a", zh: "中".repeat(r + 1) } })).toMatch(
      /reason/,
    );
    expect(
      validateSetupCheckResult({
        status: "failing",
        reason: { en: "a" },
        fix: { en: "a".repeat(f) },
      }),
    ).not.toHaveProperty("problem");
    expect(
      problem({ status: "failing", reason: { en: "a" }, fix: { en: "a".repeat(f + 1) } }),
    ).toMatch(/fix/);
  });
  it("rejects missing or empty en", () => {
    expect(problem({ status: "ok", reason: { zh: "好" } })).toMatch(/en/);
    expect(problem({ status: "ok", reason: { en: "" } })).toMatch(/en/);
    expect(problem({ status: "ok", fix: { en: 1 } })).toMatch(/en/);
    expect(problem({ status: "ok", reason: "plain string" })).toMatch(/reason/);
    expect(problem({ status: "ok", reason: { en: "a", zh: 2 } })).toMatch(/zh/);
    expect(problem({ status: "ok", reason: { en: "a", zh: "" } })).toMatch(/zh/);
  });
  it("needs a reason when failing", () => {
    expect(problem({ status: "failing" })).toMatch(/reason/);
    expect(problem({ status: "failing", fix: { en: "Do this." } })).toMatch(/reason/);
  });
  it("rejects control characters other than tab and newlines", () => {
    expect(
      validateSetupCheckResult({ status: "ok", reason: { en: "a\nb\tc\r\n" } }),
    ).not.toHaveProperty("problem");
    expect(problem({ status: "ok", reason: { en: "a\u0000b" } })).toMatch(/control/);
    expect(problem({ status: "ok", fix: { en: "a\u001bb" } })).toMatch(/control/);
    expect(problem({ status: "ok", reason: { en: "a\u009bb" } })).toMatch(/control/);
  });
});

describe("SetupCheckTarget", () => {
  it("has no field for an OAuth client secret or a member token", () => {
    // Type-level guard: these must stay compile errors.
    const ok: SetupCheckTarget = {
      kind: "connector",
      connectorId: "c",
      templateId: "t",
      clientId: null,
      accountId: null,
    };
    // @ts-expect-error a connector target never carries the client secret
    const a: SetupCheckTarget = { ...ok, clientSecret: "s" };
    // @ts-expect-error a connector target never carries a member token
    const b: SetupCheckTarget = { ...ok, accessToken: "t" };
    // @ts-expect-error a connector target never carries config (credentials live there)
    const c: SetupCheckTarget = { ...ok, config: {} };
    expect([ok, a, b, c]).toHaveLength(4);
  });
});
