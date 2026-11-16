import { expect, test } from "@playwright/test";
import { signIn } from "./support/sign-in";

test("sign-in completes while an unrelated request is still pending", async ({ page }) => {
  let pending = false;
  let pendingAtSignIn = false;
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/e2e-sign-in-pending", async (route) => {
    pending = true;
    await held;
    await route.fulfill({ status: 204 });
  });
  await page.addInitScript(() => {
    if (location.pathname === "/login") void fetch("/e2e-sign-in-pending");
  });
  page.on("request", (request) => {
    if (request.url().endsWith("/api/v1/auth/login") && request.method() === "POST") {
      pendingAtSignIn = pending;
    }
  });
  try {
    await signIn(page);
    expect(pendingAtSignIn).toBe(true);
    await expect(page.locator('[data-template="ConversationPage"]')).toBeVisible();
  } finally {
    release();
  }
});
