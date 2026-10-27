import { expect, type Page, test } from "@playwright/test";

/**
 * Conversation-page interaction (design spec §6.11, §6.16.8–§6.16.9; §9.5): opening a tool line,
 * a group or a row grows its height over `motion.expand`, only when the viewer toggles it, and is
 * instant under reduced motion. Runs on the live `/dev/ui/reference/tool-group` blocks.
 */
const block = (page: Page, id: string) => page.locator(`[data-ref-block="${id}"]`);

async function open(page: Page) {
  await page.goto("/zh/dev/ui/reference/tool-group");
  await page.waitForLoadState("networkidle");
}

const animation = (page: Page, sel: string) =>
  page
    .locator(sel)
    .first()
    .evaluate((e) => {
      const cs = getComputedStyle(e);
      return { name: cs.animationName, seconds: Number.parseFloat(cs.animationDuration) };
    });

test("no expand motion on first paint", async ({ page }) => {
  await open(page);
  const box = block(page, "tool-group-expanded").locator(".cb-expand").first();
  expect(await box.evaluate((e) => getComputedStyle(e).animationName)).toBe("none");
});

test("opening a single call animates its height over motion.expand", async ({ page }) => {
  await open(page);
  const b = block(page, "tool-group-single");
  const line = b.locator('[data-part="tool-line"]').first();
  await expect(line).toHaveAttribute("aria-expanded", "false");
  await line.click();
  await expect(line).toHaveAttribute("aria-expanded", "true");
  const sel = '[data-ref-block="tool-group-single"] .cb-expand';
  expect(await animation(page, sel)).toEqual({ name: "cb-expand", seconds: 0.16 });
  await expect
    .poll(() =>
      page
        .locator(sel)
        .first()
        .evaluate((e) => e.getBoundingClientRect().height),
    )
    .toBeGreaterThan(0);
});

test("opening a group and a row inside it animates both", async ({ page }) => {
  await open(page);
  const b = block(page, "tool-group-collapsed");
  const head = b.locator('[data-part="tool-line"]');
  await head.click();
  await expect(head).toHaveAttribute("aria-expanded", "true");
  const sel = '[data-ref-block="tool-group-collapsed"] .cb-expand';
  expect((await animation(page, sel)).name).toBe("cb-expand");
  const e = block(page, "tool-group-expanded");
  const row = e.getByRole("button", { name: /获取文件元数据 失败/ });
  await row.click();
  await expect(row).toHaveAttribute("aria-expanded", "true");
  const detail = e.locator('[data-part="tool-detail"][data-animate="true"]');
  await expect(detail).toHaveCount(1);
  expect(await detail.evaluate((x) => getComputedStyle(x).animationDuration)).toBe("0.16s");
});

test("reduced motion: opening is instant", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await open(page);
  const line = block(page, "tool-group-single").locator('[data-part="tool-line"]').first();
  await line.click();
  const { seconds } = await animation(page, '[data-ref-block="tool-group-single"] .cb-expand');
  expect(seconds * 1000).toBeLessThanOrEqual(0.01);
});

// ── The conversation template (design spec §5.4, §6.16.1, §6.16.18) ────────────────────────────

const TEMPLATE = "/zh/dev/ui/templates/conversation";

async function openTemplate(page: Page, width = 1440) {
  await page.setViewportSize({ width, height: 900 });
  await page.goto(TEMPLATE);
  await page.waitForLoadState("networkidle");
}

const titleButton = (page: Page, name: string) =>
  page.locator('[data-part="title-bar"]').getByRole("button", { name, exact: true });

test("opening a panel closes properties and vice versa", async ({ page }) => {
  await openTemplate(page);
  const panel = page.locator('[data-part="panel-slot"]');
  await expect(panel).toHaveCount(1);
  await titleButton(page, "属性面板").click();
  await expect(panel).toHaveCount(0);
  await expect(page.locator('[data-part="properties"]')).toBeVisible();
  await expect(titleButton(page, "属性面板")).toHaveAttribute("aria-pressed", "true");
  await titleButton(page, "待办").click();
  await expect(page.locator('[data-part="properties"]')).toHaveCount(0);
  await expect(panel).toHaveCount(1);
  await expect(titleButton(page, "待办")).toHaveAttribute("aria-pressed", "true");
  await expect(titleButton(page, "属性面板")).toHaveAttribute("aria-pressed", "false");
});

test("the resize handle moves by 16 with the arrow keys, is clamped and remembered", async ({
  page,
}) => {
  await openTemplate(page);
  await page.evaluate(() => localStorage.removeItem("cap.chat.panelWidth"));
  await page.reload();
  await page.waitForLoadState("networkidle");
  const handle = page.getByRole("separator", { name: "调整右侧面板宽度" });
  const panel = page.locator('[data-part="panel-slot"]');
  const width = () => panel.evaluate((e) => Math.round(e.getBoundingClientRect().width));
  // 1440 − sidebar 256 = 1184 of content: the default 560 fits.
  await expect.poll(width).toBe(560);
  await handle.focus();
  await page.keyboard.press("ArrowLeft");
  await expect.poll(width).toBe(576);
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await expect.poll(width).toBe(544);
  // Clamped to layout.panel-min…
  for (let i = 0; i < 10; i++) await page.keyboard.press("ArrowRight");
  await expect.poll(width).toBe(520);
  // …and to the content width minus layout.chat-min (1184 − 480).
  await page.keyboard.press("End");
  await expect.poll(width).toBe(704);
  await page.reload();
  await page.waitForLoadState("networkidle");
  await expect.poll(width).toBe(704);
});

test("below 1280 the panel is a sheet; Esc closes it and focus returns to the icon", async ({
  page,
}) => {
  await openTemplate(page, 1100);
  const sheet = page.getByRole("dialog");
  await expect(sheet).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);
  const files = titleButton(page, "文件");
  await files.click();
  await expect(sheet).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);
  await expect(files).toBeFocused();
});

for (const width of [1440, 1279, 959, 640]) {
  test(`no horizontal page scroll at ${width}`, async ({ page }) => {
    await openTemplate(page, width);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });
}

test("reduced motion: opening a sub-agent group is instant", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/zh/dev/ui/reference/subagent-group");
  await page.waitForLoadState("networkidle");
  const head = block(page, "subagent-group-done").locator('[data-part="tool-line"]');
  await head.click();
  await expect(head).toHaveAttribute("aria-expanded", "true");
  const { seconds } = await animation(page, '[data-ref-block="subagent-group-done"] .cb-expand');
  expect(seconds * 1000).toBeLessThanOrEqual(0.01);
});
