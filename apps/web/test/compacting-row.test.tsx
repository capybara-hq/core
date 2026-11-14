import { cleanup, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { CompactingRow } from "../src/components/conversation/CompactingRow";
import type { CompactionProgress } from "../src/lib/stream";
import { renderPage } from "./support/render";

afterEach(cleanup);

const progress = (extra: Partial<CompactionProgress> = {}): CompactionProgress => ({
  runId: "r1",
  conversationId: "c1",
  phase: "summarizing",
  step: 1,
  chars: 10,
  startedAt: Date.now() - 3000,
  ...extra,
});

describe("CompactingRow", () => {
  const row = (): HTMLElement => {
    const el = document.querySelector<HTMLElement>('[data-role="compacting-row"]');
    if (el === null) throw new Error("no compacting row");
    return el;
  };

  it("shows the spinner and the compacting line while a summary streams", () => {
    renderPage(<CompactingRow progress={progress()} />);
    expect(row().textContent).toContain("Compacting conversation…");
    expect(screen.getByRole("img", { name: "In progress" })).toBeTruthy();
  });

  it("shows a real 1/3 in the chunked path", () => {
    renderPage(<CompactingRow progress={progress({ chunk: 1, chunks: 3 })} />);
    expect(row().textContent).toContain("1/3");
  });

  it("shows no fake percentage in the single-call path", () => {
    renderPage(<CompactingRow progress={progress()} />);
    expect(row().textContent).not.toMatch(/\d+\s*\/\s*\d+/);
    expect(row().textContent).not.toContain("%");
  });
});
