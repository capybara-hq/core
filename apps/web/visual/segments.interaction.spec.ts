import { expect, type Page, test } from "@playwright/test";

/**
 * Foldable layout (mobile layout spec §8): with a display feature emulated through the DevTools
 * protocol, the two-pane regions put one pane in each segment with the expanded sidebar visible, so
 * no pane reaches the hinge: a vertical hinge (side-by-side segments) and a horizontal one
 * (stacked segments). Headless Chromium only, with the segment media queries and
 * `env(viewport-segment-*)` switched on. A Chromium that cannot emulate display features FAILS
 * these tests; set CAPYBARA_SKIP_FOLD_EMULATION=1 to skip them knowingly.
 */
test.use({
  launchOptions: { args: ["--enable-blink-features=CSSFoldables,ViewportSegments"] },
});

const WIDTH = 1440;
const HEIGHT = 900;
// the hinge line's offset: x for a vertical line (side by side), y for a horizontal one (stacked)
const HINGE_X = 700;
const HINGE_Y = 440;
const HINGE = 40;

type Fold = "horizontal" | "vertical";

async function fold(page: Page, path: string, kind: Fold) {
  await page.setViewportSize({ width: WIDTH, height: HEIGHT });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: WIDTH,
    height: HEIGHT,
    deviceScaleFactor: 1,
    mobile: false,
    // a vertical hinge splits the window into side-by-side segments
    displayFeature: {
      orientation: kind === "vertical" ? "vertical" : "horizontal",
      offset: kind === "vertical" ? HINGE_X : HINGE_Y,
      maskLength: HINGE,
    },
  });
  await page.goto(path);
  await page.waitForLoadState("networkidle");
  await page.waitForFunction(() => document.querySelector("[data-ref-pending]") === null);
  const media = `(${kind === "vertical" ? "horizontal" : "vertical"}-viewport-segments: 2)`;
  const two = await page.evaluate((q) => matchMedia(q).matches, media);
  if (process.env.CAPYBARA_SKIP_FOLD_EMULATION) test.skip(!two, "no display-feature emulation");
  expect(two, `${media} must match: this Chromium cannot emulate display features`).toBe(true);
}

const rect = (page: Page, sel: string) =>
  page
    .locator(sel)
    .first()
    .evaluate((e) => e.getBoundingClientRect().toJSON());

for (const kind of ["vertical", "horizontal"] as const) {
  // "vertical" orientation = a vertical hinge line = segments side by side (the horizontal media
  // feature counts them); "horizontal" = stacked (the vertical media feature).
  const side = kind === "vertical";
  const lo = side ? "left" : "top";
  const hi = side ? "right" : "bottom";
  const end = side ? WIDTH : HEIGHT;
  const HINGE_AT = side ? HINGE_X : HINGE_Y;

  test(`list-detail, ${side ? "side by side" : "stacked"}: the list ends before the hinge, the detail starts after`, async ({
    page,
  }) => {
    await fold(page, "/dev/ui/templates/inbox", kind);
    await expect(page.locator('[data-part="sidebar"]')).toBeVisible();
    const list = await rect(page, '[data-part="list-pane"]');
    const detail = await rect(page, '[data-part="detail-pane"]');
    expect(list[hi]).toBeLessThanOrEqual(HINGE_AT);
    expect(detail[lo]).toBeGreaterThanOrEqual(HINGE_AT + HINGE);
    expect(detail[hi]).toBeLessThanOrEqual(end);
  });

  for (const right of ["panel-slot", "properties"] as const) {
    test(`conversation page, ${side ? "side by side" : "stacked"}: the ${right} sits in the second segment`, async ({
      page,
    }) => {
      await fold(
        page,
        `/dev/ui/templates/conversation${right === "panel-slot" ? "" : "#properties"}`,
        kind,
      );
      const sel = right === "panel-slot" ? '[data-part="panel-slot"]' : ".cb-properties";
      await expect(page.locator(sel).first()).toBeVisible();
      const p = await rect(page, sel);
      const main = await rect(page, '[data-part="conv-main"]');
      expect(p[lo]).toBeGreaterThanOrEqual(HINGE_AT + HINGE);
      if (right === "panel-slot") expect(main[hi]).toBeLessThanOrEqual(HINGE_AT);
    });
  }
}
