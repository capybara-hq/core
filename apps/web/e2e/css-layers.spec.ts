import { expect, type Locator, type Page, test } from "@playwright/test";

/**
 * Cascade layers (client extensions spec §7.2). Unlayered CSS beats every layer whatever the order,
 * so the design stylesheet declares `@layer design, theme, extensions;` once and puts every file
 * in `design`, the kernel's theme stylesheet is one `@layer theme { … }` block, and plugin CSS will
 * be `@layer extensions { … }`. On `/dev/ui/components` (no sign-in) these cases add a sheet the
 * way the theme link and plugin links do (after the design stylesheet) and read computed styles.
 */

/** The primary button of the components page (`.cb-btn[data-variant="primary"]`). */
async function primaryButton(page: Page): Promise<Locator> {
  await page.goto("/dev/ui/components");
  const button = page.locator('.cb-btn[data-variant="primary"]').first();
  await expect(button).toBeVisible();
  // The part attribute plugin CSS selects on (UI parts, spec §7.1)
  await button.evaluate((el) => el.setAttribute("data-cap-part", "button"));
  return button;
}

/** Appends a stylesheet to `<head>`, after the design stylesheet (where theme and plugin links go). */
async function addSheet(page: Page, css: string): Promise<void> {
  await page.evaluate((text) => {
    const style = document.createElement("style");
    style.textContent = text;
    document.head.append(style);
  }, css);
}

const rootVar = (page: Page, name: string) =>
  page.evaluate((n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(), name);

test.describe("CSS cascade layers", () => {
  test("the design stylesheet declares the layer order first", async ({ page }) => {
    await primaryButton(page);
    // The page's layer order as the cascade computes it: top-level layers in order of first
    // appearance across the sheets. The bundler emits the imported files' `@layer design { … }`
    // blocks before index.css's own statement, so design comes first by its blocks and theme and
    // extensions by the statement, before any theme or plugin sheet.
    const order = await page.evaluate(() => {
      const seen: string[] = [];
      const add = (name: string) => {
        const top = name.split(".")[0] as string;
        if (!seen.includes(top)) seen.push(top);
      };
      for (const sheet of Array.from(document.styleSheets)) {
        for (const rule of Array.from(sheet.cssRules)) {
          if (rule instanceof CSSLayerStatementRule) rule.nameList.forEach(add);
          else if (rule instanceof CSSLayerBlockRule) add(rule.name);
          else if (rule instanceof CSSImportRule && rule.layerName) add(rule.layerName);
        }
      }
      return seen;
    });
    expect(order).toEqual(["design", "theme", "extensions"]);
  });

  test("no stylesheet of the page has an unlayered rule", async ({ page }) => {
    await primaryButton(page);
    // An unlayered rule (the app's, a framework's or a vendor's) would beat design, theme and
    // plugin CSS alike, whatever its specificity.
    const unlayered = await page.evaluate(() => {
      const out: string[] = [];
      for (const sheet of Array.from(document.styleSheets)) {
        for (const rule of Array.from(sheet.cssRules)) {
          const layered =
            rule instanceof CSSLayerStatementRule ||
            rule instanceof CSSLayerBlockRule ||
            (rule instanceof CSSImportRule && rule.layerName !== null);
          // `next dev` only: the dev overlay's own faces (`__nextjs-Geist…`), no style rules
          const devOverlayFace =
            rule instanceof CSSFontFaceRule &&
            rule.style.getPropertyValue("font-family").replace(/^"/, "").startsWith("__nextjs-");
          if (!layered && !devOverlayFace)
            out.push(`${sheet.href ?? "inline"}: ${rule.cssText.slice(0, 120)}`);
        }
      }
      return out;
    });
    expect(unlayered).toEqual([]);
  });

  test("a theme token beats the design default", async ({ page }) => {
    await primaryButton(page);
    const theme = await page.evaluate(() => document.documentElement.dataset.theme);
    expect(theme === "dark" || theme === "light").toBe(true);
    // The design sets --cb-accent under :root[data-theme="…"]; the theme's bare :root has a lower
    // specificity and wins only by its layer. A theme sheet as renderThemeCss writes it.
    await addSheet(page, "@layer theme {\n:root { --cb-accent: #123456; }\n}\n");
    expect(await rootVar(page, "--cb-accent")).toBe("#123456");
    await addSheet(page, `@layer theme {\n:root[data-theme="${theme}"] { --cb-bg: #010203; }\n}\n`);
    expect(await rootVar(page, "--cb-bg")).toBe("#010203");
    await expect(page.locator("body")).toHaveCSS("background-color", "rgb(1, 2, 3)");
  });

  test("an extensions-layer rule beats the design rule", async ({ page }) => {
    const button = await primaryButton(page);
    // The design's focus ring (:focus-visible { outline: 2px solid var(--cb-accent) })
    await button.focus();
    expect(await button.evaluate((el) => el.matches(":focus-visible"))).toBe(true);
    const accent = await button.evaluate((el) => getComputedStyle(el).outlineColor);
    expect(accent).not.toBe("rgb(1, 2, 3)");
    await addSheet(page, '@layer extensions{[data-cap-part~="button"]{outline-color:rgb(1,2,3)}}');
    await expect(button).toHaveCSS("outline-color", "rgb(1, 2, 3)");
    // A more specific design rule (.cb-btn[data-variant="primary"] { background }) loses too
    await addSheet(
      page,
      '@layer extensions{[data-cap-part~="button"]{background-color:rgb(4,5,6)}}',
    );
    await expect(button).toHaveCSS("background-color", "rgb(4, 5, 6)");
  });

  test("design !important beats a plugin rule", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    const button = await primaryButton(page);
    // base.css: under prefers-reduced-motion, transition-duration: 0.01ms !important
    const kept = await button.evaluate((el) => getComputedStyle(el).transitionDuration);
    expect(kept).not.toBe("5s");
    await addSheet(
      page,
      '@layer extensions{[data-cap-part~="button"]{transition-duration:5s !important}}',
    );
    await expect(button).toHaveCSS("transition-duration", kept);
  });

  test("no plugin css: the design and theme still apply", async ({ page }) => {
    const button = await primaryButton(page);
    const theme = await page.evaluate(() => document.documentElement.dataset.theme);
    // tokens.css (built-in theme) values, read through the design rules that use them
    const accent = theme === "light" ? "rgb(204, 70, 9)" : "rgb(255, 106, 19)";
    const bg = theme === "light" ? "rgb(250, 249, 246)" : "rgb(10, 10, 10)";
    await expect(button).toHaveCSS("background-color", accent);
    await expect(page.locator("body")).toHaveCSS("background-color", bg);
    await expect(button).toHaveCSS("border-top-style", "solid");
    // The visual and fidelity suites (playwright.visual.config.ts) cover the rest pixel for pixel
  });
});
