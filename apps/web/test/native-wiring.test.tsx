// The native wiring (mobile app spec §6): the frame hands the shell's nav@1 strip to the design
// (the sections with the inbox count, taps navigate, the strip's menu button opens the drawer) and
// profiles@1 to the account sheet and menu as 「切换平台」; downloads go to the system browser in a
// shell with openExternal@1; DesignRoot passes the shell's menu / share / haptics and tells
// chrome@1 the page has drawn.
import { useHaptics, useNative } from "@capybara-hq/design";
import { act, cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DesignRoot } from "../src/components/design-root";
import { useOpenDownload } from "../src/components/SessionFilePreview";
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
    const matches = /pointer/.test(t)
      ? !t.startsWith("(any-pointer: fine)")
      : features.length > 0 &&
        features.every(([, k, n]) => (k === "min" ? width >= Number(n) : width <= Number(n)));
    return { matches, media: q, addEventListener() {}, removeEventListener() {} };
  });
}

function fakeNav() {
  const select = new Set<(id: string) => void>();
  const menu = new Set<() => void>();
  return {
    nav: {
      set: vi.fn(async (_state: unknown) => {}),
      onSelect: vi.fn((l: (id: string) => void) => {
        select.add(l);
        return () => select.delete(l);
      }),
      onMenu: vi.fn((l: () => void) => {
        menu.add(l);
        return () => menu.delete(l);
      }),
    },
    select: (id: string) => {
      for (const l of [...select]) l(id);
    },
    menu: () => {
      for (const l of [...menu]) l();
    },
  };
}

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
});

describe("AppFrame with nav@1", () => {
  it("hands the strip the sections with the inbox count; a tap navigates, the menu opens the drawer", () => {
    const fake = fakeNav();
    install(shellWith({ "nav@1": fake.nav }));
    renderFrame(shellOf(ME, pending));
    expect(document.querySelector(".cb-shell")?.hasAttribute("data-native-nav")).toBe(true);
    expect(fake.nav.set).toHaveBeenCalled();
    const state = fake.nav.set.mock.calls.at(-1)?.[0] as {
      items: { id: string; count?: number }[];
      current: string | null;
      menu: { label: string; count?: number } | null;
    };
    expect(state.items.map((i) => i.id)).toEqual(["chats", "inbox", "agents", "schedules"]);
    expect(state.items[1]?.count).toBe(3);
    expect(state.current).toBe("chats");
    expect(state.menu).toEqual({ label: "打开菜单", count: 3 });
    act(() => fake.select("inbox"));
    expect(router.push).toHaveBeenCalledWith("/inbox");
    expect(drawerEl()).toBeNull();
    act(() => fake.menu());
    expect(drawerEl()).not.toBeNull();
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
  function Download({ url }: { url: string }) {
    const open = useOpenDownload();
    return (
      <button type="button" onClick={() => open(url)}>
        下载
      </button>
    );
  }

  it("go to the system browser inside the click, not a blank popup", () => {
    const open = vi.fn(async () => {});
    install(shellWith({ "openExternal@1": { open } }));
    const popup = vi.spyOn(window, "open");
    const { getByRole } = renderPage(<Download url="/api/v1/orgs/o1/attachments/f1/download" />);
    fireEvent.click(getByRole("button", { name: "下载" }));
    expect(open).toHaveBeenCalledWith(
      new URL("/api/v1/orgs/o1/attachments/f1/download", window.location.href).href,
    );
    expect(popup).not.toHaveBeenCalled();
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
