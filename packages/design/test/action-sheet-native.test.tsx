// The action sheet in a native shell (responsive system spec §2.4, decision P3) and its history
// entry: a sheet of plain actions opens as the platform's action sheet (`menu@1`); a sheet with a
// link stays the web sheet; unmounting the owner with the sheet open leaves no history entry.
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ActionSheet,
  DesignProvider,
  type MenuItem,
  type NativeHandlers,
  OVERLAY_HISTORY_MARKER,
} from "../src/index";

/** A compact touch window, as the overlay history needs it. */
function stubTouchPhone() {
  vi.stubGlobal("matchMedia", (q: string) => {
    const one = (s: string) => {
      const t = s.trim();
      if (t === "(pointer: coarse)" || t === "(any-pointer: coarse)") return true;
      if (t === "(any-pointer: fine)") return false;
      const max = /\(max-width:\s*(\d+)px\)/.exec(t);
      return max ? 390 <= Number(max[1]) : false;
    };
    const matches = q.includes("not (any-pointer: fine)") ? true : q.split(",").some(one);
    return { matches, media: q, addEventListener() {}, removeEventListener() {} };
  });
}

beforeEach(() => {
  history.replaceState(null, "", "/");
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function Owner({ items, native }: { items: MenuItem[]; native?: NativeHandlers }) {
  const [open, setOpen] = useState(false);
  return (
    <DesignProvider locale="zh" {...(native ? { native } : {})}>
      <button type="button" onClick={() => setOpen(true)}>
        更多
      </button>
      <span data-testid="state">{open ? "open" : "closed"}</span>
      <ActionSheet open={open} onOpenChange={setOpen} title="部署失败排查" items={items} />
    </DesignProvider>
  );
}

const webSheet = () => document.querySelector('[data-part="action-sheet"]');

describe("ActionSheet in a native shell", () => {
  it("native menu used for a sheet without links", async () => {
    const archive = vi.fn();
    const remove = vi.fn();
    const menu = vi.fn<NonNullable<NativeHandlers["menu"]>>(async (input) => {
      return input.items.find((i) => i.label === "归档")?.id ?? null;
    });
    render(
      <Owner
        native={{ menu }}
        items={[
          { label: "归档", onSelect: archive },
          "separator",
          { label: "删除", danger: true, onSelect: remove },
        ]}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "更多" }));
    await act(async () => {});
    expect(menu).toHaveBeenCalledTimes(1);
    const input = menu.mock.calls[0]?.[0];
    expect(input?.title).toBe("部署失败排查");
    expect(input?.items.map((i) => [i.label, i.destructive ?? false])).toEqual([
      ["归档", false],
      ["删除", true],
    ]);
    // the web sheet never drew, and the owner's state is closed again
    expect(webSheet()).toBeNull();
    expect(screen.getByTestId("state").textContent).toBe("closed");
    expect(archive).toHaveBeenCalledOnce();
    expect(remove).not.toHaveBeenCalled();
  });

  it("a native dismissal runs nothing; a rejection opens the web sheet", async () => {
    const archive = vi.fn();
    const menu = vi.fn<NonNullable<NativeHandlers["menu"]>>(async () => null);
    const { unmount } = render(
      <Owner native={{ menu }} items={[{ label: "归档", onSelect: archive }]} />,
    );
    await userEvent.click(screen.getByRole("button", { name: "更多" }));
    await act(async () => {});
    expect(menu).toHaveBeenCalledTimes(1);
    expect(archive).not.toHaveBeenCalled();
    expect(webSheet()).toBeNull();
    expect(screen.getByTestId("state").textContent).toBe("closed");
    unmount();

    const failing = vi.fn<NonNullable<NativeHandlers["menu"]>>(async () => {
      throw new Error("busy");
    });
    render(<Owner native={{ menu: failing }} items={[{ label: "归档", onSelect: archive }]} />);
    await userEvent.click(screen.getByRole("button", { name: "更多" }));
    await waitFor(() => expect(webSheet()).not.toBeNull());
    expect(failing).toHaveBeenCalledTimes(1);
    await userEvent.click(within(webSheet() as HTMLElement).getByRole("button", { name: "归档" }));
    await waitFor(() => expect(archive).toHaveBeenCalledOnce());
    // closing the fallback sheet: the next open tries the native sheet again
    await waitFor(() => expect(webSheet()).toBeNull());
    await userEvent.click(screen.getByRole("button", { name: "更多" }));
    await act(async () => {});
    expect(failing).toHaveBeenCalledTimes(2);
  });

  it("sheet with a link stays the web sheet in a native shell", async () => {
    const menu = vi.fn<NonNullable<NativeHandlers["menu"]>>(async () => null);
    render(
      <Owner
        native={{ menu }}
        items={[
          { label: "开始会话", href: "/agents/a1" },
          { label: "归档", onSelect: () => {} },
        ]}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "更多" }));
    await waitFor(() => expect(webSheet()).not.toBeNull());
    expect(menu).not.toHaveBeenCalled();
    // the link row is a real link: a modified click or the system's link menu still works on it
    const link = within(webSheet() as HTMLElement).getByRole("link", { name: "开始会话" });
    expect(link.getAttribute("href")).toBe("/agents/a1");
  });
});

describe("ActionSheet history", () => {
  it("closes when the form unmounts", async () => {
    stubTouchPhone();
    const marker = () =>
      (history.state as Record<string, unknown> | null)?.[OVERLAY_HISTORY_MARKER];
    const { unmount } = render(<Owner items={[{ label: "归档", onSelect: () => {} }]} />);
    await userEvent.click(screen.getByRole("button", { name: "更多" }));
    await waitFor(() => expect(webSheet()).not.toBeNull());
    expect(typeof marker()).toBe("string");
    const back = vi.spyOn(history, "back");
    unmount();
    // the sheet's entry is popped once (batched in a microtask) and nothing is left holding it
    await waitFor(() => expect(back).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(marker()).toBeUndefined());
    // a later back is a page back again: no stale overlay swallows it
    const later = vi.fn();
    render(
      <DesignProvider locale="zh">
        <ActionSheet open={false} onOpenChange={later} title="x" items={[]} />
      </DesignProvider>,
    );
    act(() => history.back());
    await act(async () => {});
    expect(later).not.toHaveBeenCalled();
  });
});
