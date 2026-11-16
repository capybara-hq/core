import { QueryObserver } from "@tanstack/react-query";
import { act, cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { hydrateRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import zh from "../messages/zh.json";
import BindView from "../src/app/(auth)/bind/[token]/view";
import { identitiesQuery } from "../src/lib/query/account";
import { pendingBindingQuery } from "../src/lib/query/auth";
import { meQuery } from "../src/lib/query/shell";
import { json, lastStubRoutes, stubApi } from "./support/api";
import { resetNavigation, router } from "./support/navigation";
import { renderAuthRouteWithCache } from "./support/query";
import { ME, pageElement, testQueryClient } from "./support/render";

vi.mock("../src/i18n/navigation", () => import("./support/navigation"));
const navigateBrowser = vi.hoisted(() => vi.fn());
vi.mock("../src/lib/browser", () => ({ navigateBrowser }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
}));

const PAGE = "/bind/cap_bind_tok";

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

beforeEach(() => {
  resetNavigation("/bind/cap_bind_tok");
  navigateBrowser.mockReset();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("binding confirmation (AuthPage)", () => {
  it("keeps confirmation and cancel disabled until hydration, then binds only on a human click", async () => {
    let finishConfirmation!: (response: Response) => void;
    const response = new Promise<Response>((resolve) => {
      finishConfirmation = resolve;
    });
    const calls = stubApi({ [`POST ${PATH}`]: () => response });
    const client = testQueryClient();
    client.setQueryData(pendingBindingQuery("cap_bind_tok").queryKey, BINDING);
    const ui = pageElement(<BindView token="cap_bind_tok" />, { client });
    const container = document.createElement("div");
    container.innerHTML = renderToString(ui);
    document.body.append(container);
    let root: Root | undefined;
    try {
      const confirm = within(container).getByRole("button", { name: en.bind.confirm });
      const cancel = within(container).getByRole("button", { name: en.bind.cancel });
      expect(confirm).toHaveProperty("disabled", true);
      expect(cancel).toHaveProperty("disabled", true);
      expect(calls).toHaveLength(0);
      const errors: unknown[] = [];
      await act(async () => {
        root = hydrateRoot(container, ui, { onRecoverableError: (e) => errors.push(e) });
      });
      expect(errors).toEqual([]);
      expect(confirm).toHaveProperty("disabled", false);
      expect(cancel).toHaveProperty("disabled", false);
      expect(calls).toHaveLength(0);
      const user = userEvent.setup();
      await user.click(confirm);
      expect(confirm).toHaveProperty("disabled", true);
      expect(cancel).toHaveProperty("disabled", true);
      await user.click(confirm);
      expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
      finishConfirmation(json(200, { binding: BINDING }));
      expect(await within(container).findByText(en.bind.doneTitle)).toBeTruthy();
      expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
    } finally {
      finishConfirmation(json(200, { binding: BINDING }));
      act(() => root?.unmount());
      container.remove();
      client.clear();
    }
  });

  it.each(["zh", "en"] as const)(
    "醒目展示 IM 显示名、来源与租户和防钓鱼提示；确认 → POST 并显示成功（%s）",
    async (locale) => {
      const m = msgs[locale].bind;
      const calls = stubApi({
        [`GET ${PATH}`]: () => json(200, { binding: BINDING }),
        [`POST ${PATH}`]: () => json(200, { binding: BINDING }),
      });
      const { container } = await renderAuthRouteWithCache(PAGE, lastStubRoutes(), { locale });
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

  it("cancel: no binding, back home (the new conversation)", async () => {
    const calls = stubApi({ [`GET ${PATH}`]: () => json(200, { binding: BINDING }) });
    await renderAuthRouteWithCache(PAGE, lastStubRoutes());
    await userEvent.setup().click(await screen.findByRole("button", { name: en.bind.cancel }));
    expect(navigateBrowser).toHaveBeenCalledWith("/");
    expect(router.replace).not.toHaveBeenCalledWith("/");
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });

  it("a confirm that finds the session gone signs in again, back here", async () => {
    stubApi({
      [`GET ${PATH}`]: () => json(200, { binding: BINDING }),
      [`POST ${PATH}`]: unauthenticated,
      "POST /api/v1/auth/refresh": unauthenticated,
    });
    await renderAuthRouteWithCache(PAGE, lastStubRoutes());
    await userEvent.setup().click(await screen.findByRole("button", { name: en.bind.confirm }));
    await vi.waitFor(() =>
      expect(router.replace).toHaveBeenCalledWith("/login?returnTo=%2Fbind%2Fcap_bind_tok"),
    );
  });

  it("confirming invalidates the identities of the cached session's account", async () => {
    const calls = stubApi({
      [`GET ${PATH}`]: () => json(200, { binding: BINDING }),
      [`POST ${PATH}`]: () => json(200, { binding: BINDING }),
      "GET /api/v1/me/identities": () => json(200, { identities: [] }),
    });
    const { client } = await renderAuthRouteWithCache(PAGE, lastStubRoutes());
    // what an earlier page of this tab cached: the session and its identities (observed, as a
    // mounted identities list would be)
    client.setQueryData(meQuery().queryKey, ME);
    client.setQueryData(identitiesQuery(ME.account.id).queryKey, { identities: [] });
    const observer = new QueryObserver(client, identitiesQuery(ME.account.id));
    const unsubscribe = observer.subscribe(() => {});
    await userEvent.setup().click(await screen.findByRole("button", { name: en.bind.confirm }));
    expect(await screen.findByText(en.bind.doneTitle)).toBeTruthy();
    await vi.waitFor(() =>
      expect(calls.filter((c) => c.method === "GET").map((c) => c.url)).toEqual([
        "/api/v1/me/identities",
      ]),
    );
    unsubscribe();
  });

  it.each(["zh", "en"] as const)("链接无效 / 过期（bind.invalid）（%s）", async (locale) => {
    const m = msgs[locale];
    stubApi({
      [`GET ${PATH}`]: () => json(404, { error: { code: "bind.invalid", message: "x" } }),
    });
    await renderAuthRouteWithCache(PAGE, lastStubRoutes(), { locale });
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
    await renderAuthRouteWithCache(PAGE, lastStubRoutes());
    await userEvent.setup().click(await screen.findByRole("button", { name: en.bind.confirm }));
    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      `${en.errors.identity.taken}`,
    );
    expect(screen.getByRole("button", { name: en.bind.confirm })).toBeTruthy();
  });
});
