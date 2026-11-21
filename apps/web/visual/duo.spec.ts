import { expect, type Page, test } from "@playwright/test";

/**
 * The iPhone Duo's outer display (382 wide) edge to edge (mobile layout spec §8): with the native
 * strip's width as `--cb-shell-inset-right` (84 px, mobile app spike 1.4) the page ground runs to
 * the right edge while text and controls end 84 px before it. Once plain and once with
 * `data-native-nav` on `<html>` (the strip's sections are native then: the web's menu button is
 * absent). Drawn on the catalog's shell pages (no kernel): `duo-outer-home` is a page in the
 * chat-first shell, `duo-outer-chat` the conversation. Baselines come from `visual-update`.
 */
const WIDTH = 382;
const HEIGHT = 800;
const STRIP = 84;

test.use({ viewport: { width: WIDTH, height: HEIGHT }, hasTouch: true, isMobile: true });

const PAGES = [
  { name: "duo-outer-home", path: "/dev/ui/templates/inbox" },
  { name: "duo-outer-chat", path: "/dev/ui/templates/conversation" },
] as const;

async function open(page: Page, path: string, nativeNav: boolean) {
  await page.goto(path);
  await page.waitForLoadState("networkidle");
  await page.evaluate(() => document.fonts.ready);
  await page.waitForFunction(() => document.querySelector("[data-ref-pending]") === null);
  await page.evaluate(
    ([inset, native]) => {
      const root = document.documentElement;
      root.style.setProperty("--cb-shell-inset-right", `${inset}px`);
      if (native) root.setAttribute("data-native-nav", "");
    },
    [STRIP, nativeNav] as const,
  );
}

for (const { name, path } of PAGES) {
  for (const nativeNav of [false, true]) {
    const shot = nativeNav ? `${name}-native-nav` : name;
    test(shot, async ({ page }) => {
      await open(page, path, nativeNav);
      // the ground (the shell's background) runs to the window's right edge
      const shell = await page.locator(".cb-shell").first().boundingBox();
      expect(shell && Math.round(shell.x + shell.width)).toBe(WIDTH);
      // the content ends before the strip: no visible control or text box reaches into it
      const over = await page.evaluate(
        ([limit]) => {
          const bad: string[] = [];
          for (const el of document.querySelectorAll<HTMLElement>(
            ".cb-shell button, .cb-shell a[href], .cb-shell input, .cb-shell textarea, .cb-shell h1, .cb-shell p",
          )) {
            const r = el.getBoundingClientRect();
            if (r.width === 0 || r.height === 0) continue;
            const cs = getComputedStyle(el);
            if (cs.visibility === "hidden" || cs.display === "none") continue;
            if (r.right > (limit ?? 0) + 0.5)
              bad.push(`${el.tagName}.${el.className}@${Math.round(r.right)}`);
          }
          return bad;
        },
        [WIDTH - STRIP] as const,
      );
      expect(over).toEqual([]);
      if (nativeNav) await expect(page.locator(".cb-shell-menu-btn:visible")).toHaveCount(0);
      await expect(page).toHaveScreenshot(`${shot}.png`);
    });
  }
}
