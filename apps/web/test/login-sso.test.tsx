import { cleanup, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import zh from "../messages/zh.json";
import LoginPage from "../src/app/[locale]/(auth)/login/page";
import {
  LOGIN_ERROR_CODES,
  parseLoginError,
  safeReturnTo,
  ssoStartUrl,
} from "../src/lib/auth-sources";
import { json, stubApi } from "./support/api";
import { resetNavigation, router } from "./support/navigation";
import { renderPage } from "./support/render";

vi.mock("../src/i18n/navigation", () => import("./support/navigation"));
const navigateBrowser = vi.hoisted(() => vi.fn());
vi.mock("../src/lib/browser", () => ({ navigateBrowser }));

const msgs = { zh, en } as const;
const SOURCES = [{ plugin: "fake-im", label: { zh: "假 IM", en: "Fake IM" } }];

function at(search: string) {
  window.history.replaceState(null, "", `/zh/login${search}`);
}

beforeEach(() => {
  resetNavigation("/login");
  navigateBrowser.mockReset();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  at("");
});

describe("登录错误码", () => {
  it("parseLoginError：已知码原样、未知码 → unknown、没有 → null", () => {
    expect(parseLoginError("?error=sso.access_denied")).toBe("sso.access_denied");
    expect(parseLoginError("?error=auth.account_disabled")).toBe("auth.account_disabled");
    expect(parseLoginError("?error=sso.identity_not_verified")).toBe("sso.identity_not_verified");
    expect(parseLoginError("?error=<script>")).toBe("unknown");
    expect(parseLoginError("?x=1")).toBeNull();
  });

  it("每个回跳错误码都有 zh / en 文案（不回显服务器文本）", () => {
    for (const m of [zh, en]) {
      for (const code of LOGIN_ERROR_CODES) {
        const [ns, key] = code.split(".") as [string, string];
        const group = (m.login.ssoError as Record<string, unknown>)[ns] as Record<string, string>;
        expect(typeof group[key], `${code}`).toBe("string");
      }
      expect(typeof m.login.ssoError.unknown).toBe("string");
    }
  });

  it.each([
    ["zh", "sso.session_mismatch", zh.login.ssoError.sso.session_mismatch],
    ["en", "sso.unavailable", en.login.ssoError.sso.unavailable],
    ["en", "auth.account_disabled", en.login.ssoError.auth.account_disabled],
    ["en", "weird", en.login.ssoError.unknown],
  ] as const)("登录页把 ?error=%s 显示为译文（%s）", async (locale, code, text) => {
    stubApi({
      "GET /api/v1/setup": () => json(200, { needsSetup: false }),
      "GET /api/v1/auth/sources": () => json(200, { sources: [] }),
    });
    at(`?error=${encodeURIComponent(code)}`);
    renderPage(<LoginPage />, { locale });
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", `${text}`);
  });
});

describe("第三方登录按钮", () => {
  it.each(["zh", "en"] as const)(
    "按身份源渲染按钮，点击整页跳到发起地址并带回跳页面（%s）",
    async (locale) => {
      const m = msgs[locale];
      stubApi({
        "GET /api/v1/setup": () => json(200, { needsSetup: false }),
        "GET /api/v1/auth/sources": () => json(200, { sources: SOURCES }),
      });
      at("?returnTo=%2Fbind%2Fcap_bind_x");
      renderPage(<LoginPage />, { locale });
      const name = m.login.sso.replace("{name}", locale === "zh" ? "假 IM" : "Fake IM");
      const button = await screen.findByRole("button", { name });
      await userEvent.setup().click(button);
      expect(navigateBrowser).toHaveBeenCalledWith(
        "/api/v1/auth/sso/fake-im/start?returnTo=%2Fbind%2Fcap_bind_x",
      );
      expect(screen.queryByRole("alert")).toBeNull();
    },
  );

  it("没有身份源：不显示「或使用以下方式登录」", async () => {
    stubApi({
      "GET /api/v1/setup": () => json(200, { needsSetup: false }),
      "GET /api/v1/auth/sources": () => json(200, { sources: [] }),
    });
    renderPage(<LoginPage />);
    await screen.findByRole("button", { name: en.login.submit });
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByText(en.login.or)).toBeNull();
  });

  it("本地登录成功后回到 returnTo；外站地址被拒，回首页", async () => {
    stubApi({
      "GET /api/v1/setup": () => json(200, { needsSetup: false }),
      "GET /api/v1/auth/sources": () => json(200, { sources: [] }),
      "POST /api/v1/auth/login": () => json(200, { account: { id: "a1" } }),
    });
    at("?returnTo=%2Fbind%2Fcap_bind_x");
    renderPage(<LoginPage />);
    const user = userEvent.setup();
    await user.type(screen.getByRole("textbox", { name: en.login.loginLabel }), "alice");
    await user.type(screen.getByLabelText(en.login.passwordLabel), "pw-123456789");
    await user.click(screen.getByRole("button", { name: en.login.submit }));
    await vi.waitFor(() => expect(router.replace).toHaveBeenCalledWith("/bind/cap_bind_x"));
  });

  it("safeReturnTo / ssoStartUrl", () => {
    expect(safeReturnTo("/bind/x?y=1")).toBe("/bind/x?y=1");
    expect(safeReturnTo("//evil.example")).toBe("/");
    expect(safeReturnTo("https://evil.example")).toBe("/");
    expect(safeReturnTo("/\\evil")).toBe("/");
    expect(safeReturnTo(null)).toBe("/");
    expect(ssoStartUrl("a b", "/x")).toBe("/api/v1/auth/sso/a%20b/start?returnTo=%2Fx");
  });
});
