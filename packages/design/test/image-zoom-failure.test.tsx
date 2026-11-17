import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ImageZoom } from "../src/conversation/image-zoom";
import { DesignProvider } from "../src/provider";

const wrap = (ui: React.ReactElement) => render(<DesignProvider locale="zh">{ui}</DesignProvider>);

describe("ImageZoom failure", () => {
  it("says the image could not be loaded and offers a retry", () => {
    const retry = vi.fn();
    wrap(
      <ImageZoom
        open
        onOpenChange={() => {}}
        src="/api/v1/attachments/a/download"
        name="cat.png"
        onDownload={() => {}}
        onRetry={retry}
      />,
    );
    const img = screen.getByRole("img", { name: "cat.png" });
    fireEvent.error(img);
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("cat.png");
    fireEvent.click(screen.getByRole("button", { name: /重试/ }));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("clears the failure when a new source arrives (the retry token)", () => {
    const { rerender } = wrap(
      <ImageZoom open onOpenChange={() => {}} src="/a.png" name="cat.png" onDownload={() => {}} />,
    );
    fireEvent.error(screen.getByRole("img", { name: "cat.png" }));
    expect(screen.getByRole("alert")).not.toBeNull();
    // the caller reloads with its retry token: the new source is a new attempt
    rerender(
      <DesignProvider locale="zh">
        <ImageZoom
          open
          onOpenChange={() => {}}
          src="/a.png?retry=1"
          name="cat.png"
          onDownload={() => {}}
        />
      </DesignProvider>,
    );
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("img", { name: "cat.png" })).not.toBeNull();
  });

  it("shows no retry when the caller has none left", () => {
    wrap(
      <ImageZoom open onOpenChange={() => {}} src="/a.png" name="cat.png" onDownload={() => {}} />,
    );
    fireEvent.error(screen.getByRole("img", { name: "cat.png" }));
    expect(screen.getByRole("alert")).not.toBeNull();
    expect(screen.queryByRole("button", { name: /重试/ })).toBeNull();
  });
});
