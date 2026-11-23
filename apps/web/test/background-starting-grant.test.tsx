import { cleanup, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import zh from "../messages/zh.json";
import { BackgroundSection } from "../src/components/conversation/BackgroundSection";
import type { BackgroundTaskView } from "../src/lib/conversations";
import { renderPage } from "./support/render";

vi.mock("../src/i18n/navigation", () => import("./support/navigation"));
afterEach(cleanup);

const task = (over: Partial<BackgroundTaskView> = {}): BackgroundTaskView => ({
  id: "t1",
  conversationId: "c1",
  subagentId: null,
  description: "npm test --watch",
  command: "npm test --watch",
  status: "running",
  exitCode: null,
  lostReason: null,
  startedAt: "2026-11-16T10:00:00.000Z",
  finishedAt: null,
  stopping: false,
  ...over,
});

const NOTICE =
  "Running work keeps the permissions it started with; a permission change applies to new operations. Revoked device or organization access can still stop it.";

/** The section's hint button (the sentence is its description and its tooltip). */
const hint = () => document.querySelector<HTMLElement>('[data-part="property-hint"]');
const hintText = () =>
  document.getElementById(hint()?.getAttribute("aria-describedby") ?? "")?.textContent;

describe("work under way keeps its starting grant (Task 10D)", () => {
  it("says so in the section's hint beside a running task, never naming a per-task profile; Stop still works", async () => {
    const onStop = vi.fn();
    renderPage(
      <BackgroundSection
        views={[]}
        tasks={[task()]}
        onStop={onStop}
        onOpen={() => {}}
        onOpenCompleted={() => {}}
      />,
      { locale: "en" },
    );
    expect(hint()?.getAttribute("aria-label")).toBe("About Background tasks");
    expect(hintText()).toBe(NOTICE);
    // no recorded per-task profile exists: none is claimed
    for (const profile of ["Request approval", "Approve for me", "Full access"])
      expect(screen.queryByText(profile, { exact: false })).toBeNull();
    const stop = screen
      .getAllByRole("button")
      .find((b) => /stop/i.test(b.getAttribute("aria-label") ?? b.textContent ?? ""));
    expect(stop).toBeDefined();
    await userEvent.setup().click(stop as HTMLElement);
    expect(onStop).toHaveBeenCalledWith({ kind: "task", id: "t1" });
  });

  it("says nothing once nothing runs; speaks Chinese", () => {
    const { unmount } = renderPage(
      <BackgroundSection
        views={[]}
        tasks={[task({ status: "completed", finishedAt: "2026-11-16T10:05:00.000Z", exitCode: 0 })]}
        onStop={() => {}}
        onOpen={() => {}}
        onOpenCompleted={() => {}}
      />,
      { locale: "en" },
    );
    expect(hint()).toBeNull();
    expect(screen.queryByText(NOTICE)).toBeNull();
    unmount();
    renderPage(
      <BackgroundSection
        views={[]}
        tasks={[task()]}
        onStop={() => {}}
        onOpen={() => {}}
        onOpenCompleted={() => {}}
      />,
      { locale: "zh" },
    );
    expect(hintText()).toBe(zh.subagents.startingGrant);
  });
});
