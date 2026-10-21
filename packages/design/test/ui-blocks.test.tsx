import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Card, ImageBlock } from "../src/index";

afterEach(cleanup);

describe("Card tone accent（待人处理的对话卡片）", () => {
  it("tone=accent 时带 data-tone=accent", () => {
    const { container } = render(<Card tone="accent" title="审批" />);
    expect(container.querySelector(".cb-card")?.getAttribute("data-tone")).toBe("accent");
  });
});

describe("ImageBlock（插件视图里的图片）", () => {
  it("渲染带 alt 的图片，宽度不超出容器；不带 referrer", () => {
    render(<ImageBlock src="https://example.com/a.png" alt="Diagram" />);
    const img = screen.getByRole("img", { name: "Diagram" });
    expect(img.getAttribute("src")).toBe("https://example.com/a.png");
    expect(img.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(img.getAttribute("loading")).toBe("lazy");
    expect(img.className).toBe("cb-image");
  });

  it.each(["javascript:alert(1)", "data:image/svg+xml,<svg/>", "/relative.png", "not a url"])(
    "不是 http(s) 绝对地址时什么都不渲染：%s",
    (src) => {
      const { container } = render(<ImageBlock src={src} alt="x" />);
      expect(container.querySelector("img")).toBeNull();
    },
  );
});
