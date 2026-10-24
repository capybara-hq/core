import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import zh from "../messages/zh.json";
import ChatPage from "../src/app/[locale]/(app)/chat/[conversationId]/page";
import { json, stubApi } from "./support/api";
import { resetNavigation } from "./support/navigation";
import { renderPage } from "./support/render";

vi.mock("../src/i18n/navigation", () => import("./support/navigation"));
const params = vi.hoisted(() => ({ current: {} as Record<string, string> }));
vi.mock("next/navigation", () => ({ useParams: () => params.current }));

const ORG = "/api/v1/orgs/o1";
const BASE = `${ORG}/conversations/c1`;
const UI = `${ORG}/ui`;

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  readonly listeners = new Map<string, ((e: Event) => void)[]>();
  readyState = 1;
  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }
  addEventListener(type: string, fn: (e: Event) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  close() {
    this.readyState = 2;
  }
  emit(type: string, data?: unknown) {
    const e =
      data === undefined ? new Event(type) : new MessageEvent(type, { data: JSON.stringify(data) });
    for (const fn of this.listeners.get(type) ?? []) fn(e);
  }
}
const convStream = () =>
  FakeEventSource.instances.find((s) => s.url.startsWith(`${BASE}/stream`)) as FakeEventSource;

function ev(seq: number, type: string, payload: unknown, runId: string | null = "r1") {
  return {
    conversationId: "c1",
    seq,
    type,
    payload,
    runId,
    createdAt: new Date(Date.UTC(2026, 9, 21, 8, 0, seq)).toISOString(),
  };
}
const userMsg = (seq: number, text: string) =>
  ev(seq, "user_message", { content: [{ type: "text", text }], authorAccountId: "a1" }, null);
const artifact = (seq: number, id: string, name: string, contentType: string, size: number) =>
  ev(seq, "artifact_created", {
    artifactId: id,
    name,
    contentType,
    size,
    objectKey: `artifacts/c1/${id}`,
    sourcePath: `/workspace/${name}`,
    callId: `call_${seq}`,
  });
const sandboxResult = (seq: number) =>
  ev(seq, "tool_result", {
    step: 0,
    callId: `call_${seq}`,
    toolKey: "sandbox_bash",
    content: "ok",
    isError: false,
  });

beforeEach(() => {
  resetNavigation("/chat/c1");
  params.current = { conversationId: "c1" };
  vi.stubGlobal("EventSource", FakeEventSource);
  try {
    localStorage.clear();
  } catch {}
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  FakeEventSource.instances = [];
});

const panelOf = () => screen.getByRole("complementary");
const NO_SANDBOX = () => json(404, { error: { code: "sandbox.not_found", message: "none" } });

