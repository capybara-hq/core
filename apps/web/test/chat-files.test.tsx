import { act, cleanup, createEvent, fireEvent, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import zh from "../messages/zh.json";
import ChatPage from "../src/app/[locale]/(app)/chat/[conversationId]/page";
import { resetNavigation } from "./support/navigation";
import { renderPage } from "./support/render";

vi.mock("../src/i18n/navigation", () => import("./support/navigation"));
vi.mock("next/navigation", () => ({ useParams: () => ({ conversationId: "c1" }) }));

type Call = { url: string; method: string; body: unknown };

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

let seqTime = 0;
function ev(seq: number, type: string, payload: unknown, runId: string | null = null) {
  seqTime += 1;
  return {
    conversationId: "c1",
    seq,
    type,
    payload,
    runId,
    createdAt: new Date(seqTime).toISOString(),
  };
}
const userMsg = (seq: number, content: unknown[]) =>
  ev(seq, "user_message", { content, authorAccountId: "a1" });

class FakeEventSource {
  readyState = 1;
  addEventListener() {}
  close() {
    this.readyState = 2;
  }
}

/** XHR 桩：记录请求，由测试推进进度、完成或失败。 */
class FakeXhr {
  static instances: FakeXhr[] = [];
  method = "";
  url = "";
  headers: Record<string, string> = {};
  body: unknown;
  status = 0;
  withCredentials = false;
  aborted = false;
  readonly upload = { onprogress: null as ((e: ProgressEvent) => void) | null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  constructor() {
    FakeXhr.instances.push(this);
  }
  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }
  setRequestHeader(k: string, v: string) {
    this.headers[k] = v;
  }
  send(body: unknown) {
    this.body = body;
  }
  abort() {
    this.aborted = true;
    this.onabort?.();
  }
  progress(loaded: number, total: number) {
    this.upload.onprogress?.({ lengthComputable: true, loaded, total } as ProgressEvent);
  }
  respond(status: number) {
    this.status = status;
    this.onload?.();
  }
}

const BASE = "/api/v1/orgs/o1/conversations/c1";
const ATT = "/api/v1/orgs/o1/attachments";
const ID1 = "11111111-1111-4111-8111-111111111111";
const ID2 = "22222222-2222-4222-8222-222222222222";
const S3_URL = "http://s3.test:8333/capybara";

const png = (name = "chart.png", size = 4) =>
  new File([new Uint8Array(size)], name, { type: "image/png" });

/** 按 `METHOD path` 路由的 fetch 桩；登记附件依次发出 ID1、ID2。 */
function stubApi(extra: Record<string, (call: Call) => Response> = {}): Call[] {
  const calls: Call[] = [];
  const ids = [ID1, ID2];
  const routes: Record<string, (call: Call) => Response> = {
    [`GET ${BASE}/events`]: () =>
      json(200, { events: [userMsg(1, [{ type: "text", text: "hi" }])] }),
    [`POST ${ATT}`]: () =>
      json(201, {
        id: ids.shift(),
        upload: {
          method: "POST",
          url: S3_URL,
          headers: {},
          fields: { key: "kernel/o1/attachments/x", policy: "p", "x-amz-signature": "s" },
        },
        expiresAt: new Date(Date.now() + 300_000).toISOString(),
      }),
    [`POST ${ATT}/${ID1}/finalize`]: () =>
      json(200, { id: ID1, name: "chart.png", contentType: "image/png", size: 4 }),
    [`POST ${ATT}/${ID2}/finalize`]: () =>
      json(200, { id: ID2, name: "notes.txt", contentType: "text/plain", size: 4 }),
    ...extra,
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      const call = { url, method, body: init?.body };
      calls.push(call);
      const handler = routes[`${method} ${url.split("?")[0]}`];
      if (!handler) throw new Error(`unexpected ${method} ${url}`);
      return handler(call);
    }),
  );
  return calls;
}

const posted = (calls: Call[], url: string) =>
  calls.filter((c) => c.method === "POST" && c.url === url);

async function renderChat(locale: "zh" | "en" = "en") {
  const r = renderPage(<ChatPage />, { locale });
  await screen.findByText("hi");
  return r;
}

