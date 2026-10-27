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
