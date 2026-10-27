import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type CommandGroup, CommandPalette, DesignProvider } from "../src/index";

/** Phase D Task 10: tagged, searchable palette items (spec §6.7, `command-palette`). */

afterEach(cleanup);

const noop = () => {};
const wrap = (groups: CommandGroup[], extra: { inline?: boolean } = {}) =>
  render(
    <DesignProvider locale="en">
      <CommandPalette open onOpenChange={noop} groups={groups} {...extra} />
    </DesignProvider>,
  );

const items = () =>
  screen.getAllByRole("option").map((o) => o.getAttribute("data-value") ?? o.textContent);

describe("CommandPalette items", () => {
  it("show tags, the hint and the description", () => {
    wrap([
      {
        label: "Skills",
        items: [
          {
            id: "fix",
            label: "/fix-issue",
            hint: "[issue-number]",
            description: "Fix a GitHub issue",
            tags: ["manual", "sub-agent"],
            onSelect: noop,
          },
        ],
      },
    ]);
    const opt = screen.getByRole("option");
    expect(within(opt).getByText("/fix-issue")).toBeTruthy();
    expect(within(opt).getByText("[issue-number]").getAttribute("data-part")).toBe("palette-hint");
    expect(within(opt).getByText("Fix a GitHub issue").getAttribute("data-part")).toBe(
      "palette-desc",
    );
    expect(
      [...opt.querySelectorAll('[data-part="palette-tag"]')].map((t) => t.textContent),
    ).toEqual(["manual", "sub-agent"]);
  });

  it("filtering brai matches an item whose search holds superpowers:brainstorming", async () => {
    const user = userEvent.setup();
    wrap([
      {
        label: "Skills",
        items: [
          { id: "a", label: "/ideas", search: "superpowers:brainstorming", onSelect: noop },
          { id: "b", label: "/billing", onSelect: noop },
        ],
      },
    ]);
    await user.type(screen.getByRole("combobox"), "brai");
    expect(items()).toEqual(["a"]);
  });

  it("ranks a name prefix before a name substring before a description match", async () => {
    const user = userEvent.setup();
    wrap([
      {
        label: "Skills",
        items: [
          { id: "desc", label: "/deploy", description: "Review the release", onSelect: noop },
          { id: "sub", label: "/code-review", onSelect: noop },
          { id: "prefix", label: "/review-pr", onSelect: noop },
          { id: "none", label: "/other", onSelect: noop },
        ],
      },
    ]);
    await user.type(screen.getByRole("combobox"), "review");
    expect(items()).toEqual(["prefix", "sub", "desc"]);
  });

  it("a leading / in the query matches the name prefix", async () => {
    const user = userEvent.setup();
    wrap([
      {
        label: "Skills",
        items: [
          { id: "x", label: "/fix-issue", onSelect: noop },
          { id: "y", label: "/other", onSelect: noop },
        ],
      },
    ]);
    await user.type(screen.getByRole("combobox"), "/fix");
    expect(items()).toEqual(["x"]);
  });

  it("Enter selects the top item", async () => {
    const user = userEvent.setup();
    const pick = vi.fn();
    wrap([{ label: "Skills", items: [{ id: "x", label: "/fix-issue", onSelect: pick }] }]);
    await user.type(screen.getByRole("combobox"), "fix{Enter}");
    expect(pick).toHaveBeenCalledTimes(1);
  });

  it("inline draws the palette in place, without a dialog", () => {
    wrap([{ label: "Skills", items: [{ id: "x", label: "/fix-issue", onSelect: noop }] }], {
      inline: true,
    });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.querySelector('[data-part="palette"]')).toBeTruthy();
    expect(screen.getByRole("option")).toBeTruthy();
  });
});
