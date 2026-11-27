// The native wiring (mobile app spec §6; interaction model §10.2–10.4): the frame hands the
// shell's nav@1 strip to the design (the sections with the inbox count and Search, the pill's top
// item New conversation, the account; taps navigate after closing an open sheet, Search opens the
// palette, the top item runs the primary, the avatar opens the account sheet; no menu button on
// the strip, D12) and profiles@1 to the account sheet and menu as "Switch platform"; downloads go
// to the system browser in a shell with openExternal@1; DesignRoot passes the shell's menu /
// share / haptics and tells chrome@1 the page has drawn.
import { useHaptics, useNative } from "@capybara-hq/design";
import { act, cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DesignRoot } from "../src/components/design-root";
import { useOpenDownload } from "../src/components/SessionFilePreview";
import { json, stubApi } from "./support/api";
import { resetNavigation, router } from "./support/navigation";
import { ME, renderPage } from "./support/render";
import { renderFrame, shellOf } from "./support/shell";

vi.mock("../src/i18n/navigation", () => import("./support/navigation"));

const install = (shell: unknown) => {
  (window as unknown as { capybaraShell?: unknown }).capybaraShell = shell;
};

function shellWith(capabilities: Record<string, object>) {
  return { version: 1, kind: "mobile", platform: "ios", capabilities, on: () => () => {} };
}

/** A window `width` wide with a coarse pointer (the iPhone Duo's outer display at 382). */
function window_(width: number) {
  vi.stubGlobal("matchMedia", (q: string) => {
    const t = q.trim();
    const features = [...t.matchAll(/\((min|max)-width:\s*(\d+)px\)/g)];
    const hit =
      features.length > 0 &&
      features.every(([, k, n]) => (k === "min" ? width >= Number(n) : width <= Number(n)));
    // the compact query is the complement of (min-width: 600px)
    const matches = /pointer/.test(t)
      ? !t.startsWith("(any-pointer: fine)")
      : t.startsWith("not all and ")
        ? !hit
        : hit;
    return { matches, media: q, addEventListener() {}, removeEventListener() {} };
  });
}

function fakeNav(side?: "left" | "right") {
  const select = new Set<(id: string) => void>();
  const action = new Set<() => void>();
  const account = new Set<() => void>();
  const sub =
    <L,>(set: Set<L>) =>
    (l: L) => {
      set.add(l);
      return () => set.delete(l);
    };
  const fire = (set: Set<() => void>) => {
    for (const l of [...set]) l();
  };
  return {
    nav: {
      set: vi.fn(async (_state: unknown) => {}),
      onSelect: vi.fn(sub(select)),
      onAction: vi.fn(sub(action)),
      onAccount: vi.fn(sub(account)),
      ...(side ? { side } : {}),
    },
    select: (id: string) => {
      for (const l of [...select]) l(id);
    },
    action: () => fire(action),
    account: () => fire(account),
  };
}

type NavState = {
  items: { id: string; label: string; count?: number }[];
  current: string | null;
  menu?: unknown;
  action?: { id: string; label: string; icon: string };
  account?: { name: string; initial: string; avatarUrl?: string };
};
const lastState = (fake: ReturnType<typeof fakeNav>) =>
  fake.nav.set.mock.calls.at(-1)?.[0] as NavState;
const accountSheet = () => document.querySelector('[data-part="account-sheet"]');

const pending = { pending: { count: 3, more: false } };
const drawerEl = () => document.querySelector('[data-part="drawer"]') as HTMLElement | null;

beforeEach(() => {
  resetNavigation("/");
  window.history.replaceState(null, "", "/");
  window_(382);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(window, "capybaraShell");
  document.documentElement.removeAttribute("data-native-nav");
  document.documentElement.removeAttribute("data-strip");
});

