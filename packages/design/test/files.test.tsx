import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AttachmentStrip,
  CsvPreview,
  DesignProvider,
  FileCard,
  FileChip,
  FileOutputs,
  FilePreviewFrame,
  type FilePreviewHeader,
  ImageOutput,
  ImagePreview,
  isInlineImageType,
  isSafeImageSrc,
  LoadFailed,
  MarkdownPreview,
  middleTruncate,
  NoPreview,
  parseCsv,
  TextOutput,
  TextPreview,
  typeBadge,
} from "../src/index";

afterEach(cleanup);

const wrap = (ui: React.ReactElement, locale: "zh" | "en" = "zh") =>
  render(<DesignProvider locale={locale}>{ui}</DesignProvider>);

const chars = (s: string) => [...s].length;

describe("middleTruncate", () => {
  it("keeps the extension and the length", () => {
    const name = "一个非常长的季度经营数据汇总与差异逐项核对明细示例表.xlsx";
    const out = middleTruncate(name, 24);
    expect(out.endsWith(".xlsx")).toBe(true);
    expect(chars(out)).toBe(24);
    expect(out).toContain("…");
    expect(out.startsWith("一个非常长")).toBe(true);
  });

  it("leaves short names alone and handles names without an extension", () => {
    expect(middleTruncate("a.xlsx", 24)).toBe("a.xlsx");
    const out = middleTruncate("x".repeat(50), 10);
    expect(chars(out)).toBe(10);
    expect(out).toContain("…");
  });

  it("does not keep an absurd extension", () => {
    const out = middleTruncate(`a.${"b".repeat(40)}`, 12);
    expect(chars(out)).toBe(12);
  });

  it("counts code points, not UTF-16 units", () => {
    const out = middleTruncate(`${"😀".repeat(30)}.png`, 10);
    expect(chars(out)).toBe(10);
    expect(out.endsWith(".png")).toBe(true);
  });
});

describe("typeBadge", () => {
  it("names the type from the extension, else the content type, else FILE", () => {
    expect(typeBadge("a.tar.gz", "application/gzip")).toBe("GZ");
    expect(typeBadge("报告.xlsx", "")).toBe("XLSX");
    expect(typeBadge("readme.md", "text/markdown")).toBe("MD");
    expect(typeBadge("noext", "image/png")).toBe("PNG");
    expect(typeBadge("noext", "application/pdf")).toBe("PDF");
    expect(typeBadge("noext", "application/octet-stream")).toBe("FILE");
    expect(typeBadge("weird.<script>", "")).toBe("FILE");
    expect(typeBadge(".bashrc", "")).toBe("FILE");
  });
});

describe("image rules", () => {
  it("only bitmaps render inline, never SVG", () => {
    expect(isInlineImageType("image/png")).toBe(true);
    expect(isInlineImageType("image/webp; charset=binary")).toBe(true);
    expect(isInlineImageType("image/svg+xml")).toBe(false);
    expect(isInlineImageType("text/html")).toBe(false);
  });

  it("image sources: http(s), same-origin paths and blob: only", () => {
    expect(isSafeImageSrc("/api/orgs/o/conversations/c/artifacts/a/download?inline=1")).toBe(true);
    expect(isSafeImageSrc("blob:https://app.example/1b2c")).toBe(true);
    expect(isSafeImageSrc("javascript:alert(1)")).toBe(false);
    expect(isSafeImageSrc("data:image/svg+xml,<svg/>")).toBe(false);
    expect(isSafeImageSrc("//evil.example/x.png")).toBe(false);
  });
});

describe("FileCard (§6.16.19)", () => {
  it("is a button with the badge, the middle-truncated name, the size and a chevron", async () => {
    const onOpen = vi.fn();
    const name = `${"很长的名字".repeat(10)}末尾.xlsx`;
    const { container } = wrap(
      <FileCard name={name} contentType="" size={48 * 1024} onOpen={onOpen} />,
    );
    const card = container.querySelector('[data-part="file-card"]') as HTMLElement;
    expect(card.tagName).toBe("BUTTON");
    expect(card.getAttribute("title")).toBe(name);
    expect(container.querySelector('[data-part="type-badge"]')?.textContent).toBe("XLSX");
    expect(container.querySelector('[data-part="file-name"]')?.textContent?.endsWith(".xlsx")).toBe(
      true,
    );
    expect(card.textContent).toContain("48 KB");
    await userEvent.click(card);
    expect(onOpen).toHaveBeenCalled();
  });

  it("removed: not clickable, struck through, the reason instead of the size", () => {
    const { container } = wrap(
      <FileCard
        name="8月差异明细.xlsx"
        contentType=""
        size={51 * 1024}
        removed={{ reason: "文件已不可用" }}
        onOpen={() => {}}
      />,
    );
    const card = container.querySelector('[data-part="file-card"]') as HTMLElement;
    expect(card.getAttribute("data-removed")).toBe("true");
    expect(card.tagName).not.toBe("BUTTON");
    expect(screen.queryByRole("button")).toBeNull();
    expect(container.querySelector('[data-part="file-name"]')?.tagName).toBe("S");
    expect(card.textContent).toContain("文件已不可用");
    expect(card.textContent).not.toContain("51 KB");
  });
});

