import { cleanup, render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BubbleAttachments, DesignProvider, ImageZoom } from "../src/index";

afterEach(cleanup);

/** The user bubble's attachments plus the zoom the caller opens from a thumbnail (§5.6). */
function Harness({ onDownload }: { onDownload(): void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <BubbleAttachments
        items={[
          { id: "1", kind: "image", name: "截图.png", src: "/a.png" },
          { id: "2", kind: "file", name: "电商工行.xlsx", type: "XLSX", size: "1.2 MB" },
        ]}
        onOpen={(id) => {
          if (id === "1") setOpen(true);
        }}
      />
      <ImageZoom
        open={open}
        onOpenChange={setOpen}
        src="/a.png"
        name="截图.png"
        size="1.2 MB"
        onDownload={onDownload}
      />
    </>
  );
}

const wrap = (ui: React.ReactElement) => render(<DesignProvider locale="en">{ui}</DesignProvider>);

describe("ImageZoom (§5.6)", () => {
  it("opens on the thumbnail, shows the name and size, closes on Escape and downloads", async () => {
    const user = userEvent.setup();
    const onDownload = vi.fn();
    wrap(<Harness onDownload={onDownload} />);
    const thumb = screen.getByRole("button", { name: "截图.png" });
    await user.click(thumb);
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("截图.png")).toBeTruthy();
    expect(within(dialog).getByText("1.2 MB")).toBeTruthy();
    // the image fills the frame, loaded from the same source as the thumbnail
    const img = within(dialog).getByRole("img", { name: "截图.png" });
    expect(img.getAttribute("src")).toBe("/a.png");
    await user.click(within(dialog).getByRole("button", { name: "Download" }));
    expect(onDownload).toHaveBeenCalledTimes(1);
    // the dialog's own close button (overlay.close) is there beside the download action
    expect(within(dialog).getByRole("button", { name: "Close" })).toBeTruthy();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    // the focus returns to the thumbnail that opened the zoom
    expect(document.activeElement).toBe(thumb);
  });

  it("closes with its close button, and never loads an unsafe source", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    wrap(
      <ImageZoom
        open
        onOpenChange={onOpenChange}
        src="javascript:1"
        name="x.png"
        onDownload={() => {}}
      />,
    );
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).queryByRole("img")).toBeNull();
    expect(within(dialog).getByText("x.png")).toBeTruthy();
    await user.click(within(dialog).getByRole("button", { name: "Close" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("closes on a click outside the frame (the scrim)", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    wrap(
      <ImageZoom
        open
        onOpenChange={onOpenChange}
        src="/a.png"
        name="x.png"
        onDownload={() => {}}
      />,
    );
    const scrim = document.querySelector(".cb-scrim");
    expect(scrim).not.toBeNull();
    await user.click(scrim as Element);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("a file chip shows its size after the type badge and the name", () => {
    wrap(
      <BubbleAttachments
        items={[{ id: "2", kind: "file", name: "电商工行.xlsx", type: "XLSX", size: "1.2 MB" }]}
      />,
    );
    const chip = screen.getByRole("button", { name: /电商工行\.xlsx/ });
    expect(chip.textContent).toBe("XLSX电商工行.xlsx1.2 MB");
  });
});
