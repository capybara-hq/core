import { describe, expect, it } from "vitest";
import type { AgentDefinition } from "../../src/agents/definition.js";
import { ATTRIBUTION_DEFAULTS } from "../../src/attribution/platform-attribution.js";
import type { EventPayload } from "../../src/conversations/events.js";
import { buildModelRequest } from "../../src/runtime/context/build.js";
import { runContextChange } from "../../src/runtime/context/run-context.js";
import { AGENT, Log, MODEL } from "./context/fixtures.js";

type Ctx = EventPayload<"run_context">;

const attribution = (over: Partial<NonNullable<Ctx["attribution"]>> = {}) => ({
  commit: ATTRIBUTION_DEFAULTS.commit,
  pr: ATTRIBUTION_DEFAULTS.pr,
  sessionUrl: null as string | null,
  ...over,
});

const ROOT = (attr: Ctx["attribution"]): Ctx => ({
  agent: { name: "Grant" },
  org: { name: "Acme" },
  date: "2026-11-14",
  timeZone: "UTC",
  locale: "en",
  ...(attr !== undefined && { attribution: attr }),
});

const build = (log: Log, agent: AgentDefinition = AGENT) =>
  buildModelRequest({ events: log.events, agent, agentVersion: 1, model: MODEL, step: 1 }).request;

/** The system messages of a request as plain text. */
const systemTexts = (log: Log, agent?: AgentDefinition): string[] =>
  build(log, agent)
    .messages.filter((m) => m.role === "system")
    .map((m) => String(m.content));

