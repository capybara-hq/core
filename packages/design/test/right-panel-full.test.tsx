import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConversationPage, DesignProvider, RightPanel } from "../src/index";

afterEach(cleanup);

/**
 * The right panel's full screen (spec §6.16.18): maximised inside the page, never the browser's
 * full screen. The panel takes the conversation's content area (the thread and the composer give
 * way; the title bar stays), its button turns into "Exit full screen", and Esc restores it.
 */
function page(p: { full: boolean; onFull: (v: boolean) => void; layout?: "inline" | "sheet" }) {
  return (
    <DesignProvider locale="zh">
      <ConversationPage
        titleBar={{
          title: "t",
          untitled: "u",
          menu: [],
          properties: { pressed: false, onToggle: () => {} },
          panels: [],
        }}
        thread={<div data-testid="thread">thread</div>}
        composer={<div data-testid="composer">composer</div>}
        status={{ context: "c", version: "v" }}
        right="panel"
        panel={
          <RightPanel title="输出" onClose={() => {}} onFullscreen={() => p.onFull(!p.full)}>
            body
          </RightPanel>
        }
        rightFull={p.full}
        onRightFullChange={p.onFull}
        onCloseRight={() => {}}
        layout={p.layout ?? "inline"}
      />
    </DesignProvider>
  );
}

describe("ConversationPage rightFull", () => {
  it("off: the panel sits beside the thread with a 全屏 button", async () => {
    const onFull = vi.fn();
    const { container } = render(page({ full: false, onFull }));
    expect(screen.getByTestId("thread")).toBeTruthy();
    expect(
      container.querySelector('[data-part="panel-slot"] [data-part="right-panel"]'),
    ).not.toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "全屏" }));
    expect(onFull).toHaveBeenCalledWith(true);
  });

  it("on: the panel takes the content area, the thread and composer give way, the title bar stays", async () => {
    const onFull = vi.fn();
    const { container } = render(page({ full: true, onFull }));
    expect(screen.queryByTestId("thread")).toBeNull();
    expect(screen.queryByTestId("composer")).toBeNull();
    expect(container.querySelector('[data-part="panel-slot"]')).toBeNull();
    expect(container.querySelector(".cb-title-bar")).not.toBeNull();
    const full = container.querySelector('[data-part="panel-full"]');
    expect(full?.querySelector('[data-part="right-panel"]')).not.toBeNull();
    expect(
      container
        .querySelector('[data-template="ConversationPage"]')
        ?.getAttribute("data-right-full"),
    ).toBe("true");
    const exit = screen.getByRole("button", { name: "退出全屏" });
    expect(exit.querySelector("svg")?.getAttribute("data-icon")).toBe("minimize-2");
    await userEvent.click(exit);
    expect(onFull).toHaveBeenCalledWith(false);
  });

  it("Esc restores", () => {
    const onFull = vi.fn();
    render(page({ full: true, onFull }));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onFull).toHaveBeenCalledWith(false);
  });

  it("Esc does nothing while not full", () => {
    const onFull = vi.fn();
    render(page({ full: false, onFull }));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onFull).not.toHaveBeenCalled();
  });

  it("in the sheet layout, full draws the panel in the content area, not in a sheet", () => {
    const { container } = render(page({ full: true, onFull: vi.fn(), layout: "sheet" }));
    expect(document.querySelector('[data-part="sheet"]')).toBeNull();
    expect(
      container.querySelector('[data-part="panel-full"] [data-part="right-panel"]'),
    ).not.toBeNull();
  });
});
