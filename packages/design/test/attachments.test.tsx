import { cleanup, createEvent, fireEvent, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AttachmentChip,
  AttachmentPreview,
  DesignProvider,
  FileButton,
  FileDrop,
  formatBytes,
} from "../src/index";

afterEach(cleanup);

const wrap = (ui: React.ReactElement, locale: "zh" | "en" = "zh") =>
  render(<DesignProvider locale={locale}>{ui}</DesignProvider>);

const png = (name = "a.png") => new File([new Uint8Array([1, 2, 3])], name, { type: "image/png" });

/** jsdom 没有 DataTransfer：拖放 / 粘贴事件带一个最小的桩。 */
const transfer = (files: File[], types = files.length > 0 ? ["Files"] : ["text/plain"]) => ({
  files,
  types,
  items: files.map((f) => ({ kind: "file", type: f.type, getAsFile: () => f })),
});

describe("formatBytes", () => {
  it("B / KB / MB", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(20 * 1024 * 1024)).toBe("20 MB");
    expect(formatBytes(1_258_291)).toBe("1.2 MB");
  });
});

describe("AttachmentChip", () => {
  it("上传中：名称、大小、进度条（0–100）", () => {
    const { container } = wrap(
      <AttachmentChip name="chart.png" size={2048} status="uploading" progress={0.42} />,
    );
    expect(screen.getByText("chart.png")).toBeTruthy();
    expect(screen.getByText("2 KB")).toBeTruthy();
    const bar = screen.getByRole("progressbar");
    expect(bar.getAttribute("aria-valuenow")).toBe("42");
    expect(bar.getAttribute("aria-valuemin")).toBe("0");
    expect(bar.getAttribute("aria-valuemax")).toBe("100");
    expect(container.querySelector('[data-status="uploading"]')).toBeTruthy();
  });

  it("就绪：没有进度条；移除按钮带文件名", async () => {
    const onRemove = vi.fn();
    wrap(<AttachmentChip name="chart.png" size={10} status="ready" onRemove={onRemove} />);
    expect(screen.queryByRole("progressbar")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "移除 chart.png" }));
    expect(onRemove).toHaveBeenCalledOnce();
  });

  it("出错：显示错误（alert），仍可移除；英文标签", async () => {
    const onRemove = vi.fn();
    const { container } = wrap(
      <AttachmentChip
        name="big.pdf"
        size={30_000_000}
        status="error"
        error="File is too large"
        onRemove={onRemove}
      />,
      "en",
    );
    expect(screen.getByRole("alert").textContent).toBe("File is too large");
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(container.querySelector('[data-status="error"]')).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Remove big.pdf" }));
    expect(onRemove).toHaveBeenCalledOnce();
  });

  it("没有 onRemove 时不显示移除按钮", () => {
    wrap(<AttachmentChip name="a.txt" size={1} status="ready" />);
    expect(screen.queryByRole("button")).toBeNull();
  });
});

