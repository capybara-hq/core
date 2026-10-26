import { cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import zh from "../messages/zh.json";
import BindPage from "../src/app/[locale]/(auth)/bind/[token]/page";
import { json, stubApi } from "./support/api";
import { resetNavigation, router } from "./support/navigation";
import { renderPage } from "./support/render";

vi.mock("../src/i18n/navigation", () => import("./support/navigation"));
vi.mock("next/navigation", () => ({ useParams: () => ({ token: "cap_bind_tok" }) }));

const msgs = { zh, en } as const;
const PATH = "/api/v1/bind/cap_bind_tok";
const BINDING = {
  connectionId: "ch1",
  source: "fake-im:t1",
  externalId: "u-alice",
  displayName: "Alice Wong",
  email: "alice@corp.example",
};
const unauthenticated = () => json(401, { error: { code: "auth.required", message: "x" } });

beforeEach(() => resetNavigation("/bind/cap_bind_tok"));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("绑定确认页（AuthPage）", () => {
  it.each(["zh", "en"] as const)(
    "醒目展示 IM 显示名、来源与租户和防钓鱼提示；确认 → POST 并显示成功（%s）",
    async (locale) => {
      const m = msgs[locale].bind;
      const calls = stubApi({
        [`GET ${PATH}`]: () => json(200, { binding: BINDING }),
        [`POST ${PATH}`]: () => json(200, { binding: BINDING }),
      });
      const { container } = renderPage(<BindPage />, { locale });
      expect(container.querySelector('[data-template="AuthPage"]')).not.toBeNull();
      expect(await screen.findByText("Alice Wong")).toBeTruthy();
      expect(screen.getByText("fake-im")).toBeTruthy();
      expect(screen.getByText("t1")).toBeTruthy();
      expect(screen.getByText("u-alice")).toBeTruthy();
      expect(within(screen.getByRole("note")).getByText(m.warning)).toBeTruthy();
      // 确认之前不发 POST
      expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
      const confirm = screen.getByRole("button", { name: m.confirm });
      expect(confirm.getAttribute("data-variant")).toBe("primary");
      await userEvent.setup().click(confirm);
      expect(await screen.findByText(m.doneTitle)).toBeTruthy();
      const post = calls.find((c) => c.method === "POST");
      expect(post?.headers.get("x-capybara-csrf")).toBe("1");
    },
  );

  it("取消：不绑定，回首页", async () => {
    const calls = stubApi({ [`GET ${PATH}`]: () => json(200, { binding: BINDING }) });
    renderPage(<BindPage />);
    await userEvent.setup().click(await screen.findByRole("button", { name: en.bind.cancel }));
    expect(router.replace).toHaveBeenCalledWith("/");
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });

  it("未登录：去登录页并带回本页", async () => {
    stubApi({
      [`GET ${PATH}`]: unauthenticated,
      "POST /api/v1/auth/refresh": () =>
        json(401, { error: { code: "auth.refresh_invalid", message: "x" } }),
    });
    renderPage(<BindPage />);
    await vi.waitFor(() =>
      expect(router.replace).toHaveBeenCalledWith("/login?returnTo=%2Fbind%2Fcap_bind_tok"),
    );
  });

  it.each(["zh", "en"] as const)("链接无效 / 过期（bind.invalid）（%s）", async (locale) => {
    const m = msgs[locale];
    stubApi({
      [`GET ${PATH}`]: () => json(404, { error: { code: "bind.invalid", message: "x" } }),
    });
    renderPage(<BindPage />, { locale });
    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      `${m.errors.bind.invalid}`,
    );
    expect(screen.getByText(m.bind.invalidTitle)).toBeTruthy();
    expect(screen.queryByRole("button", { name: m.bind.confirm })).toBeNull();
  });

  it("身份已绑定他人（identity.taken）：留在确认页并提示", async () => {
    stubApi({
      [`GET ${PATH}`]: () => json(200, { binding: BINDING }),
      [`POST ${PATH}`]: () => json(409, { error: { code: "identity.taken", message: "x" } }),
    });
    renderPage(<BindPage />);
    await userEvent.setup().click(await screen.findByRole("button", { name: en.bind.confirm }));
    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      `${en.errors.identity.taken}`,
    );
    expect(screen.getByRole("button", { name: en.bind.confirm })).toBeTruthy();
  });
});
