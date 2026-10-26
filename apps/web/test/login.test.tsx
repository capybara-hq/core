import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import zh from "../messages/zh.json";
import { LoginForm } from "../src/components/login-form";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function stubFetch(response: () => Response) {
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => response());
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function renderLogin(locale: "zh" | "en", onSuccess = vi.fn()) {
  render(
    <NextIntlClientProvider locale={locale} messages={locale === "zh" ? zh : en}>
      <LoginForm onSuccess={onSuccess} />
    </NextIntlClientProvider>,
  );
  return onSuccess;
}

async function submit(locale: "zh" | "en") {
  const m = locale === "zh" ? zh : en;
  const user = userEvent.setup();
  await user.type(screen.getByRole("textbox", { name: m.login.loginLabel }), "admin");
  await user.type(screen.getByLabelText(m.login.passwordLabel), "s3cret-password");
  const submitButton = screen.getByRole("button", { name: m.login.submit });
  // 认证页的唯一主操作（spec §5 T10）
  expect(submitButton.getAttribute("data-variant")).toBe("primary");
  expect(submitButton.getAttribute("data-density")).toBe("prominent");
  await user.click(submitButton);
}

describe("LoginForm", () => {
  it("提交表单 -> POST /api/v1/auth/login（带 CSRF 头与 JSON body），成功后回调", async () => {
    const fetchMock = stubFetch(() => json(200, { account: { id: "a1" } }));
    const onSuccess = renderLogin("zh");
    await submit("zh");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("/api/v1/auth/login");
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("x-capybara-csrf")).toBe("1");
    expect(JSON.parse(String(init?.body))).toEqual({ login: "admin", password: "s3cret-password" });
    expect(onSuccess).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["zh", "用户名或密码错误"],
    ["en", "Invalid username or password"],
  ] as const)("auth.invalid_credentials 显示翻译后的文案（%s）", async (locale, text) => {
    stubFetch(() =>
      json(401, { error: { code: "auth.invalid_credentials", message: "Invalid login" } }),
    );
    const onSuccess = renderLogin(locale);
    await submit(locale);
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", `✗ ${text}`);
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it("未登记的错误码 -> 通用错误文案", async () => {
    stubFetch(() => json(500, { error: { code: "something.new", message: "x" } }));
    renderLogin("en");
    await submit("en");
    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      `✗ ${en.errors.unknown}`,
    );
  });
});
