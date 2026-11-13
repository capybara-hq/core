import { describe, expect, it } from "vitest";
import {
  GIT_PUSH_GRANT,
  gitGrantRefusal,
  gitPushForbidden,
  gitPushGrantKey,
  grantRefusalOf,
  isGitGrantKey,
  normalizeGitGrantKey,
  normalizeGitRepo,
} from "../../src/schedules/grant-rules.js";
import type { ApprovalRecord } from "../../src/tools/approvals.service.js";
import { GIT_ASK_CANCELLED_NOTE } from "../../src/tools/approvals.service.js";
import {
  clipGitKept,
  GIT_ASK_CLIPPED_NOTE,
  GIT_ASK_RECORD_TTL_SECONDS,
  type GitAskRedis,
  type GitRunState,
  gitAskKey,
  gitDeniedNote,
  gitPolicyDeniedNote,
  gitUnattendedNote,
  MAX_GIT_ASKS_PER_RUN,
  planGitAsk,
  recordGitAsk,
  settledGitNotes,
  takeGitAsk,
  withGitNotes,
} from "../../src/tools/git-asks.js";
import { gitPushBase } from "../../src/tools/git-push-policy.js";

/**
 * Git push asks (sandbox git credentials spec §5.6, §7): the model-visible notes, what a push the
 * gateway held becomes, the Redis record the gateway and the pipeline share, the policy levels
 * without grants, and the task grant keys.
 */

const REFS = ["refs/heads/feat/x"];

const state = (over: Partial<GitRunState> = {}): GitRunState => ({
  granted: new Set(),
  refused: new Set(),
  asks: 0,
  pending: false,
  ...over,
});

describe("git ask notes", () => {
  it("say what happened in English, name the repository and drop refs/heads/", () => {
    expect(gitDeniedNote("acme/app", REFS, "not today")).toBe(
      "[git] The push to acme/app (feat/x) was held for the user's approval. The user declined the push to acme/app. Do not push it another way; continue without pushing or ask the user. Reason: not today",
    );
    expect(gitUnattendedNote("acme/app", REFS)).toContain(
      "this scheduled run cannot ask for approval. The task's owner can allow pushes to acme/app for the task.",
    );
    expect(gitPolicyDeniedNote("acme/app", [])).toBe(
      "[git] The push to acme/app was not made: pushes to acme/app are not allowed by this organization's policy. Do not push it another way; continue without pushing or tell the user.",
    );
    // more than three refs are counted, not listed
    expect(gitDeniedNote("a/b", ["a", "b", "c", "d", "e"])).toContain("a/b (a, b, c and 2 more)");
  });

  const rec = (over: Partial<ApprovalRecord>): ApprovalRecord =>
    ({
      kind: "git",
      status: "pending",
      scope: null,
      denyReason: null,
      detail: null,
      git: {
        host: "github.com",
        repo: "acme/app",
        refs: REFS,
        result: { content: "", isError: true },
      },
      ...over,
    }) as ApprovalRecord;

  it("settle by status and scope; null while pending or for another kind", () => {
    expect(settledGitNotes(rec({}), 24)).toBeNull();
    expect(settledGitNotes(rec({ git: null }), 24)).toBeNull();
    expect(settledGitNotes(rec({ status: "approved", scope: "once" }), 24)?.[0]).toContain(
      "The user allowed pushes to acme/app for the rest of this task. Run the push again.",
    );
    expect(settledGitNotes(rec({ status: "approved", scope: "always" }), 24)?.[0]).toContain(
      "The user allowed pushes to acme/app from now on. Run the push again.",
    );
    expect(settledGitNotes(rec({ status: "denied", denyReason: "no" }), 24)?.[0]).toContain(
      "The user declined the push to acme/app.",
    );
    expect(settledGitNotes(rec({ status: "expired" }), 24)?.[0]).toContain(
      "did not answer within 24h; the push was not made.",
    );
    expect(settledGitNotes(rec({ status: "skipped" }), 24)?.[0]).toContain(
      "sent a message instead of answering",
    );
    expect(settledGitNotes(rec({ status: "cancelled" }), 24)).toEqual([GIT_ASK_CANCELLED_NOTE]);
  });

  it("append after a blank line; the kept result clips at 16 KB with the git note", () => {
    expect(withGitNotes("out", [])).toBe("out");
    expect(withGitNotes("out", ["a", "b"])).toBe("out\n\na\nb");
    expect(clipGitKept("short")).toBe("short");
    const clipped = clipGitKept("x".repeat(20_000));
    expect(Buffer.byteLength(clipped)).toBeLessThanOrEqual(16 * 1024);
    expect(clipped.endsWith(GIT_ASK_CLIPPED_NOTE)).toBe(true);
  });
});

