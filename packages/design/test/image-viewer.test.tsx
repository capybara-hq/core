import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BubbleAttachments, DesignProvider, ImageViewer } from "../src/index";

const IMAGES = [
  { src: "/a.png", name: "a.png", size: "1.2 MB" },
  { src: "/b.png", name: "b.png" },
  { src: "/c.png", name: "c.png" },
];

/** The stage is 1000 × 800 and the image 2000 × 1000: it fits at 50 %. */
function stubGeometry() {
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1000);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(800);
  vi.spyOn(HTMLImageElement.prototype, "naturalWidth", "get").mockReturnValue(2000);
  vi.spyOn(HTMLImageElement.prototype, "naturalHeight", "get").mockReturnValue(1000);
}

beforeEach(stubGeometry);
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

type Handlers = Partial<{
  onOpenChange(open: boolean): void;
  onIndexChange(i: number): void;
  onDownload(i: number): void;
  onOpenInNewTab(i: number): void;
  onRetry(i: number): void;
}>;

function show(images = IMAGES, index = 0, h: Handlers = {}) {
  const props = {
    open: true,
    onOpenChange: h.onOpenChange ?? (() => {}),
    images,
    index,
    onIndexChange: h.onIndexChange ?? (() => {}),
    onDownload: h.onDownload ?? (() => {}),
    onOpenInNewTab: h.onOpenInNewTab ?? (() => {}),
    ...(h.onRetry ? { onRetry: h.onRetry } : {}),
  };
  const ui = (p: typeof props) => (
    <DesignProvider locale="en">
      <ImageViewer {...p} />
    </DesignProvider>
  );
  const r = render(ui(props));
  const loaded = () =>
    fireEvent.load(screen.getByRole("img", { name: images[props.index]?.name ?? "" }));
  return {
    ...r,
    loaded,
    rerenderWith: (p: Partial<typeof props>) => r.rerender(ui({ ...props, ...p })),
  };
}

/** A double click as a browser sends it: the press first, then the dblclick. */
const dblclick = (el: HTMLElement) => {
  fireEvent.pointerDown(el, { pointerId: 1 });
  fireEvent.pointerUp(el, { pointerId: 1 });
  fireEvent.doubleClick(el);
};

const percent = () => document.querySelector("[data-part='image-viewer-percent']")?.textContent;

