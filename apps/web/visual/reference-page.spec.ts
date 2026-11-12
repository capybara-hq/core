import { expect, test } from "@playwright/test";
import { openReference } from "./reference-page";

const ORIGIN = `http://localhost:${process.env.CAPYBARA_VISUAL_PORT ?? "3100"}`;

/**
 * `openReference` returns only once the page has hydrated. Before hydration the app shell draws
 * both sidebar panels and the drawer bar (`data-responsive`) and lets CSS pick; a spec that
 * measured then counted the sidebar twice (skeleton-alignment, template-conversation, under load
 * in CI). Each of React's scheduler yields is held back here, so hydration outlasts `networkidle`
 * as it does on a busy runner, without slowing the rest of the page.
 */
test("openReference waits for hydration", async ({ page }) => {
  await page.addInitScript(() => {
    const Native = window.MessageChannel;
    window.MessageChannel = class {
      port1: MessagePort;
      port2: Pick<MessagePort, "postMessage">;
      constructor() {
        const c = new Native();
        this.port1 = c.port1;
        this.port2 = { postMessage: (m: unknown) => setTimeout(() => c.port2.postMessage(m), 100) };
      }
    } as unknown as typeof MessageChannel;
  });
  await openReference(page, "template-conversation", "dark", ORIGIN);
  const responsive = await page.evaluate(
    () => document.querySelectorAll("[data-responsive]").length,
  );
  expect(responsive, "shell parts still in their pre-hydration form").toBe(0);
});
