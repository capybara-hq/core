// The shell's state hooks (client extensions spec §7.3): `data-cap-state` on the shell element.
import { act, cleanup, render } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { usePublishRunState } from "../src/components/client-ext/run-state";
import type { ThemeRef } from "../src/lib/themes";
import { resetNavigation } from "./support/navigation";
import { ME } from "./support/render";
import { frameElement, renderFrame, shellOf } from "./support/shell";
import { themeCssUrl } from "./support/themes";

vi.mock("../src/i18n/navigation", () => import("./support/navigation"));

const NEON: ThemeRef = {
  id: "t-neon",
  key: "neon/neon-grid",
  version: "1",
  name: { en: "Neon Grid" },
  schemes: ["dark"],
  singleScheme: "dark",
  logo: null,
  cssUrl: themeCssUrl("t-neon", "1"),
};

const shell = () => document.querySelector('[data-cap-part~="shell"]') as HTMLElement;
const tokens = () => (shell().getAttribute("data-cap-state") ?? "").split(" ");

/** A conversation page stand-in that publishes `state`. */
function Page({ id, state }: { id: string; state: "running" | "waiting" | "failed" | "idle" }) {
  usePublishRunState(id, state);
  return <p>conversation</p>;
}

const realMatchMedia = window.matchMedia;
beforeEach(() => resetNavigation("/chat/c1"));
afterEach(() => {
  cleanup();
  window.matchMedia = realMatchMedia;
});

const mediaMock = (reduced: boolean) => {
  const listeners = new Set<() => void>();
  let value = reduced;
  window.matchMedia = ((query: string) => ({
    get matches() {
      return query.includes("prefers-reduced-motion") ? value : false;
    },
    addEventListener: (_: string, cb: () => void) => listeners.add(cb),
    removeEventListener: (_: string, cb: () => void) => listeners.delete(cb),
  })) as unknown as typeof window.matchMedia;
  return (next: boolean) => {
    value = next;
    for (const l of [...listeners]) l();
  };
};

describe("data-cap-state", () => {
  it("the server render writes run=idle and the theme token", () => {
    const html = renderToString(frameElement(shellOf(ME, { theme: NEON })));
    const state = /data-cap-state="([^"]*)"/.exec(html)?.[1] ?? "";
    expect(state.split(" ")).toEqual(["run=idle", "theme=neon/neon-grid"]);
    const builtin = /data-cap-state="([^"]*)"/.exec(renderToString(frameElement(shellOf(ME))));
    expect(builtin?.[1]).toBe("run=idle theme=builtin");
  });

  it("sign-in=new is in the server render of the first workspace document, after the theme", () => {
    const html = renderToString(
      frameElement(shellOf(ME, { theme: NEON }), undefined, { newSignIn: true }),
    );
    const state = /data-cap-state="([^"]*)"/.exec(html)?.[1] ?? "";
    expect(state.split(" ")).toEqual(["run=idle", "theme=neon/neon-grid", "sign-in=new"]);
  });

  it("sign-in=new stays through runs and navigations of that document", () => {
    mediaMock(false);
    const view = renderFrame(shellOf(ME), <Page id="c1" state="running" />, { newSignIn: true });
    expect(tokens()).toEqual([
      "run=running",
      "theme=builtin",
      "sign-in=new",
      "motion=full",
      "sidebar=full",
    ]);
    view.update(shellOf(ME), <p>another page</p>);
    expect(tokens()).toContain("sign-in=new");
  });

  it("a run turns run=running then run=failed until the next run", () => {
    const view = renderFrame(shellOf(ME), <Page id="c1" state="idle" />);
    expect(tokens()).toContain("run=idle");
    const show = (state: "running" | "waiting" | "failed" | "idle") =>
      view.update(shellOf(ME), <Page id="c1" state={state} />);
    show("running");
    expect(tokens()).toContain("run=running");
    expect(tokens()).not.toContain("run=idle");
    show("waiting");
    expect(tokens()).toContain("run=waiting");
    show("failed");
    expect(tokens()).toContain("run=failed");
    // it stays failed through a re-render, until the next run starts
    show("failed");
    expect(tokens()).toContain("run=failed");
    show("running");
    expect(tokens()).toContain("run=running");
  });

  it("leaving the conversation page writes run=idle", () => {
    const view = renderFrame(shellOf(ME), <Page id="c1" state="running" />);
    expect(tokens()).toContain("run=running");
    view.update(shellOf(ME), <p>another page</p>);
    expect(tokens()).toContain("run=idle");
  });

  it("motion=reduced follows the media query after hydration", () => {
    const set = mediaMock(true);
    renderFrame(shellOf(ME));
    expect(tokens()).toContain("motion=reduced");
    act(() => set(false));
    expect(tokens()).toContain("motion=full");
    expect(tokens()).not.toContain("motion=reduced");
  });

  it("publishes the sidebar mode next to run, theme and motion", () => {
    mediaMock(false);
    renderFrame(shellOf(ME, { theme: NEON }));
    expect(tokens()).toEqual(["run=idle", "theme=neon/neon-grid", "motion=full", "sidebar=full"]);
  });

  it("no motion token where there is no matchMedia (the server's first paint)", () => {
    window.matchMedia = undefined as unknown as typeof window.matchMedia;
    render(frameElement(shellOf(ME)));
    expect(tokens().some((t) => t.startsWith("motion="))).toBe(false);
  });
});
