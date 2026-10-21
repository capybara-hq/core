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

type Call = { url: string; method: string; body: unknown; signal?: AbortSignal | null | undefined };
type Handler = (call: Call) => Response | Promise<Response>;

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
function stubApi(extra: Record<string, Handler> = {}): Call[] {
  const calls: Call[] = [];
  const ids = [ID1, ID2];
  let n = 0;
  const routes: Record<string, Handler> = {
    [`GET ${BASE}/events`]: () =>
      json(200, { events: [userMsg(1, [{ type: "text", text: "hi" }])] }),
    [`POST ${ATT}`]: () =>
      json(201, {
        id: ids.shift() ?? `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`,
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
      const call = { url, method, body: init?.body, signal: init?.signal };
      calls.push(call);
      const path = url.split("?")[0] as string;
      const handler = routes[`${method} ${path}`];
      if (handler) return handler(call);
      // 其余附件的 finalize：按 id 回显
      const fin = new RegExp(`^${ATT}/([^/]+)/finalize$`).exec(path);
      if (method === "POST" && fin) {
        return json(200, { id: fin[1], name: "f", contentType: "image/png", size: 4 });
      }
      throw new Error(`unexpected ${method} ${url}`);
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
    // 未取到上限（接口不可用）时按内核默认值预检，文案由上限拼出
    expect(within(group).getByRole("alert").textContent).toBe(
      zh.chat.fileTypeNotAllowed.replace(
        "{types}",
        "PNG / JPEG / GIF / WebP / PDF / TXT / Markdown / CSV",
      ),
    );
    // 图片上限 5 MB
    await user.upload(fileInput(container), png("huge.png", 5 * 1024 * 1024 + 1));
    await vi.waitFor(() => expect(within(group).getAllByRole("alert")).toHaveLength(2));
    expect(within(group).getAllByRole("alert")[1]?.textContent).toBe(
      zh.chat.fileTooLarge.replace("{image}", "5 MB").replace("{other}", "20 MB"),
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
      expect(within(group).getByRole("alert").textContent).toBe(
        en.chat.fileTooLarge.replace("{image}", "5 MB").replace("{other}", "20 MB"),
      ),
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

describe("输入框：上传文件（修正轮 1）", () => {
  it("上限取自内核 GET /attachments/limits：按它预检，文案由它拼出", async () => {
    const calls = stubApi({
      [`GET ${ATT}/limits`]: () =>
        json(200, {
          types: ["image/png", "text/plain"],
          maxBytes: 1000,
          imageMaxBytes: 100,
          maxPerMessage: 2,
        }),
    });
    const { container } = await renderChat("zh");
    await vi.waitFor(() => expect(calls.some((c) => c.url === `${ATT}/limits`)).toBe(true));
    const input = fileInput(container);
    await vi.waitFor(() => expect(input.accept).toBe("image/png,text/plain"));
    const user = userEvent.setup({ applyAccept: false });
    await user.upload(input, new File(["%PDF-"], "a.pdf", { type: "application/pdf" }));
    const group = await screen.findByRole("group", { name: zh.chat.files });
    expect(within(group).getByRole("alert").textContent).toBe(
      zh.chat.fileTypeNotAllowed.replace("{types}", "PNG / TXT"),
    );
    await user.upload(input, png("big.png", 101));
    await vi.waitFor(() => expect(within(group).getAllByRole("alert")).toHaveLength(2));
    expect(within(group).getAllByRole("alert")[1]?.textContent).toBe(
      zh.chat.fileTooLarge.replace("{image}", "100 B").replace("{other}", "1000 B"),
    );
    // 预检拦下的 2 个不占名额（条数上限 2）：再加 2 个照常上传，第 3 个才被拦下
    await user.upload(input, [png("third.png"), png("fourth.png")]);
    await vi.waitFor(() => expect(posted(calls, ATT)).toHaveLength(2));
    expect(screen.queryByText(zh.chat.filesLimit.replace("{max}", "2"))).toBeNull();
    await user.upload(input, png("fifth.png"));
    expect(await screen.findByText(zh.chat.filesLimit.replace("{max}", "2"))).toBeTruthy();
    expect(within(group).queryByText("fifth.png")).toBeNull();
    expect(posted(calls, ATT)).toHaveLength(2);
  });

  it("两次并发拖入：合计只收 10 个，只为收下的文件发起上传", async () => {
    const calls = stubApi();
    const { container } = await renderChat("en");
    const zone = dropZone(container);
    const batch = (p: string) => Array.from({ length: 6 }, (_, i) => png(`${p}${i}.png`));
    act(() => {
      fireEvent.drop(zone, { dataTransfer: transfer(batch("a")) });
      fireEvent.drop(zone, { dataTransfer: transfer(batch("b")) });
    });
    await vi.waitFor(() => expect(posted(calls, ATT)).toHaveLength(10));
    const group = screen.getByRole("group", { name: en.chat.files });
    expect(within(group).getAllByText(/^[ab]\d\.png$/)).toHaveLength(10);
    expect(within(group).queryByText("b4.png")).toBeNull();
    expect(screen.getByText(en.chat.filesLimit.replace("{max}", "10"))).toBeTruthy();
    // 稍等也不会多发
    await new Promise((r) => setTimeout(r, 20));
    expect(posted(calls, ATT)).toHaveLength(10);
  });

  it("上传中移除：登记请求也被中止（AbortSignal 传给 createAttachment）", async () => {
    let seen: AbortSignal | null | undefined;
    stubApi({
      [`POST ${ATT}`]: (c) =>
        new Promise<Response>((_, reject) => {
          seen = c.signal;
          c.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        }),
    });
    const { container } = await renderChat("en");
    const user = userEvent.setup();
    await user.upload(fileInput(container), png());
    await vi.waitFor(() => expect(seen).toBeDefined());
    const group = screen.getByRole("group", { name: en.chat.files });
    await user.click(within(group).getByRole("button", { name: "Remove chart.png" }));
    expect(seen?.aborted).toBe(true);
    expect(FakeXhr.instances).toHaveLength(0);
  });

  it("直传失败：可重试，用同一个文件重新登记、上传", async () => {
    const calls = stubApi();
    const { container } = await renderChat("en");
    const user = userEvent.setup();
    await user.upload(fileInput(container), png());
    await vi.waitFor(() => expect(FakeXhr.instances).toHaveLength(1));
    act(() => (FakeXhr.instances[0] as FakeXhr).respond(403));
    const group = screen.getByRole("group", { name: en.chat.files });
    await user.click(await within(group).findByRole("button", { name: "Retry chart.png" }));
    await vi.waitFor(() => expect(posted(calls, ATT)).toHaveLength(2));
    await vi.waitFor(() => expect(FakeXhr.instances).toHaveLength(2));
    const second = FakeXhr.instances[1] as FakeXhr;
    expect(((second.body as FormData).get("file") as File).name).toBe("chart.png");
    act(() => second.respond(204));
    await vi.waitFor(() => expect(within(group).queryByRole("progressbar")).toBeNull());
    expect(within(group).queryByRole("alert")).toBeNull();
  });

  it("前端预检拦下的文件没有重试按钮", async () => {
    stubApi();
    const { container } = await renderChat("en");
    await userEvent
      .setup({ applyAccept: false })
      .upload(fileInput(container), new File(["x"], "a.zip", { type: "application/zip" }));
    const group = await screen.findByRole("group", { name: en.chat.files });
    expect(within(group).queryByRole("button", { name: "Retry a.zip" })).toBeNull();
  });

  it("发送时内核说附件不存在：对应条目标为出错（可重试），其余保持就绪", async () => {
    stubApi({
      [`POST ${BASE}/messages`]: () =>
        json(404, {
          error: {
            code: "attachment.not_found",
            message: "gone",
            details: [{ path: "files", message: "gone", attachmentId: ID2 }],
          },
        }),
    });
    const { container } = await renderChat("en");
    const user = userEvent.setup();
    await user.upload(fileInput(container), [png("one.png"), png("two.png")]);
    await vi.waitFor(() => expect(FakeXhr.instances).toHaveLength(2));
    act(() => {
      for (const x of FakeXhr.instances) x.respond(204);
    });
    const group = screen.getByRole("group", { name: en.chat.files });
    await vi.waitFor(() => expect(within(group).queryByRole("progressbar")).toBeNull());
    await user.type(screen.getByLabelText(en.chat.inputLabel), "go");
    await user.click(screen.getByRole("button", { name: en.chat.send }));
    const alert = await within(group).findByRole("alert");
    expect(alert.textContent).toBe(en.errors.attachment.not_found);
    expect(within(group).getByRole("button", { name: "Retry two.png" })).toBeTruthy();
    expect(within(group).queryByRole("button", { name: "Retry one.png" })).toBeNull();
  });

  it("发送成功只移除发出去的文件：发送期间新加的保留", async () => {
    let release: (r: Response) => void = () => {};
    const calls = stubApi({
      [`POST ${BASE}/messages`]: () =>
        new Promise<Response>((r) => {
          release = r;
        }),
    });
    const { container } = await renderChat("en");
    const user = userEvent.setup();
    await user.upload(fileInput(container), png("first.png"));
    await vi.waitFor(() => expect(FakeXhr.instances).toHaveLength(1));
    act(() => (FakeXhr.instances[0] as FakeXhr).respond(204));
    const send = screen.getByRole("button", { name: en.chat.send });
    await user.type(screen.getByLabelText(en.chat.inputLabel), "go");
    await vi.waitFor(() => expect(send).toHaveProperty("disabled", false));
    await user.click(send);
    await vi.waitFor(() => expect(posted(calls, `${BASE}/messages`)).toHaveLength(1));
    // 发送进行中又拖入一个
    fireEvent.drop(dropZone(container), { dataTransfer: transfer([png("later.png")]) });
    await act(async () => {
      release(json(202, { event: userMsg(2, [{ type: "text", text: "go" }]) }));
    });
    const group = await screen.findByRole("group", { name: en.chat.files });
    await vi.waitFor(() => expect(within(group).queryByText("first.png")).toBeNull());
    expect(within(group).getByText("later.png")).toBeTruthy();
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

describe("时间线：登录过期后的附件（修正轮 1）", () => {
  const events = () =>
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
    });

  it("图片加载失败：先确认登录（必要时刷新）再带缓存参数重试一次；再失败不再重试", async () => {
    let expired = true;
    const calls = stubApi({
      [`GET ${BASE}/events`]: events,
      "GET /api/v1/me": () =>
        expired
          ? json(401, { error: { code: "auth.token_expired", message: "expired" } })
          : json(200, { account: { id: "a1" } }),
      "POST /api/v1/auth/refresh": () => {
        expired = false;
        return new Response(null, { status: 204 });
      },
    });
    await renderChat("en");
    const img = screen.getByRole("img", { name: "chart.png" });
    fireEvent.error(img);
    await vi.waitFor(() =>
      expect(screen.getByRole("img", { name: "chart.png" }).getAttribute("src")).toBe(
        `${ATT}/${ID1}/download?retry=1`,
      ),
    );
    expect(calls.filter((c) => c.url === "/api/v1/auth/refresh")).toHaveLength(1);
    fireEvent.error(screen.getByRole("img", { name: "chart.png" }));
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.getByRole("img", { name: "chart.png" }).getAttribute("src")).toBe(
      `${ATT}/${ID1}/download?retry=1`,
    );
    expect(calls.filter((c) => c.url === "/api/v1/me")).toHaveLength(2);
  });

  it("点开文件卡片：先同步开新标签页，确认登录后再导航到下载地址（不留 opener）", async () => {
    const calls = stubApi({
      [`GET ${BASE}/events`]: events,
      "GET /api/v1/me": () => json(200, { account: { id: "a1" } }),
    });
    const tab = { opener: {} as unknown, location: { href: "about:blank" }, close: vi.fn() };
    const open = vi.fn(() => tab);
    vi.stubGlobal("open", open);
    await renderChat("en");
    fireEvent.click(screen.getByRole("link", { name: /report\.pdf/ }), { button: 0 });
    expect(open).toHaveBeenCalledWith("", "_blank");
    expect(tab.opener).toBeNull();
    await vi.waitFor(() =>
      expect(tab.location.href).toBe(new URL(`${ATT}/${ID2}/download`, window.location.href).href),
    );
    expect(calls.some((c) => c.url === "/api/v1/me")).toBe(true);
  });

  it("点开文件卡片但登录已失效：关掉新标签页、在当前页提示，不导航到下载地址（不显示裸 401）", async () => {
    stubApi({
      [`GET ${BASE}/events`]: events,
      "GET /api/v1/me": () =>
        json(401, { error: { code: "auth.session_revoked", message: "revoked" } }),
      "POST /api/v1/auth/refresh": () =>
        json(401, { error: { code: "auth.refresh_invalid", message: "invalid" } }),
    });
    const tab = { opener: {} as unknown, location: { href: "about:blank" }, close: vi.fn() };
    vi.stubGlobal(
      "open",
      vi.fn(() => tab),
    );
    await renderChat("en");
    fireEvent.click(screen.getByRole("link", { name: /report\.pdf/ }), { button: 0 });
    await vi.waitFor(() => expect(tab.close).toHaveBeenCalled());
    expect(tab.location.href).toBe("about:blank");
    expect(await screen.findByText(/session is no longer valid|Please sign in/)).toBeTruthy();
  });
});

describe("uploadToStorage", () => {
  it("signal 已中止：立即拒绝，不发请求", async () => {
    const { uploadToStorage } = await import("../src/lib/attachments");
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(
      uploadToStorage({ method: "PUT", url: S3_URL, headers: {} }, png(), { signal: ctrl.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(FakeXhr.instances).toHaveLength(0);
  });
});

describe("输入框：只发文件、存储不可用与请求预算（修正波 S1）", () => {
  it("只有就绪的文件、没有文字：可以发送，text 为空串", async () => {
    const calls = stubApi({
      [`POST ${BASE}/messages`]: () =>
        json(202, {
          event: userMsg(2, [
            {
              type: "image",
              mediaType: "image/png",
              source: { kind: "ref", attachmentId: ID1 },
              name: "chart.png",
            },
          ]),
        }),
    });
    const { container } = await renderChat("en");
    const user = userEvent.setup();
    const send = screen.getByRole("button", { name: en.chat.send });
    // 什么都没有：不能发送
    expect(send).toHaveProperty("disabled", true);
    await user.upload(fileInput(container), png());
    await vi.waitFor(() => expect(FakeXhr.instances).toHaveLength(1));
    act(() => (FakeXhr.instances[0] as FakeXhr).respond(204));
    await vi.waitFor(() => expect(send).toHaveProperty("disabled", false));
    await user.click(send);
    await vi.waitFor(() => expect(posted(calls, `${BASE}/messages`)).toHaveLength(1));
    const body = JSON.parse(String(posted(calls, `${BASE}/messages`)[0]?.body)) as Record<
      string,
      unknown
    >;
    expect(body).toMatchObject({ text: "", files: [ID1] });
  });

  it("对象存储不可用（limits.available=false）：添加文件按钮禁用并提示，拖入 / 粘贴不上传", async () => {
    const calls = stubApi({
      [`GET ${ATT}/limits`]: () =>
        json(200, {
          types: ["image/png"],
          maxBytes: 1000,
          imageMaxBytes: 1000,
          maxPerMessage: 10,
          requestMediaBytes: 1000,
          available: false,
        }),
    });
    const { container } = await renderChat("zh");
    const button = await screen.findByRole("button", { name: zh.chat.filesUnavailable });
    expect(button).toHaveProperty("disabled", true);
    expect(fileInput(container).disabled).toBe(true);
    const zone = dropZone(container);
    fireEvent.drop(zone, { dataTransfer: transfer([png()]) });
    const input = screen.getByLabelText(zh.chat.inputLabel);
    fireEvent(input, createEvent.paste(input, { clipboardData: transfer([png("p.png")]) }));
    await new Promise((r) => setTimeout(r, 20));
    expect(posted(calls, ATT)).toHaveLength(0);
    expect(screen.queryByRole("group", { name: zh.chat.files })).toBeNull();
  });

  it("选中的文件合计超过 requestMediaBytes：加文件时提醒（较早的文件可能被省略）", async () => {
    stubApi({
      [`GET ${ATT}/limits`]: () =>
        json(200, {
          types: ["image/png"],
          maxBytes: 1000,
          imageMaxBytes: 1000,
          maxPerMessage: 10,
          requestMediaBytes: 10,
          available: true,
        }),
    });
    const { container } = await renderChat("en");
    const user = userEvent.setup();
    const input = fileInput(container);
    await vi.waitFor(() => expect(input.accept).toBe("image/png"));
    await user.upload(input, png("a.png", 6));
    expect(screen.queryByText(en.chat.filesOverBudget.replace("{max}", "10 B"))).toBeNull();
    await user.upload(input, png("b.png", 6));
    expect(await screen.findByText(en.chat.filesOverBudget.replace("{max}", "10 B"))).toBeTruthy();
  });
});
