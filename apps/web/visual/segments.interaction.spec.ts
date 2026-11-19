import { expect, type Page, test } from "@playwright/test";

/**
 * Foldable layout (mobile layout spec §8): with a display feature emulated through the DevTools
 * protocol (a vertical hinge: two side-by-side segments), the two-pane regions put one pane in each
 * segment with the expanded sidebar visible, so no pane reaches the hinge. Headless Chromium only,
 * with the segment media queries and `env(viewport-segment-*)` switched on.
 */
test.use({
  launchOptions: { args: ["--enable-blink-features=CSSFoldables,ViewportSegments"] },
});

const WIDTH = 1440;
const HEIGHT = 900;
const HINGE_LEFT = 700;
const HINGE = 40;

async function fold(page: Page, path: string) {
  await page.setViewportSize({ width: WIDTH, height: HEIGHT });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: WIDTH,
    height: HEIGHT,
    deviceScaleFactor: 1,
    mobile: false,
    displayFeature: { orientation: "vertical", offset: HINGE_LEFT, maskLength: HINGE },
  });
  await page.goto(path);
  await page.waitForLoadState("networkidle");
  await page.waitForFunction(() => document.querySelector("[data-ref-pending]") === null);
  const two = await page.evaluate(() => matchMedia("(horizontal-viewport-segments: 2)").matches);
  test.skip(!two, "this Chromium does not emulate display features");
}

const rect = (page: Page, sel: string) =>
  page
    .locator(sel)
    .first()
    .evaluate((e) => e.getBoundingClientRect().toJSON());

test("list-detail: the list ends before the hinge and the detail starts after it", async ({
  page,
}) => {
  await fold(page, "/dev/ui/templates/inbox");
  await expect(page.locator('[data-part="sidebar"]')).toBeVisible();
  const list = await rect(page, '[data-part="list-pane"]');
  const detail = await rect(page, '[data-part="detail-pane"]');
  expect(list.right).toBeLessThanOrEqual(HINGE_LEFT);
  expect(detail.left).toBeGreaterThanOrEqual(HINGE_LEFT + HINGE);
  expect(detail.right).toBeLessThanOrEqual(WIDTH);
});

test("conversation page: the right panel sits in the second segment", async ({ page }) => {
  await fold(page, "/dev/ui/templates/conversation");
  const panel = page.locator('[data-part="panel-slot"]');
  test.skip((await panel.count()) === 0, "the fixture shows no inline right panel");
  const p = await rect(page, '[data-part="panel-slot"]');
  const main = await rect(page, '[data-part="conv-main"]');
  expect(p.left).toBeGreaterThanOrEqual(HINGE_LEFT + HINGE);
  expect(main.right).toBeLessThanOrEqual(HINGE_LEFT);
});
