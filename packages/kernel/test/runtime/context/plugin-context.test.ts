import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  ConversationEventSchema,
  PLUGIN_CONTEXT_MAX_BYTES,
} from "../../../src/conversations/events.js";
import { buildModelRequest } from "../../../src/runtime/context/build.js";
import { compactionPlan } from "../../../src/runtime/context/compaction.js";
import {
  latestPluginContexts,
  pluginContextIdemKey,
  pluginContextText,
} from "../../../src/runtime/context/plugin-context.js";
import { AGENT, compactionSettings, Log, MODEL, NO_TAIL_LIMIT } from "./fixtures.js";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");

const pc = (log: Log, plugin: string, text: string) =>
  log.add({ type: "plugin_context", payload: { plugin, text, hash: hash(text) } });

const build = (log: Log) =>
  buildModelRequest({ events: log.events, agent: AGENT, agentVersion: 1, model: MODEL, step: 1 })
    .request;

const wrapped = (plugin: string, text: string) =>
  `<plugin-context plugin="${plugin}">\n${text}\n</plugin-context>`;

describe("plugin_context: the event", () => {
  const parse = (payload: unknown) =>
    ConversationEventSchema.safeParse({ type: "plugin_context", payload }).success;

  it("accepts text up to the byte limit, a 1-64 char plugin and a sha256 hex hash", () => {
    const max = "a".repeat(PLUGIN_CONTEXT_MAX_BYTES);
    expect(parse({ plugin: "memory", text: max, hash: hash(max) })).toBe(true);
    expect(parse({ plugin: "m".repeat(64), text: "", hash: hash("") })).toBe(true);
  });

  it("refuses text over the byte limit (counted in UTF-8 bytes), a bad plugin or hash", () => {
    // 3 bytes per character: under the limit in characters, over it in bytes
    const cjk = "记".repeat(PLUGIN_CONTEXT_MAX_BYTES / 3 + 1);
    expect(parse({ plugin: "memory", text: cjk, hash: hash(cjk) })).toBe(false);
    expect(parse({ plugin: "", text: "x", hash: hash("x") })).toBe(false);
    expect(parse({ plugin: "m".repeat(65), text: "x", hash: hash("x") })).toBe(false);
    expect(parse({ plugin: "memory", text: "x", hash: hash("x").toUpperCase() })).toBe(false);
    expect(parse({ plugin: "memory", text: "x", hash: "abc" })).toBe(false);
  });

  it("idem key per run and plugin", () => {
    expect(pluginContextIdemKey("run-1", "memory")).toBe("plugin_context:run-1:memory");
  });
});

describe("plugin_context: helpers", () => {
  it("wraps the text in a plugin-context tag; empty text renders nothing", () => {
    expect(pluginContextText({ plugin: "memory", text: "- a fact", hash: hash("- a fact") })).toBe(
      '<plugin-context plugin="memory">\n- a fact\n</plugin-context>',
    );
    expect(pluginContextText({ plugin: "memory", text: "", hash: hash("") })).toBe("");
  });

  it("latestPluginContexts keeps the last event per plugin at or before the seq", () => {
    const log = new Log();
    pc(log, "memory", "one"); // seq 1
    pc(log, "notes", "n1"); // seq 2
    pc(log, "memory", "two"); // seq 3
    pc(log, "memory", ""); // seq 4
    expect([...latestPluginContexts(log.events, 3)].map(([k, v]) => [k, v.text])).toEqual([
      ["memory", "two"],
      ["notes", "n1"],
    ]);
    expect(latestPluginContexts(log.events, 4).get("memory")?.text).toBe("");
    expect(latestPluginContexts(log.events, 0).size).toBe(0);
  });
});

describe("plugin_context: request building", () => {
  it("renders at its position as a system message", () => {
    const log = new Log();
    pc(log, "memory", "- prefers tea");
    log.user("hello");
    log.assistant("hi");
    pc(log, "memory", "- prefers coffee");
    log.user("again");
    expect(build(log).messages).toEqual([
      { role: "system", content: wrapped("memory", "- prefers tea") },
      { role: "user", content: [{ type: "text", text: "hello" }] },
      { role: "assistant", content: [{ type: "text", text: "hi" }] },
      { role: "system", content: wrapped("memory", "- prefers coffee") },
      { role: "user", content: [{ type: "text", text: "again" }] },
    ]);
  });

  it("empty text renders nothing", () => {
    const log = new Log();
    log.user("hello");
    pc(log, "memory", "");
    log.user("again");
    expect(build(log).messages.filter((m) => m.role === "system")).toEqual([]);
  });

  it("after a summary: the latest non-empty one per plugin, in plugin-name order, after device_paths", () => {
    const log = new Log();
    pc(log, "notes", "old notes"); // seq 1
    pc(log, "memory", "old memory"); // seq 2
    log.user("hello"); // seq 3
    pc(log, "notes", "new notes"); // seq 4
    log.add({
      type: "device_paths",
      payload: { roots: { workspace: "/w", skills: "/s", tmp: "/t" } },
    }); // seq 5
    log.assistant("hi"); // seq 6
    log.summary(6, "S");
    log.user("next");
    const messages = build(log).messages;
    expect(messages.map((m) => (m.role === "system" ? m.content : m.role))).toEqual([
      "user",
      expect.stringMatching(/^This device's directories:/),
      wrapped("memory", "old memory"),
      wrapped("notes", "new notes"),
      "user",
    ]);
  });

  it("a covered empty event stops the earlier text from following the summary", () => {
    const log = new Log();
    pc(log, "memory", "old memory"); // seq 1
    log.user("hello"); // seq 2
    log.assistant("hi"); // seq 3
    pc(log, "memory", ""); // seq 4
    log.summary(4, "S");
    log.user("next");
    expect(build(log).messages.filter((m) => m.role === "system")).toEqual([]);
  });

  it("an event after the summary renders at its position, not again after the summary", () => {
    const log = new Log();
    log.user("hello"); // seq 1
    log.assistant("hi"); // seq 2
    log.summary(2, "S");
    pc(log, "memory", "fresh");
    log.user("next");
    expect(build(log).messages.filter((m) => m.role === "system")).toEqual([
      { role: "system", content: wrapped("memory", "fresh") },
    ]);
  });

  it("is left out of the compaction transcript", () => {
    const log = new Log();
    pc(log, "memory", "SECRET-MEMORY");
    log.user("question");
    log.assistant("answer");
    log.user("latest");
    const plan = compactionPlan(
      log.events,
      compactionSettings({ keepRecentTurns: 1 }),
      NO_TAIL_LIMIT,
    );
    expect(plan?.transcript).toBe("User: question\n\nAssistant: answer");
  });
});
