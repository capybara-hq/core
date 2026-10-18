import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DesignProvider, useDesignT } from "../src/index.js";

function Probe() {
  const t = useDesignT();
  return <span data-testid="p">{t("theme.dark")}</span>;
}

describe("DesignProvider", () => {
  it("按 locale 返回文案", () => {
    const { unmount } = render(
      <DesignProvider locale="zh">
        <Probe />
      </DesignProvider>,
    );
    expect(screen.getByTestId("p").textContent).toBe("深色");
    unmount();
    render(
      <DesignProvider locale="en">
        <Probe />
      </DesignProvider>,
    );
    expect(screen.getByTestId("p").textContent).toBe("Dark");
  });
});
