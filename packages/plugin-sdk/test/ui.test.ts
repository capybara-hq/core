import { readFileSync } from "node:fs";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  defineExtension,
  EMBED_PROTOCOL,
  type ExtensionContext,
  type ExtensionManifest,
  parseEmbedChildMessage,
  type ToolResult,
  UI_LIMITS,
  type UiBlock,
  type UiView,
  validatePermissions,
  validateToolDisplay,
  validateUiContributions,
  validateUiView,
} from "../src/index.js";

/** navigate 路径的共享测试向量（与 apps/web/test/embed-bridge.test.tsx 共用）。 */
const NAV_VECTORS = JSON.parse(
  readFileSync(
    new URL("../../../tools/fixtures/embed-navigate-vectors.json", import.meta.url),
    "utf8",
  ),
) as { accept: string[]; reject: string[] };

const view = (...blocks: unknown[]): unknown => ({ blocks });
const ok = (...blocks: unknown[]) => expect(validateUiView(view(...blocks))).toEqual([]);
const bad = (re: RegExp, ...blocks: unknown[]) =>
  expect(validateUiView(view(...blocks)).join("\n")).toMatch(re);

const FORM = {
  title: "Pick",
  fields: [{ key: "color", label: "Color", schema: { type: "string", enum: ["red", "blue"] } }],
};

describe("validateUiView：每种块一个合法、一个非法用例", () => {
  it("整体结构", () => {
    expect(validateUiView({ blocks: [], badge: "2/4" })).toEqual([]);
    expect(validateUiView(null).join()).toMatch(/object/);
    expect(validateUiView({}).join()).toMatch(/blocks/);
    expect(validateUiView({ blocks: [], badge: 3 }).join()).toMatch(/badge/);
    bad(/type/, { type: "marquee", text: "x" });
    bad(/object/, "heading");
  });
  it("heading", () => {
    ok({ type: "heading", text: "Tasks" });
    bad(/text/, { type: "heading", text: 1 });
  });
  it("text", () => {
    ok({ type: "text", markdown: "see [docs](https://example.com/a) and <https://x.io>" });
    bad(/markdown/, { type: "text" });
  });
  it("checklist", () => {
    ok({
      type: "checklist",
      items: [
        { text: "a", status: "pending" },
        { text: "b", status: "in_progress" },
        { text: "c", status: "completed" },
      ],
    });
    bad(/status/, { type: "checklist", items: [{ text: "a", status: "done" }] });
    bad(/text/, { type: "checklist", items: [{ text: "", status: "pending" }] });
  });
  it("keyValue", () => {
    ok({ type: "keyValue", items: [{ label: "Owner", value: "Ann" }] });
    bad(/value/, { type: "keyValue", items: [{ label: "Owner", value: 3 }] });
  });
  it("table", () => {
    ok({
      type: "table",
      columns: [
        { key: "name", label: "Name" },
        { key: "state", label: "State" },
      ],
      rows: [{ name: "a", state: "open" }, { name: "b" }],
    });
    bad(/unknown column/, {
      type: "table",
      columns: [{ key: "name", label: "Name" }],
      rows: [{ nope: "a" }],
    });
    bad(/duplicate/, {
      type: "table",
      columns: [
        { key: "a", label: "A" },
        { key: "a", label: "B" },
      ],
      rows: [],
    });
  });
  it("code", () => {
    ok({ type: "code", language: "ts", text: "const a = 1;" });
    ok({ type: "code", text: "plain" });
    bad(/language/, { type: "code", language: 3, text: "x" });
  });
  it("image", () => {
    ok({ type: "image", url: "https://example.com/a.png", alt: "chart" });
    bad(/url/, { type: "image", url: "/relative.png", alt: "x" });
  });
  it("chart", () => {
    ok({ type: "chart", kind: "bar", series: [{ label: "Mon", value: 3 }] });
    ok({ type: "chart", kind: "line", series: [] });
    bad(/value/, { type: "chart", kind: "line", series: [{ label: "Mon", value: Number.NaN }] });
    bad(/kind/, { type: "chart", kind: "pie", series: [] });
  });
  it("actions", () => {
    ok({
      type: "actions",
      buttons: [
        { actionId: "retry", label: "Retry", payload: { id: 1 } },
        { actionId: "drop", label: "Drop", danger: true },
      ],
    });
    bad(/actionId/, { type: "actions", buttons: [{ label: "Retry" }] });
    bad(/danger/, { type: "actions", buttons: [{ actionId: "a", label: "A", danger: "yes" }] });
  });
  it("form", () => {
    ok({ type: "form", form: FORM, actionId: "pick", submitLabel: "Save" });
    bad(/form/, {
      type: "form",
      form: { title: "x", fields: [] },
      actionId: "pick",
      submitLabel: "Save",
    });
    bad(/submitLabel/, { type: "form", form: FORM, actionId: "pick" });
  });
});

