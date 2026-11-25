import { describe, expect, it } from "vitest";
import { decideSsoCallback, type SsoDecisionInput } from "../../src/identity/sso.js";

const A = "acc-a";
const B = "acc-b";
const link = (over: Partial<SsoDecisionInput> = {}): SsoDecisionInput => ({
  intent: "link",
  sessionAccountId: A,
  signUp: "link",
  ...over,
});
const signin = (over: Partial<SsoDecisionInput> = {}): SsoDecisionInput => ({
  intent: "signin",
  signUp: "link",
  ...over,
});

// Spec 2026-11-26-login-extensions §4, one test per cell
describe("decideSsoCallback: link intent (signed in as A)", () => {
  it("row of A (sso / directory / legacy) → refresh A", () => {
    for (const linkedVia of ["sso", "directory", null] as const) {
      expect(decideSsoCallback(link({ row: { accountId: A, linkedVia } }))).toEqual({
        kind: "refresh",
        accountId: A,
      });
    }
  });

  it("row of A as bind → upgrade A", () => {
    expect(decideSsoCallback(link({ row: { accountId: A, linkedVia: "bind" } }))).toEqual({
      kind: "upgrade",
      accountId: A,
    });
  });

  it("row of B (any kind) → identity.taken", () => {
    for (const linkedVia of ["sso", "directory", "bind", null] as const) {
      expect(decideSsoCallback(link({ row: { accountId: B, linkedVia } }))).toEqual({
        kind: "error",
        code: "identity.taken",
      });
    }
  });

  it("no row, merge target B → linked to A (the session wins over the email)", () => {
    expect(decideSsoCallback(link({ mergeTarget: B }))).toEqual({
      kind: "linked",
      accountId: A,
      via: "oauth",
    });
  });

  it("no row → linked to A via oauth, whatever signUp says", () => {
    for (const signUp of ["link", "create"] as const) {
      expect(decideSsoCallback(link({ signUp }))).toEqual({
        kind: "linked",
        accountId: A,
        via: "oauth",
      });
    }
  });

  it("without the same session → sso.session_mismatch, never a creation", () => {
    const noSession = { intent: "link", signUp: "create" } as const;
    for (const input of [noSession, { ...noSession, row: { accountId: A, linkedVia: "bind" } }]) {
      expect(decideSsoCallback(input as SsoDecisionInput)).toEqual({
        kind: "error",
        code: "sso.session_mismatch",
      });
    }
  });
});

describe("decideSsoCallback: signin intent", () => {
  it("row (sso / directory / legacy) → sign in as its account", () => {
    for (const linkedVia of ["sso", "directory", null] as const) {
      expect(decideSsoCallback(signin({ row: { accountId: A, linkedVia } }))).toEqual({
        kind: "signin",
        accountId: A,
      });
    }
  });

  it("row of A as bind → link page (A's password upgrades it)", () => {
    expect(decideSsoCallback(signin({ row: { accountId: A, linkedVia: "bind" } }))).toEqual({
      kind: "link_page",
      existingAccountId: A,
    });
  });

  it("row of B (sso / directory) → sign in as B, the session plays no part", () => {
    for (const linkedVia of ["sso", "directory"] as const) {
      expect(
        decideSsoCallback(signin({ sessionAccountId: A, row: { accountId: B, linkedVia } })),
      ).toEqual({ kind: "signin", accountId: B });
    }
  });

  it("row of B as bind → link page with B as the existing account", () => {
    expect(
      decideSsoCallback(signin({ sessionAccountId: A, row: { accountId: B, linkedVia: "bind" } })),
    ).toEqual({ kind: "link_page", existingAccountId: B });
  });

  it("no row, merge applies → linked to the merge target (then signed in)", () => {
    for (const signUp of ["link", "create"] as const) {
      expect(decideSsoCallback(signin({ mergeTarget: B, signUp }))).toEqual({
        kind: "linked",
        accountId: B,
        via: "verified_email",
      });
    }
  });

  it("no row, signUp link → link page", () => {
    expect(decideSsoCallback(signin({ signUp: "link" }))).toEqual({ kind: "link_page" });
  });

  it("no row, signUp create → create an account", () => {
    expect(decideSsoCallback(signin({ signUp: "create" }))).toEqual({ kind: "create" });
  });
});
