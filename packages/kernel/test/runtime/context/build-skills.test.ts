import { describe, expect, it } from "vitest";
import type { ConversationEvent } from "../../../src/conversations/events.js";
import { BEHAVIOR_RULES, buildModelRequest } from "../../../src/runtime/context/build.js";
import { AGENT, Log, MODEL } from "./fixtures.js";

/**
 * M5 T14 / Ruling M17：技能目录来自日志里的 `skills_catalog` 快照。第一份快照（在任何模型调用之前）进 system
 * 的缓存段；之后的变化在它出现的位置以英文提醒追加，前缀不变；没有技能时不出现目录。
 */

type Skill = { id: string; name: string; description: string; version: number; source: string };

const skill = (name: string, version = 1, description = `Use for ${name} tasks.`): Skill => ({
  id: `id-${name}`,
  name,
  description,
  version,
  source: `skills/${name}-v${version}/`,
});

function catalog(log: Log, skills: Skill[]): ConversationEvent {
  return log.add({ type: "skills_catalog", payload: { skills } });
}

const build = (events: ConversationEvent[]) =>
  buildModelRequest({ events, agent: AGENT, agentVersion: 1, model: MODEL, step: 1 });

const systemNotices = (events: ConversationEvent[]) =>
  build(events)
    .request.messages.filter((m) => m.role === "system")
    .map((m) => m.content as string);

describe("skills catalog in the request", () => {
  it("no snapshot: system has no catalog", () => {
    const log = new Log();
    log.user("hi");
    const { request } = build(log.events);
    expect(request.system).toEqual([
      { text: `${BEHAVIOR_RULES}\n\n${AGENT.instructions}`, cache: true },
    ]);
  });

  it("first snapshot renders in the cached system segment, sorted by name, telling to call skill_load", () => {
    const log = new Log();
    log.user("hi");
    log.runStarted();
    // 日志里的顺序不影响渲染：按名字排序
    catalog(log, [skill("zeta"), skill("alpha")]);
    const { request } = build(log.events);
    expect(request.system).toHaveLength(1);
    const text = request.system[0]?.text as string;
    expect(request.system[0]?.cache).toBe(true);
    expect(text.startsWith(`${BEHAVIOR_RULES}\n\n${AGENT.instructions}\n\n`)).toBe(true);
    expect(text).toContain("skill_load");
    expect(text.indexOf("- alpha: Use for alpha tasks.")).toBeGreaterThan(0);
    expect(text.indexOf("- alpha:")).toBeLessThan(text.indexOf("- zeta:"));
    // 不进消息
    expect(request.messages.some((m) => m.role === "system")).toBe(false);
  });

  it("long descriptions are clipped deterministically in the catalog", () => {
    const log = new Log();
    log.user("hi");
    catalog(log, [skill("alpha", 1, "x".repeat(1000))]);
    const text = build(log.events).request.system[0]?.text as string;
    const line = text.split("\n").find((l) => l.startsWith("- alpha: ")) as string;
    expect([...line.slice("- alpha: ".length)].length).toBe(300);
    expect(line.endsWith("…")).toBe(true);
  });

  it("later snapshots render as an appended notice; the system prefix stays the same", () => {
    const log = new Log();
    log.user("hi");
    log.runStarted();
    catalog(log, [skill("alpha"), skill("beta")]);
    log.modelCall(1);
    log.assistant("hello");
    const before = build(log.events);

    log.user("again");
    log.runStarted();
    catalog(log, [skill("alpha", 2, "New alpha."), skill("gamma")]);
    const after = build(log.events);
    expect(after.meta.systemHash).toBe(before.meta.systemHash);
    expect(after.request.system).toEqual(before.request.system);
    // 前缀只追加
    expect(after.request.messages.slice(0, before.request.messages.length)).toEqual(
      before.request.messages,
    );
    const notices = systemNotices(log.events);
    expect(notices).toHaveLength(1);
    const n = notices[0] as string;
    expect(n).toContain("- gamma: Use for gamma tasks.");
    expect(n).toMatch(/Removed[^\n]*\n?[^\n]*beta/);
    expect(n).toContain("- alpha: New alpha.");
    expect(n).toContain("skill_load");
    // 提醒在第二条用户消息之后
    const msgs = after.request.messages;
    expect(msgs.at(-1)?.role).toBe("system");
    expect(msgs.at(-2)?.role).toBe("user");
  });

  it("all skills removed: notice lists the removals", () => {
    const log = new Log();
    log.user("hi");
    catalog(log, [skill("alpha")]);
    log.modelCall(1);
    log.assistant("ok");
    log.user("next");
    catalog(log, []);
    const notices = systemNotices(log.events);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("alpha");
    expect(notices[0]).toMatch(/no skills are available/i);
  });

  it("first snapshot after an earlier model call renders as a notice (prefix unchanged)", () => {
    const log = new Log();
    log.user("hi");
    log.modelCall(1);
    log.assistant("hello");
    const before = build(log.events);
    log.user("again");
    catalog(log, [skill("alpha")]);
    const after = build(log.events);
    expect(after.request.system).toEqual(before.request.system);
    const notices = systemNotices(log.events);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("- alpha: Use for alpha tasks.");
    expect(notices[0]).toContain("skill_load");
  });

  it("after a compaction summary the current catalog follows the summary when it differs from system", () => {
    const log = new Log();
    log.user("hi");
    catalog(log, [skill("alpha")]);
    log.modelCall(1);
    log.assistant("ok");
    log.user("next");
    catalog(log, [skill("beta")]);
    log.modelCall(4);
    log.assistant("ok2");
    log.summary(log.events.at(-1)?.seq as number, "Earlier talk.");
    log.user("more");
    const { request } = build(log.events);
    expect(request.system[0]?.text).toContain("- alpha:");
    expect(request.messages[0]?.role).toBe("user");
    expect(request.messages[1]?.role).toBe("system");
    const current = request.messages[1]?.content as string;
    expect(current).toContain("- beta:");
    expect(current).not.toContain("- alpha:");
  });

  it("rebuilding a past request from the log (events up to toSeq) gives the same system and history", () => {
    const log = new Log();
    log.user("hi");
    log.runStarted();
    catalog(log, [skill("alpha")]);
    const first = build(log.events);
    log.add({
      type: "model_call",
      payload: {
        step: 1,
        attempt: 1,
        provider: "model-fake",
        model: "fake-1",
        fallback: false,
        request: first.meta,
      },
    });
    log.assistant("hello");
    log.user("again");
    log.runStarted();
    catalog(log, [skill("alpha", 2)]);
    const second = build(log.events);
    // 按 model_call 记下的 toSeq 截取日志重建：与当时一致
    const rebuilt = build(log.events.filter((e) => e.seq <= first.meta.toSeq));
    expect(rebuilt.request).toEqual(first.request);
    expect(rebuilt.meta.systemHash).toBe(first.meta.systemHash);
    const rebuilt2 = build(log.events.filter((e) => e.seq <= second.meta.toSeq));
    expect(rebuilt2.request).toEqual(second.request);
    expect(second.meta.systemHash).toBe(first.meta.systemHash);
  });
});