describe("validateUiView：actionId 在整个视图内唯一", () => {
  it("按钮之间、按钮与表单之间、跨块重复都报错", () => {
    ok(
      {
        type: "actions",
        buttons: [
          { actionId: "a", label: "A" },
          { actionId: "b", label: "B" },
        ],
      },
      { type: "form", form: FORM, actionId: "c", submitLabel: "Save" },
    );
    bad(/duplicate actionId "a"/, {
      type: "actions",
      buttons: [
        { actionId: "a", label: "A" },
        { actionId: "a", label: "B" },
      ],
    });
    bad(
      /duplicate actionId "a"/,
      { type: "actions", buttons: [{ actionId: "a", label: "A" }] },
      { type: "actions", buttons: [{ actionId: "a", label: "B" }] },
    );
    bad(
      /duplicate actionId "pick"/,
      { type: "actions", buttons: [{ actionId: "pick", label: "A" }] },
      { type: "form", form: FORM, actionId: "pick", submitLabel: "Save" },
    );
    bad(
      /duplicate actionId "pick"/,
      { type: "form", form: FORM, actionId: "pick", submitLabel: "Save" },
      { type: "form", form: FORM, actionId: "pick", submitLabel: "Again" },
    );
  });
});

describe("validateUiView：上限", () => {
  it("块数", () => {
    const blocks = Array.from({ length: UI_LIMITS.blocks }, () => ({ type: "heading", text: "h" }));
    ok(...blocks);
    bad(/blocks/, ...blocks, { type: "heading", text: "h" });
  });
  it("表格行数", () => {
    const rows = (n: number) => Array.from({ length: n }, () => ({ a: "x" }));
    const t = (n: number) => ({
      type: "table",
      columns: [{ key: "a", label: "A" }],
      rows: rows(n),
    });
    ok(t(UI_LIMITS.tableRows));
    bad(/rows/, t(UI_LIMITS.tableRows + 1));
  });
  it("清单项数", () => {
    const items = (n: number) =>
      Array.from({ length: n }, () => ({ text: "t", status: "pending" }));
    ok({ type: "checklist", items: items(UI_LIMITS.checklistItems) });
    bad(/items/, { type: "checklist", items: items(UI_LIMITS.checklistItems + 1) });
  });
  it("文本总长（跨块累计）", () => {
    ok({ type: "text", markdown: "x".repeat(UI_LIMITS.textChars) });
    bad(/characters/, { type: "text", markdown: "x".repeat(UI_LIMITS.textChars + 1) });
    const half = "x".repeat(UI_LIMITS.textChars / 2 + 1);
    bad(/characters/, { type: "code", text: half }, { type: "heading", text: half });
  });
  it("按钮 payload 字节数（UTF-8）", () => {
    // JSON.stringify("…") 带两个引号
    const fits = "a".repeat(UI_LIMITS.payloadBytes - 2);
    ok({ type: "actions", buttons: [{ actionId: "a", label: "A", payload: fits }] });
    bad(/payload/, {
      type: "actions",
      buttons: [{ actionId: "a", label: "A", payload: `${fits}a` }],
    });
    // 多字节字符按字节计
    const cjk = "汉".repeat(700);
    bad(/payload/, { type: "actions", buttons: [{ actionId: "a", label: "A", payload: cjk }] });
  });
  it("payload 必须可 JSON 序列化", () => {
    const cyc: Record<string, unknown> = {};
    cyc.self = cyc;
    bad(/payload/, { type: "actions", buttons: [{ actionId: "a", label: "A", payload: cyc }] });
    bad(/payload/, { type: "actions", buttons: [{ actionId: "a", label: "A", payload: 10n }] });
    bad(/payload/, { type: "actions", buttons: [{ actionId: "a", label: "A", payload: () => 1 }] });
  });
});

