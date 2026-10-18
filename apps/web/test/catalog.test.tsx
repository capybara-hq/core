import { DesignProvider, PAGE_TEMPLATES, ToastProvider } from "@capybara-hq/design";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Catalog } from "../src/dev/catalog";
import { CATALOG_ROUTES, TEMPLATE_ROUTES } from "../src/dev/catalog/routes";

const notFound = vi.hoisted(() =>
  vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
);
vi.mock("next/navigation", () => ({ notFound }));
const connection = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("next/server", () => ({ connection }));

// jsdom 缺少 Radix / cmdk 依赖的若干浏览器 API。
beforeAll(() => {
  class RO {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  globalThis.ResizeObserver ??= RO as unknown as typeof ResizeObserver;
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.setPointerCapture ??= () => {};
  Element.prototype.releasePointerCapture ??= () => {};
  Element.prototype.scrollIntoView ??= () => {};
  window.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia;
});

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  notFound.mockClear();
  connection.mockClear();
});

function renderRoute(route: string) {
  return render(
    <DesignProvider locale="zh">
      <ToastProvider>
        <Catalog route={route} />
      </ToastProvider>
    </DesignProvider>,
  );
}

describe("/dev/ui 目录页", () => {
  it("路由覆盖 12 个模板（kebab 名去掉 Page 后缀）", () => {
    const kebab = PAGE_TEMPLATES.map((n) =>
      n
        .replace(/Page$/, "")
        .replace(/[A-Z]/g, (c, i: number) => (i === 0 ? "" : "-") + c.toLowerCase()),
    );
    expect(TEMPLATE_ROUTES).toEqual(kebab.map((k) => `templates/${k}`));
    for (const r of TEMPLATE_ROUTES) expect(CATALOG_ROUTES).toContain(r);
    expect(CATALOG_ROUTES).toEqual(
      expect.arrayContaining([
        "components",
        "table",
        "overlays/dialog",
        "overlays/danger",
        "overlays/sheet",
        "overlays/menu",
        "overlays/command",
        "overlays/toast",
        "stress",
      ]),
    );
  });

  it.each(CATALOG_ROUTES)("%s 能渲染且不抛错", (route) => {
    const { container } = renderRoute(route);
    expect(container.textContent?.length ?? 0).toBeGreaterThan(0);
  });

  it("目录首页列出所有路由", () => {
    renderRoute("");
    for (const r of CATALOG_ROUTES) {
      expect(screen.getByRole("link", { name: r })).toHaveProperty(
        "href",
        expect.stringContaining(`/dev/ui/${r}`),
      );
    }
  });

  it("模板页（认证页除外）套在 AppShell 里", () => {
    renderRoute("templates/list");
    expect(screen.getByRole("navigation", { name: "主导航" })).toBeTruthy();
    cleanup();
    renderRoute("templates/auth");
    expect(screen.queryByRole("navigation", { name: "主导航" })).toBeNull();
  });
});

describe("/dev/ui 生产门禁", () => {
  const params = (slug?: string[]) => Promise.resolve({ locale: "zh", ...(slug ? { slug } : {}) });

  it("NODE_ENV=production 且未设 CAPYBARA_DEV_UI=1 时 notFound", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("CAPYBARA_DEV_UI", "");
    const { default: Page } = await import("../src/app/[locale]/dev/ui/[[...slug]]/page");
    await expect(Page({ params: params(["components"]) })).rejects.toThrow("NEXT_NOT_FOUND");
    expect(notFound).toHaveBeenCalled();
  });

  it("CAPYBARA_DEV_UI=1 时生产环境也可访问", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("CAPYBARA_DEV_UI", "1");
    const { default: Page } = await import("../src/app/[locale]/dev/ui/[[...slug]]/page");
    await expect(Page({ params: params(["components"]) })).resolves.toBeTruthy();
    expect(notFound).not.toHaveBeenCalled();
  });

  it("门禁在请求时判断：先 await connection() 再读环境变量（不会被预渲染固化）", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("CAPYBARA_DEV_UI", "");
    const order: string[] = [];
    connection.mockImplementationOnce(async () => {
      order.push("connection");
    });
    notFound.mockImplementationOnce(() => {
      order.push("notFound");
      throw new Error("NEXT_NOT_FOUND");
    });
    const { default: Page } = await import("../src/app/[locale]/dev/ui/[[...slug]]/page");
    await expect(Page({ params: params(["components"]) })).rejects.toThrow("NEXT_NOT_FOUND");
    expect(order).toEqual(["connection", "notFound"]);
  });

  it("未知路由 notFound", async () => {
    const { default: Page } = await import("../src/app/[locale]/dev/ui/[[...slug]]/page");
    await expect(Page({ params: params(["nope"]) })).rejects.toThrow("NEXT_NOT_FOUND");
  });
});
