import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, render, screen } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BubbleAttachments,
  bubbleLooksLong,
  DesignProvider,
  Prose,
  RunDivider,
  Spinner,
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
    expect(b.querySelector('[data-part="bubble-body"]')?.firstElementChild).toBe(chip);
    const d = screen.getByTestId("d");
    expect(b.compareDocumentPosition(d)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(b.contains(d)).toBe(false);
  });

  describe("a long message collapses (acceptance item AC4)", () => {
    /** jsdom lays nothing out: every element reports a box `on` taller than its clamp. */
    const overflowing = (on: boolean) => {
      const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
      for (const [key, value] of [
        ["scrollHeight", on ? 520 : 52],
        ["clientHeight", on ? 208 : 52],
      ] as const) {
        Object.defineProperty(proto, key, { configurable: true, get: () => value });
      }
    };
    afterEach(() => {
      const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
      delete proto.scrollHeight;
      delete proto.clientHeight;
    });
    const body = (c: Element) => c.querySelector('[data-part="bubble-body"]') as HTMLElement;

    it("a short message has no control and no fade", () => {
      overflowing(false);
      const { container } = wrap(<UserBubble text="核对三月份" />);
      expect(screen.queryByRole("button", { name: "展开" })).toBeNull();
      expect(container.querySelector('[data-part="bubble-more"]')).toBeNull();
      expect(body(container).dataset.overflows).toBeUndefined();
    });

    it("a long one is clamped and toggles with aria-expanded, by keyboard too", async () => {
      overflowing(true);
      const { container } = wrap(<UserBubble text={"一行\n".repeat(20)} />);
      const b = body(container);
      expect(b.dataset.expanded).toBe("false");
      expect(b.dataset.overflows).toBe("true");
      const more = screen.getByRole("button", { name: "展开" });
      expect(more.getAttribute("aria-expanded")).toBe("false");
      expect(more.getAttribute("aria-controls")).toBe(b.id);
      // under the bubble, never inside it
      const bubble = container.querySelector('[data-part="bubble"]') as Element;
      expect(bubble.contains(more)).toBe(false);
      expect(bubble.compareDocumentPosition(more)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
      more.focus();
      await userEvent.keyboard("{Enter}");
      expect(b.dataset.expanded).toBe("true");
      expect(b.dataset.overflows).toBeUndefined();
      const less = screen.getByRole("button", { name: "收起" });
      expect(less.getAttribute("aria-expanded")).toBe("true");
      await userEvent.click(less);
      expect(b.dataset.expanded).toBe("false");
      expect(screen.getByRole("button", { name: "展开" })).toBeTruthy();
    });

    it("the clamp keeps attachments, the skill chip and details visible; pending bubbles too", () => {
      overflowing(true);
      const { container } = wrap(
        <UserBubble
          text={"参数\n".repeat(20)}
          skill="/fix-issue"
          queued
          attachments={<span data-testid="att">a.pdf</span>}
          details={<span data-testid="d">待处理</span>}
        />,
        "en",
      );
      const b = body(container);
      // the attachments and details live outside the clamped body; the chip leads it
      expect(b.contains(screen.getByTestId("att"))).toBe(false);
      expect(b.contains(screen.getByTestId("d"))).toBe(false);
      expect(b.firstElementChild?.getAttribute("data-part")).toBe("bubble-skill");
      expect(screen.getByRole("button", { name: "Show more" })).toBeTruthy();
      expect(container.querySelector('[data-queued="true"]')).not.toBeNull();
    });

    it("the server render guesses from the text, the client measurement corrects it", () => {
      const long = "第一行\n".repeat(12);
      const wide = "这是一段没有换行但非常长的消息".repeat(30);
      const short = "核对三月份\n再看四月";
      expect(bubbleLooksLong(long)).toBe(true);
      expect(bubbleLooksLong(wide)).toBe(true);
      expect(bubbleLooksLong(short)).toBe(false);
      expect(bubbleLooksLong("a".repeat(400))).toBe(false);
      const html = (text: string) =>
        renderToString(
          <DesignProvider locale="zh">
            <UserBubble text={text} />
          </DesignProvider>,
        );
      // a long message is folded in the server's HTML: the fade and 展开 from the first paint
      expect(html(long)).toContain('data-overflows="true"');
      expect(html(long)).toContain('aria-expanded="false"');
      expect(html(long)).toContain(">展开<");
      expect(html(short)).not.toContain("data-overflows");
      expect(html(short)).not.toContain("展开");
      // on the client the measurement wins: jsdom measures no overflow, so the guess goes
      overflowing(false);
      const { container } = wrap(<UserBubble text={long} />);
      expect(container.querySelector('[data-part="bubble-more"]')).toBeNull();
      expect(body(container).dataset.overflows).toBeUndefined();
    });

    it("the clamp is layout.bubble-clamp with the last prose line fading", () => {
      const css = readFileSync(
        resolve(import.meta.dirname, "../src/styles/conversation.css"),
        "utf8",
      );
      const rule = (sel: string) => {
        const at = css.indexOf(`${sel} {`);
        return at < 0 ? "" : css.slice(at, css.indexOf("}", at));
      };
      expect(rule('.cb-bubble-body[data-expanded="false"]')).toMatch(
        /max-height: var\(--cb-layout-bubble-clamp\);/,
      );
      expect(rule('.cb-bubble-body[data-expanded="false"]')).toMatch(/overflow: hidden;/);
      expect(rule('.cb-bubble-body[data-overflows="true"]')).toMatch(
        /mask-image: linear-gradient\(black calc\(100% - var\(--cb-type-prose-line\)\), transparent\);/,
      );
    });
  });

  it("sender: a message another agent sent is labelled with its sender above the bubble", () => {
    const { container } = wrap(<UserBubble text="先核对三月份" sender="整理季度经营报告" />);
    const label = container.querySelector('[data-part="bubble-sender"]') as Element;
    expect(label.textContent).toBe("来自 整理季度经营报告");
    const b = container.querySelector('[data-part="bubble"]') as Element;
    expect(label.compareDocumentPosition(b)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(b.textContent).toBe("先核对三月份");
    cleanup();
    const en = wrap(<UserBubble text="t" sender="Lead" />, "en");
    expect(en.container.querySelector('[data-part="bubble-sender"]')?.textContent).toBe(
      "From Lead",
    );
    cleanup();
    // a person's own message has no label
    const own = wrap(<UserBubble text="t" />);
    expect(own.container.querySelector('[data-part="bubble-sender"]')).toBeNull();
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

describe("the thinking row's live spinner (§6.16.5)", () => {
  it("is 16, the Spinner's default stays 12 (panel headers, background tasks)", () => {
    const { container } = wrap(<ThinkingRow seconds={2} text="…" live />);
    const icon = container.querySelector('[data-part="spinner"] svg') as SVGElement;
    expect(icon.getAttribute("width")).toBe("16");
    const tool = wrap(<Spinner />);
    expect(tool.container.querySelector('[data-part="spinner"] svg')?.getAttribute("width")).toBe(
      "12",
    );
  });
});
