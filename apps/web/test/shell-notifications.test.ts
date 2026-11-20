// @vitest-environment jsdom
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import { useShellNotifications } from "../src/lib/use-shell-notifications";
import { json, stubApi } from "./support/api";
import { pageElement, testQueryClient } from "./support/render";

const URL = "GET /api/v1/orgs/o1/inbox";
const item = (id: string, type = "tool_approval") => ({
  type,
  id,
  createdAt: "2026-11-07T08:00:00.000Z",
});

function installNotify(notify: unknown) {
  (window as unknown as { capybaraShell?: unknown }).capybaraShell = {
    version: 1,
    capabilities: notify === undefined ? {} : { "notify@1": { notify } },
    on: () => () => {},
  };
}
function setVisibility(state: "hidden" | "visible") {
  Object.defineProperty(document, "visibilityState", { value: state, configurable: true });
}

let inbox: unknown[] = [];
const client = () => testQueryClient();
function mount() {
  const qc = client();
  const wrapper = ({ children }: { children: ReactNode }) =>
    pageElement(createElement("div", null, children), { client: qc });
  const r = renderHook(() => useShellNotifications("o1"), { wrapper });
  return { qc, ...r };
}
const refetch = (qc: ReturnType<typeof client>) =>
  qc.invalidateQueries({ queryKey: ["org", "o1", "inbox"] });

beforeEach(() => {
  inbox = [];
  window.sessionStorage.clear();
  stubApi({ [URL]: () => json(200, { items: inbox, truncated: false }) });
});
afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, "capybaraShell");
  setVisibility("visible");
});

describe("shell notifications", () => {
  it("a new item notifies once while hidden, with title, body and path", async () => {
    const notify = vi.fn().mockResolvedValue(undefined);
    installNotify(notify);
    inbox = [item("a")];
    const { qc } = mount();
    // the first read only records what already waits
    await waitFor(() =>
      expect(window.sessionStorage.getItem("capybara.shell.notified.o1")).toBe('["a"]'),
    );
    expect(notify).not.toHaveBeenCalled();
    setVisibility("hidden");
    inbox = [item("b"), item("a")];
    await refetch(qc);
    await waitFor(() => expect(notify).toHaveBeenCalledTimes(1));
    expect(notify).toHaveBeenCalledWith({
      title: en.shellNotify.title,
      body: en.shellNotify.tool_approval,
      path: "/inbox",
    });
    // the same item never notifies twice
    await refetch(qc);
    await refetch(qc);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("a reload in the same session does not notify an item again", async () => {
    const notify = vi.fn().mockResolvedValue(undefined);
    installNotify(notify);
    inbox = [item("a")];
    const first = mount();
    await waitFor(() =>
      expect(window.sessionStorage.getItem("capybara.shell.notified.o1")).not.toBeNull(),
    );
    setVisibility("hidden");
    inbox = [item("b"), item("a")];
    await refetch(first.qc);
    await waitFor(() => expect(notify).toHaveBeenCalledTimes(1));
    first.unmount();
    mount();
    await waitFor(() =>
      expect(window.sessionStorage.getItem("capybara.shell.notified.o1")).toContain("b"),
    );
    await refetch(client());
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("a visible window does not notify", async () => {
    const notify = vi.fn().mockResolvedValue(undefined);
    installNotify(notify);
    const { qc } = mount();
    await waitFor(() =>
      expect(window.sessionStorage.getItem("capybara.shell.notified.o1")).toBe("[]"),
    );
    inbox = [item("c")];
    await refetch(qc);
    await waitFor(() =>
      expect(window.sessionStorage.getItem("capybara.shell.notified.o1")).toBe('["c"]'),
    );
    expect(notify).not.toHaveBeenCalled();
  });

  it("without notify@1 nothing is read or called", async () => {
    installNotify(undefined);
    const calls = stubApi({ [URL]: () => json(200, { items: [item("a")], truncated: false }) });
    mount();
    await new Promise((r) => setTimeout(r, 0));
    expect(calls.filter((c) => c.url.includes("/inbox"))).toHaveLength(0);
  });

  it("more than three fresh items in one read collapse into one notification", async () => {
    const notify = vi.fn().mockResolvedValue(undefined);
    installNotify(notify);
    const { qc } = mount();
    await waitFor(() =>
      expect(window.sessionStorage.getItem("capybara.shell.notified.o1")).toBe("[]"),
    );
    setVisibility("hidden");
    inbox = [item("a"), item("b"), item("c"), item("d")];
    await refetch(qc);
    await waitFor(() => expect(notify).toHaveBeenCalledTimes(1));
    expect(notify).toHaveBeenCalledWith({
      title: en.shellNotify.title,
      body: en.shellNotify.other,
      path: "/inbox",
    });
  });

  it("keeps its handled ids per org", async () => {
    installNotify(vi.fn().mockResolvedValue(undefined));
    inbox = [item("a")];
    mount();
    await waitFor(() =>
      expect(window.sessionStorage.getItem("capybara.shell.notified.o1")).toBe('["a"]'),
    );
    expect(window.sessionStorage.getItem("capybara.shell.notified.o2")).toBeNull();
    expect(window.sessionStorage.getItem("capybara.shell.notified")).toBeNull();
  });
});