const fileInput = (container: HTMLElement) =>
  container.querySelector('input[type="file"]') as HTMLInputElement;
const dropZone = (container: HTMLElement) =>
  container.querySelector(".cb-file-drop") as HTMLElement;
const transfer = (files: File[]) => ({
  files,
  types: ["Files"],
  items: files.map((f) => ({ kind: "file", type: f.type, getAsFile: () => f })),
});

beforeEach(() => {
  resetNavigation("/chat/c1");
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.stubGlobal("XMLHttpRequest", FakeXhr);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  FakeXhr.instances = [];
});

describe("输入框：上传文件", () => {
  it("点击选择：登记 → 直传（表单字段在前、file 在后）→ 进度 → finalize；上传中不能发送；发送带上附件 id", async () => {
    const calls = stubApi({
      [`POST ${BASE}/messages`]: (c) => {
        const body = JSON.parse(String(c.body)) as { text: string };
        return json(202, {
          event: userMsg(2, [
            { type: "text", text: body.text },
            {
              type: "image",
              mediaType: "image/png",
              source: { kind: "ref", attachmentId: ID1 },
              name: "chart.png",
            },
          ]),
        });
      },
    });
    const { container } = await renderChat("en");
    const user = userEvent.setup();
    await user.upload(fileInput(container), png());

    await vi.waitFor(() => expect(posted(calls, ATT)).toHaveLength(1));
    expect(JSON.parse(String(posted(calls, ATT)[0]?.body))).toEqual({
      name: "chart.png",
      contentType: "image/png",
      size: 4,
    });
    await vi.waitFor(() => expect(FakeXhr.instances).toHaveLength(1));
    const xhr = FakeXhr.instances[0] as FakeXhr;
    expect(xhr.method).toBe("POST");
    expect(xhr.url).toBe(S3_URL);
    expect(xhr.withCredentials).toBe(false);
    const form = xhr.body as FormData;
    expect([...form.keys()]).toEqual(["key", "policy", "x-amz-signature", "file"]);
    expect((form.get("file") as File).name).toBe("chart.png");

    const group = screen.getByRole("group", { name: en.chat.files });
    act(() => xhr.progress(2, 4));
    expect(within(group).getByRole("progressbar").getAttribute("aria-valuenow")).toBe("50");
    await user.type(screen.getByLabelText(en.chat.inputLabel), "look");
    expect(screen.getByRole("button", { name: en.chat.send })).toHaveProperty("disabled", true);
    await user.keyboard("{Enter}");
    expect(posted(calls, `${BASE}/messages`)).toHaveLength(0);

    act(() => xhr.respond(204));
    await vi.waitFor(() => expect(posted(calls, `${ATT}/${ID1}/finalize`)).toHaveLength(1));
    await vi.waitFor(() => expect(within(group).queryByRole("progressbar")).toBeNull());
    const send = screen.getByRole("button", { name: en.chat.send });
    await vi.waitFor(() => expect(send).toHaveProperty("disabled", false));
    await user.click(send);
    const post = posted(calls, `${BASE}/messages`)[0];
    const body = JSON.parse(String(post?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({ text: "look", files: [ID1] });
    // 上传文件与 `@` 资源引用是两份：没有资源时不带 attachments
    expect(body.attachments).toBeUndefined();
    // 发送成功：输入框的文件清空，时间线显示缩略图
    const composer = screen.getByLabelText(en.chat.inputLabel).closest("form") as HTMLElement;
    await vi.waitFor(() =>
      expect(within(composer).queryByRole("group", { name: en.chat.files })).toBeNull(),
    );
    const log = screen.getByRole("log");
    const img = await within(log).findByRole("img", { name: "chart.png" });
    expect(img.getAttribute("src")).toBe(`${ATT}/${ID1}/download`);
  });

  it("PUT 直传：请求体是文件本身，带上 headers", async () => {
    stubApi({
      [`POST ${ATT}`]: () =>
        json(201, {
          id: ID1,
          upload: { method: "PUT", url: `${S3_URL}/k`, headers: { "content-type": "image/png" } },
          expiresAt: new Date(Date.now() + 300_000).toISOString(),
        }),
    });
    const { container } = await renderChat();
    await userEvent.setup().upload(fileInput(container), png());
    await vi.waitFor(() => expect(FakeXhr.instances).toHaveLength(1));
    const xhr = FakeXhr.instances[0] as FakeXhr;
    expect(xhr.method).toBe("PUT");
    expect(xhr.url).toBe(`${S3_URL}/k`);
    expect(xhr.headers).toEqual({ "content-type": "image/png" });
    expect((xhr.body as File).name).toBe("chart.png");
  });

  it("拖入文件：同样上传", async () => {
    const calls = stubApi();
    const { container } = await renderChat();
    const zone = dropZone(container);
    const f = png();
    fireEvent.dragEnter(zone, { dataTransfer: transfer([f]) });
    expect(screen.getByText(en.chat.dropFiles)).toBeTruthy();
    fireEvent.drop(zone, { dataTransfer: transfer([f]) });
    await vi.waitFor(() => expect(posted(calls, ATT)).toHaveLength(1));
    expect(screen.getByRole("group", { name: en.chat.files })).toBeTruthy();
  });

  it("粘贴文件：同样上传，且不把文件名粘进文本", async () => {
    const calls = stubApi();
    await renderChat();
    const input = screen.getByLabelText(en.chat.inputLabel);
    const paste = createEvent.paste(input, {
      clipboardData: transfer([new File(["hello"], "notes.txt", { type: "text/plain" })]),
    });
    fireEvent(input, paste);
    expect(paste.defaultPrevented).toBe(true);
    await vi.waitFor(() => expect(posted(calls, ATT)).toHaveLength(1));
    expect(JSON.parse(String(posted(calls, ATT)[0]?.body))).toMatchObject({
      name: "notes.txt",
      contentType: "text/plain",
    });
  });

  it("类型不在允许范围 / 超过大小：前端拦下（文案与内核错误码一致），不登记；可以移除", async () => {
    const calls = stubApi();
    const { container } = await renderChat("zh");
    const user = userEvent.setup({ applyAccept: false });
    await user.upload(fileInput(container), new File(["x"], "a.zip", { type: "application/zip" }));
    const group = await screen.findByRole("group", { name: zh.chat.files });
    expect(within(group).getByRole("alert").textContent).toBe(
      zh.errors.attachment.type_not_allowed,
    );
    // 图片上限 5 MB
    await user.upload(fileInput(container), png("huge.png", 5 * 1024 * 1024 + 1));
    await vi.waitFor(() => expect(within(group).getAllByRole("alert")).toHaveLength(2));
    expect(within(group).getAllByRole("alert")[1]?.textContent).toBe(
      zh.errors.attachment.too_large,
    );
    expect(posted(calls, ATT)).toHaveLength(0);
    // 有出错的文件时不能发送；移除后可以
    await user.type(screen.getByLabelText(zh.chat.inputLabel), "hi");
    expect(screen.getByRole("button", { name: zh.chat.send })).toHaveProperty("disabled", true);
    await user.click(within(group).getByRole("button", { name: "移除 a.zip" }));
    await user.click(within(group).getByRole("button", { name: "移除 huge.png" }));
    expect(screen.queryByRole("group", { name: zh.chat.files })).toBeNull();
    expect(screen.getByRole("button", { name: zh.chat.send })).toHaveProperty("disabled", false);
  });

  it("内核拒绝登记（413）/ 直传失败：显示对应错误", async () => {
    stubApi({
      [`POST ${ATT}`]: () =>
        json(413, { error: { code: "attachment.too_large", message: "too large" } }),
    });
    const { container } = await renderChat("en");
    const user = userEvent.setup();
    await user.upload(fileInput(container), png());
    const group = await screen.findByRole("group", { name: en.chat.files });
    await vi.waitFor(() =>
      expect(within(group).getByRole("alert").textContent).toBe(en.errors.attachment.too_large),
    );
    cleanup();
    FakeXhr.instances = [];

    stubApi();
    const r = await renderChat("en");
    await user.upload(fileInput(r.container), png());
    await vi.waitFor(() => expect(FakeXhr.instances).toHaveLength(1));
    act(() => (FakeXhr.instances[0] as FakeXhr).respond(403));
    const g2 = await screen.findByRole("group", { name: en.chat.files });
    await vi.waitFor(() =>
      expect(within(g2).getByRole("alert").textContent).toBe(en.errors.attachment.upload_failed),
    );
  });

  it("上传中移除：中止直传，不再 finalize", async () => {
    const calls = stubApi();
    const { container } = await renderChat("en");
    const user = userEvent.setup();
    await user.upload(fileInput(container), png());
    await vi.waitFor(() => expect(FakeXhr.instances).toHaveLength(1));
    const group = screen.getByRole("group", { name: en.chat.files });
    await user.click(within(group).getByRole("button", { name: "Remove chart.png" }));
    expect((FakeXhr.instances[0] as FakeXhr).aborted).toBe(true);
    expect(screen.queryByRole("group", { name: en.chat.files })).toBeNull();
    expect(posted(calls, `${ATT}/${ID1}/finalize`)).toHaveLength(0);
  });

  it(`每条消息最多 10 个文件`, async () => {
    const calls = stubApi();
    const { container } = await renderChat("en");
    const user = userEvent.setup();
    await user.upload(
      fileInput(container),
      Array.from({ length: 11 }, (_, i) => png(`p${i}.png`)),
    );
    expect(await screen.findByText(en.chat.filesLimit.replace("{max}", "10"))).toBeTruthy();
    // 只加前 10 个，都开始上传
    await vi.waitFor(() => expect(posted(calls, ATT)).toHaveLength(10));
    const group = screen.getByRole("group", { name: en.chat.files });
    expect(within(group).getAllByText(/^p\d+\.png$/)).toHaveLength(10);
  });
});

describe("时间线：消息附件", () => {
  it("图片显示缩略图，其他文件显示文件卡片；都指向 download", async () => {
    stubApi({
      [`GET ${BASE}/events`]: () =>
        json(200, {
          events: [
            userMsg(1, [
              { type: "text", text: "hi" },
              {
                type: "image",
                mediaType: "image/png",
                source: { kind: "ref", attachmentId: ID1 },
                name: "chart.png",
              },
              {
                type: "document",
                mediaType: "application/pdf",
                source: { kind: "ref", attachmentId: ID2 },
                name: "report.pdf",
              },
            ]),
          ],
        }),
    });
    await renderChat("en");
    const group = screen.getByRole("group", { name: en.chat.files });
    const img = within(group).getByRole("img", { name: "chart.png" });
    expect(img.getAttribute("src")).toBe(`${ATT}/${ID1}/download`);
    const card = within(group).getByRole("link", { name: /report\.pdf/ });
    expect(card.getAttribute("href")).toBe(`${ATT}/${ID2}/download`);
    expect(within(card).getByText("PDF")).toBeTruthy();
    // 文本仍只显示用户输入
    expect(screen.getByText("hi")).toBeTruthy();
  });

  it("同时带 @ 资源与上传文件：资源正文不展开，两类附件分别显示", async () => {
    stubApi({
      [`GET ${BASE}/events`]: () =>
        json(200, {
          events: [
            ev(1, "user_message", {
              content: [
                { type: "text", text: "hi" },
                { type: "text", text: "Attached resource …" },
                {
                  type: "document",
                  mediaType: "text/plain",
                  source: { kind: "ref", attachmentId: ID2 },
                  name: "notes.txt",
                },
              ],
              attachments: [
                { appId: "a1", appName: "Docs", uri: "docs://handbook", name: "Handbook" },
              ],
              authorAccountId: "a1",
            }),
          ],
        }),
    });
    await renderChat("en");
    expect(screen.getByText("@Handbook · Docs")).toBeTruthy();
    expect(screen.queryByText("Attached resource …")).toBeNull();
    const group = screen.getByRole("group", { name: en.chat.files });
    expect(within(group).getByRole("link", { name: /notes\.txt/ })).toBeTruthy();
  });
});