describe("FileOutputs (§6.16.20)", () => {
  const files = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      id: `f${i}`,
      name: `文件${i}.csv`,
      contentType: "text/csv",
      size: 1024 * (i + 1),
    }));

  it("shows up to 4 cards in two columns", () => {
    const { container } = wrap(<FileOutputs files={files(4)} onOpen={() => {}} />);
    expect(container.querySelector('[data-part="file-grid"]')).not.toBeNull();
    expect(container.querySelectorAll('[data-part="file-card"]').length).toBe(4);
    expect(container.querySelector('[data-part="file-more"]')).toBeNull();
  });

  it("past 4, the first 3 and a card for the rest", async () => {
    const onMore = vi.fn();
    const onOpen = vi.fn();
    const { container } = wrap(<FileOutputs files={files(6)} onOpen={onOpen} onMore={onMore} />);
    expect(container.querySelectorAll('[data-part="file-card"]').length).toBe(3);
    const more = screen.getByRole("button", { name: /还有 3 个文件/ });
    expect(more.getAttribute("data-part")).toBe("file-more");
    await userEvent.click(more);
    expect(onMore).toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: /文件1\.csv/ }));
    expect(onOpen).toHaveBeenCalledWith("f1");
  });

  it("a single file is one card, no grid", () => {
    const { container } = wrap(<FileOutputs files={files(1)} onOpen={() => {}} />);
    expect(container.querySelector('[data-part="file-grid"]')).toBeNull();
    expect(container.querySelectorAll('[data-part="file-card"]').length).toBe(1);
  });
});

describe("ImageOutput and TextOutput (§6.16.20)", () => {
  it("shows the image with enlarge and download, and its dimensions once loaded", async () => {
    const onOpen = vi.fn();
    const onDownload = vi.fn();
    const { container } = wrap(
      <ImageOutput
        src="/x.png?inline=1"
        name="趋势.png"
        size={84 * 1024}
        onOpen={onOpen}
        onDownload={onDownload}
      />,
    );
    const img = container.querySelector("img") as HTMLImageElement;
    expect(img.getAttribute("src")).toBe("/x.png?inline=1");
    expect(container.textContent).toContain("趋势.png");
    expect(container.textContent).not.toContain("×");
    Object.defineProperty(img, "naturalWidth", { value: 1280 });
    Object.defineProperty(img, "naturalHeight", { value: 720 });
    fireEvent.load(img);
    expect(container.textContent).toContain(" · 1280×720 · 84 KB");
    await userEvent.click(screen.getByRole("button", { name: "放大" }));
    await userEvent.click(screen.getByRole("button", { name: "下载" }));
    expect(onOpen).toHaveBeenCalled();
    expect(onDownload).toHaveBeenCalled();
  });

  it("never loads an unsafe source", () => {
    const { container } = wrap(
      <ImageOutput
        src="javascript:alert(1)"
        name="x.png"
        size={1}
        onOpen={() => {}}
        onDownload={() => {}}
      />,
    );
    expect(container.querySelector("img")).toBeNull();
  });

  it("text outputs are plain text, never HTML", async () => {
    const onOpen = vi.fn();
    const { container } = wrap(
      <TextOutput
        name="a.md"
        contentType="text/markdown"
        size={6 * 1024}
        head={"# 标题\n<script>alert(1)</script><b>x</b>"}
        onOpen={onOpen}
      />,
    );
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("b")).toBeNull();
    const body = container.querySelector('[data-part="text-output-body"]');
    expect(body?.textContent).toBe("# 标题\n<script>alert(1)</script><b>x</b>");
    await userEvent.click(screen.getByRole("button", { name: /打开/ }));
    expect(onOpen).toHaveBeenCalled();
  });
});