describe("FileDrop", () => {
  it("拖入文件显示覆盖层；松手交给 onFiles，覆盖层消失", () => {
    const onFiles = vi.fn();
    const { container } = wrap(
      <FileDrop label="松开以添加文件" onFiles={onFiles}>
        <textarea aria-label="输入" />
      </FileDrop>,
    );
    const zone = container.querySelector(".cb-file-drop") as HTMLElement;
    expect(screen.queryByText("松开以添加文件")).toBeNull();
    const f = png();
    fireEvent.dragEnter(zone, { dataTransfer: transfer([f]) });
    expect(zone.getAttribute("data-dragging")).toBe("true");
    expect(screen.getByText("松开以添加文件")).toBeTruthy();
    const over = createEvent.dragOver(zone, { dataTransfer: transfer([f]) });
    fireEvent(zone, over);
    expect(over.defaultPrevented).toBe(true);
    fireEvent.drop(zone, { dataTransfer: transfer([f]) });
    expect(onFiles).toHaveBeenCalledWith([f]);
    expect(zone.getAttribute("data-dragging")).toBeNull();
    expect(screen.queryByText("松开以添加文件")).toBeNull();
  });

  it("子元素间移动不闪烁：进出计数归零才收起覆盖层", () => {
    const { container } = wrap(
      <FileDrop label="drop" onFiles={() => {}}>
        <textarea aria-label="输入" />
      </FileDrop>,
    );
    const zone = container.querySelector(".cb-file-drop") as HTMLElement;
    const input = screen.getByLabelText("输入");
    fireEvent.dragEnter(zone, { dataTransfer: transfer([png()]) });
    fireEvent.dragEnter(input, { dataTransfer: transfer([png()]) });
    fireEvent.dragLeave(zone, { dataTransfer: transfer([png()]) });
    expect(zone.getAttribute("data-dragging")).toBe("true");
    fireEvent.dragLeave(input, { dataTransfer: transfer([png()]) });
    expect(zone.getAttribute("data-dragging")).toBeNull();
  });

  it("拖文字不响应", () => {
    const { container } = wrap(
      <FileDrop label="drop" onFiles={() => {}}>
        <span>x</span>
      </FileDrop>,
    );
    const zone = container.querySelector(".cb-file-drop") as HTMLElement;
    fireEvent.dragEnter(zone, { dataTransfer: transfer([]) });
    expect(zone.getAttribute("data-dragging")).toBeNull();
  });

  it("粘贴含文件：交给 onFiles 并阻止默认；不含文件的粘贴照常", () => {
    const onFiles = vi.fn();
    wrap(
      <FileDrop label="drop" onFiles={onFiles}>
        <textarea aria-label="输入" />
      </FileDrop>,
    );
    const input = screen.getByLabelText("输入");
    const f = png("clip.png");
    const withFile = createEvent.paste(input, { clipboardData: transfer([f]) });
    fireEvent(input, withFile);
    expect(onFiles).toHaveBeenCalledWith([f]);
    expect(withFile.defaultPrevented).toBe(true);
    const textOnly = createEvent.paste(input, { clipboardData: transfer([]) });
    fireEvent(input, textOnly);
    expect(onFiles).toHaveBeenCalledOnce();
    expect(textOnly.defaultPrevented).toBe(false);
  });

  it("dragging 强制显示覆盖层（目录页用）", () => {
    wrap(
      <FileDrop label="松开以添加文件" onFiles={() => {}} dragging>
        <span>x</span>
      </FileDrop>,
    );
    expect(screen.getByText("松开以添加文件")).toBeTruthy();
  });

  it("disabled：拖放与粘贴都不响应", () => {
    const onFiles = vi.fn();
    const { container } = wrap(
      <FileDrop label="drop" onFiles={onFiles} disabled>
        <textarea aria-label="输入" />
      </FileDrop>,
    );
    const zone = container.querySelector(".cb-file-drop") as HTMLElement;
    fireEvent.dragEnter(zone, { dataTransfer: transfer([png()]) });
    expect(zone.getAttribute("data-dragging")).toBeNull();
    fireEvent.drop(zone, { dataTransfer: transfer([png()]) });
    fireEvent.paste(screen.getByLabelText("输入"), { clipboardData: transfer([png()]) });
    expect(onFiles).not.toHaveBeenCalled();
  });
});

describe("FileButton", () => {
  it("点按钮打开文件选择；选中的文件交给 onFiles，然后清空以便再选同一文件", async () => {
    const onFiles = vi.fn();
    const { container } = wrap(
      <FileButton label="添加文件" onFiles={onFiles} accept="image/png" multiple />,
    );
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    expect(input.accept).toBe("image/png");
    expect(input.multiple).toBe(true);
    const click = vi.spyOn(input, "click");
    await userEvent.click(screen.getByRole("button", { name: "添加文件" }));
    expect(click).toHaveBeenCalled();
    const f = png();
    await userEvent.upload(input, f);
    expect(onFiles).toHaveBeenCalledWith([f]);
    expect(input.value).toBe("");
  });

  it("disabled 时按钮禁用", () => {
    wrap(<FileButton label="添加文件" onFiles={() => {}} disabled />);
    expect(screen.getByRole("button", { name: "添加文件" })).toHaveProperty("disabled", true);
  });
});

describe("AttachmentPreview", () => {
  const HREF = "/api/v1/orgs/o1/attachments/a1/download";

  it("图片：本源路径的缩略图，新标签页打开", () => {
    wrap(<AttachmentPreview kind="image" name="chart.png" href={HREF} />);
    const link = screen.getByRole("link", { name: "chart.png" });
    expect(link.getAttribute("href")).toBe(HREF);
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    const img = screen.getByRole("img", { name: "chart.png" });
    expect(img.getAttribute("src")).toBe(HREF);
    expect(img.getAttribute("loading")).toBe("lazy");
    expect(img.getAttribute("referrerpolicy")).toBe("no-referrer");
  });

  it("文件卡片：名称与说明，没有图片", () => {
    wrap(<AttachmentPreview kind="file" name="report.pdf" meta="PDF" href={HREF} />);
    const link = screen.getByRole("link", { name: /report\.pdf/ });
    expect(link.getAttribute("href")).toBe(HREF);
    expect(screen.getByText("PDF")).toBeTruthy();
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("http(s) 绝对地址可用", () => {
    wrap(<AttachmentPreview kind="image" name="x.png" href="https://cdn.example.com/x.png" />);
    expect(screen.getByRole("img").getAttribute("src")).toBe("https://cdn.example.com/x.png");
  });

  it.each([
    "javascript:alert(1)",
    "data:image/png;base64,AAAA",
    "//evil.example.com/x.png",
    "/\\evil.example.com/x.png",
    "api/relative.png",
    "",
  ])("不安全的地址 %j：不渲染链接与图片，只显示文件名", (href) => {
    wrap(<AttachmentPreview kind="image" name="x.png" href={href} />);
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.getByText("x.png")).toBeTruthy();
  });
});
