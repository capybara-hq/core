import { readFileSync } from "node:fs";
import { type Browser, expect, type Page, test } from "@playwright/test";
import { CSRF, currentOrg } from "./support/chat";
import { hydrated } from "./support/nav";
import { signIn } from "./support/sign-in";

/**
 * Themes (spec `docs/superpowers/specs/2026-11-08-themes-design.md`). First paint (§8): the layouts
 * link the resolved theme's stylesheet in the streamed `<head>`, so the document is themed before
 * any client code runs: the workspace with the org default, the sign-in page with the platform
 * default and its wordmark (§3, through the design context), without the scheme toggle under a
 * single-scheme theme (§10).
 *
 * Seeding: the super admin imports the fixture plugin `fake-theme` (`CAPYBARA_E2E_THEME_TGZ`,
 * packed by global-setup; themes `night-city`: dark only, wordmark `NIGHT CITY`; `paper`: light and
 * dark) with scope `all`, then sets the levels through the settings APIs; each case puts its level
 * back, so the other specs see the built-in theme.
 */

/** A theme of the org's listing (the part these cases read). */
interface Listed {
  id: string;
  name: { en: string };
  cssUrl: string;
}

/** Night City's dark `bg` and Paper's dark `accent` (fixture `fake-theme`, its theme files). */
const NIGHT_CITY_BG = "#05070d";
const PAPER_DARK_ACCENT = "#e0a070";
/** Night City's dark accent. */
const NIGHT_CITY_ACCENT = "#fce300";

/** Imports `fake-theme` once (scope `all`); returns the `platform_themes` ids by English name. */
async function themeIds(page: Page): Promise<{ nightCity: Listed; paper: Listed }> {
  const orgId = await currentOrg(page);
  const list = async () => {
    const r = await page.request.get(`/api/v1/orgs/${orgId}/themes`);
    expect(r.ok(), await r.text()).toBe(true);
    return ((await r.json()) as { themes: Listed[] }).themes;
  };
  const byName = (themes: Listed[], en: string) => themes.find((t) => t.name.en === en);
  if (byName(await list(), "Night City") === undefined) {
    const tgz = process.env.CAPYBARA_E2E_THEME_TGZ;
    expect(tgz, "global-setup writes CAPYBARA_E2E_THEME_TGZ").toBeTruthy();
    const staged = await page.request.post("/api/v1/admin/catalog/import/file", {
      headers: { ...CSRF, "content-type": "application/octet-stream" },
      data: readFileSync(tgz as string),
    });
    expect(staged.ok(), await staged.text()).toBe(true);
    const { stagingId, review } = (await staged.json()) as {
      stagingId: string;
      review: { reviewHash: string };
    };
    const confirmed = await page.request.post(
      `/api/v1/admin/catalog/imports/${stagingId}/confirm`,
      { headers: CSRF, data: { reviewHash: review.reviewHash, scope: "all" } },
    );
    expect(confirmed.status(), await confirmed.text()).toBe(201);
  }
  let found: { nightCity: Listed; paper: Listed } | null = null;
  await expect
    .poll(async () => {
      const themes = await list();
      const nightCity = byName(themes, "Night City");
      const paper = byName(themes, "Paper");
      found = nightCity && paper ? { nightCity, paper } : null;
      return found !== null;
    })
    .toBe(true);
  return found as unknown as { nightCity: Listed; paper: Listed };
}

async function setOrgTheme(page: Page, id: string | null): Promise<void> {
  const r = await page.request.patch(`/api/v1/orgs/${await currentOrg(page)}/settings`, {
    headers: CSRF,
    data: { theme: { id, personal: "allowed" } },
  });
  expect(r.ok(), await r.text()).toBe(true);
}

async function setPlatformTheme(page: Page, id: string | null): Promise<void> {
  const r = await page.request.put("/api/v1/admin/settings", {
    headers: CSRF,
    data: { uiTheme: { id } },
  });
  expect(r.ok(), await r.text()).toBe(true);
}

/** What a document holds when DOMContentLoaded fires (before any client fetch answers). */
type FirstPaint = { bg: string; accent: string; themeLinkInHead: boolean; text: string };