describe("FileChip", () => {
  it("is a mono chip that opens the file", async () => {
    const onOpen = vi.fn();
    wrap(<FileChip path="reports/a.xlsx" onOpen={onOpen} />);
    const chip = screen.getByRole("button", { name: "reports/a.xlsx" });
    expect(chip.getAttribute("data-part")).toBe("file-chip");
    await userEvent.click(chip);
    expect(onOpen).toHaveBeenCalled();
  });
});

describe("AttachmentStrip (§6.16.21)", () => {
  it("thumbnails, file chips, progress and rejections, each removable", async () => {
    const remove = vi.fn();
    const { container } = wrap(
      <AttachmentStrip
        items={[
          {
            id: "i",
            kind: "image",
            name: "截图.png",
            size: 1024,
            src: "blob:https://a/1",
            onRemove: () => remove("i"),
          },
          {
            id: "f",
            kind: "file",
            name: "说明.pdf",
            contentType: "application/pdf",
            size: 3_984_588,
            onRemove: () => remove("f"),
          },
          { id: "u", kind: "file", name: "流水.xlsx", contentType: "", size: 10, progress: 0.62 },
          {
            id: "r",
            kind: "file",
            name: "凭证.zip",
            contentType: "",
            size: 10,
            error: "超过 50 MB",
            onRemove: () => remove("r"),
          },
        ]}
      />,
    );
    expect(container.querySelector('[data-part="thumb"] img')?.getAttribute("src")).toBe(
      "blob:https://a/1",
    );
    const bar = screen.getByRole("progressbar");
    expect(bar.getAttribute("aria-valuenow")).toBe("62");
    expect(container.textContent).toContain("62%");
    const rejected = container.querySelector('[data-state="rejected"]') as HTMLElement;
    expect(rejected.textContent).toContain("超过 50 MB");
    expect(container.textContent).toContain("3.8 MB");
    await userEvent.click(screen.getByRole("button", { name: "移除 截图.png" }));
    await userEvent.click(screen.getByRole("button", { name: "移除 说明.pdf" }));
    await userEvent.click(screen.getByRole("button", { name: "移除 凭证.zip" }));
    expect(remove.mock.calls).toEqual([["i"], ["f"], ["r"]]);
  });
});

const header = (over: Partial<FilePreviewHeader> = {}): FilePreviewHeader => ({
  badge: "CSV",
  name: "差异行.csv",
  version: "v1 · 刚刚",
  onDownload: () => {},
  onFullscreen: () => {},
  onClose: () => {},
  ...over,
});

describe("FilePreviewFrame (§6.16.22)", () => {
  it("header: badge, name, version, download, full screen, close; never Share", async () => {
    const onClose = vi.fn();
    const { container } = wrap(
      <FilePreviewFrame header={header({ onClose })} state="ready">
        <TextPreview text="x" truncated={false} />
      </FilePreviewFrame>,
    );
    expect(container.querySelector('[data-part="right-panel"]')).not.toBeNull();
    expect(screen.getByText("v1 · 刚刚")).toBeTruthy();
    expect(screen.getByRole("button", { name: "下载" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "全屏" })).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "关闭" }));
    expect(onClose).toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: /分享|Share/ })).toBeNull();
    expect(container.textContent).not.toMatch(/分享|Share/);
    // no switcher without files
    expect(screen.queryByRole("button", { name: /差异行\.csv/ })).toBeNull();
    expect(screen.getByText("差异行.csv")).toBeTruthy();
  });

  it("has no Share in English either", () => {
    const { container } = wrap(
      <FilePreviewFrame
        header={header({ files: [{ id: "a", name: "a.csv" }], onSwitch: () => {} })}
        state="ready"
      />,
      "en",
    );
    expect(container.textContent).not.toMatch(/Share/);
  });

  it("the file switcher appears with files", () => {
    wrap(
      <FilePreviewFrame
        header={header({
          files: [
            { id: "a", name: "差异行.csv" },
            { id: "b", name: "对账报告.md" },
          ],
          onSwitch: () => {},
        })}
        state="ready"
      />,
    );
    const sw = screen.getByRole("button", { name: /差异行\.csv/ });
    expect(sw.getAttribute("aria-haspopup")).toBe("menu");
  });

  it("the previewer switch appears only when more than one previewer applies", () => {
    wrap(
      <FilePreviewFrame
        header={header({
          previewers: [
            { id: "x", title: "表格预览" },
            { id: "builtin:csv", title: "内置" },
          ],
          previewer: "x",
          onPreviewer: () => {},
        })}
        state="ready"
      />,
    );
    expect(screen.getByRole("button", { name: /表格预览/ })).toBeTruthy();
    cleanup();
    wrap(
      <FilePreviewFrame
        header={header({ previewers: [{ id: "x", title: "表格预览" }], previewer: "x" })}
        state="ready"
      />,
    );
    expect(screen.queryByRole("button", { name: /表格预览/ })).toBeNull();
  });

  it("failed: the load-failure line with Retry, in the panel only", async () => {
    const onRetry = vi.fn();
    const { container } = wrap(
      <FilePreviewFrame
        header={header()}
        state="failed"
        onRetry={onRetry}
        failure={{ name: "预览", reason: "10 秒内没有响应" }}
      >
        <NoPreview name="a.pdf" contentType="application/pdf" size={1024} onDownload={() => {}} />
      </FilePreviewFrame>,
    );
    expect(container.querySelector('[data-part="load-failed-title"]')?.textContent).toBe(
      "预览 加载失败",
    );
    await userEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(onRetry).toHaveBeenCalled();
    expect(container.querySelector('[data-part="no-preview"]')).not.toBeNull();
  });

  it("loading is busy", () => {
    const { container } = wrap(<FilePreviewFrame header={header()} state="loading" />);
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
  });
});

