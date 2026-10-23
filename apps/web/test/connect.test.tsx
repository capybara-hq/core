import { cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import zh from "../messages/zh.json";
import ConnectionsPage from "../src/app/[locale]/(app)/settings/connections/page";
import { ConnectCard } from "../src/components/ConnectCard";
import { navigateBrowser } from "../src/lib/browser";
import { parseConnectResult, useConnectResultToast } from "../src/lib/connect";
import { bodyOf, json, noContent, stubApi } from "./support/api";
import { resetNavigation, router } from "./support/navigation";
import { renderPage } from "./support/render";

vi.mock("../src/i18n/navigation", () => import("./support/navigation"));
vi.mock("../src/lib/browser", () => ({ navigateBrowser: vi.fn() }));

const msgs = { zh, en } as const;
const LOCALES = ["zh", "en"] as const;
const AUTH_URL = "https://auth.example.com/authorize?state=s1";
const T = "2026-10-19T12:00:00.000Z";

const oauthApp = (status: "connected" | "missing") => ({
  id: "app1",
  slug: "docs",
  name: "Docs",
  connector: "mcp",
  endpoint: {},
  auth: { type: "oauth_code", ownership: "personal" },
  status: "active",
  createdAt: T,
  updatedAt: T,
  tools: [],
  credential: { ownership: "personal", status },
});

const item = {
  kind: "connect" as const,
  key: "e1",
  callId: "c",
  connectorId: "app1",
  connectorName: "Docs",
  closed: false,
};

beforeEach(() => {
  resetNavigation();
  vi.mocked(navigateBrowser).mockClear();
  window.history.replaceState(null, "", "/");
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("parseConnectResult", () => {
  it("connected / oauth_error 解析并从查询串去掉，其他参数保留；未知错误码归为 unknown", () => {
    expect(parseConnectResult("?connected=app1&x=1")).toEqual({
      result: { kind: "connected" },
      cleanedSearch: "?x=1",
    });
    expect(parseConnectResult("?oauth_error=access_denied")).toEqual({
      result: { kind: "error", code: "access_denied" },
      cleanedSearch: "",
    });
    expect(parseConnectResult("?oauth_error=<script>").result).toEqual({
      kind: "error",
      code: "unknown",
    });
    expect(parseConnectResult("?a=b")).toEqual({ result: null, cleanedSearch: "?a=b" });
  });
});

describe("ConnectCard：OAuth 连接器", () => {
  it.each(LOCALES)(
    "「连接」以当前页为 returnTo 调 connect，再整页跳到授权地址（%s）",
    async (locale) => {
      window.history.replaceState(null, "", `/${locale}/chat/c1`);
      const calls = stubApi({
        "GET /api/v1/orgs/o1/connectors/app1": () => json(200, { connector: oauthApp("missing") }),
        "POST /api/v1/orgs/o1/connectors/app1/connect": () =>
          json(200, { authorizationUrl: AUTH_URL }),
      });
      renderPage(<ConnectCard orgId="o1" item={item} />, { locale });
      await userEvent
        .setup()
        .click(screen.getByRole("button", { name: msgs[locale].connect.action }));
      await vi.waitFor(() => expect(navigateBrowser).toHaveBeenCalledWith(AUTH_URL));
      expect(bodyOf(calls.find((c) => c.method === "POST"))).toEqual({
        returnTo: `/${locale}/chat/c1`,
      });
      expect(router.push).not.toHaveBeenCalled();
    },
  );

  it("授权地址不是 http(s) 时不跳转", async () => {
    stubApi({
      "GET /api/v1/orgs/o1/connectors/app1": () => json(200, { connector: oauthApp("missing") }),
      "POST /api/v1/orgs/o1/connectors/app1/connect": () =>
        json(200, { authorizationUrl: "javascript:alert(1)" }),
    });
    renderPage(<ConnectCard orgId="o1" item={item} />);
    await userEvent.setup().click(screen.getByRole("button", { name: en.connect.action }));
    expect(await screen.findByText(en.connect.result.unknown)).toBeTruthy();
    expect(navigateBrowser).not.toHaveBeenCalled();
  });

  it("connect 失败：toast 显示译文，不跳转", async () => {
    stubApi({
      "GET /api/v1/orgs/o1/connectors/app1": () => json(200, { connector: oauthApp("missing") }),
      "POST /api/v1/orgs/o1/connectors/app1/connect": () =>
        json(404, { error: { code: "connector.not_found", message: "x" } }),
    });
    renderPage(<ConnectCard orgId="o1" item={item} />);
    await userEvent.setup().click(screen.getByRole("button", { name: en.connect.action }));
    await vi.waitFor(() => expect(screen.getByRole("status")).toBeTruthy());
    expect(navigateBrowser).not.toHaveBeenCalled();
  });
});

function ResultProbe() {
  useConnectResultToast();
  return null;
}

describe("回跳结果提示", () => {
  it.each(LOCALES)("connected：成功提示，并清掉地址栏的参数（%s）", async (locale) => {
    window.history.replaceState(null, "", `/${locale}/chat/c1?connected=app1&keep=1#x`);
    renderPage(<ResultProbe />, { locale });
    expect(await screen.findByText(msgs[locale].connect.result.connected)).toBeTruthy();
    expect(window.location.search).toBe("?keep=1");
    expect(window.location.pathname).toBe(`/${locale}/chat/c1`);
    expect(window.location.hash).toBe("#x");
  });

  it.each(LOCALES)("oauth_error：只显示自己的译文（%s）", async (locale) => {
    window.history.replaceState(null, "", "/settings/connections?oauth_error=access_denied");
    renderPage(<ResultProbe />, { locale });
    expect(await screen.findByText(msgs[locale].connect.result.error.access_denied)).toBeTruthy();
    expect(window.location.search).toBe("");
  });

  it("未知错误码显示通用文案，不渲染原文", async () => {
    window.history.replaceState(null, "", "/x?oauth_error=boom%20raw%20text");
    renderPage(<ResultProbe />);
    expect(await screen.findByText(en.connect.result.unknown)).toBeTruthy();
    expect(screen.queryByText(/boom/)).toBeNull();
  });
});

describe("个人连接页：OAuth 连接器", () => {
  it.each(LOCALES)("连接 / 重新连接 / 断开连接（%s）", async (locale) => {
    const m = msgs[locale];
    window.history.replaceState(null, "", `/${locale}/settings/connections`);
    let status: "connected" | "missing" = "missing";
    const calls = stubApi({
      "GET /api/v1/orgs/o1/connectors": () =>
        json(200, {
          connectors: [{ ...oauthApp("missing"), tools: undefined, credential: undefined }],
        }),
      "GET /api/v1/orgs/o1/connectors/app1": () => json(200, { connector: oauthApp(status) }),
      "POST /api/v1/orgs/o1/connectors/app1/connect": () =>
        json(200, { authorizationUrl: AUTH_URL }),
      "DELETE /api/v1/orgs/o1/connectors/app1/credentials/me": () => {
        status = "missing";
        return noContent();
      },
    });
    const { container } = renderPage(<ConnectionsPage />, { locale });
    const section = await screen.findByRole("region", { name: "Docs" });
    // 没有 token 输入框；页面没有多个主操作
    expect(within(section).queryByLabelText(m.connectors.form.tokenLabel)).toBeNull();
    expect(
      container.querySelectorAll('[data-variant="primary"], .cb-btn-link-primary').length,
    ).toBeLessThanOrEqual(1);
    expect(within(section).queryByRole("button", { name: m.connections.disconnect })).toBeNull();
    const user = userEvent.setup();
    await user.click(within(section).getByRole("button", { name: m.connections.oauthConnect }));
    await vi.waitFor(() => expect(navigateBrowser).toHaveBeenCalledWith(AUTH_URL));
    expect(bodyOf(calls.find((c) => c.method === "POST"))).toEqual({
      returnTo: `/${locale}/settings/connections`,
    });

    // 已连接：重新连接 + 断开连接
    cleanup();
    status = "connected";
    renderPage(<ConnectionsPage />, { locale });
    const again = await screen.findByRole("region", { name: "Docs" });
    expect(within(again).getByRole("button", { name: m.connections.reconnect })).toBeTruthy();
    await user.click(within(again).getByRole("button", { name: m.connections.disconnect }));
    await vi.waitFor(() => expect(calls.some((c) => c.method === "DELETE")).toBe(true));
    expect(await screen.findByRole("button", { name: m.connections.oauthConnect })).toBeTruthy();
  });
});
