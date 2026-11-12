import { expect, test } from "@playwright/test";
import { openReference } from "./reference-page";

const ORIGIN = `http://localhost:${process.env.CAPYBARA_VISUAL_PORT ?? "3100"}`;

/**
 * `openReference` returns only once the page has hydrated. Before hydration the app shell draws
 * both sidebar panels and the drawer bar (`data-responsive`) and lets CSS pick; a spec that
 * measured then counted the sidebar twice (skeleton-alignment, template-conversation, under load
 * in CI). A slowed CPU keeps hydration running past `networkidle`, as a busy runner does.
 */
test("openReference waits for hydration", async ({ page }) => {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 20 });
  await openReference(page, "template-conversation", "dark", ORIGIN);
  const responsive = await page.evaluate(
    () => document.querySelectorAll("[data-responsive]").length,
  );
  expect(responsive, "shell parts still in their pre-hydration form").toBe(0);
});
