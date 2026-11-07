import { expect, type Page, test } from "@playwright/test";
import {
  currentOrg,
  designZh,
  newAgent,
  OBJECT_ROW_MENU,
  openAgentSection,
  saveSection,
  zh,
} from "./support/chat";
import { selectOption } from "./support/select";
import { signIn } from "./support/sign-in";

/**
 * Phase 4, agent templates (spec 2026-11-05-plugin-component-management-design §15): the /agents
 * tabs and cards, 另存为模板, 用它创建 with a connector the org has not configured (待配置), the
 * admin binding it from the agent page, and a member's setup request closed from the admin inbox.
 *
 * Seeding: everything goes through the UI and the same-origin API against the e2e stack's fake MCP
 * server (`CAPYBARA_E2E_MCP_URL`). The templates are org templates made with 另存为模板, whose
 * connector is a hand-configured one, so the template records a "needs a connector" entry (P4-11).
 * Gap: a platform template whose connector entry names a plugin's connector template needs a packed
 * plugin with an `agents/<name>.md` file; the e2e catalog fixtures (`crm`) carry a connector
 * template but no agent template, so that path ("one more connector from this template") is
 * covered by the web unit tests and the kernel tests only.
 */

const CSRF = { "X-Capybara-Csrf": "1" };
const A = zh.agents;
const fill = (s: string, vars: Record<string, string | number>) =>
  s.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k]));

const actionRow = (page: Page) => page.getByRole("region", { name: designZh("shell.pending") });
/** A card of the agents page's CardGrid (design `ObjectCard`), by the text it shows. */
const cards = (page: Page) => page.locator('[data-part="object-card"]');
const card = (page: Page, text: string) => cards(page).filter({ hasText: text });

/**
 * Installs an MCP connector without auth through the install wizard (as tools.spec does). The slug
 * follows the kernel's rule (`^[a-z][a-z0-9_]{0,23}$`: no hyphens).
 */
async function installMcp(page: Page, name: string, slug: string, url: string): Promise<void> {
  const w = zh.connectors.wizard;
  await page.goto("/connectors/install");
  await expect(page.locator('[data-template="WizardPage"]')).toBeVisible();
  await actionRow(page).getByRole("button", { name: w.next }).click();
  await page.getByRole("textbox", { name: zh.connectors.form.nameLabel, exact: true }).fill(name);
  await page
    .getByRole("textbox", { name: new RegExp(`^${zh.connectors.form.slugLabel}`) })
    .fill(slug);
  await page.getByRole("textbox", { name: zh.connectors.form.urlLabel }).fill(url);
  await actionRow(page).getByRole("button", { name: w.next }).click();
  // the auth step is up (no auth) before the next 下一步
  await expect(
    page.getByRole("combobox", { name: zh.connectors.form.authTypeLabel, exact: true }),
  ).toHaveAttribute("value", "none");
  await actionRow(page).getByRole("button", { name: w.next }).click();
  await expect(page.getByRole("table", { name: w.toolsTitle })).toBeVisible();
  await actionRow(page).getByRole("button", { name: w.install }).click();
  await expect(page.getByText(w.doneTitle.replace("{name}", name))).toBeVisible();
}

/** A new agent that uses every tool of the connector `connectorName`; returns its id. */
async function agentWithConnector(
  page: Page,
  agentName: string,
  connectorName: string,
): Promise<string> {
  const id = await newAgent(page, agentName);
  await openAgentSection(page, "tools");
  await page
    .getByRole("checkbox", {
      name: fill(A.form.connectorTools, { name: connectorName }),
      exact: true,
    })
    .check();
  await saveSection(page);
  return id;
}

/** Saves the agent as the org template `name` through the API. */
async function saveAsTemplate(page: Page, agentId: string, name: string): Promise<void> {
  const orgId = await currentOrg(page);
  const res = await page.request.post(`/api/v1/orgs/${orgId}/agents/${agentId}/save-as-template`, {
    headers: CSRF,
    data: { name, description: "E2E template" },
  });
  expect(res.status(), await res.text()).toBeLessThan(300);
}

/** The connector picker's option text for a connector (PendingConnectorDialog: `name · slug`). */
const connectorOption = (name: string, slug: string) => ({ label: `${name} · ${slug}` });

