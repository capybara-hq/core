import { act, cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import zh from "../messages/zh.json";
import { bodyOf, json, lastStubRoutes, noContent, stubApi as stubApiOnly } from "./support/api";
import { resetNavigation, router } from "./support/navigation";
import { renderRouteEmptyCache, renderRouteWithCache } from "./support/query";
import { ME } from "./support/render";
import { expectNoFirstPaintFetch } from "./support/server";
import { NOT_READY } from "./support/shell";

vi.mock("../src/i18n/navigation", () => import("./support/navigation"));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
}));

/** The platform skills offered to the org (the 技能 page's switches): none unless a test stubs them. */
const stubApi = (routes: Parameters<typeof stubApiOnly>[0]) =>
  stubApiOnly({
    "GET /api/v1/orgs/o1/components": () => json(200, { components: [] }),
    ...routes,
  });

type RenderOpts = Parameters<typeof renderRouteWithCache>[2];
/** `/skills` as a first load: the layout prefetches from the latest `stubApi` routes. */
const renderSkills = (opts: RenderOpts = {}) =>
  renderRouteWithCache("/skills", lastStubRoutes(), opts);
/** `/skills/s1` as a first load (routes as in {@link renderSkills}). */
const renderSkill = (opts: RenderOpts = {}) =>
  renderRouteWithCache("/skills/s1", lastStubRoutes(), opts);

/** Lets pending reads and effects run (a read after mount would show up in the calls). */
const settle = () => act(() => new Promise((r) => setTimeout(r, 20)));

const msgs = { zh, en } as const;
const LOCALES = ["zh", "en"] as const;
const T = "2026-10-20T08:00:00.000Z";
const BASE = "/api/v1/orgs/o1/skills";
const S3_URL = "https://s3.example.test/bucket";

const MEMBER = {
  ...ME,
  memberships: [{ orgId: "o1", slug: "acme", name: "Acme", role: "member" }],
};

const skill = (id: string, name: string, over: Record<string, unknown> = {}) => ({
  id,
  scope: "org",
  agentId: null,
  name,
  description: `Use for ${name}.`,
  currentVersion: 1,
  createdBy: "a1",
  createdAt: T,
  updatedAt: T,
  ...over,
});

/** 直传存储的 XHR 桩：send 之后立即以 204 完成（或按 `status` 失败）。 */
class FakeXhr {
  static instances: FakeXhr[] = [];
  static status = 204;
  /** 为 true 时 send 之后不自动完成（测试进度与取消）。 */
  static hold = false;
  method = "";
  url = "";
  body: unknown;
  status = 0;
  withCredentials = false;
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
  setRequestHeader() {}
  send(body: unknown) {
    this.body = body;
    if (FakeXhr.hold) return;
    queueMicrotask(() => {
      this.status = FakeXhr.status;
      this.onload?.();
    });
  }
  abort() {
    this.onabort?.();
  }
}

const zipFile = (name = "pdf-tools.zip", size = 4) =>
  new File([new Uint8Array(size)], name, { type: "application/zip" });

/** The upload lives in a dialog opened by the header action "Upload skill". */
const fileInput = () => document.querySelector('input[type="file"]') as HTMLInputElement;
const openUpload = async (locale: "zh" | "en" = "en") => {
  await userEvent
    .setup()
    .click(
      screen.getAllByRole("button", { name: msgs[locale].skills.upload.open })[0] as HTMLElement,
    );
};

beforeEach(() => {
  resetNavigation("/skills");
  vi.stubGlobal("XMLHttpRequest", FakeXhr);
  FakeXhr.status = 204;
  FakeXhr.hold = false;
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  FakeXhr.instances = [];
});

/** A long, multi-line description: detail pages show it in full (fix round 1). */
const LONG =
  "Use when a meeting ends.\nIt writes the minutes, lists the decisions and the follow-ups, and names who owns each one, so nothing said in the room is lost on the way out of it.";

