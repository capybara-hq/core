import { act, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Call, json, stubApi } from "./support/api";
import {
  AGENTS,
  CONV,
  ev,
  FakeEventSource,
  MODELS,
  renderChatRoute,
  runStarted,
  userMsg,
} from "./support/conversation";
import { resetNavigation } from "./support/navigation";

vi.mock("../src/i18n/navigation", () => import("./support/navigation"));
vi.mock("next/navigation", () => ({ useParams: () => ({ conversationId: "c1" }) }));

const ORG = "/api/v1/orgs/o1";
const UI = `${ORG}/ui`;
const BASE = `${ORG}/conversations/c1`;

const EMBED = {
  plugin: "board",
  id: "live",
  title: { zh: "实时", en: "Live" },
  slot: "conversation.panel",
  kind: "embed",
  icon: "layout-grid",
};

function api(extra: Record<string, (c: Call) => Response | Promise<Response>> = {}) {
  return stubApi({
    [`GET ${BASE}`]: () => json(200, CONV()),
    [`GET ${BASE}/events`]: () => json(200, { events: [userMsg(1, "hi")] }),
    [`GET ${BASE}/queue`]: () => json(200, { items: [], paused: false }),
    [`GET ${BASE}/files`]: () => json(200, { files: [], next: null }),
    [`GET ${BASE}/device`]: () => json(200, { device: null }),
    [`GET ${BASE}/tools`]: () => json(200, { tools: [] }),
    [`GET ${ORG}/agents`]: () => json(200, AGENTS),
    [`GET ${ORG}/models`]: () => json(200, MODELS),
    [`GET ${ORG}/connectors`]: () => json(200, { connectors: [] }),
    [`GET ${UI}/contributions`]: () => json(200, { items: [EMBED] }),
    [`POST ${UI}/embeds/board/live/token`]: () =>
      json(200, {
        token: "tok-1",
        src: "/plugin-ui/board/live",
        expiresAt: new Date(Date.now() + 300_000).toISOString(),
        expiresIn: 300,
      }),
    ...extra,
  });
}

beforeEach(() => {
  resetNavigation("/chat/c1");
  window.history.replaceState(null, "", "/chat/c1#panel=board/live");
  vi.stubGlobal("EventSource", FakeEventSource);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  FakeEventSource.instances = [];
});

const isFull = () => document.querySelector('[data-right-full="true"]') !== null;