describe("ImageViewer", () => {
  it("starts fit to the viewport, never upscaled", () => {
    const { loaded } = show();
    loaded();
    expect(percent()).toBe("50%");
  });

  it("does not upscale a small image", () => {
    vi.spyOn(HTMLImageElement.prototype, "naturalWidth", "get").mockReturnValue(100);
    vi.spyOn(HTMLImageElement.prototype, "naturalHeight", "get").mockReturnValue(50);
    const { loaded } = show();
    loaded();
    expect(percent()).toBe("100%");
  });

  it("zooms with the toolbar: + raises, 1:1 shows 100%, fit restores, - lowers", async () => {
    const user = userEvent.setup();
    const { loaded } = show();
    loaded();
    await user.click(screen.getByRole("button", { name: "Zoom in" }));
    expect(Number.parseInt(percent() ?? "0", 10)).toBeGreaterThan(50);
    await user.click(screen.getByRole("button", { name: "Actual size" }));
    expect(percent()).toBe("100%");
    await user.click(screen.getByRole("button", { name: "Zoom out" }));
    expect(Number.parseInt(percent() ?? "0", 10)).toBeLessThan(100);
    await user.click(screen.getByRole("button", { name: "Fit to window" }));
    expect(percent()).toBe("50%");
  });

  it("clamps the zoom to 10% .. 800%", async () => {
    const user = userEvent.setup();
    const { loaded } = show();
    loaded();
    for (let i = 0; i < 30; i++) await user.click(screen.getByRole("button", { name: "Zoom in" }));
    expect(percent()).toBe("800%");
    for (let i = 0; i < 60; i++) await user.click(screen.getByRole("button", { name: "Zoom out" }));
    expect(percent()).toBe("10%");
  });

  it("zooms in on a wheel up over the image and out on a wheel down", () => {
    const { loaded } = show();
    loaded();
    const img = screen.getByRole("img", { name: "a.png" });
    fireEvent.wheel(img, { deltaY: -100 });
    const up = Number.parseInt(percent() ?? "0", 10);
    expect(up).toBeGreaterThan(50);
    fireEvent.wheel(img, { deltaY: 200 });
    expect(Number.parseInt(percent() ?? "0", 10)).toBeLessThan(up);
  });

  it("a double click toggles fit and 100%", () => {
    const { loaded } = show();
    loaded();
    const img = screen.getByRole("img", { name: "a.png" });
    dblclick(img);
    expect(percent()).toBe("100%");
    dblclick(img);
    expect(percent()).toBe("50%");
  });

  it("drags to pan only when the image exceeds the viewport", () => {
    const { loaded } = show();
    loaded();
    const img = screen.getByRole("img", { name: "a.png" });
    const stage = img.closest("[data-part='image-viewer-stage']") as HTMLElement;
    const pan = () => img.style.transform;
    // fit: the image is inside the viewport, nothing moves
    fireEvent.pointerDown(stage, { pointerId: 1, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(stage, { pointerId: 1, clientX: 140, clientY: 120 });
    fireEvent.pointerUp(stage, { pointerId: 1 });
    expect(pan()).toContain("translate(0px, 0px)");
    // 100%: 2000 × 1000 in a 1000 × 800 viewport, so it pans (both axes exceed the box)
    dblclick(img);
    fireEvent.pointerDown(stage, { pointerId: 1, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(stage, { pointerId: 1, clientX: 140, clientY: 120 });
    fireEvent.pointerUp(stage, { pointerId: 1 });
    expect(pan()).toContain("translate(40px, 20px)");
  });

  describe("with pointer capture (real browsers retarget click and dblclick to the stage)", () => {
    beforeEach(() => {
      (HTMLElement.prototype as unknown as { setPointerCapture: () => void }).setPointerCapture =
        () => {};
    });
    afterEach(() => {
      (HTMLElement.prototype as unknown as { setPointerCapture?: unknown }).setPointerCapture =
        undefined;
    });

    it("a click that began on the image does not close, though it lands on the stage", () => {
      const onOpenChange = vi.fn();
      const { loaded } = show(IMAGES, 0, { onOpenChange });
      loaded();
      const img = screen.getByRole("img", { name: "a.png" });
      const stage = img.closest("[data-part='image-viewer-stage']") as HTMLElement;
      fireEvent.pointerDown(img, { pointerId: 1, clientX: 5, clientY: 5 });
      fireEvent.pointerUp(stage, { pointerId: 1 });
      fireEvent.click(stage);
      expect(onOpenChange).not.toHaveBeenCalled();
      // a press on the bare backdrop still closes
      fireEvent.pointerDown(stage, { pointerId: 1, clientX: 5, clientY: 5 });
      fireEvent.pointerUp(stage, { pointerId: 1 });
      fireEvent.click(stage);
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });

    it("a double click that began on the image toggles fit and 100%", () => {
      const { loaded } = show();
      loaded();
      const img = screen.getByRole("img", { name: "a.png" });
      const stage = img.closest("[data-part='image-viewer-stage']") as HTMLElement;
      fireEvent.pointerDown(img, { pointerId: 1 });
      fireEvent.pointerUp(stage, { pointerId: 1 });
      fireEvent.doubleClick(stage);
      expect(percent()).toBe("100%");
      fireEvent.pointerDown(img, { pointerId: 1 });
      fireEvent.pointerUp(stage, { pointerId: 1 });
      fireEvent.doubleClick(stage);
      expect(percent()).toBe("50%");
    });
  });

  it("two pointers pinch: spreading them zooms in", () => {
    const { loaded } = show();
    loaded();
    const stage = document.querySelector("[data-part='image-viewer-stage']") as HTMLElement;
    fireEvent.pointerDown(stage, { pointerId: 1, clientX: 400, clientY: 400 });
    fireEvent.pointerDown(stage, { pointerId: 2, clientX: 500, clientY: 400 });
    fireEvent.pointerMove(stage, { pointerId: 2, clientX: 700, clientY: 400 });
    expect(Number.parseInt(percent() ?? "0", 10)).toBeGreaterThan(50);
  });

  it("pointercancel clears the pointer state: later moves do not pan", () => {
    const { loaded } = show();
    loaded();
    const img = screen.getByRole("img", { name: "a.png" });
    const stage = img.closest("[data-part='image-viewer-stage']") as HTMLElement;
    dblclick(img);
    fireEvent.pointerDown(stage, { pointerId: 1, clientX: 100, clientY: 100 });
    fireEvent.pointerCancel(stage, { pointerId: 1 });
    fireEvent.pointerMove(stage, { pointerId: 1, clientX: 160, clientY: 100 });
    expect(img.style.transform).toContain("translate(0px, 0px)");
  });

  it("the zoom percent is a polite live region", () => {
    const { loaded } = show();
    loaded();
    expect(
      document.querySelector("[data-part='image-viewer-percent']")?.getAttribute("aria-live"),
    ).toBe("polite");
  });

  it("the + - 0 1 keys work from the dialog content", async () => {
    const user = userEvent.setup();
    const { loaded } = show();
    loaded();
    screen.getByRole("dialog").focus();
    await user.keyboard("1");
    expect(percent()).toBe("100%");
    await user.keyboard("0");
    expect(percent()).toBe("50%");
  });

  it("closes on Escape, the close button and a click on the backdrop, not on the image", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    const { loaded } = show(IMAGES, 0, { onOpenChange });
    loaded();
    await user.click(screen.getByRole("img", { name: "a.png" }));
    expect(onOpenChange).not.toHaveBeenCalled();
    await user.keyboard("{Escape}");
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
    onOpenChange.mockClear();
    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
    onOpenChange.mockClear();
    const stage = document.querySelector("[data-part='image-viewer-stage']") as HTMLElement;
    await user.click(stage);
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
  });

  it("ArrowRight and ArrowLeft switch with several images; the side buttons too", async () => {
    const user = userEvent.setup();
    const onIndexChange = vi.fn();
    show(IMAGES, 1, { onIndexChange });
    await user.keyboard("{ArrowRight}");
    expect(onIndexChange).toHaveBeenLastCalledWith(2);
    await user.keyboard("{ArrowLeft}");
    expect(onIndexChange).toHaveBeenLastCalledWith(0);
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(onIndexChange).toHaveBeenLastCalledWith(2);
    await user.click(screen.getByRole("button", { name: "Previous" }));
    expect(onIndexChange).toHaveBeenLastCalledWith(0);
    expect(screen.getByText("2 / 3")).toBeTruthy();
  });

  it("does not move past the ends", async () => {
    const user = userEvent.setup();
    const onIndexChange = vi.fn();
    show(IMAGES, 0, { onIndexChange });
    await user.keyboard("{ArrowLeft}");
    expect(onIndexChange).not.toHaveBeenCalled();
    expect((screen.getByRole("button", { name: "Previous" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it("renders no navigation for a single image", async () => {
    const user = userEvent.setup();
    const onIndexChange = vi.fn();
    show([IMAGES[0] as (typeof IMAGES)[number]], 0, { onIndexChange });
    expect(screen.queryByRole("button", { name: "Next" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Previous" })).toBeNull();
    expect(screen.queryByText(/ \/ /)).toBeNull();
    await user.keyboard("{ArrowRight}");
    expect(onIndexChange).not.toHaveBeenCalled();
  });

  it("a new image starts fit again", async () => {
    const user = userEvent.setup();
    const { loaded, rerenderWith } = show();
    loaded();
    await user.click(screen.getByRole("button", { name: "Actual size" }));
    expect(percent()).toBe("100%");
    rerenderWith({ index: 1 });
    fireEvent.load(screen.getByRole("img", { name: "b.png" }));
    expect(percent()).toBe("50%");
  });

  it("shows the name and size, and calls download and new tab with the index", async () => {
    const user = userEvent.setup();
    const onDownload = vi.fn();
    const onOpenInNewTab = vi.fn();
    show(IMAGES, 1, { onDownload, onOpenInNewTab });
    expect(screen.getByText("b.png")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Download" }));
    expect(onDownload).toHaveBeenCalledWith(1);
    await user.click(screen.getByRole("button", { name: "Open in new tab" }));
    expect(onOpenInNewTab).toHaveBeenCalledWith(1);
  });

  it("shows the size when the image has one", () => {
    show();
    expect(screen.getByText("1.2 MB")).toBeTruthy();
  });

  it("loads no image from an unsafe source", () => {
    show([{ src: "javascript:alert(1)", name: "x.png" }]);
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.getByText("x.png")).toBeTruthy();
  });

  it("returns the focus to the opener after close", async () => {
    const user = userEvent.setup();
    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <DesignProvider locale="en">
          <BubbleAttachments
            items={[{ id: "1", kind: "image", name: "a.png", src: "/a.png" }]}
            onOpen={() => setOpen(true)}
          />
          <ImageViewer
            open={open}
            onOpenChange={setOpen}
            images={IMAGES}
            index={0}
            onIndexChange={() => {}}
            onDownload={() => {}}
            onOpenInNewTab={() => {}}
          />
        </DesignProvider>
      );
    }
    render(<Harness />);
    const opener = screen.getByRole("button", { name: "a.png" });
    await user.click(opener);
    const dialog = screen.getByRole("dialog");
    expect(dialog.contains(document.activeElement)).toBe(true);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it("a failed image shows the failure with a retry, and clears on a new source", () => {
    const onRetry = vi.fn();
    const { rerenderWith } = show(IMAGES, 0, { onRetry });
    fireEvent.error(screen.getByRole("img", { name: "a.png" }));
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("a.png");
    fireEvent.click(within(alert).getByRole("button", { name: /Retry/ }));
    expect(onRetry).toHaveBeenCalledWith(0);
    act(() => {
      rerenderWith({
        images: [{ ...IMAGES[0], src: "/a.png?retry=1" } as (typeof IMAGES)[number]],
      });
    });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("img", { name: "a.png" })).not.toBeNull();
  });

  it("a failed image has no retry when the caller gives none", () => {
    show();
    fireEvent.error(screen.getByRole("img", { name: "a.png" }));
    expect(screen.getByRole("alert")).not.toBeNull();
    expect(screen.queryByRole("button", { name: /Retry/ })).toBeNull();
  });

  it("is labelled in Chinese", () => {
    render(
      <DesignProvider locale="zh">
        <ImageViewer
          open
          onOpenChange={() => {}}
          images={IMAGES}
          index={0}
          onIndexChange={() => {}}
          onDownload={() => {}}
          onOpenInNewTab={() => {}}
        />
      </DesignProvider>,
    );
    for (const n of [
      "放大",
      "缩小",
      "实际大小",
      "适应窗口",
      "在新标签打开",
      "下载",
      "关闭",
      "下一张",
    ])
      expect(screen.getByRole("button", { name: n })).toBeTruthy();
    expect(screen.getByRole("button", { name: "上一张" })).toBeTruthy();
  });
});
