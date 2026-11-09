import { expect, test } from "@playwright/test";
import { hydrated } from "./support/nav";
import { signIn } from "./support/sign-in";

const CSRF = { "X-Capybara-Csrf": "1" };

/**
 * The `platform.page` slot on the fake `fake-tools-ui` (the `platform-home` view): the super admin
 * opens it from the admin console's sidebar and sees the view; a person who is not a super admin
 * gets the admin no-access state at the URL.
 */
test("platform page: the super admin opens it from the nav, a member gets no access", async ({
  page,
  browser,
}) => {
  await signIn(page);
  const me = await page.request.get("/api/v1/me");
  const orgId = ((await me.json()) as { currentOrgId: string }).currentOrgId;
  const base = `/api/v1/orgs/${orgId}`;

  await page.goto("/admin");
  await hydrated(page);
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("link", { name: "平台首页", exact: true })
    .click();
  await expect(page).toHaveURL(/\/admin\/p\/fake-tools-ui\/platform-home$/);
  await expect(page.locator('[data-template="DetailPage"]')).toBeVisible();
  await expect(page.getByRole("heading", { name: "Platform home" })).toBeVisible();

  // an agent the whole org sees, so the member gets the shell (not the setup layout)
  const shared = await page.request.post(`${base}/agents`, {
    headers: CSRF,
    data: {
      definition: {
        name: "Shared agent",
        instructions: "Help.",
        model: { provider: "model-fake", model: "fake-1" },
      },
      visibility: "org",
    },
  });
  expect(shared.status(), await shared.text()).toBe(201);

  const run = Date.now().toString(36);
  const invite = await page.request.post(`${base}/invitations`, {
    headers: CSRF,
    data: { role: "member", expiresInHours: 24 },
  });
  expect(invite.status(), await invite.text()).toBe(201);
  const { token } = (await invite.json()) as { token: string };
  const other = await browser.newContext();
  try {
    const guest = await other.newPage();
    const accepted = await guest.request.post(`/api/v1/invitations/${token}/accept`, {
      headers: CSRF,
      data: {
        login: `member-${run}`,
        password: "member-password-123",
        displayName: `Member ${run}`,
      },
    });
    expect(accepted.status(), await accepted.text()).toBeLessThan(300);
    await guest.goto("/admin/p/fake-tools-ui/platform-home");
    await hydrated(guest);
    await expect(
      guest.locator('[data-template="StatusPage"][data-kind="no-access"]'),
    ).toBeVisible();
    await expect(guest.getByRole("heading", { name: "Platform home" })).toHaveCount(0);
  } finally {
    await other.close();
  }
});
