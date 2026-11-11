import { expect, type Page, test } from "@playwright/test";
import { hydrated } from "./support/nav";
import { signIn } from "./support/sign-in";

const CSRF = { "X-Capybara-Csrf": "1" };

/** The 界面位置 switch of a contribution in a slot's table (a title may repeat across slots). */
const hideSwitch = (page: Page, slot: string, title: string) =>
  page.getByRole("table", { name: slot, exact: true }).getByRole("switch", {
    name: `隐藏 ${title}`,
    exact: true,
  });

/**
 * The UI slot cases share one file on purpose: hiding contributions writes the org's and the
 * platform's arrangement on the shared stack, which the slot cases below read (Acme's
 * `agent.detail.section` / `org.settings.section`, the platform's `platform.page`). Tests of one
 * file run in one worker, one after the other, so a hide never lands while another case looks for
 * the entry it hides (with `--workers=2` the files ran side by side and raced).
 */

/**
 * 界面位置 (组织设置 › 外观) on the fakes `fake-embed` (org page `panel`) and `fake-tools-ui`
 * (agent section `agent-notes`, org settings section `org-admin`, platform page `platform-home`):
 * hiding a contribution only unlists it, a direct URL still renders; the super admin's platform
 * default removes the admin nav's 扩展 entry. Every arrangement is cleared at the end (the stack is shared).
 */
test("hiding unlists a contribution from its slot; a direct URL still works", async ({ page }) => {
  await signIn(page);
  const me = await page.request.get("/api/v1/me");
  const orgId = ((await me.json()) as { currentOrgId: string }).currentOrgId;
  const base = `/api/v1/orgs/${orgId}`;
  for (const name of ["fake-embed", "fake-tools-ui"]) {
    const enable = await page.request.put(`${base}/extensions/${name}`, {
      headers: CSRF,
      data: { enabled: true },
    });
    expect(enable.status(), await enable.text()).toBe(200);
  }
  const created = await page.request.post(`${base}/agents`, {
    headers: CSRF,
    data: {
      definition: {
        name: "Arranged agent",
        instructions: "Help.",
        model: { provider: "model-fake", model: "fake-1" },
      },
      visibility: "org",
    },
  });
  expect(created.status(), await created.text()).toBe(201);
  const agentId = ((await created.json()) as { agent: { id: string } }).agent.id;
  const nav = page.getByRole("navigation", { name: "主导航" });

  try {
    // ---- org.page: leaves the sidebar's 更多 group, the direct URL still renders ----
    await page.goto("/");
    await hydrated(page);
    await nav.getByRole("button", { name: "更多", exact: true }).click();
    await expect(
      page.getByRole("menu", { name: "更多" }).getByRole("menuitem", { name: "面板", exact: true }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await page.goto("/settings/appearance");
    await hydrated(page);
    await expect(page.getByRole("heading", { name: "界面位置" })).toBeVisible();
    await hideSwitch(page, "组织页面", "面板").click();
    await expect(hideSwitch(page, "组织页面", "面板")).toBeChecked();
    await nav.getByRole("button", { name: "更多", exact: true }).click();
    await expect(
      page.getByRole("menu", { name: "更多" }).getByRole("menuitem", { name: "面板", exact: true }),
    ).toHaveCount(0);
    await page.keyboard.press("Escape");
    await page.goto("/p/fake-embed/panel");
    await hydrated(page);
    await expect(page.locator('iframe[title="面板"]')).toBeVisible();

    // ---- agent.detail.section: the agent nav item goes ----
    await page.goto(`/agents/${agentId}`);
    await hydrated(page);
    await expect(page.getByRole("link", { name: "智能体备注" })).toBeVisible();
    await page.goto("/settings/appearance");
    await hideSwitch(page, "智能体页面区块", "智能体备注").click();
    await expect(hideSwitch(page, "智能体页面区块", "智能体备注")).toBeChecked();
    await page.goto(`/agents/${agentId}`);
    await hydrated(page);
    await expect(page.getByRole("link", { name: "智能体备注" })).toHaveCount(0);

    // ---- org.settings.section: the org settings section goes ----
    await page.goto("/settings/organization");
    await hydrated(page);
    await expect(page.getByText("组织设置扩展")).toBeVisible();
    await page.goto("/settings/appearance");
    await hideSwitch(page, "组织设置区块", "组织设置扩展").click();
    await expect(hideSwitch(page, "组织设置区块", "组织设置扩展")).toBeChecked();
    await page.goto("/settings/organization");
    await hydrated(page);
    await expect(page.locator('[data-template="SettingsPage"]')).toBeVisible();
    await expect(page.getByText("组织设置扩展")).toHaveCount(0);
  } finally {
    const reset = await page.request.patch(`${base}/settings`, {
      headers: CSRF,
      data: {
        uiArrangement: {
          "org.page": null,
          "agent.detail.section": null,
          "org.settings.section": null,
        },
      },
    });
    expect(reset.status(), await reset.text()).toBe(200);
  }
});

test("the super admin hides a platform page in 平台设置: its nav entry goes, its URL works", async ({
  page,
}) => {
  await signIn(page);
  const me = await page.request.get("/api/v1/me");
  const orgId = ((await me.json()) as { currentOrgId: string }).currentOrgId;
  const enable = await page.request.put(`/api/v1/orgs/${orgId}/extensions/fake-tools-ui`, {
    headers: CSRF,
    data: { enabled: true },
  });
  expect(enable.status(), await enable.text()).toBe(200);
  const nav = page.getByRole("navigation", { name: "主导航" });
  try {
    await page.goto("/admin");
    await hydrated(page);
    await expect(nav.getByRole("link", { name: "平台首页", exact: true })).toBeVisible();
    await page.goto("/admin/settings");
    await hydrated(page);
    await expect(page.getByRole("heading", { name: "界面位置" })).toBeVisible();
    await hideSwitch(page, "平台页面", "平台首页").click();
    await expect(hideSwitch(page, "平台页面", "平台首页")).toBeChecked();
    await page.goto("/admin");
    await hydrated(page);
    await expect(nav.getByRole("link", { name: "平台首页", exact: true })).toHaveCount(0);
    // hidden means not listed: the direct URL still renders the page
    await page.goto("/admin/p/fake-tools-ui/platform-home");
    await hydrated(page);
    await expect(page.getByRole("heading", { name: "Platform home" })).toBeVisible();
  } finally {
    const reset = await page.request.put("/api/v1/admin/settings", {
      headers: CSRF,
      data: { uiArrangement: { "platform.page": null } },
    });
    expect(reset.status(), await reset.text()).toBe(200);
  }
});

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