/** Opens the template's 用它创建 dialog from the 模板 tab. */
async function openCreateDialog(page: Page, templateName: string) {
  await page.goto("/agents?tab=templates");
  await card(page, templateName).getByRole("button", { name: A.templates.create }).click();
  const dialog = page.getByRole("dialog", {
    name: fill(A.fromTemplate.title, { name: templateName }),
  });
  await expect(dialog).toBeVisible();
  // the preview groups the connector as 待配置 (a hand-configured connector is a "needs" entry)
  await expect(dialog.getByText(fill(A.fromTemplate.groups.pending, { n: 1 }))).toBeVisible();
  return dialog;
}

test("agents page: tabs and cards, and /agent-templates redirects to the 模板 tab", async ({
  page,
}) => {
  await signIn(page);
  await page.goto("/agents");
  const tabs = page.getByRole("tab");
  await expect(tabs.filter({ hasText: A.pageTabs.agents })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  // the agent from signIn is a card with its primary action 开始会话
  await expect(cards(page).getByRole("link", { name: A.chat, exact: true }).first()).toBeVisible();

  await tabs.filter({ hasText: A.pageTabs.templates }).click();
  await expect(page).toHaveURL(/\/agents\?tab=templates$/);
  await expect(tabs.filter({ hasText: A.pageTabs.templates })).toHaveAttribute(
    "aria-selected",
    "true",
  );

  // the old list is a temporary redirect (307), the browser lands on the tab
  const old = await page.request.get("/agent-templates", { maxRedirects: 0 });
  expect(old.status()).toBe(307);
  expect(old.headers().location ?? "").toMatch(/\/agents\?tab=templates$/);
  await page.goto("/agent-templates");
  await expect(page).toHaveURL(/\/agents\?tab=templates$/);
});

test("admin: 另存为模板 -> it is in the 模板 tab -> 用它创建 shows 待配置 -> bind the connector on the agent page", async ({
  page,
}) => {
  const run = Date.now().toString(36);
  const mcpUrl = process.env.CAPYBARA_E2E_MCP_URL as string;
  const connector = `Tpl docs ${run}`;
  const slug = `tpl_${run}`;
  const source = `Tpl source ${run}`;
  const tpl = `tpl-${run}`;
  const copy = `Tpl copy ${run}`;
  await signIn(page);
  await installMcp(page, connector, slug, mcpUrl);
  await agentWithConnector(page, source, connector);

  // 1. 另存为模板 from the agent card's ⋯ menu
  await page.goto("/agents");
  await card(page, source).getByRole("button", { name: OBJECT_ROW_MENU }).click();
  await page.getByRole("menuitem", { name: A.saveAs.action }).click();
  const save = page.getByRole("dialog", { name: fill(A.saveAs.title, { name: source }) });
  await save.getByRole("textbox", { name: A.saveAs.name }).fill(tpl);
  await save.getByRole("textbox", { name: A.saveAs.description }).fill("Docs helper");
  await save.getByRole("button", { name: A.saveAs.submit }).click();
  // nothing was left out (a new agent has no other model params, fallback or org agents), so the
  // dialog goes straight to the new template's page instead of listing omissions
  await expect(page).toHaveURL(/\/agents\/templates\/[^/?#]+$/);
  await expect(page.getByRole("dialog")).toHaveCount(0);

  // 2. the template is a card in the 模板 tab, owned by the org
  await page.goto("/agents?tab=templates");
  const tplCard = card(page, tpl);
  await expect(tplCard).toBeVisible();
  await expect(tplCard).toContainText(A.templates.source.org);

  // 3. 用它创建: the dialog (admins see 可见范围), 待配置 listed, create lands on the Tools section
  const dialog = await openCreateDialog(page, tpl);
  await expect(dialog.getByText(A.form.visibilityLabel).first()).toBeVisible();
  await dialog.getByRole("textbox", { name: A.form.nameLabel, exact: true }).fill(copy);
  await dialog.getByRole("button", { name: A.fromTemplate.submit, exact: true }).click();
  await expect(page).toHaveURL(/\/agents\/[^/?#]+\?s=tools$/);
  const agentId = decodeURIComponent(new URL(page.url()).pathname.split("/").at(-1) ?? "");

  // 4. the agent has no connector tools yet; the 待配置 notice names the connector
  const notice = page.getByRole("list", { name: A.pending.listLabel });
  await expect(notice.getByText(connector)).toBeVisible();
  const toolsBox = page.getByRole("checkbox", {
    name: fill(A.form.connectorTools, { name: connector }),
    exact: true,
  });
  await expect(toolsBox).not.toBeChecked();

  // 5. the admin picks the existing connector and binds it: the notice goes, the tools appear
  await notice
    .getByRole("listitem")
    .filter({ hasText: connector })
    .getByRole("button", { name: A.pending.configure, exact: true })
    .click();
  const bind = page.getByRole("dialog", { name: fill(A.pending.entryTitle, { name: connector }) });
  await bind.getByRole("radio", { name: new RegExp(A.pending.modeExisting) }).check();
  await selectOption(
    bind.getByRole("combobox", { name: A.pending.connectorLabel }),
    connectorOption(connector, slug),
  );
  await bind.getByRole("button", { name: A.pending.bind, exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(notice).toBeHidden();
  await expect(toolsBox).toBeChecked();

  // the agent's page keeps its provenance, and the kernel agrees: no pending entry is left
  const orgId = await currentOrg(page);
  const res = await page.request.get(`/api/v1/orgs/${orgId}/agents/${agentId}`);
  const body = (await res.json()) as {
    agent: {
      createdFrom?: { name: string };
      definition: { pendingConnectors?: unknown[]; tools?: { kind: string }[] };
    };
  };
  expect(body.agent.createdFrom?.name).toBe(tpl);
  expect(body.agent.definition.pendingConnectors ?? []).toHaveLength(0);
  expect(body.agent.definition.tools?.some((t) => t.kind !== "builtin")).toBe(true);
});

test("member: 用它创建 is private and sends a setup request -> the admin configures it from the inbox -> the request closes", async ({
  page,
  browser,
}) => {
  const run = Date.now().toString(36);
  const mcpUrl = process.env.CAPYBARA_E2E_MCP_URL as string;
  const connector = `Req docs ${run}`;
  const slug = `req_${run}`;
  const tpl = `req-${run}`;
  const mine = `Member copy ${run}`;
  await signIn(page);
  await installMcp(page, connector, slug, mcpUrl);
  const sourceId = await agentWithConnector(page, `Req source ${run}`, connector);
  await saveAsTemplate(page, sourceId, tpl);

  // a member joins through an invitation (the accept call signs the new account in)
  const orgId = await currentOrg(page);
  const invite = await page.request.post(`/api/v1/orgs/${orgId}/invitations`, {
    headers: CSRF,
    data: { role: "member", expiresInHours: 24 },
  });
  expect(invite.status(), await invite.text()).toBe(201);
  const { token } = (await invite.json()) as { token: string };
  const other = await browser.newContext({ baseURL: process.env.CAPYBARA_E2E_BASE_URL as string });
  try {
    const accept = await other.request.post(`/api/v1/invitations/${token}/accept`, {
      headers: CSRF,
      data: {
        login: `tpl-member-${run}`,
        password: "member-password-123",
        displayName: `Mia ${run}`,
      },
    });
    expect(accept.status(), await accept.text()).toBeLessThan(300);
    const member = await other.newPage();

    // 1. the member sees the org template and creates from it: no 可见范围, 待配置 listed
    const dialog = await openCreateDialog(member, tpl);
    await expect(dialog.getByText(A.form.visibilityLabel)).toHaveCount(0);
    await dialog.getByRole("textbox", { name: A.form.nameLabel, exact: true }).fill(mine);
    await dialog.getByRole("button", { name: A.fromTemplate.submit, exact: true }).click();
    await expect(member).toHaveURL(/\/agents\/[^/?#]+\?s=tools$/);

    // 2. the owner cannot configure connectors: the request went to the org admins by itself
    await expect(member.getByText(A.pending.request.pending)).toBeVisible();
  } finally {
    await other.close();
  }

  // 3. the admin finds the request in the inbox and configures it from the dialog
  await page.goto("/inbox");
  const list = page.getByRole("table", { name: zh.inbox.listLabel });
  await list.getByText(mine).first().click();
  await page.getByRole("button", { name: zh.inbox.setup.configure, exact: true }).click();
  const all = page.getByRole("dialog", { name: fill(A.pending.listTitle, { agent: mine }) });
  await all
    .getByRole("listitem")
    .filter({ hasText: connector })
    .getByRole("button", { name: A.pending.configure, exact: true })
    .click();
  const entry = page.getByRole("dialog", { name: fill(A.pending.entryTitle, { name: connector }) });
  await entry.getByRole("radio", { name: new RegExp(A.pending.modeExisting) }).check();
  await selectOption(
    entry.getByRole("combobox", { name: A.pending.connectorLabel }),
    connectorOption(connector, slug),
  );
  await entry.getByRole("button", { name: A.pending.bind, exact: true }).click();

  // 4. the last entry is bound: the request closes and leaves the inbox
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(list.getByText(mine)).toHaveCount(0);
});