describe("Built-in previewers", () => {
  it("text is shown as text", () => {
    const { container } = wrap(
      <TextPreview text={"<img src=x onerror=alert(1)>\nline 2"} truncated />,
    );
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector('[data-part="preview-text"]')?.textContent).toBe(
      "<img src=x onerror=alert(1)>\nline 2",
    );
    expect(container.textContent).toContain("只显示了文件开头");
  });

  it("Markdown goes through the design Markdown: no raw HTML", () => {
    const { container } = wrap(<MarkdownPreview text={"# 标题\n\n<script>alert(1)</script>"} />);
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("h3")?.textContent).toBe("标题");
    expect(container.querySelector('[data-part="prose"]')).not.toBeNull();
  });

  it("images: bitmaps only", () => {
    const { container } = wrap(<ImagePreview src="/a.png?inline=1" name="a.png" />);
    expect(container.querySelector('[data-part="preview-image"] img')).not.toBeNull();
    cleanup();
    const bad = wrap(<ImagePreview src="javascript:x" name="a.png" />);
    expect(bad.container.querySelector("img")).toBeNull();
  });

  it("no preview: the card with Download", async () => {
    const onDownload = vi.fn();
    const { container } = wrap(
      <NoPreview
        name="a.pdf"
        contentType="application/pdf"
        size={3_984_588}
        onDownload={onDownload}
      />,
    );
    expect(container.textContent).toContain("3.8 MB · 没有可用的预览");
    await userEvent.click(screen.getByRole("button", { name: "下载" }));
    expect(onDownload).toHaveBeenCalled();
  });

  it("LoadFailed stands alone", () => {
    wrap(<LoadFailed name="待办" reason="r" onRetry={() => {}} />);
    expect(screen.getByRole("alert").textContent).toContain("待办 加载失败");
  });
});

describe("CSV (RFC 4180)", () => {
  it("parses quoted commas, quotes and newlines", () => {
    expect(parseCsv('a,b\n"x, y","he said ""hi"""\n"multi\nline",2\r\n', ",")).toEqual([
      ["a", "b"],
      ["x, y", 'he said "hi"'],
      ["multi\nline", "2"],
    ]);
    expect(parseCsv("a\tb\n1\t2", "\t")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("caps the rows and says how many there are", () => {
    const rows = ["n,v", ...Array.from({ length: 501 }, (_, i) => `${i},x`)].join("\n");
    const { container } = wrap(<CsvPreview text={rows} delimiter="," />);
    expect(container.querySelectorAll("tbody tr").length).toBe(500);
    expect(container.querySelector('[data-part="preview-note"]')?.textContent).toBe(
      "显示前 500 行 · 共 501 行",
    );
  });

  it("right-aligns numeric columns and renders cells as text", () => {
    const { container } = wrap(
      <CsvPreview text={"name,amount\n<b>a</b>,−1,240.00\nb,+31.20"} delimiter="," maxRows={10} />,
    );
    expect(container.querySelector("b")).toBeNull();
    const head = container.querySelectorAll("th");
    expect(head[1]?.getAttribute("data-align")).toBe("right");
    expect(head[0]?.getAttribute("data-align")).toBeNull();
    expect(container.querySelector('[data-part="preview-note"]')).toBeNull();
  });
});
