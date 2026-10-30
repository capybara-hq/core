import { describe, expect, it } from "vitest";
import { legacyScopeOf, recordedCalls } from "../../src/evals/recorded-tools.js";
import type { CaseSnapshot } from "../../src/evals/snapshot.js";

type Call = { key: string; hash: string | null; connector?: boolean; spec?: boolean };

/** A one-run snapshot whose assistant message calls `calls`, each recorded with a tool spec. */
function snap(calls: Call[], plugins: { plugin: string; name: string }[] = []): CaseSnapshot {
  const toolSpecs: Record<string, unknown> = {};
  const events: CaseSnapshot["events"] = [];
  let seq = 1;
  const ev = (type: string, payload: unknown) =>
    events.push({ seq: seq++, type, payload, runId: "r", createdAt: "" } as never);
  ev("assistant_message", {
    step: 1,
    stopReason: "tool_use",
    content: calls.map((c, i) => ({
      type: "tool_call",
      id: `c${i}`,
      name: c.key,
      input: { q: 1 },
    })),
  });
  for (const [i, c] of calls.entries()) {
    const tool = c.key.slice(c.key.indexOf("__") + 2);
    if (c.hash !== null && c.spec !== false) {
      toolSpecs[c.hash] = {
        name: tool,
        description: "d",
        inputSchema: { type: "object" },
        ...(c.connector && { connectorData: { tool } }),
      };
    }
    ev("tool_call_started", {
      step: 1,
      callId: `c${i}`,
      toolKey: c.key,
      specHash: c.hash ?? "",
    });
    ev("tool_result", { step: 1, callId: `c${i}`, toolKey: c.key, content: "ok", isError: false });
  }
  return {
    version: 1,
    orgId: "o",
    conversationId: "c",
    runId: "r",
    agentId: "a",
    agentVersion: 1,
    events,
    definitions: {
      "1": { tools: plugins.map((p) => ({ kind: "plugin", ...p })) } as never,
    },
    toolSpecs: toolSpecs as never,
  };
}

const keys = (s: CaseSnapshot) => recordedCalls(s).map((c) => c.toolKey);

describe("legacy scope from positive evidence", () => {
  it("a connector tool spec and an extension tool spec are read as such", () => {
    const s = snap([
      { key: "docs__search", hash: "h1", connector: true },
      { key: "probe__echo", hash: "h2" },
    ]);
    expect(keys(s)).toEqual(["mcp__docs__search", "plugin__probe__echo"]);
    expect(recordedCalls(s).every((c) => c.legacy === true)).toBe(true);
  });

  it("an extension ref in the definition is evidence for exactly that tool", () => {
    const s = snap([{ key: "probe__echo", hash: null }], [{ plugin: "probe", name: "echo" }]);
    expect(keys(s)).toEqual(["plugin__probe__echo"]);
    const other = snap([{ key: "probe__echo", hash: null }], [{ plugin: "probe", name: "second" }]);
    expect(keys(other)).toEqual(["probe__echo"]);
  });

  it("a connector slug equal to an extension name is ambiguous: left unmapped", () => {
    const s = snap(
      [
        { key: "same__search", hash: "h1", connector: true },
        { key: "same__echo", hash: "h2" },
      ],
      [{ plugin: "same", name: "echo" }],
    );
    const scope = legacyScopeOf(s);
    expect(scope.connectorSlugs.has("same") && scope.extensionNames.has("same")).toBe(true);
    expect(keys(s)).toEqual(["same__search", "same__echo"]);
    expect(recordedCalls(s).some((c) => c.legacy)).toBe(false);
  });

  it("a head with no evidence stays unmapped, even when it looks like a plugin name", () => {
    const s = snap([{ key: "ghost__t", hash: null }], [{ plugin: "ghost", name: "other" }]);
    expect(keys(s)).toEqual(["ghost__t"]);
    const noSpec = snap([{ key: "ghost__t", hash: "gone", spec: false }]);
    expect(keys(noSpec)).toEqual(["ghost__t"]);
    expect(recordedCalls(noSpec)[0]?.legacy).toBeUndefined();
  });
});