describe("validateUiView：链接与图片只允许 http(s)", () => {
  it("javascript: 链接", () => {
    bad(/link/, { type: "text", markdown: "[click](javascript:alert(1))" });
    bad(/link/, { type: "text", markdown: "[click]( JavaScript:alert(1) )" });
    bad(/link/, { type: "text", markdown: "![img](javascript:alert(1))" });
    bad(/link/, { type: "text", markdown: "<javascript:alert(1)>" });
    bad(/link/, { type: "text", markdown: "[x]: javascript:alert(1)\n\n[go][x]" });
    bad(/link/, { type: "text", markdown: "[data](data:text/html,hi)" });
    bad(/link/, { type: "text", markdown: "[rel](/local/path)" });
  });
  it("javascript: 图片", () => {
    bad(/url/, { type: "image", url: "javascript:alert(1)", alt: "x" });
    bad(/url/, { type: "image", url: "data:image/png;base64,AAAA", alt: "x" });
  });
  it("表单的外部链接沿用 InputForm 校验", () => {
    bad(/url/, {
      type: "form",
      form: { ...FORM, url: "javascript:alert(1)" },
      actionId: "pick",
      submitLabel: "Go",
    });
  });
});

describe("parseEmbedChildMessage", () => {
  const msg = (o: Record<string, unknown>) => ({ protocol: EMBED_PROTOCOL, ...o });
  it("接受三种合法消息，只留已知字段", () => {
    expect(parseEmbedChildMessage(msg({ type: "resize", height: 320, extra: 1 }))).toEqual(
      msg({ type: "resize", height: 320 }),
    );
    expect(parseEmbedChildMessage(msg({ type: "navigate", path: "/c/123?x=1#y" }))).toEqual(
      msg({ type: "navigate", path: "/c/123?x=1#y" }),
    );
    expect(parseEmbedChildMessage(msg({ type: "toast", text: "Saved" }))).toEqual(
      msg({ type: "toast", text: "Saved" }),
    );
  });
  it("拒绝协议不符", () => {
    expect(
      parseEmbedChildMessage({ protocol: "capybara-embed/2", type: "toast", text: "x" }),
    ).toBeNull();
    expect(parseEmbedChildMessage({ type: "toast", text: "x" })).toBeNull();
    expect(parseEmbedChildMessage(null)).toBeNull();
    expect(parseEmbedChildMessage("toast")).toBeNull();
  });
  it("navigate：共享向量里的 accept 原样放行、reject 一律拒绝（站外、//、. / .. 段、编码的 / \\ 与控制字符）", () => {
    for (const path of NAV_VECTORS.accept) {
      expect(parseEmbedChildMessage(msg({ type: "navigate", path })), path).toEqual(
        msg({ type: "navigate", path }),
      );
    }
    for (const path of NAV_VECTORS.reject) {
      expect(parseEmbedChildMessage(msg({ type: "navigate", path })), path).toBeNull();
    }
  });
  it("拒绝负数 / NaN / 无穷 / 超过 10000 的高度", () => {
    expect(parseEmbedChildMessage(msg({ type: "resize", height: 10000 }))).not.toBeNull();
    for (const height of [-1, Number.NaN, Number.POSITIVE_INFINITY, "100", 10001]) {
      expect(parseEmbedChildMessage(msg({ type: "resize", height }))).toBeNull();
    }
  });
  it("拒绝多余的类型与空提示", () => {
    expect(parseEmbedChildMessage(msg({ type: "init", token: "t" }))).toBeNull();
    expect(parseEmbedChildMessage(msg({ type: "eval", code: "1" }))).toBeNull();
    expect(parseEmbedChildMessage(msg({ type: "toast", text: "" }))).toBeNull();
  });
});

describe("validateToolDisplay", () => {
  it("合法摘要", () => {
    expect(
      validateToolDisplay({ summary: { zh: "更新任务清单（4 项）", en: "Updated tasks (4)" } }),
    ).toEqual([]);
    expect(validateToolDisplay({ summary: { zh: "汉".repeat(200), en: "x".repeat(200) } })).toEqual(
      [],
    );
  });
  it("任一语言超过 200 字符报错", () => {
    expect(validateToolDisplay({ summary: { zh: "汉".repeat(201), en: "ok" } }).join()).toMatch(
      /zh/,
    );
    expect(validateToolDisplay({ summary: { zh: "ok", en: "x".repeat(201) } }).join()).toMatch(
      /en/,
    );
  });
  it("结构不对报错", () => {
    expect(validateToolDisplay(null).length).toBeGreaterThan(0);
    expect(validateToolDisplay({ summary: "hi" }).length).toBeGreaterThan(0);
    expect(validateToolDisplay({ summary: { zh: "", en: "x" } }).join()).toMatch(/zh/);
  });
  it("ToolResult 可带 display", () => {
    expectTypeOf<ToolResult["display"]>().toEqualTypeOf<
      { summary: { zh: string; en: string } } | undefined
    >();
  });
});