describe("AppFrame with nav@1", () => {
  it("set carries action (page primary or 新会话) and account", () => {
    const fake = fakeNav();
    install(shellWith({ "nav@1": fake.nav }));
    renderFrame(shellOf(ME, pending));
    expect(document.querySelector(".cb-shell")?.hasAttribute("data-native-nav")).toBe(true);
    expect(fake.nav.set).toHaveBeenCalled();
    const state = lastState(fake);
    expect(state.items.map((i) => i.id)).toEqual([
      "chats",
      "inbox",
      "agents",
      "schedules",
      "search",
    ]);
    expect(state.items[1]?.count).toBe(3);
    // the home is the pill's first item: no section is current there
    expect(state.current).toBeNull();
    // no menu button on the strip (D12); the pill's top item is New conversation on a page without a primary
    expect(state).not.toHaveProperty("menu");
    expect(state.action).toEqual({ id: "new-conversation", label: "新会话", icon: "square-pen" });
    expect(state.account).toEqual(
      expect.objectContaining({ name: ME.account.displayName, initial: "G" }),
    );
  });

  it("a section tap navigates without opening the drawer", () => {
    const fake = fakeNav();
    install(shellWith({ "nav@1": fake.nav }));
    renderFrame(shellOf(ME, pending));
    act(() => fake.select("inbox"));
    expect(router.push).toHaveBeenCalledWith("/inbox");
    expect(drawerEl()).toBeNull();
  });

  it("onAction runs the primary (新会话 without one)", () => {
    resetNavigation("/agents");
    const fake = fakeNav();
    install(shellWith({ "nav@1": fake.nav }));
    renderFrame(shellOf(ME, pending));
    act(() => fake.action());
    expect(router.push).toHaveBeenCalledWith("/");
  });

  it("onAccount opens the account sheet", () => {
    const fake = fakeNav();
    install(shellWith({ "nav@1": fake.nav }));
    renderFrame(shellOf(ME, pending));
    expect(accountSheet()).toBeNull();
    act(() => fake.account());
    const sheet = accountSheet() as HTMLElement;
    expect(sheet).not.toBeNull();
    expect(within(sheet).getByText(ME.account.displayName)).toBeTruthy();
    expect(drawerEl()).toBeNull();
  });

  it("a strip selection closes the open sheet first", async () => {
    const fake = fakeNav();
    install(shellWith({ "nav@1": fake.nav }));
    renderFrame(shellOf(ME, pending));
    act(() => fake.account());
    // the touch window: the sheet holds a history entry
    await waitFor(() =>
      expect((window.history.state as Record<string, unknown> | null)?.cbOverlay).toBeDefined(),
    );
    const at: unknown[] = [];
    router.push.mockImplementation(() => {
      at.push((window.history.state as Record<string, unknown> | null)?.cbOverlay);
    });
    act(() => fake.select("agents"));
    await waitFor(() => expect(router.push).toHaveBeenCalledWith("/agents"));
    // the sheet's entry was popped before the move
    expect(at).toEqual([undefined]);
    await waitFor(() => expect(accountSheet()).toBeNull());
  });

  it("search item opens the palette", async () => {
    const fake = fakeNav();
    install(shellWith({ "nav@1": fake.nav }));
    renderFrame(shellOf(ME, pending));
    expect(document.querySelector("[cmdk-root]")).toBeNull();
    act(() => fake.select("search"));
    await waitFor(() => expect(document.querySelector("[cmdk-root]")).not.toBeNull());
  });

  it("side from nav@1 is written as data-strip", () => {
    const fake = fakeNav("left");
    const listeners = new Set<() => void>();
    const shell = {
      ...shellWith({ "nav@1": fake.nav }),
      on: (_e: string, l: () => void) => {
        listeners.add(l);
        return () => listeners.delete(l);
      },
    };
    install(shell);
    renderFrame(shellOf(ME, pending));
    expect(document.documentElement.getAttribute("data-strip")).toBe("left");
    // a live split change: the side moves with change
    act(() => {
      shell.capabilities = { "nav@1": { ...fake.nav, side: "right" } };
      for (const l of [...listeners]) l();
    });
    expect(document.documentElement.getAttribute("data-strip")).toBe("right");
  });

  it("has no strip without nav@1", () => {
    renderFrame(shellOf(ME));
    expect(document.querySelector("[data-native-nav]")).toBeNull();
  });
});

describe("profiles@1: 切换平台", () => {
  async function openAccountSheet() {
    const bar = document.querySelector('[data-part="floating-bar"]') as HTMLElement;
    await userEvent.click(within(bar).getByRole("button", { name: /^打开菜单/ }));
    await userEvent.click(within(drawerEl() as HTMLElement).getByRole("button", { name: /Grant/ }));
    return document.querySelector('[data-part="account-sheet"]') as HTMLElement;
  }

  it("shows in the account sheet only with profiles@1 and calls show() inside the click", async () => {
    const show = vi.fn(async () => {});
    install(shellWith({ "profiles@1": { show } }));
    renderFrame(shellOf(ME, pending));
    const sheet = await openAccountSheet();
    const row = within(sheet).getByRole("button", { name: "切换平台" });
    fireEvent.click(row);
    // synchronously, in the click's handler (the shell needs the user activation)
    expect(show).toHaveBeenCalledTimes(1);
  });

  it("is absent without profiles@1", async () => {
    renderFrame(shellOf(ME, pending));
    const sheet = await openAccountSheet();
    expect(within(sheet).queryByRole("button", { name: "切换平台" })).toBeNull();
  });

  it("the sidebar's account menu has it too on a wide window", async () => {
    window_(1000);
    const show = vi.fn(async () => {});
    install(shellWith({ "profiles@1": { show } }));
    renderFrame(shellOf(ME, pending));
    const side = document.querySelector(".cb-sidebar") as HTMLElement;
    await userEvent.click(within(side).getByRole("button", { name: /Grant/ }));
    const item = await waitFor(() => {
      const el = [...document.querySelectorAll('[role="menuitem"]')].find(
        (e) => e.textContent === "切换平台",
      );
      if (!el) throw new Error("no 切换平台");
      return el as HTMLElement;
    });
    await userEvent.click(item);
    expect(show).toHaveBeenCalledTimes(1);
  });
});

