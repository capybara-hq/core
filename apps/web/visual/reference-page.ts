import type { Page } from "@playwright/test";

export const THEMES = ["dark", "light"] as const;
export type Theme = (typeof THEMES)[number];

/**
 * Opens `/zh/dev/ui/reference/<component>` in `theme` (the `cb-theme` cookie), waits for the
 * fonts, and forces the pseudo-states the blocks ask for (`data-ref-force` on
 * `data-ref-force-selector` inside the block) through the DevTools protocol, marking each forced
 * element `data-ref-forced="true"` (design spec §9.2). Chromium only.
 */
export async function openReference(page: Page, component: string, theme: Theme, origin: string) {
  await page.context().addCookies([{ name: "cb-theme", value: theme, url: origin }]);
  const res = await page.goto(`/zh/dev/ui/reference/${component}`);
  if (!res?.ok()) throw new Error(`/dev/ui/reference/${component} answered ${res?.status()}`);
  await page.waitForLoadState("networkidle");
  await page.evaluate(() => document.fonts.ready);
  await forceStates(page);
  return res;
}

async function forceStates(page: Page) {
  const asks = await page.$$eval("[data-ref-block][data-ref-force]", (blocks) =>
    blocks.map((b) => ({
      id: b.getAttribute("data-ref-block") ?? "",
      pseudo: (b.getAttribute("data-ref-force") ?? "").split(" ").filter(Boolean),
      selector: b.getAttribute("data-ref-force-selector") ?? "",
    })),
  );
  if (asks.length === 0) return;
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("DOM.enable");
  await cdp.send("CSS.enable");
  const { root } = await cdp.send("DOM.getDocument", { depth: -1 });
  for (const a of asks) {
    const { nodeIds } = await cdp.send("DOM.querySelectorAll", {
      nodeId: root.nodeId,
      selector: `[data-ref-block="${a.id}"] ${a.selector}`,
    });
    if (nodeIds.length === 0)
      throw new Error(`${a.id}: force selector "${a.selector}" matched nothing`);
    for (const nodeId of nodeIds) {
      await cdp.send("CSS.forcePseudoState", { nodeId, forcedPseudoClasses: a.pseudo });
      await cdp.send("DOM.setAttributeValue", { nodeId, name: "data-ref-forced", value: "true" });
    }
  }
  // Let forced-state transitions (motion.hover) finish before anything is measured.
  await page.waitForTimeout(400);
}

export async function blockIds(page: Page): Promise<string[]> {
  return page.$$eval("[data-ref-block]", (bs) =>
    bs.map((b) => b.getAttribute("data-ref-block") ?? ""),
  );
}