describe("permissions.ui", () => {
  it("合法与非法形状", () => {
    expect(validatePermissions("p", { ui: { views: ["tasks"], embeds: ["board"] } })).toEqual([]);
    expect(validatePermissions("p", { ui: { views: "tasks" } }).join()).toMatch(/ui\.views/);
    expect(validatePermissions("p", { ui: { bogus: [] } }).join()).toMatch(/bogus/);
    expect(validatePermissions("p", { ui: { views: ["a"], embeds: ["a"] } }).join()).toMatch(
      /both/,
    );
  });
});

describe("清单校验：ui 贡献与 permissions 交叉核对", () => {
  const title = { zh: "任务", en: "Tasks" };
  const base = (over: Partial<ExtensionManifest> = {}): ExtensionManifest => ({
    name: "demo-plugin",
    version: "1.0.0",
    sdk: "^0.1.0",
    provides: [],
    setup() {},
    ...over,
  });
  const GET_BOARD = [{ method: "GET" as const, path: "/ui/board" }];
  const good = base({
    ui: [
      { id: "tasks", title, place: "conversation", kind: "view" },
      { id: "board", title, place: "page", kind: "embed", path: "/ui/board" },
    ],
    permissions: {
      http: GET_BOARD,
      ui: { views: ["tasks"], embeds: ["board"] },
    },
  });

  it("合法清单通过", () => {
    expect(defineExtension(good)).toBe(good);
  });
  it("缺 permissions.ui 条目报错", () => {
    expect(() =>
      defineExtension({ ...good, permissions: { ...good.permissions, ui: { embeds: ["board"] } } }),
    ).toThrow(/tasks.*permissions\.ui\.views/);
    expect(() => defineExtension({ ...good, permissions: { http: GET_BOARD } })).toThrow(
      /permissions\.ui/,
    );
    // kind 与列表不匹配：embed 写进了 views
    expect(() =>
      defineExtension({
        ...good,
        permissions: { ...good.permissions, ui: { views: ["tasks", "board"] } },
      }),
    ).toThrow(/board.*permissions\.ui\.embeds/);
  });
  it("permissions.ui 有贡献里没有的 id 报错", () => {
    expect(() =>
      defineExtension({
        ...good,
        permissions: { ...good.permissions, ui: { views: ["tasks", "ghost"], embeds: ["board"] } },
      }),
    ).toThrow(/ghost/);
  });
  it("embed 的 path 不在 /ui/ 下报错", () => {
    const m = base({
      ui: [{ id: "board", title, place: "page", kind: "embed", path: "/board" }],
      permissions: { http: [{ method: "GET", path: "/board" }], ui: { embeds: ["board"] } },
    });
    expect(() => defineExtension(m)).toThrow(/\/ui\//);
  });
  it("embed 的 path 未在 permissions.http 声明为 GET 报错", () => {
    const m = base({
      ui: [{ id: "board", title, place: "page", kind: "embed", path: "/ui/board" }],
      permissions: { http: [{ method: "POST", path: "/ui/board" }], ui: { embeds: ["board"] } },
    });
    expect(() => defineExtension(m)).toThrow(/GET \/ui\/board/);
  });
  it("贡献本身的形状", () => {
    const errs = (ui: unknown, perms: unknown = { ui: { views: ["a"] } }) =>
      validateUiContributions(ui, perms).join("\n");
    expect(errs([{ id: "a", title, place: "sidebar", kind: "view" }])).toMatch(/place/);
    expect(errs([{ id: "a", title, place: "page", kind: "widget" }])).toMatch(/kind/);
    expect(errs([{ id: "a", title: { zh: "x" }, place: "page", kind: "view" }])).toMatch(/title/);
    expect(errs([{ id: "a", title, place: "page", kind: "view", path: "/ui/a" }])).toMatch(/path/);
    expect(errs([{ id: "Bad Id", title, place: "page", kind: "view" }])).toMatch(/id/);
    expect(
      errs([
        { id: "a", title, place: "page", kind: "view" },
        { id: "a", title, place: "conversation", kind: "view" },
      ]),
    ).toMatch(/duplicate/);
    expect(errs("nope")).toMatch(/array/);
    expect(validateUiContributions(undefined, undefined)).toEqual([]);
  });
});

describe("类型", () => {
  it("ctx.ui 与块联合", () => {
    expectTypeOf<ExtensionContext["ui"]["invalidate"]>()
      .parameter(0)
      .toEqualTypeOf<{ orgId: string; conversationId?: string; contribution: string }>();
    expectTypeOf<UiView["blocks"][number]>().toEqualTypeOf<UiBlock>();
  });
});