describe("技能库列表（ListPage）", () => {
  it.each(LOCALES)("列出组织技能；管理员看到上传说明（布局与上限）（%s）", async (locale) => {
    const m = msgs[locale];
    stubApi({ [`GET ${BASE}`]: () => json(200, { skills: [skill("s1", "pdf-tools")] }) });
    const { container } = await renderSkills({ locale });
    expect(container.querySelector('[data-template="ListPage"]')).not.toBeNull();
    const list = await screen.findByRole("list", { name: m.skills.listLabel });
    expect(within(list).getByText("pdf-tools")).toBeTruthy();
    expect(within(list).getByText("Use for pdf-tools.")).toBeTruthy();
    expect(within(list).getByRole("link", { name: "pdf-tools" }).getAttribute("href")).toBe(
      "/skills/s1",
    );
    await openUpload(locale);
    expect(screen.getByText(m.skills.upload.layoutHint)).toBeTruthy();
    expect(screen.getByText(m.skills.upload.limits)).toBeTruthy();
    // one design drop zone with a real button, not a bare "+"
    const zone = document.querySelector('[data-part="file-picker"]') as HTMLElement;
    expect(within(zone).getByRole("button", { name: m.skills.upload.choose }).textContent).toBe(
      m.skills.upload.choose,
    );
    expect(within(zone).getByText(m.skills.upload.chooseHint)).toBeTruthy();
    // 打开一行 → 详情页
  });

  it("成员只能查看：没有上传入口", async () => {
    stubApi({ [`GET ${BASE}`]: () => json(200, { skills: [skill("s1", "pdf-tools")] }) });
    await renderSkills({ me: MEMBER });
    await screen.findByText("pdf-tools");
    expect(screen.queryByRole("button", { name: en.skills.upload.open })).toBeNull();
    expect(screen.queryByText(en.skills.upload.layoutHint)).toBeNull();
  });

  it("上传 zip：登记 → 直传预签名表单 → POST /skills {uploadId} → 提示并重读列表", async () => {
    let skills = [skill("s1", "pdf-tools")];
    const calls = stubApi({
      [`GET ${BASE}`]: () => json(200, { skills }),
      [`POST ${BASE}/uploads`]: () =>
        json(201, {
          id: "up1",
          upload: { method: "POST", url: S3_URL, headers: {}, fields: { key: "k", policy: "p" } },
          expiresAt: T,
        }),
      [`POST ${BASE}`]: () => {
        skills = [skill("s1", "pdf-tools", { currentVersion: 2 })];
        return json(201, { skill: skills[0], version: 2, created: false });
      },
    });
    await renderSkills();
    await screen.findByText("pdf-tools");
    await openUpload();
    await userEvent.setup().upload(fileInput(), zipFile());
    expect(
      await screen.findByText(
        en.skills.upload.versionCreated.replace("{name}", "pdf-tools").replace("{version}", "2"),
      ),
    ).toBeTruthy();
    expect(bodyOf(calls.find((c) => c.url === `${BASE}/uploads`))).toEqual({
      name: "pdf-tools.zip",
      size: 4,
    });
    expect(FakeXhr.instances).toHaveLength(1);
    expect(FakeXhr.instances[0]?.url).toBe(S3_URL);
    const form = FakeXhr.instances[0]?.body as FormData;
    expect([...form.keys()]).toEqual(["key", "policy", "file"]);
    expect(bodyOf(calls.find((c) => c.method === "POST" && c.url === BASE))).toEqual({
      uploadId: "up1",
    });
    await vi.waitFor(() => expect(screen.getByText(/ · v2 · /)).toBeTruthy());
  });

  it("an upload invalidates skills and that skill: the list is read again", async () => {
    const calls = stubApi({
      [`GET ${BASE}`]: () => json(200, { skills: [skill("s1", "pdf-tools")] }),
      [`POST ${BASE}/uploads`]: () =>
        json(201, {
          id: "up1",
          upload: { method: "POST", url: S3_URL, headers: {}, fields: { key: "k", policy: "p" } },
          expiresAt: T,
        }),
      [`POST ${BASE}`]: () =>
        json(201, {
          skill: skill("s1", "pdf-tools", { currentVersion: 2 }),
          version: 2,
          created: false,
        }),
    });
    const { client } = await renderSkills();
    // the skill is cached (as after a visit to /skills/s1)
    client.setQueryData(["org", "o1", "skill", "s1"], { skill: skill("s1", "pdf-tools") });
    await openUpload();
    await userEvent.setup().upload(fileInput(), zipFile());
    await vi.waitFor(() =>
      expect(client.getQueryState(["org", "o1", "skill", "s1"])?.isInvalidated).toBe(true),
    );
    const after = calls.slice(calls.findIndex((c) => c.method === "POST" && c.url === BASE));
    expect(after.map((c) => `${c.method} ${c.url}`)).toContain(`GET ${BASE}`);
  });

  it.each(LOCALES)(
    "包不合法：显示 skill.invalid_package 的文案与逐条问题（%s）",
    async (locale) => {
      const m = msgs[locale];
      stubApi({
        [`GET ${BASE}`]: () => json(200, { skills: [] }),
        [`POST ${BASE}/uploads`]: () =>
          json(201, {
            id: "up1",
            upload: { method: "PUT", url: S3_URL, headers: {} },
            expiresAt: T,
          }),
        [`POST ${BASE}`]: () =>
          json(400, {
            error: {
              code: "skill.invalid_package",
              message: "x",
              details: [{ path: "", message: "SKILL.md is missing at the package root" }],
            },
          }),
      });
      await renderSkills({ locale });
      await screen.findByText(m.skills.empty);
      await openUpload(locale);
      await userEvent.setup().upload(fileInput(), zipFile("bad.zip"));
      const alert = await screen.findByRole("alert");
      expect(within(alert).getByText(`${m.errors.skill.invalid_package}`)).toBeTruthy();
      expect(within(alert).getByText("SKILL.md is missing at the package root")).toBeTruthy();
    },
  );

  it.each(LOCALES)("上传中显示进度、可取消；取消或失败后可用同一文件重试（%s）", async (locale) => {
    const u = msgs[locale].skills.upload;
    const calls = stubApi({
      [`GET ${BASE}`]: () => json(200, { skills: [] }),
      [`POST ${BASE}/uploads`]: () =>
        json(201, { id: "up1", upload: { method: "PUT", url: S3_URL, headers: {} }, expiresAt: T }),
      [`POST ${BASE}`]: () =>
        json(201, { skill: skill("s1", "pdf-tools"), version: 1, created: true }),
    });
    await renderSkills({ locale });
    await screen.findByText(msgs[locale].skills.empty);
    await openUpload(locale);
    FakeXhr.hold = true;
    const user = userEvent.setup();
    await user.upload(fileInput(), zipFile());
    const uploading = (pct: number) =>
      u.uploading.replace("{name}", "pdf-tools.zip").replace("{percent}", String(pct));
    expect(await screen.findByText(uploading(0))).toBeTruthy();
    await vi.waitFor(() => expect(FakeXhr.instances).toHaveLength(1));
    act(() => {
      FakeXhr.instances[0]?.upload.onprogress?.({
        lengthComputable: true,
        loaded: 1,
        total: 2,
      } as ProgressEvent);
    });
    expect(await screen.findByText(uploading(50))).toBeTruthy();
    await user.click(screen.getByRole("button", { name: u.cancel }));
    expect(await screen.findByText(u.cancelled)).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(calls.some((c) => c.method === "POST" && c.url === BASE)).toBe(false);

    FakeXhr.hold = false;
    await user.click(screen.getByRole("button", { name: u.retry }));
    expect(await screen.findByText(u.created.replace("{name}", "pdf-tools"))).toBeTruthy();
    expect(FakeXhr.instances).toHaveLength(2);
    expect(screen.queryByRole("button", { name: u.retry })).toBeNull();
  });

  it("前端预检：不是 zip、超过 50MB 不发请求", async () => {
    const calls = stubApi({ [`GET ${BASE}`]: () => json(200, { skills: [] }) });
    await renderSkills();
    await screen.findByText(en.skills.empty);
    await openUpload();
    const user = userEvent.setup({ applyAccept: false });
    await user.upload(fileInput(), new File(["x"], "notes.txt", { type: "text/plain" }));
    expect(await screen.findByText(`${en.skills.upload.notZip}`)).toBeTruthy();
    const big = zipFile("big.zip");
    Object.defineProperty(big, "size", { value: 50 * 1024 * 1024 + 1 });
    await user.upload(fileInput(), big);
    expect(await screen.findByText(`${en.skills.upload.tooLarge}`)).toBeTruthy();
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });
});

