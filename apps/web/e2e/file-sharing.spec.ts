import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import {
  composer,
  createAgent,
  currentOrg,
  designZh,
  openConversation,
  replies,
  zh,
} from "./support/chat";
import { hydrated } from "./support/nav";
import { signIn } from "./support/sign-in";

/**
 * File sharing and full HTML rendering end to end (file sharing design: Tests): an HTML report the
 * agent delivers loads a chart library from an allowlisted CDN, runs its scripts and draws in the
 * right panel; a fetch to another host is blocked and the document cannot read the app's cookies;
 * once the super admin allows external sharing and the org admin turns it on, an external link
 * opened in a fresh browser without cookies draws the same chart; a revoked link shows the invalid
 * page. The CDN is faked with `route` (no real network); `example.com` is routed too, so a fetch
 * the CSP failed to block would succeed and be counted instead of failing on the network.
 */

/** The fake chart library on an allowlisted CDN (`https://cdn.jsdelivr.net`, a default origin). */
const CHART_URL = "https://cdn.jsdelivr.net/npm/fake-chart@1.0.0/chart.js";
const CHART_JS = `window.FakeChart = {
  draw(el) { el.textContent = "chart drawn"; el.setAttribute("data-drawn", "1"); },
};`;
/** A host outside the allowlist the report tries to send data to. */
const LEAK_URL = "https://example.com/x";
/** A cookie of the app a script on the app's origin could read (not HttpOnly). */
const PROBE_COOKIE = "fs-probe";

const FILE_NAME = "report.html";
const REPORT = `<!doctype html>
<html><head><meta charset="utf-8"><title>Quarterly report</title>
<script src="${CHART_URL}"></script></head>
<body><h1>Quarterly report</h1>
<div id="chart"></div>
<p id="fetch">pending</p>
<p id="cookie" data-read="0">pending</p>
<script>
FakeChart.draw(document.getElementById("chart"));
var cookie = "";
try { cookie = document.cookie; } catch (e) { cookie = ""; }
var c = document.getElementById("cookie");
c.textContent = cookie;
c.setAttribute("data-read", "1");
fetch("${LEAK_URL}").then(
  function () { document.getElementById("fetch").textContent = "allowed"; },
  function () { document.getElementById("fetch").textContent = "blocked"; }
);
</script></body></html>
`;

/** State the serial cases pass on: the conversation and the external link. */
const shared: { convId?: string; link?: string } = {};
/** Requests that reached `LEAK_URL` (none may: the document's CSP has `connect-src 'none'`). */
let leaks = 0;

/** Fakes the CDN and catches any request to the leak host, for a page or a whole context. */
async function fakeNetwork(target: Page | BrowserContext): Promise<void> {
  await target.route(CHART_URL, (r) =>
    r.fulfill({ contentType: "application/javascript", body: CHART_JS }),
  );
  await target.route(LEAK_URL, (r) => {
    leaks += 1;
    return r.fulfill({
      contentType: "text/plain",
      headers: { "access-control-allow-origin": "*" },
      body: "ok",
    });
  });
}

/** Checks the rendered report inside a frame: chart drawn, fetch blocked, no app cookie. */
async function expectReport(page: Page, frameTitle: string): Promise<void> {
  const doc = page.frameLocator(`iframe[title="${frameTitle}"]`);
  await expect(doc.locator("#chart[data-drawn]")).toHaveText("chart drawn");
  await expect(doc.locator("#fetch")).toHaveText("blocked");
  await expect(doc.locator('#cookie[data-read="1"]')).toHaveText("");
  expect(leaks).toBe(0);
}

/** The file card of the delivered report in the timeline. */
const reportCard = (page: Page) =>
  page.locator('[data-entry="files"]').getByRole("button", { name: /report\.html/ });
/** The right panel showing the report. */
const panel = (page: Page) => page.getByRole("complementary", { name: FILE_NAME });

/** Sends a message and waits for the turn's reply (model-fake answers `Tool result: …`). */
async function send(page: Page, text: string, count: number) {
  await composer(page).fill(text);
  await composer(page).press("Enter");
  await expect(replies(page)).toHaveCount(count);
}

/** Turns a settings switch on (idempotent) and saves with the page's ActionRow. */
async function switchOn(page: Page, label: string, save: string, saved: string) {
  const sw = page.getByRole("switch", { name: label, exact: true });
  await expect(sw).toBeEnabled();
  if ((await sw.getAttribute("aria-checked")) === "true") return;
  await sw.click();
  await expect(sw).toHaveAttribute("aria-checked", "true");
  await page.getByRole("button", { name: save, exact: true }).click();
  await expect(page.getByText(saved)).toBeVisible();
}