describe("a conversation.panel embed switches the panel's full mode", () => {
  it("panel-mode full=true maximises the panel, full=false restores", async () => {
    api();
    await renderChatRoute();
    const frame = await vi.waitFor(() => {
      const f = document.querySelector('iframe[title="Live"]');
      if (!f) throw new Error("no iframe yet");
      return f as HTMLIFrameElement;
    });
    expect(frame).toBeTruthy();
    // Always address the current frame, once it is there.
    const fromFrame = (data: unknown) => {
      const current = document.querySelector('iframe[title="Live"]') as HTMLIFrameElement | null;
      if (!current) throw new Error("no iframe yet");
      act(() => {
        window.dispatchEvent(
          new MessageEvent("message", { data, source: current.contentWindow as Window }),
        );
      });
    };
    const msg = (full: unknown) => ({ protocol: "capybara-embed/1", type: "panel-mode", full });
    expect(isFull()).toBe(false);
    // the listener is a passive effect: retry until the bridge answers
    await vi.waitFor(() => {
      fromFrame(msg(true));
      expect(isFull()).toBe(true);
    });
    await vi.waitFor(() => {
      fromFrame(msg(false));
      expect(isFull()).toBe(false);
    });
    // a non-boolean `full` changes nothing
    await vi.waitFor(() => {
      fromFrame(msg("true"));
      expect(isFull()).toBe(false);
    });
  });

  it("the embed keeps its own height in the normal panel and fills the panel when maximised", async () => {
    api();
    await renderChatRoute();
    const current = () =>
      document.querySelector('iframe[title="Live"]') as HTMLIFrameElement | null;
    await vi.waitFor(() => {
      if (!current()) throw new Error("no iframe yet");
    });
    expect(current()?.getAttribute("data-fill")).toBeNull();
    expect(current()?.getAttribute("height")).toBe("360");
    const msg = (full: boolean) => ({ protocol: "capybara-embed/1", type: "panel-mode", full });
    const fromFrame = (data: unknown) => {
      const f = current();
      if (!f) throw new Error("no iframe yet");
      act(() => {
        window.dispatchEvent(
          new MessageEvent("message", { data, source: f.contentWindow as Window }),
        );
      });
    };
    await vi.waitFor(() => {
      fromFrame(msg(true));
      expect(isFull()).toBe(true);
    });
    await vi.waitFor(() => {
      expect(current()?.getAttribute("data-fill")).toBe("true");
    });
    expect(current()?.hasAttribute("height")).toBe(false);
    await vi.waitFor(() => {
      fromFrame(msg(false));
      expect(isFull()).toBe(false);
    });
    await vi.waitFor(() => {
      expect(current()?.getAttribute("data-fill")).toBeNull();
    });
  });

  it("the frame stays mounted across a full-mode switch and is told each mode (panel-mode)", async () => {
    api();
    await renderChatRoute();
    const frame = await vi.waitFor(() => {
      const f = document.querySelector('iframe[title="Live"]');
      if (!f) throw new Error("no iframe yet");
      return f as HTMLIFrameElement;
    });
    const win = frame.contentWindow as Window;
    const posted: { type?: string; full?: boolean }[] = [];
    vi.spyOn(win, "postMessage").mockImplementation((m: unknown) => {
      posted.push(m as { type?: string; full?: boolean });
    });
    act(() => {
      frame.dispatchEvent(new Event("load"));
    });
    const modes = () => posted.filter((m) => m.type === "panel-mode").map((m) => m.full);
    // init first, then the mode right after it
    await vi.waitFor(() => expect(modes()).toEqual([false]));
    expect(posted[0]?.type).toBe("init");
    const fromFrame = (full: boolean) =>
      act(() => {
        window.dispatchEvent(
          new MessageEvent("message", {
            data: { protocol: "capybara-embed/1", type: "panel-mode", full },
            source: win,
          }),
        );
      });
    await vi.waitFor(() => {
      fromFrame(true);
      expect(isFull()).toBe(true);
    });
    expect(document.querySelector('iframe[title="Live"]')).toBe(frame);
    await vi.waitFor(() => expect(modes()).toEqual([false, true]));
    // the host leaves full mode on its own (Esc): the embed is told, the frame is the same one
    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    await vi.waitFor(() => expect(isFull()).toBe(false));
    expect(document.querySelector('iframe[title="Live"]')).toBe(frame);
    await vi.waitFor(() => expect(modes()).toEqual([false, true, false]));
    // one init for the whole life of the frame (no remount, no new handshake)
    expect(posted.filter((m) => m.type === "init")).toHaveLength(1);
  });
});

describe("a plugin tool's question names a panel (InputRequired.open)", () => {
  const asked = (seq: number, id: string, open?: Record<string, unknown>) =>
    ev(seq, "question_asked", {
      step: 0,
      callId: `call-${id}`,
      questionId: id,
      form: { title: "Please sign in", fields: [] },
      expiresAt: "2099-01-01T00:00:00.000Z",
      ...(open !== undefined && { open }),
    });
  const panelShown = () => document.querySelector('iframe[title="Live"]') !== null;
  const stream = () => FakeEventSource.instances[0] as FakeEventSource;

  beforeEach(() => {
    window.history.replaceState(null, "", "/chat/c1");
  });

  it("opens the panel when the question arrives", async () => {
    api();
    await renderChatRoute();
    await vi.waitFor(() => expect(FakeEventSource.instances.length).toBeGreaterThan(0));
    expect(panelShown()).toBe(false);
    act(() => stream().emit("event", runStarted(2)));
    act(() => stream().emit("event", asked(3, "q1", { plugin: "board", contribution: "live" })));
    await vi.waitFor(() => expect(panelShown()).toBe(true));
    expect(window.location.hash).toBe("#panel=board/live");
  });

  it("a question already in the log, another plugin's panel or none opens nothing", async () => {
    api({
      [`GET ${BASE}/events`]: () =>
        json(200, {
          events: [
            userMsg(1, "hi"),
            runStarted(2),
            asked(3, "q0", { plugin: "board", contribution: "live" }),
          ],
        }),
    });
    await renderChatRoute();
    await vi.waitFor(() => expect(FakeEventSource.instances.length).toBeGreaterThan(0));
    act(() => {
      stream().emit("event", asked(4, "q1", { plugin: "other", contribution: "live" }));
      stream().emit("event", asked(5, "q2"));
    });
    // the stream's events are on the page (the question cards), and still no panel
    await vi.waitFor(() => expect(document.body.textContent).toContain("Please sign in"));
    expect(panelShown()).toBe(false);
    expect(window.location.hash).toBe("");
  });
});