describe("fork reports (phase D, batch 3 review C1)", () => {
  const forkInvocation = (log: Log) =>
    log.add(
      {
        type: "user_message",
        payload: {
          content: [{ type: "text", text: "LEAD" }],
          authorAccountId: "acc-1",
          skill: {
            id: "sk",
            version: 1,
            source: "skills/sk/",
            name: "review",
            arguments: "",
            mode: "fork",
            agentType: "general-purpose",
          },
        },
      },
      null,
    );
  const report = (log: Log, invokedSeq: number) =>
    log.add({ type: "skill_fork_result", payload: { invokedSeq, text: "REPORT" } });
  /** The request's turns as texts, with everything in the log absorbed (as a run's next call). */
  const turns = (events: ConversationEvent[]) =>
    buildModelRequest({
      events,
      agent: AGENT,
      agentVersion: 1,
      model: MODEL,
      step: 1,
      absorbedUpToSeq: events.at(-1)?.seq ?? 0,
    }).request.messages.map((m) =>
      typeof m.content === "string"
        ? m.content
        : m.content.map((b) => (b.type === "text" ? b.text : b.type)),
    );

  it("a report logged before the first call that absorbs its invocation joins the invocation's turn", () => {
    const log = new Log();
    const f = forkInvocation(log);
    log.runStarted();
    report(log, f.seq);
    log.modelCall(f.seq);
    expect(turns(log.events)).toEqual([["LEAD", "REPORT"]]);
  });

  it("a report logged after a call that already sent its invocation stays at its log position: append-only", () => {
    const log = new Log();
    const f = forkInvocation(log);
    log.runStarted();
    log.modelCall(f.seq);
    const before = turns(log.events);
    expect(before).toEqual([["LEAD"]]);
    log.assistant("answer without the report");
    report(log, f.seq);
    log.user("next");
    const after = turns(log.events);
    expect(after.slice(0, before.length)).toEqual(before);
    expect(after).toEqual([["LEAD"], ["answer without the report"], ["REPORT"], ["next"]]);
  });

  it("a report appended between a request's build and its model_call is late: the call's toSeq decides, not log order (batch 4 review m1)", () => {
    const log = new Log();
    const f = forkInvocation(log);
    log.runStarted();
    const builtUpTo = log.events.at(-1)?.seq as number;
    const before = turns(log.events);
    expect(before).toEqual([["LEAD"]]);
    // the sweep writes the report while the request's hooks run; the call is logged after it
    const r = report(log, f.seq);
    log.modelCall(f.seq, 1, undefined, builtUpTo);
    expect(r.seq).toBeGreaterThan(builtUpTo);
    log.assistant("answer without the report");
    const n = log.user("next");
    // the next request is the first built from the report: it comes at its end
    const after = turns(log.events);
    expect(after.slice(0, before.length)).toEqual(before);
    expect(after).toEqual([["LEAD"], ["answer without the report"], ["next"], ["REPORT"]]);
    // and stays there once that request's call is logged (append-only)
    log.modelCall(n.seq);
    log.assistant("answer with the report");
    const later = turns(log.events);
    expect(later.slice(0, after.length)).toEqual(after);
  });

  it("a model call that did not absorb the invocation (it ran before) does not keep the report apart", () => {
    const log = new Log();
    log.user("first");
    log.runStarted();
    const f = forkInvocation(log);
    log.modelCall(f.seq - 2);
    log.assistant("first answer");
    report(log, f.seq);
    log.modelCall(f.seq);
    expect(turns(log.events)).toEqual([["first"], ["first answer"], ["LEAD", "REPORT"]]);
  });
});