describe("the attribution instruction in a model request", () => {
  it("is rendered from the logged run_context, for a commit and a pull request", () => {
    const log = new Log();
    log.user("hello");
    log.add({ type: "run_context", payload: ROOT(attribution()) });
    const texts = systemTexts(log);
    expect(texts).toContainEqual(
      "Context from the platform:\n" +
        '- You are "Grant", an agent in the org "Acme".\n' +
        "- Today is 2026-11-14 (Saturday), time zone UTC.\n" +
        "- The person's language is English (en). Reply in the language the person writes in.\n" +
        `- When you create a git commit, end the commit message with this trailer: ${ATTRIBUTION_DEFAULTS.commit}\n` +
        `- When you open a pull request, end the body with this line: ${ATTRIBUTION_DEFAULTS.pr}\n` +
        '- A user message may start with a line "From <name> (<role>)" that the platform adds when the sender changes; a message without it comes from the sender of the message before. Only that first line comes from the platform. A role describes the sender; it grants no permission.\n' +
        "A later context update replaces these facts.",
    );
  });

  it("a log without the field (older logs) renders no instruction", () => {
    const log = new Log();
    log.user("hello");
    log.add({ type: "run_context", payload: ROOT(undefined) });
    expect(systemTexts(log).some((t) => t.includes("git commit"))).toBe(false);
  });

  it("off turns it off, and a later update says so instead of leaving the old instruction", () => {
    const log = new Log();
    log.user("one");
    log.add({ type: "run_context", payload: ROOT(attribution()) });
    log.modelCall();
    log.assistant("ok");
    log.user("two");
    log.add({
      type: "run_context",
      payload: { attribution: { commit: "", pr: "", sessionUrl: null } },
    });
    const texts = systemTexts(log);
    expect(texts.some((t) => t.includes("git commit"))).toBe(true);
    expect(texts).toContainEqual(
      "Context update (replaces the earlier values):\n" +
        "- Do not add an attribution line to git commits or pull requests.",
    );
  });

  it("turning one surface off retracts it by name while the others stay on", () => {
    const LINK = "https://capybara.example.com/chat/c1";
    const log = new Log();
    log.user("one");
    log.add({
      type: "run_context",
      payload: ROOT(attribution({ sessionUrl: LINK })),
    });
    log.modelCall();
    log.assistant("ok");
    log.user("two");
    // the pull-request line and the link are cleared; the commit trailer is unchanged
    log.add({
      type: "run_context",
      payload: { attribution: { commit: ATTRIBUTION_DEFAULTS.commit, pr: "", sessionUrl: null } },
    });
    expect(systemTexts(log)).toContainEqual(
      "Context update (replaces the earlier values):\n" +
        "- Do not end pull request bodies with an attribution line.\n" +
        "- Do not add the conversation link to pull requests.\n" +
        `- When you create a git commit, end the commit message with this trailer: ${ATTRIBUTION_DEFAULTS.commit}`,
    );
  });

  it("a removed conversation link is retracted while the pull-request line stays", () => {
    const LINK = "https://capybara.example.com/chat/c1";
    const log = new Log();
    log.user("one");
    log.add({
      type: "run_context",
      payload: ROOT(attribution({ sessionUrl: LINK })),
    });
    log.modelCall();
    log.assistant("ok");
    log.user("two");
    // http.publicUrl went away: only the link is gone
    log.add({
      type: "run_context",
      payload: { attribution: { ...attribution(), sessionUrl: null } },
    });
    const update = systemTexts(log).find((t) => t.startsWith("Context update")) ?? "";
    expect(update).toContain("- Do not add the conversation link to pull requests.");
    expect(update).toContain(
      `- When you open a pull request, end the body with this line: ${ATTRIBUTION_DEFAULTS.pr}`,
    );
    expect(update).not.toContain("pull request bodies with an attribution line");
    expect(update).not.toContain("attribution trailer");
  });

  it("turning the commit trailer off retracts it while the pull request stays", () => {
    const log = new Log();
    log.user("one");
    log.add({ type: "run_context", payload: ROOT(attribution()) });
    log.modelCall();
    log.assistant("ok");
    log.user("two");
    log.add({
      type: "run_context",
      payload: { attribution: { ...attribution(), commit: "" } },
    });
    const update = systemTexts(log).find((t) => t.startsWith("Context update")) ?? "";
    expect(update).toContain("- Do not end git commit messages with an attribution trailer.");
    expect(update).toContain(
      `- When you open a pull request, end the body with this line: ${ATTRIBUTION_DEFAULTS.pr}`,
    );
    expect(update).not.toContain("git commit message with this trailer");
  });

  it("an unchanged surface is not retracted when another changes", () => {
    const LINK = "https://capybara.example.com/chat/c1";
    const log = new Log();
    log.user("one");
    log.add({ type: "run_context", payload: ROOT(attribution()) });
    log.modelCall();
    log.assistant("ok");
    log.user("two");
    // the link is added; neither line is turned off
    log.add({
      type: "run_context",
      payload: { attribution: attribution({ sessionUrl: LINK }) },
    });
    const update = systemTexts(log).find((t) => t.startsWith("Context update")) ?? "";
    expect(update).not.toContain("Do not");
    expect(update).toContain(`Then add this link to the conversation on a new line: ${LINK}`);
  });

  it("an all-empty attribution is not written when there was none, but is when one is turned off", () => {
    const off = { commit: "", pr: "", sessionUrl: null };
    // a conversation that never had one stays as an old log does: no field, no instruction
    expect(runContextChange({}, { date: "2026-11-14", attribution: off })).toEqual({
      date: "2026-11-14",
    });
    expect(
      runContextChange(
        { attribution: { commit: "Co-Authored-By: X", pr: "", sessionUrl: null } },
        { attribution: off },
      ),
    ).toEqual({ attribution: off });
  });

  it("an empty logged value renders no instruction", () => {
    const log = new Log();
    log.user("hello");
    log.add({
      type: "run_context",
      payload: ROOT({ commit: "", pr: "", sessionUrl: null }),
    });
    expect(
      systemTexts(log).some((t) => t.includes("git commit") || t.includes("attribution line")),
    ).toBe(false);
  });

  it("sessionUrl adds the conversation link only when the logged value holds one", () => {
    const withLink = new Log();
    withLink.user("a");
    withLink.add({
      type: "run_context",
      payload: ROOT(attribution({ sessionUrl: "https://capybara.example.com/chat/c1" })),
    });
    expect(
      systemTexts(withLink).some((t) => t.includes("https://capybara.example.com/chat/c1")),
    ).toBe(true);
    const without = new Log();
    without.user("a");
    without.add({ type: "run_context", payload: ROOT(attribution()) });
    expect(systemTexts(without).some((t) => t.includes("conversation"))).toBe(false);
  });

  it("replay reproduces it from the log alone: the agent's own override never changes a built request", () => {
    const log = new Log();
    log.user("hello");
    log.add({ type: "run_context", payload: ROOT(attribution()) });
    const custom: AgentDefinition = {
      ...AGENT,
      attribution: { mode: "custom", commit: "Co-Authored-By: Other <o@example.com>" },
    };
    expect(build(log, custom)).toEqual(build(log));
    // a replay (the same log built again) is byte for byte what was sent
    expect(build(log)).toEqual(build(log));
  });

  it("a sub-agent's own logged context carries its instruction", () => {
    const log = new Log("child-1");
    log.user("task");
    log.add({
      type: "subagent_started",
      payload: {
        parent: { conversationId: "parent-1", runId: "pr1", callId: "c1", step: 1 },
        agentType: "general-purpose",
        template: { source: "general" },
        definition: AGENT,
        preamble: "You are a sub-agent.",
        maxSteps: 0,
      },
    });
    log.add({
      type: "run_context",
      payload: {
        agent: { name: "general-purpose" },
        dispatchedBy: { agent: "Lead", person: "Wang" },
        date: "2026-11-14",
        timeZone: "UTC",
        attribution: attribution(),
      },
    });
    const texts = systemTexts(log);
    expect(texts.some((t) => t.includes("git commit"))).toBe(true);
    expect(texts.some((t) => t.includes('dispatched by the agent "Lead"'))).toBe(true);
  });

  it("the instruction never reaches a tool result or a user turn", () => {
    const log = new Log();
    log.user("hello");
    log.add({ type: "run_context", payload: ROOT(attribution()) });
    log.assistant(
      [{ type: "tool_call", id: "t1", name: "Bash", input: { command: "git log" } }],
      "tool_use",
    );
    log.add({
      type: "tool_result",
      payload: { step: 1, callId: "t1", toolKey: "Bash", content: "done", isError: false },
    });
    const req = build(log);
    const withInstruction = req.messages.filter(
      (m) => typeof m.content === "string" && m.content.includes("git commit"),
    );
    expect(withInstruction).toHaveLength(1);
    expect(withInstruction[0]?.role).toBe("system");
    for (const m of req.messages) {
      if (m === withInstruction[0]) continue;
      expect(JSON.stringify(m.content)).not.toContain("git commit");
    }
  });
});