describe("planGitAsk", () => {
  const ask = { host: "github.com", repo: "acme/app", refs: REFS };

  it("asks by default; the gateway's own refusals are notes (unattended records a missing grant)", () => {
    expect(planGitAsk(ask, state())).toEqual({ ask: true, notes: [], missingGrants: [] });
    expect(planGitAsk(ask, null).ask).toBe(true);
    expect(planGitAsk({ ...ask, outcome: "unattended" }, state())).toEqual({
      ask: false,
      notes: [gitUnattendedNote("acme/app", REFS)],
      missingGrants: ["git:push:acme/app"],
    });
    expect(planGitAsk({ ...ask, outcome: "denied" }, state())).toEqual({
      ask: false,
      notes: [gitPolicyDeniedNote("acme/app", REFS)],
      missingGrants: [],
    });
  });

  it("does not ask again about a refused repository, while another ask waits, or past the cap", () => {
    expect(planGitAsk(ask, state({ refused: new Set(["github.com/acme/app"]) })).notes).toEqual([
      gitDeniedNote("acme/app", REFS),
    ]);
    // a refusal on another host says nothing about this one
    expect(planGitAsk(ask, state({ refused: new Set(["gitlab.com/acme/app"]) })).ask).toBe(true);
    expect(planGitAsk(ask, state({ pending: true })).notes[0]).toContain(
      "another push request is waiting for the user",
    );
    expect(planGitAsk(ask, state({ asks: MAX_GIT_ASKS_PER_RUN })).notes[0]).toContain(
      "too many push requests in this task",
    );
    expect(planGitAsk(ask, state({ asks: MAX_GIT_ASKS_PER_RUN - 1 })).ask).toBe(true);
  });
});

describe("the git ask record", () => {
  /** An in-memory stand-in for the two Redis commands the helpers use. */
  function fakeRedis() {
    const kv = new Map<string, { value: string; ttl: number }>();
    const redis = {
      set: async (key: string, value: string, mode: string, ttl: number) => {
        expect(mode).toBe("EX");
        kv.set(key, { value, ttl });
        return "OK";
      },
      getdel: async (key: string) => {
        const v = kv.get(key);
        kv.delete(key);
        return v?.value ?? null;
      },
    } as unknown as GitAskRedis;
    return { redis, kv };
  }

  it("is written under git-ask:<execId> with a 1 h TTL, normalized, and read once", async () => {
    const { redis, kv } = fakeRedis();
    await recordGitAsk(redis, "call-1", {
      host: "GitHub.com",
      repo: "Acme/App.git",
      refs: ["refs/heads/main", "refs/heads/main", ""],
      connectorId: "c1",
    });
    expect(gitAskKey("call-1")).toBe("git-ask:call-1");
    expect(kv.get("git-ask:call-1")?.ttl).toBe(GIT_ASK_RECORD_TTL_SECONDS);
    expect(GIT_ASK_RECORD_TTL_SECONDS).toBe(3600);
    expect(await takeGitAsk(redis, "call-1")).toEqual({
      host: "github.com",
      repo: "acme/app",
      refs: ["refs/heads/main"],
      connectorId: "c1",
    });
    expect(await takeGitAsk(redis, "call-1")).toBeNull();
  });

  it("drops an unusable repository and survives a garbled value", async () => {
    const { redis, kv } = fakeRedis();
    await recordGitAsk(redis, "x", { host: "github.com", repo: "../etc", refs: [] });
    expect(kv.size).toBe(0);
    kv.set("git-ask:y", { value: "{not json", ttl: 1 });
    expect(await takeGitAsk(redis, "y")).toBeNull();
  });
});