const detail = (over: Record<string, unknown> = {}) => ({
  ...skill("s1", "pdf-tools", { currentVersion: 2 }),
  body: "# PDF tools\n\n<b>not html</b>\n",
  versions: [
    {
      version: 2,
      description: "Use for pdf-tools.",
      files: [
        { path: "SKILL.md", size: 120, sha256: "a" },
        { path: "scripts/run.py", size: 2048, sha256: "b" },
      ],
      createdBy: "a1",
      createdAt: T,
    },
    {
      version: 1,
      description: "Old.",
      files: [{ path: "SKILL.md", size: 90, sha256: "c" }],
      createdBy: "a1",
      createdAt: T,
    },
  ],
  ...over,
});

/** 删除 sits in the detail head's ⋯ menu (a destructive item): opens it and picks 删除技能. */
async function openDelete(user: ReturnType<typeof userEvent.setup>, locale: "zh" | "en") {
  const m = msgs[locale];
  await user.click(await screen.findByRole("button", { name: m.common.moreActions }));
  await user.click(await screen.findByRole("menuitem", { name: m.skills.detail.delete }));
}

describe("技能详情（DetailPage）", () => {
  beforeEach(() => resetNavigation("/skills/s1"));

  it.each(LOCALES)(
    "SKILL.md 正文按纯文本显示（不渲染 HTML）；文件与版本两个标签（%s）",
    async (locale) => {
      const m = msgs[locale];
      stubApi({ [`GET ${BASE}/s1`]: () => json(200, detail()) });
      const { container } = await renderSkill({ locale });
      expect(container.querySelector('[data-template="DetailPage"]')).not.toBeNull();
      const pre = await vi.waitFor(() => {
        const el = container.querySelector("pre");
        if (!el) throw new Error("no pre");
        return el;
      });
      expect(pre.textContent).toBe("# PDF tools\n\n<b>not html</b>\n");
      expect(container.querySelector("b")).toBeNull();
      const user = userEvent.setup();
      await user.click(screen.getByRole("tab", { name: m.skills.detail.tabs.files }));
      const files = screen.getByRole("table", { name: m.skills.detail.filesLabel });
      expect(within(files).getByText("scripts/run.py")).toBeTruthy();
      await user.click(screen.getByRole("tab", { name: m.skills.detail.tabs.versions }));
      const versions = screen.getByRole("table", { name: m.skills.detail.versionsLabel });
      expect(within(versions).getByText("Old.")).toBeTruthy();
      expect(within(versions).getByText("v1")).toBeTruthy();
    },
  );

  it("正文读不到：显示说明", async () => {
    stubApi({ [`GET ${BASE}/s1`]: () => json(200, detail({ body: null })) });
    await renderSkill();
    expect(await screen.findByText(en.skills.detail.bodyUnavailable)).toBeTruthy();
  });

  it("管理员删除：二次确认（输入技能名）→ DELETE → 回到列表", async () => {
    const calls = stubApi({
      [`GET ${BASE}/s1`]: () => json(200, detail()),
      [`GET ${BASE}/s1/delete-preview`]: () =>
        json(200, { outcome: "removed", orgs: [], agents: [] }),
      [`DELETE ${BASE}/s1`]: () => noContent(),
    });
    await renderSkill();
    const user = userEvent.setup();
    await openDelete(user, "en");
    const dialog = await screen.findByRole("dialog");
    const confirm = within(dialog).getByRole("button", { name: en.skills.detail.delete });
    expect(confirm).toHaveProperty("disabled", true);
    await user.type(within(dialog).getByRole("textbox"), "pdf-tools");
    await user.click(confirm);
    await vi.waitFor(() => expect(router.push).toHaveBeenCalledWith("/skills"));
    expect(calls.some((c) => c.method === "DELETE")).toBe(true);
  });

  it("成员没有删除入口", async () => {
    stubApi({ [`GET ${BASE}/s1`]: () => json(200, detail()) });
    await renderSkill({ me: MEMBER });
    await screen.findByText("# PDF tools", { exact: false });
    expect(screen.queryByRole("button", { name: en.skills.detail.delete })).toBeNull();
    expect(screen.queryByRole("button", { name: en.common.moreActions })).toBeNull();
  });

  it("one centred column: the full description first, the facts as a KeyValue, 删除 in the head's menu", async () => {
    stubApi({ [`GET ${BASE}/s1`]: () => json(200, detail({ description: LONG })) });
    await renderSkill();
    await screen.findByText("# PDF tools", { exact: false });
    expect(document.querySelector(".cb-body")?.getAttribute("data-layout")).toBe("single");
    // The head carries no description: the full text (line breaks kept) leads the facts block,
    // drawn once above the tab (not per tab)
    expect(document.querySelector('[data-part="page-header-description"]')).toBeNull();
    const block = document.querySelector('[data-part="detail-facts"]');
    const first = block?.querySelector(".cb-stack")?.firstElementChild;
    expect(first?.textContent).toBe(LONG);
    expect(first?.getAttribute("data-pre")).toBe("true");
    const facts = block?.querySelector('[data-part="key-value"]');
    expect(facts?.textContent).toContain(en.skills.detail.owner);
    expect(facts?.textContent).toContain(en.skills.detail.version);
    // no danger card in the page: 删除 is the head menu's destructive item
    // no danger card in the page (its hint was the card's text)
    expect(screen.queryByText(en.skills.detail.deleteHint)).toBeNull();
    // the inspector and danger card copy left with them, in both locales
    for (const m of [zh, en]) {
      for (const k of ["inspectorTitle", "name", "dangerTitle", "description"]) {
        expect(k in m.skills.detail).toBe(false);
      }
      expect("more" in m.catalog.admin.detail).toBe(false);
    }
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: en.common.moreActions }));
    const del = await screen.findByRole("menuitem", { name: en.skills.detail.delete });
    expect(del.getAttribute("data-danger")).toBe("true");
  });

  it("a skill the kernel does not find is the not-found state in the shell", async () => {
    stubApi({
      [`GET ${BASE}/s1`]: () => json(404, { error: { code: "skill.not_found", message: "x" } }),
    });
    await renderSkill({ locale: "zh" });
    expect(screen.getByRole("heading", { level: 1, name: zh.notFound.title })).toBeTruthy();
  });

  it("deleting a skill invalidates the library and forgets the skill once the page is left", async () => {
    const calls = stubApi({
      [`GET ${BASE}`]: () => json(200, { skills: [] }),
      [`GET ${BASE}/s1`]: () => json(200, detail()),
      [`GET ${BASE}/s1/delete-preview`]: () =>
        json(200, { outcome: "removed", orgs: [], agents: [] }),
      [`DELETE ${BASE}/s1`]: () => noContent(),
    });
    const { client, unmount } = await renderSkill();
    // the library is cached (as after a visit to /skills)
    client.setQueryData(["org", "o1", "skills"], { skills: [skill("s1", "pdf-tools")] });
    const user = userEvent.setup();
    await openDelete(user, "en");
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByRole("textbox"), "pdf-tools");
    await user.click(within(dialog).getByRole("button", { name: en.skills.detail.delete }));
    await vi.waitFor(() => expect(router.push).toHaveBeenCalledWith("/skills"));
    const writes = () => calls.filter((c) => c.method !== "GET").map((c) => `${c.method} ${c.url}`);
    expect(writes()).toEqual([`DELETE ${BASE}/s1`]);
    expect(calls.some((c) => c.url === `${BASE}`)).toBe(false);
    expect(client.getQueryState(["org", "o1", "skills"])?.isInvalidated).toBe(true);
    // still cached while the page shows (no read, no not-found flash before the navigation) ...
    expect(client.getQueryData(["org", "o1", "skill", "s1"])).toBeDefined();
    expect(screen.queryByRole("heading", { level: 1, name: en.notFound.title })).toBeNull();
    // ... and gone once the page is left: Back reads it instead of painting the deleted skill
    unmount();
    expect(client.getQueryState(["org", "o1", "skill", "s1"])).toBeUndefined();
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `GET ${BASE}/s1/delete-preview`,
      `DELETE ${BASE}/s1`,
    ]);
  });
});

