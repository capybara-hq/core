import { expect, type Page, test } from "@playwright/test";

/**
 * The iPhone Duo's two displays edge to edge (mobile layout spec §8): with the native strip's width
 * as `--cb-shell-inset-right` (84 px, mobile app spike 1.4) the page ground runs to the right edge
 * while text and controls end 84 px before it. Outer display 382 wide, inner 951 wide (the shell
 * with its sidebar, and an open side sheet), each plain and with `data-native-nav` on `<html>` (the
 * strip's sections are native then: the web's menu button is absent), plus one outer shot without
 * the inset. Drawn on the catalog's pages (no kernel): the inbox and the conversation template
 * stand in for the home and the chat. Baselines come from `visual-update`.
 */
const STRIP = 84;
const HEIGHT = 800;

type Display = { width: number; inset: number };
const OUTER: Display = { width: 382, inset: STRIP };
const INNER: Display = { width: 951, inset: STRIP };

type Shot = {
  name: string;
  path: string;
  display: Display;
  /** The ground whose right edge is the window's, and what it holds. */
  ground: string;
};

const SHOTS: Shot[] = [
  { name: "duo-outer-inbox", path: "/dev/ui/templates/inbox", display: OUTER, ground: ".cb-shell" },
  {
    name: "duo-outer-chat",
    path: "/dev/ui/templates/conversation",
    display: OUTER,
    ground: ".cb-shell",
  },
  {
    name: "duo-inner-chat",
    path: "/dev/ui/templates/conversation",
    display: INNER,
    ground: ".cb-shell",
  },
  { name: "duo-inner-sheet", path: "/dev/ui/overlays/sheet", display: INNER, ground: ".cb-sheet" },
];

test.use({ hasTouch: true, isMobile: true });

async function open(page: Page, path: string, display: Display, nativeNav: boolean) {
  await page.setViewportSize({ width: display.width, height: HEIGHT });
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
    [display.inset, nativeNav] as const,
  );
}

/** Visible text and controls inside `ground` whose right edge passes `limit`. */
const overrunning = (page: Page, ground: string, limit: number) =>
  page.evaluate(
    ([sel, max]) => {
      const bad: string[] = [];
      const items = `${sel} button, ${sel} a[href], ${sel} input, ${sel} textarea, ${sel} h1, ${sel} h2, ${sel} p`;
      for (const el of document.querySelectorAll<HTMLElement>(items)) {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        const cs = getComputedStyle(el);
        if (cs.visibility === "hidden" || cs.display === "none") continue;
        if (r.right > Number(max) + 0.5)
          bad.push(`${el.tagName}.${el.className}@${Math.round(r.right)}`);
      }
      return bad;
    },
    [ground, limit] as const,
  );

for (const shot of SHOTS) {
  for (const nativeNav of [false, true]) {
    const name = nativeNav ? `${shot.name}-native-nav` : shot.name;
    test(name, async ({ page }) => {
      const { width, inset } = shot.display;
      await open(page, shot.path, shot.display, nativeNav);
      // the ground runs to the window's right edge
      const box = await page.locator(shot.ground).first().boundingBox();
      expect(box && Math.round(box.x + box.width)).toBe(width);
      // the content ends before the strip
      expect(await overrunning(page, shot.ground, width - inset)).toEqual([]);
      if (nativeNav) await expect(page.locator(".cb-shell-menu-btn:visible")).toHaveCount(0);
      await expect(page).toHaveScreenshot(`${name}.png`);
    });
  }
}

test("duo-outer-chat-no-inset", async ({ page }) => {
  await open(page, "/dev/ui/templates/conversation", { width: OUTER.width, inset: 0 }, false);
  const box = await page.locator(".cb-shell").first().boundingBox();
  expect(box && Math.round(box.x + box.width)).toBe(OUTER.width);
  // without a strip the content keeps its ordinary 16 px gutter
  const over = await overrunning(page, ".cb-shell", OUTER.width);
  expect(over).toEqual([]);
  await expect(page).toHaveScreenshot("duo-outer-chat-no-inset.png");
});
