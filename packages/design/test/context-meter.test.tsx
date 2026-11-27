import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ContextMeter, DesignProvider } from "../src/index";

afterEach(cleanup);

const wrap = (ui: React.ReactElement) => render(<DesignProvider locale="zh">{ui}</DesignProvider>);

describe("ContextMeter", () => {
  it("renders a meter with aria-valuenow 43 and label 上下文已用 43%", () => {
    wrap(<ContextMeter pct={43} />);
    const m = screen.getByRole("meter");
    expect(m.getAttribute("aria-valuenow")).toBe("43");
    expect(m.getAttribute("aria-valuemin")).toBe("0");
    expect(m.getAttribute("aria-valuemax")).toBe("100");
    expect(m.getAttribute("aria-label")).toBe("上下文已用 43%");
    expect(m.getAttribute("data-part")).toBe("composer-context-meter");
    expect(m.getAttribute("data-tone")).toBeNull();
  });

  it("clamps 140 to 100", () => {
    wrap(<ContextMeter pct={140} />);
    expect(screen.getByRole("meter").getAttribute("aria-valuenow")).toBe("100");
  });

  it("over sets data-tone fail", () => {
    wrap(<ContextMeter pct={86} over />);
    expect(screen.getByRole("meter").getAttribute("data-tone")).toBe("fail");
  });
});
