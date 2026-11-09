import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesignProvider, ReplaceableFrame, SafeModeBanner } from "../src/index";
import { describeNestedBox, findNestedBoxes } from "../src/reference/index";

afterEach(cleanup);

const SHELL_CSS = readFileSync(resolve(import.meta.dirname, "../src/styles/shell.css"), "utf8");
const rule = (selector: string) =>
  new RegExp(`${selector.replace(/[.[\]"=]/g, "\\$&")} \\{([^}]*)\\}`).exec(SHELL_CSS)?.[1] ?? "";

describe("ReplaceableFrame", () => {
  it("hides but keeps the box while pending", () => {
    const { container, rerender } = render(
      <ReplaceableFrame pending>
        <p>built-in</p>
      </ReplaceableFrame>,
    );
    const frame = container.firstElementChild as HTMLElement;
    expect(frame.getAttribute("data-pending")).toBe("true");
    expect(frame.getAttribute("aria-hidden")).toBe("true");
    expect(frame.hasAttribute("inert")).toBe(true);
    // the children stay mounted (layout kept); the frame hides them with visibility, never display
    expect(frame.textContent).toBe("built-in");
    const hidden = rule('.cb-replaceable[data-pending="true"]');
    expect(hidden).toContain("visibility: hidden");
    expect(hidden).not.toContain("display");
    rerender(
      <ReplaceableFrame pending={false}>
        <p>built-in</p>
      </ReplaceableFrame>,
    );
    expect(frame.hasAttribute("data-pending")).toBe(false);
    expect(frame.hasAttribute("aria-hidden")).toBe(false);
    expect(frame.hasAttribute("inert")).toBe(false);
  });

  it("adds no box of its own", () => {
    expect(rule(".cb-replaceable")).toContain("display: contents");
    render(
      <ReplaceableFrame pending>
        <p>x</p>
      </ReplaceableFrame>,
    );
    expect(findNestedBoxes(document.body).map(describeNestedBox)).toEqual([]);
  });
});

describe("SafeModeBanner", () => {
  it("announces safe mode and leaves it with the button", () => {
    const onExit = vi.fn();
    render(
      <DesignProvider locale="zh">
        <SafeModeBanner onExit={onExit} />
      </DesignProvider>,
    );
    expect(screen.getByRole("status").textContent).toContain("安全模式");
    fireEvent.click(screen.getByRole("button", { name: "退出安全模式" }));
    expect(onExit).toHaveBeenCalledTimes(1);
  });
});
