import { expect, test } from "@playwright/test";
import { hydrated } from "./support/nav";
import { signIn } from "./support/sign-in";

const CSRF = { "X-Capybara-Csrf": "1" };

/**
 * The `org.settings.section` slot on the fake `fake-tools-ui` (the `org-admin` view): the org owner
 * sees it on the organization settings page, after the built-in sections; a member sees nothing.
 */
test("org settings: the owner sees the extension section, a member does not", async ({
  page,
  browser,
}) => {
  await signIn(page);
  const me = await page.request.get("/api/v1/me");
  const orgId = ((await me.json()) as { currentOrgId: string }).currentOrgId;
  const base = `/api/v1/orgs/${orgId}`;
  const enable = await page.request.put(`${base}/extensions/fake-tools-ui`, {
    headers: CSRF,
    data: { enabled: true },
  });
  expect(enable.status(), await enable.text()).toBe(200);

  await page.goto("/settings/organization");
  await hydrated(page);
  await expect(page.getByRole("heading", { name: "Org settings" })).toBeVisible();
  await expect(page.getByText("组织设置扩展")).toBeVisible();

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

  // a member of the same org
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
    await guest.goto("/settings/organization");
    await hydrated(guest);
    await expect(guest.locator('[data-template="SettingsPage"]')).toBeVisible();
    await expect(guest.getByRole("heading", { name: "Org settings" })).toHaveCount(0);
    await expect(guest.getByText("组织设置扩展")).toHaveCount(0);
  } finally {
    await other.close();
  }
});
