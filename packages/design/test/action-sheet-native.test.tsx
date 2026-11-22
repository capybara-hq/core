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
import { matchMediaFor } from "./width";

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

/** An owner like ConversationList: `open` is `target !== null`, a close clears the target. */
function TargetOwner({
  native,
  onArchive,
}: {
  native: NativeHandlers;
  onArchive(id: string): void;
}) {
  const [target, setTarget] = useState<string | null>(null);
  const [, setTick] = useState(0);
  return (
    <DesignProvider locale="zh" native={native}>
      <button type="button" onClick={() => setTarget("c1")}>
        更多
      </button>
      <button type="button" onClick={() => setTick((n) => n + 1)}>
        重绘
      </button>
      <span data-testid="target">{target ?? ""}</span>
      <ActionSheet
        open={target !== null}
        onOpenChange={(o) => {
          if (!o) setTarget(null);
        }}
        title={target ?? "x"}
        items={target ? [{ label: "归档", onSelect: () => onArchive(target) }] : []}
      />
    </DesignProvider>
  );
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const webSheet = () => document.querySelector('[data-part="action-sheet"]');

describe("ActionSheet in a native shell", () => {
  beforeEach(() => {
    vi.stubGlobal("matchMedia", matchMediaFor(390).matchMedia);
  });

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

  it("an owner whose open state carries the target keeps it until the native sheet settles", async () => {
    const archive = vi.fn();
    const d = deferred<string | null>();
    const menu = vi.fn<NonNullable<NativeHandlers["menu"]>>(() => d.promise);
    render(<TargetOwner native={{ menu }} onArchive={archive} />);
    await userEvent.click(screen.getByRole("button", { name: "更多" }));
    await act(async () => {});
    expect(menu).toHaveBeenCalledTimes(1);
    // the target stays while the native sheet is up; a re-render shows no second sheet
    expect(screen.getByTestId("target").textContent).toBe("c1");
    await userEvent.click(screen.getByRole("button", { name: "重绘" }));
    await act(async () => {});
    expect(menu).toHaveBeenCalledTimes(1);
    const id = menu.mock.calls[0]?.[0].items[0]?.id ?? "";
    await act(async () => d.resolve(id));
    expect(screen.getByTestId("target").textContent).toBe("");
    expect(archive).toHaveBeenCalledWith("c1");
  });

  it("a rejection draws the web sheet for a target-carrying owner, with the same items", async () => {
    const archive = vi.fn();
    const menu = vi.fn<NonNullable<NativeHandlers["menu"]>>(async () => {
      throw new Error("busy");
    });
    render(<TargetOwner native={{ menu }} onArchive={archive} />);
    await userEvent.click(screen.getByRole("button", { name: "更多" }));
    await waitFor(() => expect(webSheet()).not.toBeNull());
    expect(menu).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("target").textContent).toBe("c1");
    await userEvent.click(within(webSheet() as HTMLElement).getByRole("button", { name: "归档" }));
    await waitFor(() => expect(archive).toHaveBeenCalledWith("c1"));
    expect(menu).toHaveBeenCalledTimes(1);
  });

  it("at 1440 a native shell still draws the web sheet", async () => {
    vi.stubGlobal("matchMedia", matchMediaFor(1440).matchMedia);
    const menu = vi.fn<NonNullable<NativeHandlers["menu"]>>(async () => null);
    render(<Owner native={{ menu }} items={[{ label: "归档", onSelect: () => {} }]} />);
    await userEvent.click(screen.getByRole("button", { name: "更多" }));
    await waitFor(() => expect(webSheet()).not.toBeNull());
    expect(menu).not.toHaveBeenCalled();
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
