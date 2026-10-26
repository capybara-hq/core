import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DesignProvider, PAGE_TEMPLATES, ToastProvider } from "@capybara-hq/design";
import { missingStates, parseStateLists } from "@capybara-hq/design/reference";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Catalog } from "../src/dev/catalog";
import {
  CATALOG_ROUTES,
  REFERENCE_COMPONENTS,
  REFERENCE_ROUTES,
  TEMPLATE_ROUTES,
} from "../src/dev/catalog/routes";
import { ACCEPTED, PENDING_B } from "../visual/accepted";

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

describe("/dev/ui/reference (the reference-set blocks, spec §9.2)", () => {
  const spec = readFileSync(resolve(import.meta.dirname, "../../../docs/design/spec.md"), "utf8");

  // Project B components (PENDING_B) get their routes in plan Tasks 13-18; until they are accepted,
  // a pending component may lack a route, as in the fidelity completeness check.
  it("has one route per component with a state list in the design spec", () => {
    const components = parseStateLists(spec).map((l) => l.component);
    const routed = new Set<string>(REFERENCE_COMPONENTS);
    const required = components.filter((c) => !PENDING_B.includes(c) || routed.has(c));
    expect([...REFERENCE_COMPONENTS].sort()).toEqual([...required].sort());
    expect(REFERENCE_ROUTES).toEqual(REFERENCE_COMPONENTS.map((c) => `reference/${c}`));
  });

  it("keeps the reference routes out of the screenshot routes", () => {
    for (const r of REFERENCE_ROUTES) expect(CATALOG_ROUTES as readonly string[]).not.toContain(r);
  });

  it.each(REFERENCE_ROUTES)("%s renders", (route) => {
    const { container } = renderRoute(route);
    expect(container.textContent?.length ?? 0).toBeGreaterThan(0);
  });

  it("renders a block for every listed state of every accepted component", () => {
    const lists = parseStateLists(spec);
    for (const c of ACCEPTED) {
      const { container } = renderRoute(`reference/${c}`);
      const ids = [...container.querySelectorAll("[data-ref-block]")].map(
        (b) => b.getAttribute("data-ref-block") ?? "",
      );
      expect(missingStates(lists, ids, [c])).toEqual([]);
      cleanup();
    }
  });

  it("is served by the dev/ui page", async () => {
    const { default: Page } = await import("../src/app/[locale]/dev/ui/[[...slug]]/page");
    await expect(
      Page({ params: Promise.resolve({ locale: "zh", slug: ["reference", "sidebar"] }) }),
    ).resolves.toBeTruthy();
    await expect(
      Page({ params: Promise.resolve({ locale: "zh", slug: ["reference", "nope"] }) }),
    ).rejects.toThrow("NEXT_NOT_FOUND");
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
