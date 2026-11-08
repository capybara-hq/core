import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import zh from "../messages/zh.json";
import { LoginErrorNotice, LoginForm } from "../src/components/login-form";
import { SetupForm } from "../src/components/setup-form";
import { parseLoginError } from "../src/lib/auth-sources";
import { testQueryClient } from "./support/render";

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
    <QueryClientProvider client={testQueryClient()}>
      <NextIntlClientProvider locale={locale} messages={locale === "zh" ? zh : en}>
        <LoginForm onSuccess={onSuccess} />
      </NextIntlClientProvider>
    </QueryClientProvider>,
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
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", `${text}`);
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it("未登记的错误码 -> 通用错误文案", async () => {
    stubFetch(() => json(500, { error: { code: "something.new", message: "x" } }));
    renderLogin("en");
    await submit("en");
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", `${en.errors.unknown}`);
  });
});

// Acceptance (security): without the client JS the browser submits natively; a form without a
// method is a GET that put the password in the URL. Every credential form posts.
describe("credential forms post natively", () => {
  it("the sign-in form is method=post, its fields named for the proxy's POST handler", () => {
    renderLogin("en");
    const form = document.querySelector("form");
    expect(form?.getAttribute("method")).toBe("post");
    expect(form?.querySelector('input[type="password"]')?.getAttribute("name")).toBe("password");
    expect(form?.querySelector('input[name="login"]')).not.toBeNull();
  });

  it("the setup form is method=post and shows the error code a native POST came back with", () => {
    render(
      <QueryClientProvider client={testQueryClient()}>
        <NextIntlClientProvider locale="en" messages={en}>
          <SetupForm onSuccess={vi.fn()} initialError="validation_failed" />
        </NextIntlClientProvider>
      </QueryClientProvider>,
    );
    expect(document.querySelector("form")?.getAttribute("method")).toBe("post");
    expect(screen.getByRole("alert").textContent).toBe(en.errors.validation_failed);
  });

  it.each([
    ["zh", zh.login.ssoError.auth.invalid_credentials],
    ["en", en.login.ssoError.auth.invalid_credentials],
  ] as const)("a failed native sign-in's code reads in the page language (%s)", (locale, text) => {
    expect(parseLoginError("error=auth.invalid_credentials")).toBe("auth.invalid_credentials");
    render(
      <NextIntlClientProvider locale={locale} messages={locale === "zh" ? zh : en}>
        <LoginErrorNotice code="auth.invalid_credentials" />
      </NextIntlClientProvider>,
    );
    expect(screen.getByRole("alert").textContent).toBe(text);
  });
});
