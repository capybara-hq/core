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
  // the form select: the design system's own list (maintainer decision R)
  "select",
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
  // network ask spec §6.5: what a command was refused that no card lifts
  "network-facts",
  "question-block",
  "connect-block",
  "queued-message",
  "subagent-group",
  // the agent map: tree, one agent's summary, its transcript
  "agent-map",
  "inline-card",
  "property-section",
  "right-panel",
  "file-card",
  "file-outputs",
  "attachment-strip",
  "file-preview",
  // the role pass: no-access state, danger zone, secret reveal
  "roles",
  // unslop fixes: a failure sentence with its raw text behind a toggle
  "error-detail",
  // detail and review sections: a heading over its content, muted help and empty lines
  "content-section",
  // forms and flows: the one file pick
  "file-picker",
  // the run row: a run's model, duration, tokens and outcome
  "run-row",
  // the working line: the walking capybara between a send and the first output
  "working-line",
  // the new conversation page: the greeting, the agents row and panel, the quick actions
  "greeting",
  "agent-row",
  "quick-actions",
  // agent avatars: the ten pixel animals, the sizes, the initial and the picker
  "avatar",
  // config forms: arrays of objects, compact rows, records
  "repeater",
  "field-row",
  "key-value-editor",
  // loading states: the skeleton primitives
  "skeleton",
  "template-detail",
  "template-overview",
  "template-inbox",
  "template-trace",
  "template-settings",
  "template-wizard",
  "template-auth",
  // one box is enough (acceptance item AB): the groupings inside a box
  "item-list",
  "subsection",
  "callout",
  // cards on the page ground (plugin scope phase 4, ruling P4-15)
  "card-grid",
  // one section of an overview page in its own state (admin overview design §10.2)
  "overview-section",
  // the usage chart: two panels on one x-axis (admin overview design §10.1)
  "trend-chart",
  // the scheduled tasks calendar: week, month and the phone agenda (calendar design §11)
  "schedule-calendar",
  // a device's head and its two modes (auto mode design §4, plan Task 10)
  "device-nameplate",
  "mode-scale",
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
