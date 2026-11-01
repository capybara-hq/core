import { act, cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import zh from "../messages/zh.json";
import SkillDetailPage from "../src/app/(app)/skills/[id]/page";
import SkillsPage from "../src/app/(app)/skills/page";
import { bodyOf, json, lastStubRoutes, noContent, stubApi } from "./support/api";
import { resetNavigation, router } from "./support/navigation";
import { ME } from "./support/render";
import { expectNoFirstPaintFetch, renderRoute } from "./support/server";
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

type RenderOpts = Parameters<typeof renderRoute>[2];
/** `/skills` read on the server from the latest `stubApi` routes (the browser's). */
const renderSkills = (opts: RenderOpts = {}) =>
  renderRoute(() => SkillsPage(), lastStubRoutes(), opts);
/** `/skills/s1` read on the server from the latest `stubApi` routes. */
const renderSkill = (opts: RenderOpts = {}) =>
  renderRoute(
    () => SkillDetailPage({ params: Promise.resolve({ id: "s1" }) }),
    lastStubRoutes(),
    opts,
  );

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
    expect(screen.getByRole("button", { name: m.skills.upload.choose })).toBeTruthy();
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
    await vi.waitFor(() => expect(screen.getByText(/^v2 · /)).toBeTruthy());
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
      [`DELETE ${BASE}/s1`]: () => noContent(),
    });
    await renderSkill();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: en.skills.detail.delete }));
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
  });

  it("a skill the kernel does not find is the not-found page", async () => {
    stubApi({
      [`GET ${BASE}/s1`]: () => json(404, { error: { code: "skill.not_found", message: "x" } }),
    });
    await expect(renderSkill({ locale: "zh" })).rejects.toThrow("NOT_FOUND");
  });
});

describe("the skills pages render on the server (web-SSR spec §6)", () => {
  const GUEST = {
    ...ME,
    account: { ...ME.account, isEnterpriseAdmin: false },
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
  };
  const template = (name: string) => document.querySelector(`[data-template="${name}"]`);

  it("/skills: the list is the first paint", async () => {
    const browser = expectNoFirstPaintFetch();
    await renderRoute(() => SkillsPage(), routes);
    expect(screen.getByRole("list", { name: en.skills.listLabel })).toBeTruthy();
    expect(screen.getByText("pdf-tools")).toBeTruthy();
    expect(browser).toEqual([]);
  });

  it("/skills/<id>: the skill is the first paint", async () => {
    const browser = expectNoFirstPaintFetch();
    const { container } = await renderRoute(
      () => SkillDetailPage({ params: Promise.resolve({ id: "s1" }) }),
      routes,
    );
    expect(container.querySelector("pre")?.textContent).toBe("# PDF tools\n");
    expect(browser).toEqual([]);
  });

  it.each([
    ["/skills", () => SkillsPage()],
    ["/skills/<id>", () => SkillDetailPage({ params: Promise.resolve({ id: "s1" }) })],
  ])(
    "%s: a guest gets no access and nothing is read; no org renders nothing; setup redirects home",
    async (_path, page) => {
      const guest = await renderRoute(page, routes, { me: GUEST });
      expect(new Set(guest.calls.map((c) => c.url))).toEqual(
        new Set(["/api/v1/me", "/api/v1/orgs/o1/readiness"]),
      );
      expect(template("StatusPage")?.getAttribute("data-kind")).toBe("no-access");
      cleanup();
      const none = await renderRoute(page, routes, { me: { ...ME, currentOrgId: null } });
      expect(none.calls.map((c) => c.url)).toEqual(["/api/v1/me"]);
      expect(document.body.textContent).toBe("");
      await expect(renderRoute(page, routes, { readiness: NOT_READY })).rejects.toThrow(
        "REDIRECT /",
      );
    },
  );
});
