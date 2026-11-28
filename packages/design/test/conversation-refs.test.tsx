import { cleanup, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AttachmentStrip,
  BubbleAttachments,
  DesignProvider,
  type LinkComponent,
} from "../src/index";

// Referenced conversations (at-conversation spec §3; design spec §6.16.6, §6.16.21).

afterEach(cleanup);

const wrap = (ui: ReactNode, o: { locale?: "zh" | "en"; link?: LinkComponent } = {}) =>
  render(
    <DesignProvider locale={o.locale ?? "zh"} {...(o.link ? { link: o.link } : {})}>
      {ui}
    </DesignProvider>,
  );

describe("AttachmentStrip conversation chip (§6.16.21)", () => {
  it("draws the chats icon named 会话 and the title, removable, with no size", async () => {
    const remove = vi.fn();
    const { container } = wrap(
      <AttachmentStrip
        items={[{ id: "c1", kind: "conversation", name: "定价方案讨论", onRemove: remove }]}
      />,
    );
    const chip = container.querySelector('[data-part="attachment"]') as HTMLElement;
    expect(chip.dataset.kind).toBe("conversation");
    expect(chip.dataset.state).toBe("ready");
    expect(chip.querySelector('[data-icon="chats"]')).not.toBeNull();
    expect(screen.getByRole("img", { name: "会话" })).toBeTruthy();
    const title = chip.querySelector('[data-part="attachment-name"]') as HTMLElement;
    expect(title.textContent).toBe("定价方案讨论");
    expect(title.getAttribute("title")).toBe("定价方案讨论");
    expect(chip.querySelector(".cb-type-badge")).toBeNull();
    expect(chip.querySelector(".cb-muted")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "移除 定价方案讨论" }));
    expect(remove).toHaveBeenCalledOnce();
  });

  it("a refused conversation takes the rejected look with the page's reason and stays removable", async () => {
    const remove = vi.fn();
    const { container } = wrap(
      <AttachmentStrip
        items={[
          {
            id: "c2",
            kind: "conversation",
            name: "旧版报价单整理",
            error: "会话已不可用",
            onRemove: remove,
          },
        ]}
      />,
    );
    const chip = container.querySelector('[data-kind="conversation"]') as HTMLElement;
    expect(chip.dataset.state).toBe("rejected");
    expect(screen.getByRole("alert").textContent).toBe("会话已不可用");
    await userEvent.click(screen.getByRole("button", { name: "移除 旧版报价单整理" }));
    expect(remove).toHaveBeenCalledOnce();
  });

  it("an untitled conversation reads Untitled conversation", () => {
    wrap(<AttachmentStrip items={[{ id: "c3", kind: "conversation", name: "" }]} />, {
      locale: "en",
    });
    expect(screen.getByText("Untitled conversation")).toBeTruthy();
    expect(screen.getByRole("img", { name: "Conversation" })).toBeTruthy();
  });
});

describe("BubbleAttachments conversation link chip (§6.16.6)", () => {
  it("is a link through the provider's link, named 打开会话 <title>, with no download button", () => {
    const seen: string[] = [];
    const Link: LinkComponent = ({ href, children, replace: _r, ...rest }) => {
      seen.push(href);
      return (
        <a href={href} data-provider-link="true" {...rest}>
          {children}
        </a>
      );
    };
    const { container } = wrap(
      <BubbleAttachments
        items={[
          { id: "f", kind: "file", name: "a.pdf", type: "PDF" },
          { id: "c1", kind: "conversation", name: "定价方案讨论", href: "/chat/c1" },
        ]}
        onOpen={vi.fn()}
        onDownload={vi.fn()}
      />,
      { link: Link },
    );
    const link = screen.getByRole("link", { name: "打开会话 定价方案讨论" });
    expect(link.getAttribute("href")).toBe("/chat/c1");
    expect(link.dataset.providerLink).toBe("true");
    expect(link.dataset.kind).toBe("conversation");
    expect(link.querySelector('[data-icon="chats"]')).not.toBeNull();
    expect(seen).toEqual(["/chat/c1"]);
    // only the uploaded file has a download button
    expect(screen.getAllByRole("button", { name: "下载" })).toHaveLength(1);
    // files and conversations keep the page's order
    const parts = [...container.querySelectorAll('[data-part="attachment"]')].map(
      (e) => e.textContent,
    );
    expect(parts).toEqual(["PDFa.pdf", "定价方案讨论"]);
  });

  it("an untitled conversation reads 未命名会话; an unsafe href draws plain text", () => {
    wrap(
      <BubbleAttachments
        items={[
          { id: "c1", kind: "conversation", name: "", href: "/chat/c1" },
          { id: "c2", kind: "conversation", name: "坏链接", href: "javascript:alert(1)" },
        ]}
      />,
    );
    expect(screen.getByRole("link", { name: "打开会话 未命名会话" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: /坏链接/ })).toBeNull();
    expect(screen.getByText("坏链接").closest('[data-kind="conversation"]')).not.toBeNull();
  });

  it("the compact form marks the column so the chip takes its own line and its title wraps", () => {
    const { container } = wrap(
      <BubbleAttachments
        form="compact"
        items={[{ id: "c1", kind: "conversation", name: "很长的标题", href: "/chat/c1" }]}
      />,
    );
    const column = container.querySelector(".cb-bubble-atts") as HTMLElement;
    expect(column.dataset.form).toBe("compact");
  });

  it("without a form prop the column carries no form", () => {
    const { container } = wrap(
      <BubbleAttachments items={[{ id: "c1", kind: "conversation", name: "t", href: "/c" }]} />,
    );
    expect((container.querySelector(".cb-bubble-atts") as HTMLElement).dataset.form).toBe(
      undefined,
    );
  });
});