describe("downloads in a shell with openExternal@1", () => {
  const ROUTE = "/api/v1/orgs/o1/files/f1/download";
  const PRESIGNED = "https://store.example/bucket/f1?X-Amz-Signature=abc";
  function Download({ url, isPublic }: { url: string; isPublic?: boolean }) {
    const open = useOpenDownload();
    return (
      <button type="button" onClick={() => open(url, isPublic ? { public: true } : {})}>
        下载
      </button>
    );
  }

  it("hand the system browser the presigned URL from the JSON form, never the cookie route", async () => {
    const open = vi.fn(async () => {});
    install(shellWith({ "openExternal@1": { open } }));
    const popup = vi.spyOn(window, "open");
    // the kernel route needs the app's session cookie: without it (the system browser) it is a 401
    const calls = stubApi({
      [`GET ${ROUTE}`]: () => json(401, { error: { code: "auth.required", message: "x" } }),
      [`GET ${ROUTE}?as=url`]: () => json(200, { url: PRESIGNED }),
    });
    const { getByRole } = renderPage(<Download url={ROUTE} />);
    fireEvent.click(getByRole("button", { name: "下载" }));
    await waitFor(() => expect(open).toHaveBeenCalledTimes(1));
    expect(open).toHaveBeenCalledWith(PRESIGNED);
    expect(calls.map((c) => c.url)).toEqual([`${ROUTE}?as=url`]);
    expect(popup).not.toHaveBeenCalled();
  });

  it("a sign-in that is really gone opens nothing and says so here", async () => {
    const open = vi.fn(async () => {});
    install(shellWith({ "openExternal@1": { open } }));
    stubApi({
      [`GET ${ROUTE}?as=url`]: () => json(401, { error: { code: "auth.required", message: "x" } }),
      "POST /api/v1/auth/refresh": () =>
        json(401, { error: { code: "auth.required", message: "x" } }),
    });
    const { getByRole, findByRole } = renderPage(<Download url={ROUTE} />);
    fireEvent.click(getByRole("button", { name: "下载" }));
    expect(await findByRole("status")).toBeTruthy();
    expect(open).not.toHaveBeenCalled();
  });

  it("a public share link needs no session: it goes to the system browser as is", () => {
    const open = vi.fn(async () => {});
    install(shellWith({ "openExternal@1": { open } }));
    const calls = stubApi({});
    const { getByRole } = renderPage(<Download url="/api/v1/s/abc/inline" isPublic />);
    fireEvent.click(getByRole("button", { name: "下载" }));
    expect(open).toHaveBeenCalledWith(new URL("/api/v1/s/abc/inline", window.location.href).href);
    expect(calls).toEqual([]);
  });

  it("without openExternal@1 a public link opens in a new tab as before", () => {
    const popup = vi.spyOn(window, "open").mockReturnValue(null);
    const { getByRole } = renderPage(<Download url="/api/v1/s/abc/inline" isPublic />);
    fireEvent.click(getByRole("button", { name: "下载" }));
    expect(popup).toHaveBeenCalledWith("/api/v1/s/abc/inline", "_blank", "noopener,noreferrer");
  });
});

describe("DesignRoot", () => {
  function Probe() {
    const native = useNative();
    const buzz = useHaptics();
    return (
      <button
        type="button"
        data-has={Object.keys(native ?? {}).join(",")}
        onClick={() => buzz("light")}
      >
        x
      </button>
    );
  }

  it("provides only the present capabilities and plays haptics through impact", () => {
    const impact = vi.fn(async () => {});
    install(shellWith({ "haptics@1": { impact } }));
    const { getByRole } = render(
      <DesignRoot locale="en">
        <Probe />
      </DesignRoot>,
    );
    expect(getByRole("button").getAttribute("data-has")).toBe("haptics");
    getByRole("button").click();
    expect(impact).toHaveBeenCalledWith("light");
  });

  it("tells chrome@1 the page has drawn, once", async () => {
    const ready = vi.fn(async () => {});
    install(shellWith({ "chrome@1": { setAppearance: vi.fn(), ready } }));
    render(
      <DesignRoot locale="en">
        <p>page</p>
      </DesignRoot>,
    );
    await waitFor(() => expect(ready).toHaveBeenCalledTimes(1));
  });
});
