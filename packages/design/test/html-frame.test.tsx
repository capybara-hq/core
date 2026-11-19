import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { DesignProvider, HTML_DOCUMENT_SANDBOX, HtmlDocumentFrame } from "../src/index";

afterEach(cleanup);

describe("HtmlDocumentFrame (spec §6.43)", () => {
  it("fixes the sandbox and the referrer policy", () => {
    const { container } = render(
      <DesignProvider locale="zh">
        <HtmlDocumentFrame src="/api/v1/html/tok" title="季度报告.html" />
      </DesignProvider>,
    );
    const iframe = container.querySelector("iframe") as HTMLIFrameElement;
    expect(HTML_DOCUMENT_SANDBOX).toBe("allow-scripts allow-popups allow-popups-to-escape-sandbox");
    expect(iframe.getAttribute("sandbox")).toBe(HTML_DOCUMENT_SANDBOX);
    expect(iframe.getAttribute("sandbox")).not.toContain("allow-same-origin");
    expect(iframe.getAttribute("sandbox")).not.toContain("allow-top-navigation");
    expect(iframe.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(iframe.getAttribute("title")).toBe("季度报告.html");
    expect(iframe.getAttribute("src")).toBe("/api/v1/html/tok");
    expect(iframe.dataset.part).toBe("html-frame");
  });

  it("cannot be widened through extra props", () => {
    const props = {
      src: "/x",
      title: "x",
      sandbox: "allow-same-origin allow-scripts",
      referrerPolicy: "origin",
    } as unknown as { src: string; title: string };
    const { container } = render(<HtmlDocumentFrame {...props} />);
    const iframe = container.querySelector("iframe") as HTMLIFrameElement;
    expect(iframe.getAttribute("sandbox")).toBe(HTML_DOCUMENT_SANDBOX);
    expect(iframe.getAttribute("referrerpolicy")).toBe("no-referrer");
  });
});