/** Records the root's theme tokens and the head's theme link at every document's DOMContentLoaded. */
async function recordFirstPaint(page: Page): Promise<() => Promise<FirstPaint>> {
  await page.addInitScript(() => {
    document.addEventListener("DOMContentLoaded", () => {
      const root = getComputedStyle(document.documentElement);
      (window as unknown as { __firstPaint: unknown }).__firstPaint = {
        bg: root.getPropertyValue("--cb-bg").trim().toLowerCase(),
        accent: root.getPropertyValue("--cb-accent").trim().toLowerCase(),
        themeLinkInHead:
          document.head.querySelector('link[rel="stylesheet"][href$="/theme.css"]') !== null,
        text: document.body.innerText,
      };
    });
  });
  return () =>
    page.evaluate(() => (window as unknown as { __firstPaint: FirstPaint }).__firstPaint);
}

/** A signed-out tab on the e2e web. */
async function anonymousPage(browser: Browser): Promise<Page> {
  const context = await browser.newContext({
    baseURL: process.env.CAPYBARA_E2E_BASE_URL as string,
    locale: "zh-CN",
  });
  return context.newPage();
}

test.describe("first paint", () => {
  test("the workspace paints with the org default theme", async ({ page }) => {
    await signIn(page);
    const { paper } = await themeIds(page);
    const prefs = await page.request.put("/api/v1/me/preferences", {
      headers: CSRF,
      data: { theme: null },
    });
    expect(prefs.ok(), await prefs.text()).toBe(true);
    await setOrgTheme(page, paper.id);
    try {
      // the streamed document carries the link in its <head> (React hoisted it from the layout)
      const doc = await (await page.request.get("/")).text();
      const head = doc.slice(0, doc.indexOf("</head>"));
      expect(head).toContain(paper.cssUrl);
      const firstPaint = await recordFirstPaint(page);
      const res = await page.goto("/");
      expect(res?.status()).toBe(200);
      // no `cb-theme` cookie: the dark scheme, Paper's dark accent
      expect(await firstPaint()).toMatchObject({
        accent: PAPER_DARK_ACCENT,
        themeLinkInHead: true,
      });
    } finally {
      await setOrgTheme(page, null);
    }
  });

  test("the sign-in page paints with the platform default theme and its wordmark", async ({
    page,
    browser,
  }) => {
    await signIn(page);
    const { nightCity } = await themeIds(page);
    await setPlatformTheme(page, nightCity.id);
    const visitor = await anonymousPage(browser);
    try {
      const firstPaint = await recordFirstPaint(visitor);
      const res = await visitor.goto("/login");
      expect(res?.status()).toBe(200);
      const seen = await firstPaint();
      expect(seen).toMatchObject({ bg: NIGHT_CITY_BG, themeLinkInHead: true });
      expect(seen.text).toContain("NIGHT CITY");
      expect(seen.text).not.toContain("CAPYBARA");
      // a single-scheme theme: the PreferenceBar keeps the language, without the scheme toggle
      await expect(visitor.locator('[data-part="preferences"]')).toBeVisible();
      await expect(visitor.getByRole("radiogroup")).toHaveCount(0);
    } finally {
      await visitor.context().close();
      await setPlatformTheme(page, null);
    }
  });
});

/** UI copy from the zh messages (the specs read zh). */
const zh = JSON.parse(
  readFileSync(new URL("../messages/zh.json", import.meta.url), "utf8"),
) as typeof import("../messages/zh.json");
const AP = zh.appearance;

async function setOrgSetting(
  page: Page,
  theme: { id: string | null; personal: "allowed" | "locked" },
): Promise<void> {
  const r = await page.request.patch(`/api/v1/orgs/${await currentOrg(page)}/settings`, {
    headers: CSRF,
    data: { theme },
  });
  expect(r.ok(), await r.text()).toBe(true);
}

/**
 * A member of the admin's org in a new browser context, signed in through an invitation (the
 * accept call signs the new account in). The org has an agent the member can see, else the
 * workspace shows the setup layout.
 */
async function newMember(page: Page, browser: Browser): Promise<Page> {
  const run = Date.now().toString(36);
  const orgId = await currentOrg(page);
  const agent = await page.request.post(`/api/v1/orgs/${orgId}/agents`, {
    headers: CSRF,
    data: {
      definition: {
        name: `Themes shared ${run}`,
        instructions: "Help.",
        model: { provider: "model-fake", model: "fake-1" },
      },
      visibility: "org",
    },
  });
  expect(agent.status(), await agent.text()).toBe(201);
  const invite = await page.request.post(`/api/v1/orgs/${orgId}/invitations`, {
    headers: CSRF,
    data: { role: "member", expiresInHours: 24 },
  });
  expect(invite.status(), await invite.text()).toBe(201);
  const { token } = (await invite.json()) as { token: string };
  const context = await browser.newContext({
    baseURL: process.env.CAPYBARA_E2E_BASE_URL as string,
    locale: "zh-CN",
  });
  const accept = await context.request.post(`/api/v1/invitations/${token}/accept`, {
    headers: CSRF,
    data: {
      login: `theme-member-${run}`,
      password: "member-password-123",
      displayName: `M ${run}`,
    },
  });
  expect(accept.status(), await accept.text()).toBeLessThan(300);
  return context.newPage();
}

