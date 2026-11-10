import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { DesignProvider, Logo, useBrand } from "../src/index";

afterEach(cleanup);

describe("Logo with a theme brand", () => {
  it("without a brand draws the pixel capybara and CAPYBARA", () => {
    const { container } = render(
      <DesignProvider locale="en">
        <Logo wordmark />
      </DesignProvider>,
    );
    expect(container.querySelector("svg path")).not.toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText("CAPYBARA")).toBeTruthy();
  });

  it("a brand with markUrl and wordmark draws the image and the brand text", () => {
    const { container } = render(
      <DesignProvider locale="en" brand={{ markUrl: "/m.svg", wordmark: "NEON GRID" }}>
        <Logo wordmark scale={2} />
      </DesignProvider>,
    );
    const img = container.querySelector('img[src="/m.svg"]');
    expect(img).not.toBeNull();
    expect(img?.getAttribute("alt")).toBe("NEON GRID");
    expect(img?.getAttribute("height")).toBe(String(10 * 2));
    expect(container.querySelector("svg")).toBeNull();
    expect(screen.getByText("NEON GRID")).toBeTruthy();
    expect(screen.queryByText("CAPYBARA")).toBeNull();
  });

  it("the brand's wordmark is drawn only where the wordmark is (the rail has none)", () => {
    render(
      <DesignProvider locale="en" brand={{ markUrl: null, wordmark: "NEON GRID" }}>
        <Logo />
      </DesignProvider>,
    );
    expect(screen.queryByText("NEON GRID")).toBeNull();
  });

  it("a brand with only a wordmark keeps the pixel capybara; only a mark keeps CAPYBARA", () => {
    const { container, unmount } = render(
      <DesignProvider locale="en" brand={{ markUrl: null, wordmark: "NEON GRID" }}>
        <Logo wordmark />
      </DesignProvider>,
    );
    expect(container.querySelector("svg path")).not.toBeNull();
    expect(screen.getByText("NEON GRID")).toBeTruthy();
    unmount();
    const second = render(
      <DesignProvider locale="en" brand={{ markUrl: "/m.png", wordmark: null }}>
        <Logo wordmark />
      </DesignProvider>,
    );
    const img = second.container.querySelector("img");
    expect(img?.getAttribute("alt")).toBe("Logo");
    expect(screen.getByText("CAPYBARA")).toBeTruthy();
  });

  it("useBrand reads the provider's brand, null without one", () => {
    const Probe = () => <span data-testid="b">{useBrand()?.wordmark ?? "none"}</span>;
    const { unmount } = render(
      <DesignProvider locale="en">
        <Probe />
      </DesignProvider>,
    );
    expect(screen.getByTestId("b").textContent).toBe("none");
    unmount();
    render(
      <DesignProvider locale="en" brand={{ markUrl: null, wordmark: "X" }}>
        <Probe />
      </DesignProvider>,
    );
    expect(screen.getByTestId("b").textContent).toBe("X");
  });
});
