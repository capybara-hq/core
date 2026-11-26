import { ToolGroup } from "@capybara-hq/design";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { ToolInfo } from "../src/lib/conversations";
import { buildTimeline, type TimelineEntry } from "../src/lib/timeline";

// Streaming tool input spec §6.4: what a streaming Bash row reads on the page.

const bash = (kind: ToolInfo["kind"]): Map<string, ToolInfo> =>
  new Map([
    [
      "Bash",
      {
        key: "Bash",
        title: null,
        kind,
        sandbox: true,
        keyArgs: ["command"],
        inputView: { kind: "command", command: "command", description: "description" },
        tool: null,
        source: { kind: "builtin" },
      },
    ],
  ]);

const rowsOf = (input: string, kind: ToolInfo["kind"]) => {
  const out = buildTimeline(
    [],
    [{ runId: "r1", step: 1, text: "", thinking: "", tools: [{ id: "c1", name: "Bash", input }] }],
    bash(kind),
    "en",
  );
  const group = out.find((e): e is Extract<TimelineEntry, { kind: "tools" }> => e.kind === "tools");
  return (group?.rows ?? []).map((r) => r.row);
};

afterEach(cleanup);

describe("streaming command row", () => {
  const complete = '{"command":"ls -la /tmp","description":"List the temp files"';

  it("shows the command while the description is open, then the description", () => {
    render(
      <ToolGroup rows={rowsOf('{"command":"ls -la /tmp","description":"List the te', "command")} />,
    );
    expect(screen.getByText("ls -la /tmp")).toBeTruthy();
    expect(screen.queryByText(/List the te/)).toBeNull();
    cleanup();
    render(<ToolGroup rows={rowsOf(complete, "command")} />);
    expect(screen.getByText("List the temp files")).toBeTruthy();
    expect(screen.queryByText("ls -la /tmp")).toBeNull();
  });

  it("a command view on a tool of another kind still shows the description", () => {
    render(<ToolGroup rows={rowsOf(complete, "tool")} />);
    expect(screen.getByText("List the temp files")).toBeTruthy();
  });
});
