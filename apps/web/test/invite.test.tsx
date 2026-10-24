import { cleanup, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import zh from "../messages/zh.json";
import InvitePage from "../src/app/[locale]/(auth)/invite/[token]/page";
import { bodyOf, json, noContent, stubApi } from "./support/api";
import { resetNavigation, router } from "./support/navigation";
import { ME, renderPage } from "./support/render";

vi.mock("../src/i18n/navigation", () => import("./support/navigation"));
vi.mock("next/navigation", () => ({ useParams: () => ({ token: "cap_inv_tok" }) }));

const msgs = { zh, en } as const;
const PREVIEW = "/api/v1/invitations/cap_inv_tok";
const ACCEPT = `${PREVIEW}/accept`;
const INVITE = {
  org: { id: "o9", name: "Initech" },
  role: "guest",
  expiresAt: "2026-10-29T00:00:00.000Z",
};
const unauthenticated = () => json(401, { error: { code: "auth.required", message: "x" } });
const refreshFails = () => json(401, { error: { code: "auth.refresh_invalid", message: "x" } });

beforeEach(() => resetNavigation("/invite/cap_inv_tok"));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("接受邀请页（AuthPage）", () => {
  it.each(["zh", "en"] as const)(
    "已登录：显示组织与角色；接受 → POST accept → 切到该组织 → 进入首页（%s）",
    async (locale) => {
      const m = msgs[locale];
      const calls = stubApi({
        [`GET ${PREVIEW}`]: () => json(200, INVITE),
        "GET /api/v1/me": () => json(200, ME),
        [`POST ${ACCEPT}`]: () => json(200, { account: { id: "a1" }, orgId: "o9", role: "guest" }),
        "PUT /api/v1/me/current-org": () => noContent(),
      });
      const { container } = renderPage(<InvitePage />, { locale });
      expect(container.querySelector('[data-template="AuthPage"]')).not.toBeNull();
      expect(await screen.findByText(m.invite.subtitle.replace("{org}", "Initech"))).toBeTruthy();
      expect(screen.getByText(m.members.roles.guest)).toBeTruthy();
      // 接受之前不发 POST
      expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
      const accept = screen.getByRole("button", { name: m.invite.accept });
      expect(accept.getAttribute("data-variant")).toBe("primary");
      await userEvent.setup().click(accept);
      await vi.waitFor(() => expect(router.replace).toHaveBeenCalledWith("/"));
      expect(bodyOf(calls.find((c) => c.url === ACCEPT))).toEqual({});
      expect(bodyOf(calls.find((c) => c.method === "PUT"))).toEqual({ orgId: "o9" });
    },
  );

  it("未登录：「登录后接受」去登录页并带回本页", async () => {
    const m = en.invite;
    stubApi({
      [`GET ${PREVIEW}`]: () => json(200, INVITE),
      "GET /api/v1/me": unauthenticated,
      "POST /api/v1/auth/refresh": refreshFails,
    });
    renderPage(<InvitePage />);
    expect(await screen.findByText(m.signInHint)).toBeTruthy();
    await userEvent.setup().click(screen.getByRole("button", { name: m.signIn }));
    expect(router.push).toHaveBeenCalledWith(
      `/login?returnTo=${encodeURIComponent("/invite/cap_inv_tok")}`,
    );
  });

  it("未登录：创建账号并加入 → POST accept 带注册信息 → 切到该组织 → 进入首页", async () => {
    const m = en.invite;
    const calls = stubApi({
      [`GET ${PREVIEW}`]: () => json(200, INVITE),
      "GET /api/v1/me": unauthenticated,
      "POST /api/v1/auth/refresh": refreshFails,
      [`POST ${ACCEPT}`]: () => json(200, { account: { id: "a7" }, orgId: "o9", role: "guest" }),
      "PUT /api/v1/me/current-org": () => noContent(),
    });
    renderPage(<InvitePage />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: m.signupToggle }));
    await user.type(screen.getByLabelText(m.loginLabel), "carol");
    await user.type(screen.getByLabelText(m.passwordLabel), "a-very-long-password");
    await user.type(screen.getByLabelText(m.displayNameLabel), "Carol");
    await user.click(screen.getByRole("button", { name: m.signup }));
    await vi.waitFor(() => expect(router.replace).toHaveBeenCalledWith("/"));
    expect(bodyOf(calls.find((c) => c.url === ACCEPT))).toEqual({
      login: "carol",
      password: "a-very-long-password",
      displayName: "Carol",
    });
    expect(bodyOf(calls.find((c) => c.method === "PUT"))).toEqual({ orgId: "o9" });
  });

  it("注册失败（用户名已占用）：显示错误，留在本页", async () => {
    const m = en.invite;
    stubApi({
      [`GET ${PREVIEW}`]: () => json(200, INVITE),
      "GET /api/v1/me": unauthenticated,
      "POST /api/v1/auth/refresh": refreshFails,
      [`POST ${ACCEPT}`]: () => json(409, { error: { code: "account.login_taken", message: "x" } }),
    });
    renderPage(<InvitePage />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: m.signupToggle }));
    await user.type(screen.getByLabelText(m.loginLabel), "admin");
    await user.type(screen.getByLabelText(m.passwordLabel), "a-very-long-password");
    await user.type(screen.getByLabelText(m.displayNameLabel), "Carol");
    await user.click(screen.getByRole("button", { name: m.signup }));
    expect(await screen.findByText(`✗ ${en.errors.account.login_taken}`)).toBeTruthy();
    expect(router.replace).not.toHaveBeenCalled();
  });

  it.each([
    ["invitation.invalid", 404],
    ["invitation.expired", 410],
    ["invitation.used", 409],
  ] as const)("链接失效（%s）：显示原因与回首页按钮，不显示接受", async (code, status) => {
    stubApi({
      [`GET ${PREVIEW}`]: () => json(status, { error: { code, message: "x" } }),
      "GET /api/v1/me": () => json(200, ME),
    });
    renderPage(<InvitePage />);
    expect(await screen.findByText(en.invite.invalidTitle)).toBeTruthy();
    const [group, key] = code.split(".") as ["invitation", "invalid" | "expired" | "used"];
    expect(screen.getByText(`✗ ${en.errors[group][key]}`)).toBeTruthy();
    expect(screen.queryByRole("button", { name: en.invite.accept })).toBeNull();
    await userEvent.setup().click(screen.getByRole("button", { name: en.invite.goHome }));
    expect(router.replace).toHaveBeenCalledWith("/");
  });
});
