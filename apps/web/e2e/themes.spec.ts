import { readFileSync } from "node:fs";
import { type Browser, expect, type Page, test } from "@playwright/test";
import { CSRF, currentOrg } from "./support/chat";
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