describe("产物标签", () => {
  it("有 artifact_created 时出现「产物」标签并带数量；列出名称 / 类型 / 大小 / 时间，图片 inline 预览、文本显示开头、都能下载", async () => {
    const calls = stubApi({
      [`GET ${BASE}/events`]: () =>
        json(200, {
          events: [
            userMsg(1, "make a chart"),
            artifact(2, "a1", "chart.png", "image/png", 2048),
            artifact(3, "a2", "report.csv", "text/csv", 8),
            artifact(4, "a3", "bundle.zip", "application/zip", 3 * 1024 * 1024),
          ],
        }),
      [`GET ${UI}/contributions`]: () => json(200, { items: [] }),
      [`GET ${BASE}/artifacts/a2/preview`]: () =>
        json(200, { preview: { text: "a,b\n1,2", truncated: true } }),
    });
    renderPage(<ChatPage />, { locale: "zh" });
    const tab = await within(panelOf()).findByRole("tab", {
      name: new RegExp(zh.chatPanel.artifacts),
    });
    expect(tab.textContent).toContain("3");
    await userEvent.setup().click(tab);
    const panel = within(panelOf()).getByRole("tabpanel");

    // 最新的在前
    const cards = within(panel).getAllByRole("group");
    expect(cards.map((c) => c.getAttribute("aria-label"))).toEqual([
      "bundle.zip",
      "report.csv",
      "chart.png",
    ]);
    const card = (name: string) => within(panel).getByRole("group", { name });

    // 图片：inline 地址的缩略图（只对位图要 inline）
    const img = within(card("chart.png")).getByRole("img", { name: "chart.png" });
    expect(img.getAttribute("src")).toBe(`${BASE}/artifacts/a1/download?inline=1`);
    expect(within(card("chart.png")).getByText("PNG")).toBeTruthy();
    expect(within(card("chart.png")).getByText("2 KB")).toBeTruthy();

    // 文本：开头几行（纯文本）与「只显示开头」的提示
    const csv = card("report.csv");
    expect(await within(csv).findByText(/a,b\s+1,2/)).toBeTruthy();
    expect(within(csv).getByText(zh.chatPanel.previewTruncated)).toBeTruthy();
    expect(within(csv).getByText("CSV")).toBeTruthy();
    expect(within(csv).getByText("8 B")).toBeTruthy();

    // 其他类型：不预览，只能下载
    expect(within(card("bundle.zip")).queryByRole("img")).toBeNull();
    expect(within(card("bundle.zip")).getByText("3 MB")).toBeTruthy();
    expect(calls.filter((c) => c.url.includes("/preview")).map((c) => c.url)).toEqual([
      `${BASE}/artifacts/a2/preview`,
    ]);

    // 每个都有下载链接（attachment，不带 inline）
    for (const [name, id] of [
      ["chart.png", "a1"],
      ["report.csv", "a2"],
      ["bundle.zip", "a3"],
    ] as const) {
      const link = within(card(name))
        .getAllByRole("link")
        .find((l) => l.getAttribute("href") === `${BASE}/artifacts/${id}/download`);
      expect(link, name).toBeTruthy();
      expect(link?.textContent).toContain(zh.chatPanel.download);
    }
    // 时间（按界面语言格式化）
    expect(
      within(card("report.csv")).getByText(
        new Date(Date.UTC(2026, 9, 21, 8, 0, 3)).toLocaleString("zh", {
          dateStyle: "short",
          timeStyle: "short",
        }),
      ),
    ).toBeTruthy();
  });

  it("缩略图 401（登录过期）：先确认登录（刷新一次）再带 retry 重载一次；再失败不再重试", async () => {
    let expired = true;
    const calls = stubApi({
      [`GET ${BASE}/events`]: () =>
        json(200, {
          events: [userMsg(1, "chart"), artifact(2, "a1", "chart.png", "image/png", 9)],
        }),
      [`GET ${UI}/contributions`]: () => json(200, { items: [] }),
      "GET /api/v1/me": () =>
        expired
          ? json(401, { error: { code: "auth.token_expired", message: "expired" } })
          : json(200, { account: { id: "a1" } }),
      "POST /api/v1/auth/refresh": () => {
        expired = false;
        return new Response(null, { status: 204 });
      },
    });
    renderPage(<ChatPage />, { locale: "en" });
    const tab = await within(panelOf()).findByRole("tab", {
      name: new RegExp(en.chatPanel.artifacts),
    });
    await userEvent.setup().click(tab);
    const panel = within(panelOf()).getByRole("tabpanel");
    const img = () => within(panel).getByRole("img", { name: "chart.png" });
    fireEvent.error(img());
    await vi.waitFor(() =>
      expect(img().getAttribute("src")).toBe(`${BASE}/artifacts/a1/download?inline=1&retry=1`),
    );
    expect(calls.filter((c) => c.url === "/api/v1/auth/refresh")).toHaveLength(1);
    fireEvent.error(img());
    await new Promise((r) => setTimeout(r, 20));
    expect(img().getAttribute("src")).toBe(`${BASE}/artifacts/a1/download?inline=1&retry=1`);
    expect(calls.filter((c) => c.url === "/api/v1/me")).toHaveLength(2);
  });

  it("文本预览按纯文本显示（HTML 不渲染）；预览失败时只提示，下载仍在", async () => {
    stubApi({
      [`GET ${BASE}/events`]: () =>
        json(200, {
          events: [
            artifact(1, "h1", "page.html", "text/html", 30),
            artifact(2, "n1", "notes.txt", "text/plain", 10),
          ],
        }),
      [`GET ${UI}/contributions`]: () => json(200, { items: [] }),
      [`GET ${BASE}/artifacts/h1/preview`]: () =>
        json(200, { preview: { text: "<b>bold</b><script>x()</script>", truncated: false } }),
      [`GET ${BASE}/artifacts/n1/preview`]: () =>
        json(404, { error: { code: "conversation.artifact_not_found", message: "gone" } }),
    });
    renderPage(<ChatPage />, { locale: "en" });
    await userEvent
      .setup()
      .click(
        await within(panelOf()).findByRole("tab", { name: new RegExp(en.chatPanel.artifacts) }),
      );
    const panel = within(panelOf()).getByRole("tabpanel");
    expect(await within(panel).findByText("<b>bold</b><script>x()</script>")).toBeTruthy();
    expect(panel.querySelector("b")).toBeNull();
    expect(panel.querySelector("script")).toBeNull();
    expect(await within(panel).findByText(en.errors.conversation.artifact_not_found)).toBeTruthy();
    expect(
      within(panel)
        .getAllByRole("link")
        .some((l) => l.getAttribute("href") === `${BASE}/artifacts/n1/download`),
    ).toBe(true);
  });

  it("没有产物时不显示标签；SSE 收到 artifact_created 后标签立即出现（不用刷新）", async () => {
    stubApi({
      [`GET ${BASE}/events`]: () => json(200, { events: [userMsg(1, "hi")] }),
      [`GET ${UI}/contributions`]: () => json(200, { items: [] }),
    });
    renderPage(<ChatPage />, { locale: "en" });
    await within(panelOf()).findByRole("tab", { name: new RegExp(en.chatPanel.run) });
    expect(
      within(panelOf()).queryByRole("tab", { name: new RegExp(en.chatPanel.artifacts) }),
    ).toBeNull();
    await vi.waitFor(() => expect(convStream()).toBeTruthy());
    convStream().emit("event", artifact(2, "a1", "out.bin", "application/octet-stream", 5));
    const tab = await within(panelOf()).findByRole("tab", {
      name: new RegExp(en.chatPanel.artifacts),
    });
    expect(tab.textContent).toContain("1");
    convStream().emit("event", artifact(3, "a2", "out2.bin", "application/octet-stream", 5));
    await vi.waitFor(() => expect(tab.textContent).toContain("2"));
  });
});

