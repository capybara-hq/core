import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesignProvider, NoPreview, SharedFilePage, TextPreview } from "../src/index";
import { describeNestedBox, findNestedBoxes } from "../src/reference/index";

afterEach(cleanup);

const wrap = (ui: React.ReactElement, locale: "zh" | "en" = "zh") =>
  render(<DesignProvider locale={locale}>{ui}</DesignProvider>);
const META = "张三 分享 · 2026-11-25 过期";

describe("SharedFilePage (spec §5.12, T14)", () => {
  it("renders the name, the meta and the file body, with Download when given", async () => {
    const onDownload = vi.fn();
    const { container } = wrap(
      <SharedFilePage
        name="季度报告.html"
        badge="HTML"
        meta={META}
        onDownload={onDownload}
        state="ready"
      >
        <TextPreview text="正文" truncated={false} />
      </SharedFilePage>,
    );
    const root = container.querySelector('[data-template="SharedFilePage"]') as HTMLElement;
    expect(root).not.toBeNull();
    expect(screen.getByRole("heading", { level: 1, name: "季度报告.html" })).toBeTruthy();
    expect(screen.getByText(META)).toBeTruthy();
    expect(screen.getByText("HTML")).toBeTruthy();
    expect(screen.getByText("正文")).toBeTruthy();
    expect(root.getAttribute("aria-busy")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "下载" }));
    expect(onDownload).toHaveBeenCalled();
    // no workspace shell, no sidebar
    expect(container.querySelector('[data-part="sidebar"], nav')).toBeNull();
  });

  it("has no Download without onDownload", () => {
    wrap(
      <SharedFilePage name="差异行.csv" badge="CSV" meta={META} state="ready">
        <TextPreview text="a,b" truncated={false} />
      </SharedFilePage>,
    );
    expect(screen.queryByRole("button", { name: "下载" })).toBeNull();
  });

  it("is busy while loading: skeleton name and meta, the loading line, no Download", () => {
    const { container } = wrap(
      <SharedFilePage name="" badge="" meta="" onDownload={() => {}} state="loading" />,
      "en",
    );
    const root = container.querySelector('[data-template="SharedFilePage"]') as HTMLElement;
    expect(root.getAttribute("aria-busy")).toBe("true");
    expect(container.querySelectorAll('[data-part="skeleton-text"]').length).toBe(2);
    expect(container.querySelector('[data-part="preview-loading"]')?.textContent).toBe(
      "Loading preview…",
    );
    expect(screen.queryByRole("button", { name: "Download" })).toBeNull();
  });

  it("draws no box inside a box", () => {
    wrap(
      <SharedFilePage name="说明.pdf" badge="PDF" meta={META} onDownload={() => {}} state="ready">
        <NoPreview
          name="说明.pdf"
          contentType="application/pdf"
          size={1024}
          onDownload={() => {}}
        />
      </SharedFilePage>,
    );
    expect(findNestedBoxes(document.body).map(describeNestedBox)).toEqual([]);
  });

  it("fills the window on the panel ground, the body taking the rest", () => {
    const css = readFileSync(resolve(import.meta.dirname, "../src/styles/templates.css"), "utf8");
    const rule = (sel: string) =>
      new RegExp(`${sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\{([^}]*)\\}`).exec(css)?.[1] ??
      "";
    expect(rule(".cb-shared-page")).toMatch(/height:\s*100dvh/);
    expect(rule(".cb-shared-page")).toMatch(/background:\s*var\(--cb-panel-2\)/);
    expect(rule(".cb-shared-body")).toMatch(/flex:\s*1/);
  });
});