describe("the skills pages render on the server (web-SSR spec §6)", () => {
  const GUEST = {
    ...ME,
    account: { ...ME.account, isSuperAdmin: false },
    memberships: [{ orgId: "o1", slug: "acme", name: "Acme", role: "guest" }],
  };
  const detail = {
    ...skill("s1", "pdf-tools"),
    body: "# PDF tools\n",
    versions: [{ version: 1, description: "Use.", files: [], createdAt: T, createdBy: "a1" }],
  };
  const routes = {
    [`GET ${BASE}`]: () => json(200, { skills: [skill("s1", "pdf-tools")] }),
    [`GET ${BASE}/s1`]: () => json(200, detail),
    "GET /api/v1/orgs/o1/components": () => json(200, { components: [] }),
  };
  const template = (name: string) => document.querySelector(`[data-template="${name}"]`);

  it("/skills: a first render from the hydrated cache makes no browser read", async () => {
    const browser = expectNoFirstPaintFetch();
    await renderRouteWithCache("/skills", routes);
    expect(screen.getByRole("list", { name: en.skills.listLabel })).toBeTruthy();
    expect(screen.getByText("pdf-tools")).toBeTruthy();
    await settle();
    expect(browser).toEqual([]);
  });

  it("/skills/<id>: a first render from the hydrated cache makes no browser read", async () => {
    const browser = expectNoFirstPaintFetch();
    const { container } = await renderRouteWithCache("/skills/s1", routes);
    expect(container.querySelector("pre")?.textContent).toBe("# PDF tools\n");
    await settle();
    expect(browser).toEqual([]);
  });

  it.each([
    ["/skills", "ListPage", "pdf-tools"],
    ["/skills/s1", "DetailPage", "# PDF tools"],
  ])(
    "%s: an empty cache shows the template's loading state, then the data",
    async (path, name, text) => {
      let release: () => void = () => {};
      const held = new Promise<void>((r) => {
        release = r;
      });
      const later = (body: unknown) => async () => {
        await held;
        return json(200, body);
      };
      await renderRouteEmptyCache(path, {
        [`GET ${BASE}`]: later({ skills: [skill("s1", "pdf-tools")] }),
        [`GET ${BASE}/s1`]: later(detail),
      });
      const page = await vi.waitFor(() => {
        const el = template(name);
        if (el === null) throw new Error("no page yet");
        return el as HTMLElement;
      });
      expect(document.querySelector("[aria-busy='true']")).not.toBeNull();
      expect(screen.queryAllByText(text, { exact: false })).toEqual([]);
      await act(async () => release());
      expect(await screen.findAllByText(text, { exact: false })).not.toHaveLength(0);
      await vi.waitFor(() => expect(document.querySelector("[aria-busy='true']")).toBeNull());
      expect(page).toBeTruthy();
    },
  );

  it("/skills/<id>: the loading content is the facts' KeyValue and the body's lines, in one column", async () => {
    await renderRouteEmptyCache("/skills/s1", {
      [`GET ${BASE}/s1`]: () => new Promise<Response>(() => {}),
    });
    const page = await vi.waitFor(() => {
      const el = template("DetailPage");
      if (el === null) throw new Error("no page yet");
      return el as HTMLElement;
    });
    expect(page.querySelectorAll('[data-part="loading-card"]')).toHaveLength(0);
    // No delete card (删除 is the head's menu) and no inspector: the facts are in the column
    expect(page.querySelectorAll('[data-part="loading-shaped-card"]')).toHaveLength(0);
    expect(page.querySelectorAll('[data-part="loading-inspector-row"]')).toHaveLength(0);
    const facts = page.querySelector('[data-part="content"] [data-part="loading-key-value"]');
    expect(facts?.querySelectorAll('[data-part="key-value-row"]')).toHaveLength(5);
  });

  it.each(["/skills", "/skills/s1"])(
    "%s: a guest gets no access and nothing is read; no org renders nothing; setup goes home",
    async (path) => {
      const guest = await renderRouteWithCache(path, routes, { me: GUEST });
      expect(new Set(guest.calls.map((c) => c.url))).toEqual(
        new Set(["/api/v1/me", "/api/v1/orgs/o1/readiness"]),
      );
      expect(template("StatusPage")?.getAttribute("data-kind")).toBe("no-access");
      cleanup();
      const none = await renderRouteWithCache(path, routes, { me: { ...ME, currentOrgId: null } });
      expect(none.calls.map((c) => c.url)).toEqual(["/api/v1/me"]);
      expect(document.body.textContent).toBe("");
      cleanup();
      expectNoFirstPaintFetch();
      await renderRouteWithCache(path, routes, { readiness: NOT_READY });
      await vi.waitFor(() => expect(router.replace).toHaveBeenCalledWith("/"));
    },
  );
});

