import { cleanup, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BubbleAttachments,
  DesignProvider,
  Prose,
  RunDivider,
  ThinkingRow,
  UserBubble,
} from "../src/index";

afterEach(cleanup);

const wrap = (ui: React.ReactElement, locale: "zh" | "en" = "zh") =>
  render(<DesignProvider locale={locale}>{ui}</DesignProvider>);

describe("Prose (§6.16.4)", () => {
  it("shows the cursor at the end of the text only while streaming", () => {
    const { container, rerender } = wrap(<Prose markdown={"one\n\ntwo"} streaming />);
    const cursor = container.querySelector('[data-part="cursor"]');
    expect(cursor?.getAttribute("aria-hidden")).toBe("true");
    // inside the last paragraph, right after its text
    expect(cursor?.parentElement?.textContent).toBe("two");
    rerender(
      <DesignProvider locale="zh">
        <Prose markdown={"one\n\ntwo"} />
      </DesignProvider>,
    );
    expect(container.querySelector('[data-part="cursor"]')).toBeNull();
    expect(container.querySelector('[data-part="prose"]')).not.toBeNull();
  });

  it("puts the cursor after a list or table when the text ends there", () => {
    const { container } = wrap(<Prose markdown={"- a\n- b"} streaming />);
    expect(container.querySelector('[data-part="cursor"]')).not.toBeNull();
    cleanup();
    const t = wrap(<Prose markdown={""} streaming />);
    expect(t.container.querySelector('[data-part="cursor"]')).not.toBeNull();
  });

  it("passes file paths through to the Markdown", () => {
    wrap(<Prose markdown="`a.md`" paths={new Set(["a.md"])} onOpenPath={() => {}} />);
    expect(screen.getByRole("button", { name: "a.md" })).toBeTruthy();
  });
});

describe("ThinkingRow (§6.16.5)", () => {
  it("toggles aria-expanded and shows the text when open", async () => {
    wrap(<ThinkingRow seconds={11.6} text="先查本周消息" />);
    const btn = screen.getByRole("button", { name: /思考了 12 秒/ });
    expect(btn.getAttribute("aria-expanded")).toBe("false");
    expect(btn.getAttribute("aria-controls")).toBeNull();
    expect(screen.queryByText("先查本周消息")).toBeNull();
    await userEvent.click(btn);
    expect(btn.getAttribute("aria-expanded")).toBe("true");
    const body = screen.getByText("先查本周消息");
    expect(body.getAttribute("data-part")).toBe("thinking-body");
    expect(document.getElementById(btn.getAttribute("aria-controls") ?? "")).toBe(body);
  });

  it("reads in English and falls back when the duration is unknown", () => {
    wrap(<ThinkingRow seconds={3} text="x" />, "en");
    expect(screen.getByRole("button", { name: /Thought for 3 seconds/ })).toBeTruthy();
    cleanup();
    wrap(<ThinkingRow seconds={null} text="x" />);
    expect(screen.getByRole("button", { name: /思考过程/ })).toBeTruthy();
  });

  it("is a plain line when there is no text", () => {
    wrap(<ThinkingRow seconds={2} text="" />);
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText("思考了 2 秒")).toBeTruthy();
  });

  it("live: spinner, elapsed seconds, streaming body with a cursor, no toggle", () => {
    const { container } = wrap(<ThinkingRow seconds={4} text="两种说法" live />);
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText("正在思考")).toBeTruthy();
    expect(container.textContent).toContain("4 秒");
    expect(container.querySelector('[data-part="spinner"]')).not.toBeNull();
    const body = container.querySelector('[data-part="thinking-body"]');
    expect(body?.querySelector('[data-part="cursor"]')).not.toBeNull();
  });

  it("can start open", () => {
    wrap(<ThinkingRow seconds={1} text="body" defaultOpen />);
    expect(screen.getByText("body")).toBeTruthy();
  });
});

