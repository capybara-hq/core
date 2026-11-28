import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { DesignProvider, RightPanel, SkeletonBars } from "../src/index";
import { css, parseCss } from "./css-rules";

afterEach(cleanup);

const rules = parseCss(css("conversation-page.css"));
const padding = (selector: string) =>
  rules.find((r) => r.at === null && r.selector === selector)?.decls.padding;

/**
 * A right panel's loading shape never touches the panel's edges: the panel's own loading state
 * pads its body, and a loading shape drawn in a flush body (an embed panel loading its page) takes
 * the same inset itself.
 */
describe("RightPanel loading inset", () => {
  it("the padded body's inset is space.4", () => {
    expect(padding('.cb-rpanel-body[data-pad="pad"]')).toBe("var(--cb-space-4)");
  });

  it("a loading panel pads its body even when its ready body is flush", () => {
    const { container } = render(
      <DesignProvider locale="en">
        <RightPanel title="Browser" body="flush" state="loading" onClose={() => {}} />
      </DesignProvider>,
    );
    const body = container.querySelector('[data-part="panel-body"]');
    expect(body?.getAttribute("data-pad")).toBe("pad");
    expect(body?.querySelector('[data-part="skeleton-list"]')).not.toBeNull();
  });

  it("inset bars in a flush body take the padded body's inset", () => {
    const { container } = render(
      <DesignProvider locale="en">
        <RightPanel title="Browser" body="flush" onClose={() => {}}>
          <SkeletonBars inset />
        </RightPanel>
      </DesignProvider>,
    );
    const body = container.querySelector('[data-part="panel-body"]');
    expect(body?.getAttribute("data-pad")).toBe("flush");
    const bars = body?.querySelector('[data-part="skeleton-list"]');
    expect(bars?.getAttribute("data-inset")).toBe("pane");
    expect(padding('.cb-skeleton-list[data-inset="pane"]')).toBe(
      padding('.cb-rpanel-body[data-pad="pad"]'),
    );
  });

  it("bars without inset add no padding of their own (a padded body already insets them)", () => {
    const { container } = render(
      <DesignProvider locale="en">
        <SkeletonBars />
      </DesignProvider>,
    );
    expect(container.querySelector('[data-part="skeleton-list"]')?.hasAttribute("data-inset")).toBe(
      false,
    );
  });
});