/** The root's value of a theme token now. */
const rootToken = (page: Page, name: string) =>
  page.evaluate(
    (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim().toLowerCase(),
    name,
  );

test.describe("appearance pages", () => {
  test("a member picks Paper in 偏好设置 › 外观: the page's tokens change without a reload", async ({
    page,
    browser,
  }) => {
    await signIn(page);
    await themeIds(page);
    await setOrgSetting(page, { id: null, personal: "allowed" });
    const member = await newMember(page, browser);
    try {
      await member.goto("/account/preferences");
      await hydrated(member);
      const picker = member.getByRole("radiogroup", { name: AP.personal.label });
      await expect(picker.getByRole("radio", { name: /纸张/ })).toBeVisible();
      // the built-in dark accent first (no cb-theme cookie: dark)
      const before = await rootToken(member, "--cb-accent");
      expect(before).not.toBe(PAPER_DARK_ACCENT);
      // a marker on the window: a reload would drop it
      await member.evaluate(() => {
        (window as unknown as { __kept: boolean }).__kept = true;
      });
      await picker.getByRole("radio", { name: /纸张/ }).click();
      await member.getByRole("button", { name: zh.preferences.save }).click();
      // Paper overrides the dark accent only (its bg stays the built-in one)
      await expect.poll(() => rootToken(member, "--cb-accent")).toBe(PAPER_DARK_ACCENT);
      expect(await member.evaluate(() => (window as unknown as { __kept?: boolean }).__kept)).toBe(
        true,
      );
    } finally {
      await member.context().close();
    }
  });

  test("switching the org default in one page: theme → built-in and A → B → A apply only the current theme's tokens", async ({
    page,
  }) => {
    await signIn(page);
    await themeIds(page);
    const prefs = await page.request.put("/api/v1/me/preferences", {
      headers: CSRF,
      data: { theme: null },
    });
    expect(prefs.ok(), await prefs.text()).toBe(true);
    await setPlatformTheme(page, null);
    await setOrgSetting(page, { id: null, personal: "allowed" });
    try {
      await page.goto("/settings/appearance");
      await hydrated(page);
      // the built-in theme's values (no cb-theme cookie: dark)
      const builtin = {
        bg: await rootToken(page, "--cb-bg"),
        accent: await rootToken(page, "--cb-accent"),
      };
      expect(builtin.bg).not.toBe(NIGHT_CITY_BG);
      expect(builtin.accent).not.toBe(PAPER_DARK_ACCENT);
      // a marker on the window: a reload would drop it
      await page.evaluate(() => {
        (window as unknown as { __kept: boolean }).__kept = true;
      });
      const picker = page.getByRole("radiogroup", { name: AP.org.label });
      const pick = async (name: RegExp) => {
        await picker.getByRole("radio", { name }).click();
        await page.getByRole("button", { name: AP.save }).click();
      };
      const tokens = async () => ({
        bg: await rootToken(page, "--cb-bg"),
        accent: await rootToken(page, "--cb-accent"),
      });
      const nightCity = { bg: NIGHT_CITY_BG, accent: NIGHT_CITY_ACCENT };
      // Paper overrides the dark accent only, so the bg stays the built-in one
      const paper = { bg: builtin.bg, accent: PAPER_DARK_ACCENT };

      // a theme, then the built-in theme: nothing of the theme stays applied
      await pick(/夜之城/);
      await expect.poll(tokens).toEqual(nightCity);
      await pick(new RegExp(AP.followPlatform));
      await expect.poll(tokens).toEqual(builtin);

      // A → B → A: B leaves no A token behind, and A wins again on the way back
      await pick(/夜之城/);
      await expect.poll(tokens).toEqual(nightCity);
      await pick(/纸张/);
      await expect.poll(tokens).toEqual(paper);
      await pick(/夜之城/);
      await expect.poll(tokens).toEqual(nightCity);

      expect(await page.evaluate(() => (window as unknown as { __kept?: boolean }).__kept)).toBe(
        true,
      );
    } finally {
      await setOrgSetting(page, { id: null, personal: "allowed" });
    }
  });

  test("an org admin sets Night City with 允许成员自选 off: the member sees the lock line, 组织设置 › 外观 read only, no scheme toggle", async ({
    page,
    browser,
  }) => {
    await signIn(page);
    await themeIds(page);
    await setOrgSetting(page, { id: null, personal: "allowed" });
    const member = await newMember(page, browser);
    try {
      // the admin, in 组织设置 › 外观 (the built-in theme: the account row's scheme toggle is there)
      await page.goto("/settings/appearance");
      const schemeToggle = page
        .locator('[data-part="sidebar"]')
        .getByRole("radiogroup", { name: zh.common.theme });
      await expect(schemeToggle).toBeVisible();
      await page
        .getByRole("radiogroup", { name: AP.org.label })
        .getByRole("radio", { name: /夜之城/ })
        .click();
      await page.getByRole("switch", { name: AP.org.personal }).click();
      await page.getByRole("button", { name: AP.save }).click();
      await expect(page.getByText(AP.saved)).toBeVisible();
      // the whole workspace is Night City now: dark only, so the account row has no scheme toggle
      await expect.poll(() => rootToken(page, "--cb-bg")).toBe(NIGHT_CITY_BG);
      await expect(schemeToggle).toHaveCount(0);

      // the member: the lock line instead of the cards
      await member.goto("/account/preferences");
      await expect(member.getByText(AP.personal.locked)).toBeVisible();
      await expect(member.getByRole("radiogroup", { name: AP.personal.label })).toHaveCount(0);

      // 组织设置 › 外观, read only: the choice shown, every control disabled, no save
      await member.goto("/settings/appearance");
      const picker = member.getByRole("radiogroup", { name: AP.org.label });
      await expect(picker.getByRole("radio", { name: /夜之城/ })).toHaveAttribute(
        "aria-checked",
        "true",
      );
      for (const radio of await picker.getByRole("radio").all()) await expect(radio).toBeDisabled();
      await expect(member.getByRole("switch", { name: AP.org.personal })).toBeDisabled();
      await expect(member.getByText(zh.orgSettings.readonly)).toBeVisible();
      await expect(member.getByRole("button", { name: AP.save })).toHaveCount(0);
    } finally {
      await member.context().close();
      await setOrgSetting(page, { id: null, personal: "allowed" });
    }
  });

  test("the super admin: 主题 in the admin nav, the fixture's themes on /admin/themes by their names, only `all` themes as 平台默认主题", async ({
    page,
  }) => {
    await signIn(page);
    const { paper } = await themeIds(page);
    await setPlatformTheme(page, null);
    await page.goto("/admin");
    await page.getByRole("link", { name: zh.admin.nav.themes, exact: true }).click();
    await expect(page).toHaveURL(/\/admin\/themes$/);
    const table = page.getByRole("table", { name: zh.adminComponents.titles.theme });
    await expect(table.getByRole("link", { name: "夜之城", exact: true })).toBeVisible();
    await expect(table.getByRole("link", { name: "纸张", exact: true })).toBeVisible();

    // Paper gets its own `optional` scope: no longer offered as the platform default
    const scope = async (target: object) => {
      const preview = await page.request.post(
        `/api/v1/admin/components/theme/${paper.id}/scope/preview`,
        { headers: CSRF, data: target },
      );
      expect(preview.ok(), await preview.text()).toBe(true);
      const { scopeHash } = (await preview.json()) as { scopeHash: string };
      const put = await page.request.put(`/api/v1/admin/components/theme/${paper.id}/scope`, {
        headers: CSRF,
        data: { ...target, scopeHash },
      });
      expect(put.ok(), await put.text()).toBe(true);
    };
    await scope({ scope: "optional" });
    try {
      await page.goto("/admin/settings");
      const picker = page.getByRole("radiogroup", { name: AP.platform.label });
      await expect(picker.getByRole("radio", { name: /夜之城/ })).toBeVisible();
      await expect(picker.getByRole("radio", { name: AP.builtin })).toBeVisible();
      await expect(picker.getByRole("radio")).toHaveCount(2);
    } finally {
      await scope({ follow: true });
    }
  });
});