test.describe
  .serial("file sharing", () => {
    test.beforeEach(async ({ page, context }) => {
      await fakeNetwork(page);
      // the app's own cookie, readable by any script running on the app's origin
      const origin = new URL(process.env.CAPYBARA_E2E_BASE_URL ?? "http://localhost").origin;
      await context.addCookies([{ name: PROBE_COOKIE, value: "visible", url: origin }]);
    });

    test("an HTML report renders in the right panel: CDN script runs, fetch blocked, no cookies", async ({
      page,
    }) => {
      await signIn(page);
      const orgId = await currentOrg(page);
      const agentId = await createAgent(page, orgId, "Report agent");
      shared.convId = await openConversation(page, orgId, agentId);
      // the probe cookie is there for the app itself
      expect(await page.evaluate(() => document.cookie)).toContain(PROBE_COOKIE);

      await send(
        page,
        `tool:Write:${JSON.stringify({ file_path: "/workspace/out/report.html", content: REPORT })}`,
        1,
      );
      await send(
        page,
        `tool:Deliver:${JSON.stringify({ file_path: "/workspace/out/report.html" })}`,
        2,
      );
      await expect(reportCard(page)).toBeVisible();
      await reportCard(page).click();

      // the built-in HTML document wins: an iframe of /api/v1/html/<token>, sandboxed, no referrer
      const frame = panel(page).locator(`iframe[title="${FILE_NAME}"]`);
      await expect(frame).toHaveAttribute("src", /\/api\/v1\/html\//);
      await expect(frame).toHaveAttribute(
        "sandbox",
        "allow-scripts allow-popups allow-popups-to-escape-sandbox",
      );
      await expect(frame).toHaveAttribute("referrerpolicy", "no-referrer");
      await expectReport(page, FILE_NAME);
    });

    test("an external link (7 days) opens in a fresh browser without cookies", async ({
      page,
      browser,
    }) => {
      expect(shared.convId).toBeDefined();
      await signIn(page);

      // the super admin allows external sharing on the platform
      await page.goto("/admin/settings");
      await hydrated(page);
      await switchOn(
        page,
        zh.admin.settings.sharing.external,
        zh.admin.settings.save,
        zh.admin.settings.saved,
      );
      // the org admin turns it on in the org
      await page.goto("/settings/organization");
      await hydrated(page);
      await switchOn(
        page,
        zh.orgSettings.externalSharing.label,
        zh.orgSettings.save,
        zh.orgSettings.saved,
      );

      // the owner shares the report with anyone who has the link
      await page.goto(`/chat/${shared.convId}`);
      await hydrated(page);
      await reportCard(page).click();
      await panel(page)
        .getByRole("button", { name: designZh("files.share") })
        .click();
      const D = zh.shares.dialog;
      const dialog = page.getByRole("dialog", { name: D.title.replace("{name}", FILE_NAME) });
      const external = dialog.getByRole("radio", { name: new RegExp(D.external) });
      await expect(external).toBeEnabled();
      await external.check();
      // external links default to 7 days
      await expect(dialog.getByRole("combobox")).toHaveText(new RegExp(D.days7));
      await dialog.getByRole("button", { name: D.create, exact: true }).click();
      const field = dialog.getByRole("textbox", { name: D.link, exact: true });
      await expect(field).toHaveValue(/\/s\/[A-Za-z0-9]{10}$/);
      shared.link = await field.inputValue();
      await dialog.getByRole("button", { name: D.done, exact: true }).click();
      await expect(
        panel(page).getByRole("button", { name: designZh("files.shared") }),
      ).toBeVisible();

      // a stranger: a fresh context, no session, no app cookies
      const stranger = await browser.newContext({ locale: "zh-CN" });
      try {
        await fakeNetwork(stranger);
        const visitor = await stranger.newPage();
        const code = shared.link.split("/s/")[1] as string;
        const meta = await visitor.request.get(new URL(`/api/v1/s/${code}`, shared.link).href);
        expect(meta.status(), await meta.text()).toBe(200);
        const m = (await meta.json()) as { audience: string; expiresAt: string; render: string };
        expect(m.audience).toBe("external");
        expect(m.render).toBe("html");
        const days = (Date.parse(m.expiresAt) - Date.now()) / 86_400_000;
        expect(days).toBeGreaterThan(6.9);
        expect(days).toBeLessThanOrEqual(7);

        await visitor.goto(shared.link);
        await expect(visitor.getByRole("heading", { name: FILE_NAME })).toBeVisible();
        await expect(
          visitor.getByText(zh.shares.page.sharedBy.replace("{name}", "Admin")),
        ).toBeVisible();
        await expectReport(visitor, FILE_NAME);
      } finally {
        await stranger.close();
      }
    });

    test("a revoked link shows the invalid page", async ({ page, browser }) => {
      expect(shared.link).toBeDefined();
      await signIn(page);
      await page.goto(`/chat/${shared.convId}`);
      await hydrated(page);
      await reportCard(page).click();
      await panel(page)
        .getByRole("button", { name: designZh("files.shared") })
        .click();
      const D = zh.shares.dialog;
      const dialog = page.getByRole("dialog", { name: D.title.replace("{name}", FILE_NAME) });
      const live = dialog.getByRole("list", { name: D.live });
      await live.getByRole("button", { name: D.revoke, exact: true }).click();
      await expect(live).toHaveCount(0);

      const stranger = await browser.newContext({ locale: "zh-CN" });
      try {
        const visitor = await stranger.newPage();
        await visitor.goto(shared.link as string);
        await expect(
          visitor.getByRole("heading", { name: zh.shares.page.invalidTitle }).first(),
        ).toBeVisible();
        await expect(visitor.locator("iframe")).toHaveCount(0);
      } finally {
        await stranger.close();
      }
      // the kernel agrees: one 404 for revoked links
      const code = (shared.link as string).split("/s/")[1] as string;
      const res = await page.request.get(`/api/v1/s/${code}`);
      expect(res.status()).toBe(404);
    });
  });