describe("gitPushBase (the policy levels before grants)", () => {
  it("org default ask asks; org allow allows; org deny wins over a member allow", () => {
    expect(gitPushBase({ orgDefault: "ask" })).toEqual({ policy: "ask", reason: "ask" });
    expect(gitPushBase({ orgDefault: "allow" })).toEqual({ policy: "allow", reason: "org_allow" });
    expect(gitPushBase({ orgDefault: "deny", member: "allow" })).toEqual({
      policy: "deny",
      reason: "org_deny",
    });
  });

  it("a member's standing allow lifts an ask; a member's deny or ask holds against an org allow", () => {
    expect(gitPushBase({ orgDefault: "ask", member: "allow" })).toEqual({
      policy: "allow",
      reason: "member_allow",
    });
    expect(gitPushBase({ orgDefault: "allow", member: "deny" })).toEqual({
      policy: "deny",
      reason: "member_deny",
    });
    expect(gitPushBase({ orgDefault: "allow", member: "ask" }).policy).toBe("ask");
  });
});

describe("git push task grants", () => {
  it("normalize repositories to <owner>/<repo> and refuse other shapes", () => {
    expect(normalizeGitRepo("Acme/App.git")).toBe("acme/app");
    expect(normalizeGitRepo("acme/my_app.v2")).toBe("acme/my_app.v2");
    for (const bad of ["acme", "acme/app/x", "../app", "acme/..", "acme/a b", "", "a/b?c"]) {
      expect(normalizeGitRepo(bad), bad).toBeNull();
    }
  });

  it("accept git:push and git:push:<owner>/<repo>; refuse a bad repository or a forbidden key", () => {
    const ctx = { role: "member" as const, forbiddenTools: [] };
    expect(isGitGrantKey(GIT_PUSH_GRANT)).toBe(true);
    expect(isGitGrantKey("git:push:acme/app")).toBe(true);
    expect(isGitGrantKey("git:pull")).toBe(false);
    expect(gitPushGrantKey("acme/app")).toBe("git:push:acme/app");
    // no tool backs a git grant: grantRefusalOf takes it without one
    expect(grantRefusalOf("git:push", undefined, ctx)).toBeNull();
    expect(grantRefusalOf("git:push:acme/app", undefined, ctx)).toBeNull();
    expect(grantRefusalOf("git:push:acme", undefined, ctx)?.code).toBe("not_grantable");
    expect(grantRefusalOf("git:push:Acme/App", undefined, ctx)?.code).toBe("not_grantable");
    expect(normalizeGitGrantKey("git:push:Acme/App.git")).toBe("git:push:acme/app");
    expect(normalizeGitGrantKey("git:push:nope")).toBe("git:push:nope");
    expect(gitGrantRefusal("git:push:acme/app", { forbiddenTools: ["git:push"] })?.code).toBe(
      "forbidden",
    );
    // forbiddenTools entries compare normalized
    expect(gitPushForbidden(["git:push:Acme/App.git"], "git:push:acme/app")).toBe(true);
    expect(gitPushForbidden([" git:push "], "git:push:acme/app")).toBe(true);
    expect(gitPushForbidden(["git:push:acme/other", "Bash"], "git:push:acme/app")).toBe(false);
    expect(
      gitGrantRefusal("git:push:acme/app", { forbiddenTools: ["git:push:ACME/app"] })?.code,
    ).toBe("forbidden");
    // the longest repository keeps the grant key within a forbiddenTools entry (200)
    const longest = `${"o".repeat(39)}/${"r".repeat(191 - 40)}`;
    expect(normalizeGitRepo(longest)).toBe(longest);
    expect(gitPushGrantKey(longest).length).toBeLessThanOrEqual(200);
    expect(normalizeGitRepo(`${longest}x`)).toBeNull();
    expect(
      grantRefusalOf("git:push:acme/app", undefined, {
        ...ctx,
        forbiddenTools: ["git:push:acme/app"],
      })?.code,
    ).toBe("forbidden");
  });
});
