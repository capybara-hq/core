import { expect, test } from "@playwright/test";
import { hydrated } from "./support/nav";
import { signIn } from "./support/sign-in";

const CSRF = { "X-Capybara-Csrf": "1" };

/**
 * The `agent.detail.section` slot on the fake `fake-tools-ui` (the `agent-notes` view): a member who
 * may only use a shared agent (read-only on its page) still gets the extension's nav item and its
 * view, which names the agent.
 */
test("agent page: a member sees the extension section of a shared agent", async ({
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

  const created = await page.request.post(`${base}/agents`, {
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
  expect(created.status(), await created.text()).toBe(201);
  const agentId = ((await created.json()) as { agent: { id: string } }).agent.id;

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
    await guest.goto(`/agents/${agentId}`);
    await hydrated(guest);
    await guest.getByRole("link", { name: "智能体备注" }).click();
    await expect(guest).toHaveURL(/s=ext\.fake-tools-ui\.agent-notes/);
    await expect(guest.getByRole("heading", { name: `Agent ${agentId}` })).toBeVisible();
  } finally {
    await other.close();
  }
});