describe("UserBubble (§6.16.6)", () => {
  it("skill: the chip before the arguments in the bubble, details under it", () => {
    const { container } = wrap(
      <UserBubble text="123" skill="/fix-issue" details={<span data-testid="d">x</span>} />,
    );
    const b = container.querySelector('[data-part="bubble"]') as Element;
    const chip = b.querySelector('[data-part="bubble-skill"]');
    expect(chip?.textContent).toBe("/fix-issue");
    expect(b.textContent).toBe("/fix-issue123");
    // the chip comes first, the arguments after it
    expect(b.firstElementChild).toBe(chip);
    const d = screen.getByTestId("d");
    expect(b.compareDocumentPosition(d)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(b.contains(d)).toBe(false);
  });

  it("skill without arguments: only the chip", () => {
    const { container } = wrap(<UserBubble text="" skill="/release-check" />);
    expect(container.querySelector('[data-part="bubble"]')?.textContent).toBe("/release-check");
  });

  it("keeps line breaks, marks the bubble and the queued form", () => {
    const { container } = wrap(<UserBubble text={"a\nb"} />);
    const b = container.querySelector('[data-part="bubble"]');
    expect(b?.textContent).toBe("a\nb");
    expect(b?.hasAttribute("data-queued")).toBe(false);
    cleanup();
    const q = wrap(<UserBubble text="q" queued />);
    expect(q.container.querySelector('[data-part="bubble"]')?.hasAttribute("data-queued")).toBe(
      true,
    );
  });

  it("renders attachments above the bubble", async () => {
    const open = vi.fn();
    const { container } = wrap(
      <UserBubble
        text="t"
        attachments={
          <BubbleAttachments
            items={[
              { id: "1", kind: "image", name: "截图.png" },
              { id: "2", kind: "file", name: "说明.pdf", type: "PDF", size: "3.8 MB" },
            ]}
            onOpen={open}
          />
        }
      />,
    );
    const thumb = container.querySelector('[data-part="thumb"]');
    const chip = container.querySelector('[data-part="attachment"]');
    expect(thumb).not.toBeNull();
    expect(chip?.textContent).toContain("说明.pdf");
    expect(chip?.textContent).toContain("3.8 MB");
    // attachments come before the bubble in document order
    const bubble = container.querySelector('[data-part="bubble"]') as Element;
    expect(thumb?.compareDocumentPosition(bubble)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    await userEvent.click(screen.getByRole("button", { name: "截图.png" }));
    expect(open).toHaveBeenCalledWith("1");
  });

  it("never loads an unsafe thumbnail source", () => {
    const { container } = wrap(
      <BubbleAttachments items={[{ id: "1", kind: "image", name: "x", src: "javascript:1" }]} />,
    );
    expect(container.querySelector("img")).toBeNull();
  });
});

describe("RunDivider (§6.16.7)", () => {
  it("is a status line between rules", () => {
    const { container } = wrap(<RunDivider kind="stopped" text="已停止 · grant 10:41" />);
    const d = screen.getByRole("status");
    expect(d.getAttribute("data-part")).toBe("run-divider");
    expect(d.getAttribute("data-kind")).toBe("stopped");
    expect(container.querySelectorAll('[data-part="divider-rule"]')).toHaveLength(2);
  });

  it("failed renders the Retry action in fail tone", async () => {
    const retry = vi.fn();
    wrap(<RunDivider kind="failed" text="运行失败：超时" action={{ onClick: retry }} />);
    expect(screen.getByRole("status").getAttribute("data-tone")).toBe("fail");
    await userEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(retry).toHaveBeenCalled();
  });

  it("compacted toggles the summary through aria-expanded", () => {
    const { container, rerender } = wrap(
      <RunDivider kind="compacted" text="已压缩" action={{ onClick: () => {}, expanded: false }} />,
    );
    const btn = screen.getByRole("button", { name: "查看摘要" });
    expect(btn.getAttribute("aria-expanded")).toBe("false");
    rerender(
      <DesignProvider locale="zh">
        <RunDivider kind="compacted" text="已压缩" action={{ onClick: () => {}, expanded: true }}>
          摘要正文
        </RunDivider>
      </DesignProvider>,
    );
    expect(screen.getByRole("button", { name: "收起摘要" }).getAttribute("aria-expanded")).toBe(
      "true",
    );
    expect(container.querySelector('[data-part="divider-summary"]')?.textContent).toBe("摘要正文");
  });

  it("hook-denied is fail toned, fallback is not", () => {
    wrap(<RunDivider kind="hook-denied" text="x" />);
    expect(screen.getByRole("status").getAttribute("data-tone")).toBe("fail");
    cleanup();
    wrap(<RunDivider kind="fallback" text="x" />);
    expect(screen.getByRole("status").getAttribute("data-tone")).toBeNull();
  });
});
