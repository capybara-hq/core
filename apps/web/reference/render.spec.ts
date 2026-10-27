import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import * as fixtures from "../../../packages/design/src/fixtures/index";
import { ICON_PATHS } from "../../../packages/design/src/icons/markup";

// One PNG per [data-ref-block] per theme: docs/design/reference/<block id>-<theme>.png.
const OUT = fileURLToPath(new URL("../../../docs/design/reference/", import.meta.url));
const PAGES = [
  "sidebar",
  "page-header",
  "stat-cards",
  "status-bar",
  "action-row",
  "controls",
  "table",
  "icon",
  "template-list",
  "template-form",
  // UI refresh B: the conversation page.
  "template-conversation",
  "title-bar",
  "composer",
  "picker-menu",
  // phase D: the `/` palette's tagged items
  "command-palette",
  "prose",
  "thinking-row",
  "user-bubble",
  "run-divider",
  "tool-group",
  "tool-row",
  "diff-block",
  "approval-block",
  "question-block",
  "connect-block",
  "queued-message",
  "subagent-group",
  "inline-card",
  "property-section",
  "right-panel",
  "file-card",
  "file-outputs",
  "attachment-strip",
  "file-preview",
];
const THEMES = ["dark", "light"] as const;
const BLOCK_ID = /^[a-z-]+-[a-z0-9-]+$/;
const FAMILIES = ["Sarasa Mono SC", "Inter", "Source Han Sans SC"];

mkdirSync(OUT, { recursive: true });

async function inject(page: Page) {
  await page.addInitScript(
    ([f, icons]) => {
      Object.assign(window, { __CB_FIXTURES__: f, __CB_ICONS__: icons });
    },
    [JSON.parse(JSON.stringify(fixtures)), ICON_PATHS] as const,
  );
}

test("block ids are unique across pages and well-formed", async ({ page }) => {
  await inject(page);
  const owner = new Map<string, string>();
  for (const name of PAGES) {
    await page.goto(`/${name}.html`);
    await expect(page.locator("body")).toHaveAttribute("data-ready", "1");
    const ids = await page
      .locator("[data-ref-block]")
      .evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.refBlock ?? ""));
    expect(ids.length, name).toBeGreaterThan(0);
    for (const id of ids) {
      expect(id).toMatch(BLOCK_ID);
      expect(owner.get(id), `${id} appears twice`).toBeUndefined();
      owner.set(id, name);
    }
  }
});

for (const name of PAGES) {
  for (const theme of THEMES) {
    test(`${name} (${theme})`, async ({ page }) => {
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await inject(page);
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.goto(`/${name}.html?theme=${theme}`);
      await expect(page.locator("body")).toHaveAttribute("data-ready", "1");
      expect(errors).toEqual([]);
      await page.evaluate(async () => {
        await document.fonts.ready;
      });
      // Every face must be the real self-hosted font (a fallback would make the image worthless):
      // load both weights of each family and require the @font-face entries to be "loaded".
      for (const family of FAMILIES) {
        const loaded = await page.evaluate(async (fam) => {
          await document.fonts.load(`400 13px "${fam}"`, "示例Ag");
          await document.fonts.load(`700 13px "${fam}"`, "示例Ag");
          return [...document.fonts]
            .filter((f) => f.family.replace(/"/g, "") === fam)
            .map((f) => `${f.weight}:${f.status}`)
            .sort();
        }, family);
        expect(loaded, `${family} did not load`).toEqual(["400:loaded", "700:loaded"]);
      }
      expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe(theme);

      const blocks = page.locator("[data-ref-block]");
      const ids = await blocks.evaluateAll((els) =>
        els.map((e) => (e as HTMLElement).dataset.refBlock ?? ""),
      );
      for (const [i, id] of ids.entries()) {
        await blocks
          .nth(i)
          .screenshot({ path: `${OUT}${id}-${theme}.png`, animations: "disabled" });
      }
    });
  }
}
