import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type Brand, DesignProvider, Logo, useBrand } from "../src/index";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** A brand with only the given parts (the rest null, the decoration the default). */
const brand = (parts: Partial<Brand>): Brand => ({
  markUrl: null,
  wordmark: null,
  illustrationUrl: null,
  decoration: "dither",
  productName: null,
  ...parts,
});

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
      <DesignProvider
        locale="en"
        brand={brand({ markUrl: "/m.svg", wordmark: "NEON GRID", productName: null })}
      >
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
      <DesignProvider
        locale="en"
        brand={brand({ markUrl: null, wordmark: "NEON GRID", productName: null })}
      >
        <Logo />
      </DesignProvider>,
    );
    expect(screen.queryByText("NEON GRID")).toBeNull();
  });

  it("a brand with only a wordmark keeps the pixel capybara; only a mark keeps CAPYBARA", () => {
    const { container, unmount } = render(
      <DesignProvider
        locale="en"
        brand={brand({ markUrl: null, wordmark: "NEON GRID", productName: null })}
      >
        <Logo wordmark />
      </DesignProvider>,
    );
    expect(container.querySelector("svg path")).not.toBeNull();
    expect(screen.getByText("NEON GRID")).toBeTruthy();
    unmount();
    const second = render(
      <DesignProvider
        locale="en"
        brand={brand({ markUrl: "/m.png", wordmark: null, productName: null })}
      >
        <Logo wordmark />
      </DesignProvider>,
    );
    const img = second.container.querySelector("img");
    expect(img?.getAttribute("alt")).toBe("Logo");
    expect(screen.getByText("CAPYBARA")).toBeTruthy();
  });

  it("the mark's alt is the product name when the brand carries one; the wordmark stays the theme's", () => {
    const { container } = render(
      <DesignProvider
        locale="en"
        brand={brand({ markUrl: "/m.svg", wordmark: null, productName: "Acme Agents" })}
      >
        <Logo wordmark />
      </DesignProvider>,
    );
    expect(container.querySelector("img")?.getAttribute("alt")).toBe("Acme Agents");
    expect(screen.getByText("CAPYBARA")).toBeTruthy();
    expect(screen.queryByText("Acme Agents")).toBeNull();
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
      <DesignProvider
        locale="en"
        brand={brand({ markUrl: null, wordmark: "X", productName: null })}
      >
        <Probe />
      </DesignProvider>,
    );
    expect(screen.getByTestId("b").textContent).toBe("X");
  });

  it("without a brand the DOM equals today's", () => {
    const { container } = render(
      <DesignProvider locale="en">
        <Logo wordmark />
        <Logo scale={2} tone="muted" />
      </DesignProvider>,
    );
    expect(container.innerHTML).toMatchInlineSnapshot(
      `"<span class="cb-logo" data-tone="accent"><svg width="42" height="30" viewBox="0 0 42 30" shape-rendering="crispEdges" aria-hidden="true" focusable="false"><path d="M30 0h3v3h-3zM27 3h3v3h-3zM30 3h3v3h-3zM33 3h3v3h-3zM9 6h3v3h-3zM12 6h3v3h-3zM15 6h3v3h-3zM18 6h3v3h-3zM21 6h3v3h-3zM24 6h3v3h-3zM27 6h3v3h-3zM30 6h3v3h-3zM33 6h3v3h-3zM36 6h3v3h-3zM39 6h3v3h-3zM6 9h3v3h-3zM9 9h3v3h-3zM12 9h3v3h-3zM15 9h3v3h-3zM18 9h3v3h-3zM21 9h3v3h-3zM24 9h3v3h-3zM27 9h3v3h-3zM30 9h3v3h-3zM36 9h3v3h-3zM39 9h3v3h-3zM3 12h3v3h-3zM6 12h3v3h-3zM9 12h3v3h-3zM12 12h3v3h-3zM15 12h3v3h-3zM18 12h3v3h-3zM21 12h3v3h-3zM24 12h3v3h-3zM27 12h3v3h-3zM30 12h3v3h-3zM33 12h3v3h-3zM36 12h3v3h-3zM39 12h3v3h-3zM3 15h3v3h-3zM6 15h3v3h-3zM9 15h3v3h-3zM12 15h3v3h-3zM15 15h3v3h-3zM18 15h3v3h-3zM21 15h3v3h-3zM24 15h3v3h-3zM27 15h3v3h-3zM30 15h3v3h-3zM33 15h3v3h-3zM36 15h3v3h-3zM39 15h3v3h-3zM3 18h3v3h-3zM6 18h3v3h-3zM9 18h3v3h-3zM12 18h3v3h-3zM15 18h3v3h-3zM18 18h3v3h-3zM21 18h3v3h-3zM24 18h3v3h-3zM27 18h3v3h-3zM30 18h3v3h-3zM33 18h3v3h-3zM36 18h3v3h-3zM6 21h3v3h-3zM9 21h3v3h-3zM12 21h3v3h-3zM15 21h3v3h-3zM18 21h3v3h-3zM21 21h3v3h-3zM24 21h3v3h-3zM27 21h3v3h-3zM30 21h3v3h-3zM33 21h3v3h-3zM6 24h3v3h-3zM9 24h3v3h-3zM18 24h3v3h-3zM27 24h3v3h-3zM30 24h3v3h-3zM6 27h3v3h-3zM9 27h3v3h-3zM18 27h3v3h-3zM27 27h3v3h-3zM30 27h3v3h-3z"></path></svg><span class="cb-logo-word">CAPYBARA</span></span><span class="cb-logo" data-tone="muted"><svg width="28" height="20" viewBox="0 0 28 20" shape-rendering="crispEdges" aria-hidden="true" focusable="false"><path d="M20 0h2v2h-2zM18 2h2v2h-2zM20 2h2v2h-2zM22 2h2v2h-2zM6 4h2v2h-2zM8 4h2v2h-2zM10 4h2v2h-2zM12 4h2v2h-2zM14 4h2v2h-2zM16 4h2v2h-2zM18 4h2v2h-2zM20 4h2v2h-2zM22 4h2v2h-2zM24 4h2v2h-2zM26 4h2v2h-2zM4 6h2v2h-2zM6 6h2v2h-2zM8 6h2v2h-2zM10 6h2v2h-2zM12 6h2v2h-2zM14 6h2v2h-2zM16 6h2v2h-2zM18 6h2v2h-2zM20 6h2v2h-2zM24 6h2v2h-2zM26 6h2v2h-2zM2 8h2v2h-2zM4 8h2v2h-2zM6 8h2v2h-2zM8 8h2v2h-2zM10 8h2v2h-2zM12 8h2v2h-2zM14 8h2v2h-2zM16 8h2v2h-2zM18 8h2v2h-2zM20 8h2v2h-2zM22 8h2v2h-2zM24 8h2v2h-2zM26 8h2v2h-2zM2 10h2v2h-2zM4 10h2v2h-2zM6 10h2v2h-2zM8 10h2v2h-2zM10 10h2v2h-2zM12 10h2v2h-2zM14 10h2v2h-2zM16 10h2v2h-2zM18 10h2v2h-2zM20 10h2v2h-2zM22 10h2v2h-2zM24 10h2v2h-2zM26 10h2v2h-2zM2 12h2v2h-2zM4 12h2v2h-2zM6 12h2v2h-2zM8 12h2v2h-2zM10 12h2v2h-2zM12 12h2v2h-2zM14 12h2v2h-2zM16 12h2v2h-2zM18 12h2v2h-2zM20 12h2v2h-2zM22 12h2v2h-2zM24 12h2v2h-2zM4 14h2v2h-2zM6 14h2v2h-2zM8 14h2v2h-2zM10 14h2v2h-2zM12 14h2v2h-2zM14 14h2v2h-2zM16 14h2v2h-2zM18 14h2v2h-2zM20 14h2v2h-2zM22 14h2v2h-2zM4 16h2v2h-2zM6 16h2v2h-2zM12 16h2v2h-2zM18 16h2v2h-2zM20 16h2v2h-2zM4 18h2v2h-2zM6 18h2v2h-2zM12 18h2v2h-2zM18 18h2v2h-2zM20 18h2v2h-2z"></path></svg></span>"`,
    );
  });

  it("a theme mark that fails to load falls back to the pixel capybara for that mount", () => {
    const b = brand({ markUrl: "/broken.svg", wordmark: "NEON GRID" });
    const { container, unmount } = render(
      <DesignProvider locale="en" brand={b}>
        <Logo wordmark />
      </DesignProvider>,
    );
    const img = container.querySelector("img");
    expect(img).not.toBeNull();
    fireEvent.error(img as HTMLImageElement);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("svg path")).not.toBeNull();
    expect(screen.getByText("NEON GRID")).toBeTruthy();
    unmount();
    // a new mount tries the mark again
    const again = render(
      <DesignProvider locale="en" brand={b}>
        <Logo wordmark />
      </DesignProvider>,
    );
    expect(again.container.querySelector('img[src="/broken.svg"]')).not.toBeNull();
  });

  it('alt is productName, else the wordmark, else "Logo"', () => {
    const altOf = (b: Brand) => {
      const { container, unmount } = render(
        <DesignProvider locale="en" brand={b}>
          <Logo />
        </DesignProvider>,
      );
      const alt = container.querySelector("img")?.getAttribute("alt");
      unmount();
      return alt;
    };
    expect(altOf(brand({ markUrl: "/m.svg", wordmark: "W", productName: "P" }))).toBe("P");
    expect(altOf(brand({ markUrl: "/m.svg", wordmark: "W" }))).toBe("W");
    expect(altOf(brand({ markUrl: "/m.svg" }))).toBe("Logo");
  });

  describe("a mark that settled before hydration (no error event reaches React)", () => {
    /** Stubs the image state the browser reports once the img is in the DOM. */
    const settled = (naturalWidth: number, decode?: () => Promise<void>) => {
      vi.spyOn(HTMLImageElement.prototype, "complete", "get").mockReturnValue(true);
      vi.spyOn(HTMLImageElement.prototype, "naturalWidth", "get").mockReturnValue(naturalWidth);
      if (decode)
        Object.defineProperty(HTMLImageElement.prototype, "decode", {
          configurable: true,
          value: decode,
        });
    };
    afterEach(() => {
      // biome-ignore lint/suspicious/noExplicitAny: removing the stub jsdom does not have
      delete (HTMLImageElement.prototype as any).decode;
    });
    const renderMark = () =>
      render(
        <DesignProvider locale="en" brand={brand({ markUrl: "/m.svg" })}>
          <Logo />
        </DesignProvider>,
      );

    it("a broken image (complete, no width) falls back to the pixel capybara", () => {
      settled(0);
      const { container } = renderMark();
      expect(container.querySelector("img")).toBeNull();
      expect(container.querySelector("svg path")).not.toBeNull();
    });

    it("a loaded image stays", () => {
      settled(28);
      const { container } = renderMark();
      expect(container.querySelector('img[src="/m.svg"]')).not.toBeNull();
    });

    it("a zero width is confirmed with decode(): a loaded SVG without a size stays", async () => {
      settled(0, () => Promise.resolve());
      const { container } = renderMark();
      await act(async () => {});
      expect(container.querySelector('img[src="/m.svg"]')).not.toBeNull();
    });

    it("a zero width whose decode() rejects falls back", async () => {
      settled(0, () => Promise.reject(new Error("EncodingError")));
      const { container } = renderMark();
      await act(async () => {});
      expect(container.querySelector("img")).toBeNull();
      expect(container.querySelector("svg path")).not.toBeNull();
    });
  });
});
