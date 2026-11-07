import { describeNestedBox, findNestedBoxes } from "@capybara-hq/design/reference";
import { cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import zh from "../messages/zh.json";
import type { Me } from "../src/lib/session";
import { bodyOf, json, lastStubRoutes, stubApi } from "./support/api";
import { resetNavigation } from "./support/navigation";
import { renderRouteWithCache } from "./support/query";
import { ME } from "./support/render";

vi.mock("../src/i18n/navigation", () => import("./support/navigation"));
vi.mock("../src/lib/browser", () => ({ navigateBrowser: vi.fn() }));

const BASE = "/api/v1/orgs/o1";
const OVERRIDES = `${BASE}/extensions/bailian/overrides`;
const msgs = { zh, en } as const;
const MEMBER: Me = {
  ...ME,
  memberships: [{ orgId: "o1", slug: "acme", name: "Acme", role: "member" }],
};

/** An extension whose deployment config has overridable fields, as the org's list answers it. */
const BAILIAN = {
  plugin: "bailian",
  displayName: { zh: "百炼", en: "Bailian" },
  version: "1.0.0",
  enabled: true,
  configurable: true,
  config: null,
  secrets: [],
  permissions: [
    {
      category: "provides",
      sensitive: false,
      items: ["model-provider@2"],
      entries: [{ value: "model-provider@2", sensitive: false }],
    },
  ],
  orgConfigSchema: null,
  overrideState: "following",
  needsConfig: false,
};

const FOLLOWING = {
  state: "following",
  valid: true,
  issues: [],
  fields: [
    { path: "region", level: "readonly", secret: false, platform: { value: "eu" } },
    {
      path: "baseUrl",
      level: "override",
      secret: false,
      platform: { value: "https://platform.example" },
    },
    { path: "apiKey", level: "override", secret: true, platform: { set: true } },
  ],
};

const COPY = {
  state: "copy",
  createdAt: "2026-11-05T08:00:00.000Z",
  valid: true,
  issues: [],
  fields: [
    { path: "region", level: "readonly", secret: false, platform: { value: "eu" } },
    {
      path: "baseUrl",
      level: "override",
      secret: false,
      platform: { value: "https://platform.example" },
      org: { value: "https://own.example" },
      differs: true,
    },
    {
      path: "apiKey",
      level: "override",
      secret: true,
      platform: { set: true },
      org: { set: true },
    },
  ],
};

function routes(view: unknown, extra: Parameters<typeof stubApi>[0] = {}) {
  return stubApi({
    [`GET ${BASE}/file-previewers`]: () => json(200, { items: [] }),
    [`GET ${BASE}/extension-points`]: () => json(200, { points: [] }),
    "GET /api/v1/auth/sources": () => json(200, { sources: [] }),
    [`GET ${BASE}/extensions`]: () => json(200, { extensions: [BAILIAN] }),
    [`GET ${OVERRIDES}`]: () => json(200, view),
    ...extra,
  });
}

beforeEach(() => {
  resetNavigation("/extensions");
  window.history.replaceState(null, "", "/");
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function openSheet(locale: "zh" | "en" = "en") {
  const name = locale === "zh" ? "百炼" : "Bailian";
  await renderRouteWithCache("/extensions", lastStubRoutes(), { locale });
  const user = userEvent.setup();
  await user.click(await screen.findByText(name, { selector: ".cb-cell-title-name" }));
  const sheet = await screen.findByRole("dialog", { name });
  return { user, sheet };
}

describe("the org form of a two-level extension config (Sheet)", () => {
  it.each(["zh", "en"] as const)(
    "following: read-only fields are locked and labelled, a secret shows who holds it and no value (%s)",
    async (locale) => {
      const m = msgs[locale];
      routes(FOLLOWING);
      const { sheet } = await openSheet(locale);
      const region = (await within(sheet).findByLabelText("region")) as HTMLInputElement;
      expect(region.disabled).toBe(true);
      expect(region.value).toBe("eu");
      const baseUrl = within(sheet).getByLabelText("baseUrl") as HTMLInputElement;
      expect(baseUrl.disabled).toBe(false);
      expect(baseUrl.value).toBe("https://platform.example");
      // the platform's label on the read-only field and on the followed one
      expect(within(sheet).getAllByText(new RegExp(m.configForm.platformSet)).length).toBe(2);
      expect(within(sheet).getByText(m.extensions.overrides.following)).toBeTruthy();
      expect(within(sheet).getByText(m.configForm.secretState.platform)).toBeTruthy();
      const key = within(sheet).getByLabelText(/^apiKey/) as HTMLInputElement;
      expect(key.value).toBe("");
      expect(sheet.textContent).not.toContain("sk-");
      // no copy yet: nothing to compare or drop
      expect(
        within(sheet).queryByRole("button", { name: m.extensions.overrides.compare }),
      ).toBeNull();
      expect(
        within(sheet).queryByRole("button", { name: m.extensions.overrides.usePlatform }),
      ).toBeNull();
      expect(findNestedBoxes(document.body).map(describeNestedBox)).toEqual([]);
    },
  );

  it("zh copy is exactly the accepted wording", () => {
    const o = zh.extensions.overrides;
    expect(zh.configForm.platformSet).toBe("平台配置");
    expect(o.following).toBe("跟随平台");
    expect(o.ownConfig).toBe("本组织使用自己的配置");
    expect(o.compare).toBe("与平台对比");
    expect(o.take).toBe("采用平台值");
    expect(o.usePlatform).toBe("使用平台配置");
    expect(o.resetBody).toBe("将删除本组织自己的配置（包括密钥），之后跟随平台的配置。");
    expect(o.firstEdit).toBe("修改后本组织将使用自己的配置，需要填写自己的密钥。");
    expect(zh.configForm.secretState).toEqual({
      platform: "平台已配置",
      own: "本组织已配置",
      unset: "未配置",
    });
    expect(zh.configForm.level).toEqual({
      hidden: "组织不可见",
      readonly: "组织只读",
      override: "组织可覆盖",
    });
    expect(zh.admin.extensions.status.runningOrgsConfigure).toContain("运行中 · 组织需各自配置");
  });

  it("the first edit says the org needs its own keys, and the empty secret is required in the same save", async () => {
    const p = en.extensions.overrides;
    let view: unknown = FOLLOWING;
    const calls = routes(FOLLOWING, {
      [`GET ${OVERRIDES}`]: () => json(200, view),
      [`PUT ${OVERRIDES}`]: () => {
        view = COPY;
        return json(200, COPY);
      },
    });
    const { user, sheet } = await openSheet();
    const baseUrl = await within(sheet).findByLabelText("baseUrl");
    expect(within(sheet).queryByText(p.firstEdit)).toBeNull();
    await user.clear(baseUrl);
    await user.type(baseUrl, "https://own.example");
    expect(within(sheet).getByText(p.firstEdit)).toBeTruthy();
    // the secret is empty: the save waits for the org's own key
    const save = within(sheet).getByRole("button", { name: p.saveLabel }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    await user.type(within(sheet).getByLabelText(/^apiKey/), "sk-own");
    expect(save.disabled).toBe(false);
    await user.click(save);
    await vi.waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true));
    expect(bodyOf(calls.find((c) => c.method === "PUT"))).toEqual({
      values: { baseUrl: "https://own.example", apiKey: "sk-own" },
    });
    // the answer is a copy: the banner shows
    expect(await within(sheet).findByText(p.ownConfig)).toBeTruthy();
  });

  it("a copy: the banner offers compare; the diff lists differing fields and secrets by state only", async () => {
    const p = en.extensions.overrides;
    const calls = routes(COPY, {
      [`POST ${OVERRIDES}/take`]: () => json(200, COPY),
    });
    const { user, sheet } = await openSheet();
    expect(await within(sheet).findByText(p.ownConfig)).toBeTruthy();
    expect(within(sheet).queryByText(p.following)).toBeNull();
    expect(within(sheet).getByText(en.configForm.secretState.own)).toBeTruthy();
    await user.click(within(sheet).getByRole("button", { name: p.compare }));
    const diff = within(sheet).getByRole("region", { name: p.compare });
    expect(within(diff).getByText("baseUrl")).toBeTruthy();
    expect(within(diff).getByText("This org: https://own.example")).toBeTruthy();
    expect(within(diff).getByText("Platform: https://platform.example")).toBeTruthy();
    // the read-only field never differs; the secret row has states only
    expect(within(diff).queryByText("region")).toBeNull();
    expect(within(diff).getByText(p.platformConfigured)).toBeTruthy();
    expect(within(diff).getByText(p.orgConfigured)).toBeTruthy();
    expect(diff.textContent).not.toContain("sk-");
    expect(findNestedBoxes(document.body).map(describeNestedBox)).toEqual([]);
    await user.click(within(diff).getByRole("button", { name: p.take }));
    await vi.waitFor(() => expect(calls.some((c) => c.url.endsWith("/overrides/take"))).toBe(true));
    expect(bodyOf(calls.find((c) => c.url.endsWith("/overrides/take")))).toEqual({
      paths: ["baseUrl"],
    });
  });

  it("使用平台配置 asks first, says keys go too, then DELETEs the copy", async () => {
    const p = en.extensions.overrides;
    let view: unknown = COPY;
    const calls = routes(COPY, {
      [`GET ${OVERRIDES}`]: () => json(200, view),
      [`DELETE ${OVERRIDES}`]: () => {
        view = FOLLOWING;
        return json(200, FOLLOWING);
      },
    });
    const { user, sheet } = await openSheet();
    await user.click(await within(sheet).findByRole("button", { name: p.usePlatform }));
    const dialog = await screen.findByRole("dialog", { name: p.usePlatform });
    expect(within(dialog).getByText(p.resetBody)).toBeTruthy();
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    await user.click(within(dialog).getByRole("button", { name: p.usePlatform }));
    await vi.waitFor(() => expect(calls.some((c) => c.method === "DELETE")).toBe(true));
    expect(await within(sheet).findByText(p.following)).toBeTruthy();
  });

  it("a member's list: no overrides read, the state only", async () => {
    const members = { ...BAILIAN, overrideState: undefined, needsConfig: false };
    const calls = routes(FOLLOWING, {
      [`GET ${BASE}/extensions`]: () => json(200, { extensions: [members] }),
    });
    await renderRouteWithCache("/extensions", lastStubRoutes(), { locale: "en", me: MEMBER });
    await screen.findByText("Bailian", { selector: ".cb-cell-title-name" });
    expect(calls.some((c) => c.url.endsWith("/overrides"))).toBe(false);
  });

  it("the kernel's needsConfig decides 待配置 and keeps the switch locked while off", async () => {
    routes(FOLLOWING, {
      [`GET ${BASE}/extensions`]: () =>
        json(200, { extensions: [{ ...BAILIAN, enabled: false, needsConfig: true }] }),
    });
    await renderRouteWithCache("/extensions", lastStubRoutes(), { locale: "en" });
    const row = await screen.findByRole("row", { name: /Bailian/ });
    expect(within(row).getByText(en.extensions.needsConfig)).toBeTruthy();
  });
});