describe("上下文标签：沙箱状态", () => {
  const openContext = async (locale: "zh" | "en") => {
    const m = locale === "zh" ? zh : en;
    await userEvent
      .setup()
      .click(await within(panelOf()).findByRole("tab", { name: new RegExp(m.chatPanel.context) }));
    return within(panelOf()).getByRole("tabpanel");
  };

  it.each([
    ["running", zh.chatPanel.sandboxRunning],
    ["suspended", zh.chatPanel.sandboxSuspended],
  ] as const)("%s：显示状态与最近使用时间", async (status, label) => {
    const lastUsedAt = "2026-10-21T08:30:00.000Z";
    stubApi({
      [`GET ${BASE}/events`]: () => json(200, { events: [userMsg(1, "hi")] }),
      [`GET ${UI}/contributions`]: () => json(200, { items: [] }),
      [`GET ${ORG}/connectors`]: () => json(200, { connectors: [] }),
      [`GET ${BASE}/sandbox`]: () => json(200, { status, lastUsedAt }),
    });
    renderPage(<ChatPage />, { locale: "zh" });
    const panel = await openContext("zh");
    expect(await within(panel).findByText(label)).toBeTruthy();
    expect(within(panel).getByText(zh.chatPanel.sandbox)).toBeTruthy();
    expect(within(panel).getByText(zh.chatPanel.sandboxLastUsed)).toBeTruthy();
    expect(
      within(panel).getByText(
        new Date(lastUsedAt).toLocaleString("zh", { dateStyle: "short", timeStyle: "short" }),
      ),
    ).toBeTruthy();
  });

  it("404 显示「未创建」；之后收到沙箱工具的结果时重新读取状态", async () => {
    let status: Response = NO_SANDBOX();
    const calls = stubApi({
      [`GET ${BASE}/events`]: () => json(200, { events: [userMsg(1, "hi")] }),
      [`GET ${UI}/contributions`]: () => json(200, { items: [] }),
      [`GET ${ORG}/connectors`]: () => json(200, { connectors: [] }),
      [`GET ${BASE}/sandbox`]: () => status,
    });
    renderPage(<ChatPage />, { locale: "en" });
    const panel = await openContext("en");
    expect(await within(panel).findByText(en.chatPanel.sandboxNone)).toBeTruthy();
    expect(within(panel).queryByText(en.chatPanel.sandboxLastUsed)).toBeNull();
    status = json(200, { status: "running", lastUsedAt: "2026-10-21T08:30:00.000Z" });
    await vi.waitFor(() => expect(convStream()).toBeTruthy());
    convStream().emit("event", sandboxResult(2));
    expect(await within(panel).findByText(en.chatPanel.sandboxRunning)).toBeTruthy();
    expect(calls.filter((c) => c.url === `${BASE}/sandbox`)).toHaveLength(2);
  });

  it("读取失败（非 404）：显示「状态读取失败」，不影响其他内容", async () => {
    stubApi({
      [`GET ${BASE}/events`]: () => json(200, { events: [userMsg(1, "hi")] }),
      [`GET ${UI}/contributions`]: () => json(200, { items: [] }),
      [`GET ${ORG}/connectors`]: () => json(200, { connectors: [] }),
      [`GET ${BASE}/sandbox`]: () => json(500, { error: { code: "internal", message: "x" } }),
    });
    renderPage(<ChatPage />, { locale: "en" });
    const panel = await openContext("en");
    expect(await within(panel).findByText(en.chatPanel.sandboxFailed)).toBeTruthy();
    expect(within(panel).getByText("c1")).toBeTruthy();
  });
});