describe("plugin scope phase 3: the 可共享 switch and the delete preview", () => {
  const GUEST = {
    ...ME,
    account: { ...ME.account, isSuperAdmin: false },
    memberships: [{ orgId: "o1", slug: "acme", name: "Acme", role: "guest" }],
  };
  const fill = (s: string, vars: Record<string, string>) =>
    s.replace(/\{(\w+)\}/g, (_, k: string) => vars[k] ?? "");
  // The removed 新建 action: its label in both locales
  const CREATE_LABEL = /^(New|新建)$/;

  it.each(LOCALES)("org admins get 上传技能 and no 新建 (%s)", async (locale) => {
    stubApi({ [`GET ${BASE}`]: () => json(200, { skills: [skill("s1", "pdf-tools")] }) });
    await renderSkills({ locale });
    await screen.findByText("pdf-tools");
    expect(screen.getByRole("button", { name: msgs[locale].skills.upload.open })).toBeTruthy();
    expect(screen.queryByRole("button", { name: CREATE_LABEL })).toBeNull();
  });

  it("members and guests do not get 上传技能", async () => {
    stubApi({ [`GET ${BASE}`]: () => json(200, { skills: [skill("s1", "pdf-tools")] }) });
    await renderSkills({ me: MEMBER });
    await screen.findByText("pdf-tools");
    expect(screen.queryByRole("button", { name: en.skills.upload.open })).toBeNull();
    cleanup();
    stubApi({ [`GET ${BASE}`]: () => json(200, { skills: [skill("s1", "pdf-tools")] }) });
    await renderSkills({ me: GUEST });
    await settle();
    expect(screen.queryByRole("button", { name: en.skills.upload.open })).toBeNull();
    expect(screen.queryByText("pdf-tools")).toBeNull();
  });

  it.each(LOCALES)(
    "an own skill shows the 可共享 switch, which sets it and reads the skill again (%s)",
    async (locale) => {
      const m = msgs[locale].skills.detail;
      let shared = false;
      const calls = stubApi({
        [`GET ${BASE}/s1`]: () =>
          json(200, detail({ origin: "org", plugin: null, shareable: shared })),
        [`PUT ${BASE}/s1/shareable`]: () => {
          shared = true;
          return json(200, { id: "s1", shareable: true });
        },
      });
      await renderSkill({ locale });
      const share = await screen.findByRole("switch", { name: m.shareable });
      expect(share.getAttribute("aria-checked")).toBe("false");
      expect(screen.getByText(m.shareableHelp)).toBeTruthy();
      await userEvent.setup().click(share);
      await vi.waitFor(() =>
        expect(bodyOf(calls.find((x) => x.method === "PUT"))).toEqual({ shareable: true }),
      );
      await vi.waitFor(() =>
        expect(screen.getByRole("switch", { name: m.shareable }).getAttribute("aria-checked")).toBe(
          "true",
        ),
      );
    },
  );

  it("a platform skill names its owner from owner_org_id: 本组织, another org, 平台", async () => {
    const m = en.skills.detail;
    const cases = [
      [{ kind: "org", orgId: "o1", name: "Acme" }, en.catalog.owner.self],
      [{ kind: "org", orgId: "o2", name: "Beta" }, "Beta"],
      [{ kind: "platform" }, en.catalog.owner.platform],
    ] as const;
    for (const [owner, label] of cases) {
      stubApi({ [`GET ${BASE}/s1`]: () => json(200, detail({ origin: "platform", owner })) });
      await renderSkill();
      const key = await screen.findByText(m.owner);
      expect(key.parentElement?.textContent).toContain(label);
      cleanup();
    }
  });

  it("no 可共享 on a platform skill, a plugin's skill, or for members", async () => {
    stubApi({ [`GET ${BASE}/s1`]: () => json(200, detail({ origin: "platform" })) });
    await renderSkill();
    await screen.findByText(en.skills.detail.platformHint);
    expect(screen.queryByRole("switch", { name: en.skills.detail.shareable })).toBeNull();
    cleanup();
    stubApi({ [`GET ${BASE}/s1`]: () => json(200, detail({ origin: "org", plugin: "docs" })) });
    await renderSkill();
    await screen.findByText("# PDF tools", { exact: false });
    expect(screen.queryByRole("switch", { name: en.skills.detail.shareable })).toBeNull();
    cleanup();
    stubApi({ [`GET ${BASE}/s1`]: () => json(200, detail({ origin: "org", shareable: true })) });
    await renderSkill({ me: MEMBER });
    const share = await screen.findByRole("switch", { name: en.skills.detail.shareable });
    expect(share.getAttribute("aria-checked")).toBe("true");
    expect(share).toHaveProperty("disabled", true);
  });

  it("the delete waits for its preview; a failed preview offers 重试; the toast follows the preview seen", async () => {
    let fail = true;
    let release: () => void = () => {};
    const held = new Promise<void>((r) => {
      release = r;
    });
    let reads = 0;
    const calls = stubApi({
      [`GET ${BASE}/s1`]: () => json(200, detail({ origin: "org", shareable: true })),
      [`GET ${BASE}/s1/delete-preview`]: async () => {
        reads += 1;
        if (fail) return json(500, { error: { code: "internal", message: "x" } });
        await held;
        return json(200, {
          outcome: "transferred",
          orgs: [{ id: "o2", name: "Beta" }],
          agents: [],
        });
      },
      [`DELETE ${BASE}/s1`]: () => noContent(),
    });
    await renderSkill();
    const user = userEvent.setup();
    await openDelete(user, "en");
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByRole("textbox"), "pdf-tools");
    const confirm = within(dialog).getByRole("button", { name: en.skills.detail.delete });
    // the preview failed: an error with 重试, and no delete without it
    const retry = await within(dialog).findByRole("button", {
      name: en.skills.detail.previewRetry,
    });
    expect(confirm).toHaveProperty("disabled", true);
    fail = false;
    const before = reads;
    await user.click(retry);
    await vi.waitFor(() => expect(reads).toBe(before + 1));
    // while it reads, confirm stays disabled
    expect(confirm).toHaveProperty("disabled", true);
    release();
    await within(dialog).findByText(fill(en.plugins.delete.transferred, { orgs: "Beta" }));
    await vi.waitFor(() => expect(confirm).toHaveProperty("disabled", false));
    await user.click(confirm);
    await vi.waitFor(() => expect(router.push).toHaveBeenCalledWith("/skills"));
    expect(calls.filter((c) => c.method === "DELETE")).toHaveLength(1);
    expect(
      await screen.findByText(fill(en.plugins.delete.doneTransferred, { name: "pdf-tools" })),
    ).toBeTruthy();
  });

  it.each(LOCALES)(
    "deleting a shared skill another org uses says it is transferred, naming the orgs and agents (%s)",
    async (locale) => {
      const m = msgs[locale];
      const sep = locale === "zh" ? "、" : ", ";
      stubApi({
        [`GET ${BASE}/s1`]: () => json(200, detail({ origin: "org", shareable: true })),
        [`GET ${BASE}/s1/delete-preview`]: () =>
          json(200, {
            outcome: "transferred",
            orgs: [
              { id: "o2", name: "Beta" },
              { id: "o3", name: "Gamma" },
            ],
            agents: [{ id: "ag1", name: "Writer" }],
          }),
        [`DELETE ${BASE}/s1`]: () => noContent(),
      });
      await renderSkill({ locale });
      const user = userEvent.setup();
      await openDelete(user, locale);
      const dialog = await screen.findByRole("dialog");
      expect(
        await within(dialog).findByText(
          fill(m.plugins.delete.transferred, { orgs: `Beta${sep}Gamma` }),
        ),
      ).toBeTruthy();
      // what it does first, then the notice; the agents a list under their heading
      const hint = within(dialog).getByText(m.skills.detail.deleteHint);
      const notice = within(dialog)
        .getByText(fill(m.plugins.delete.transferred, { orgs: `Beta${sep}Gamma` }))
        .closest('[data-part="callout"]') as HTMLElement;
      expect(hint.compareDocumentPosition(notice) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      const agents = within(dialog).getByRole("list", { name: m.plugins.delete.agents });
      expect(within(agents).getByText("Writer")).toBeTruthy();
      expect(dialog.textContent).not.toContain("· Writer");
      await user.type(within(dialog).getByRole("textbox"), "pdf-tools");
      await user.click(within(dialog).getByRole("button", { name: m.skills.detail.delete }));
      await vi.waitFor(() => expect(router.push).toHaveBeenCalledWith("/skills"));
      expect(
        await screen.findByText(fill(m.plugins.delete.doneTransferred, { name: "pdf-tools" })),
      ).toBeTruthy();
    },
  );
});
