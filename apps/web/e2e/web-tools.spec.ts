import { expect, type Page, test } from "@playwright/test";
import { composer, designZh, replies, startChat, toolGroup, zh } from "./support/chat";
import { signIn } from "./support/sign-in";

/**
 * Web tools (spec docs/superpowers/specs/2026-11-04-web-tools-design.md §3.3, §6): the org
 * enables two web providers (`fake-web`, `fake-web-2` of @capybara-hq/testing, loaded by
 * global-setup), picks the default provider of each point, an agent selects `WebFetch` (not
 * checked by default), and a call asks for approval with the URL and the three scopes.
 */

const pd = zh.extensions.pointDefaults;

/** Sets the org token of a fake web provider and enables it on the org extensions page. */
async function enableWebProvider(page: Page, plugin: string) {
  const section = page.getByRole("region", { name: plugin, exact: true });
  await section.getByLabel(/^token/).fill(`${plugin}-token`);
  await section
    .getByRole("button", { name: zh.extensions.saveLabel.replace("{plugin}", plugin) })
    .click();
  await expect(
    page.getByText(zh.extensions.configSaved.replace("{plugin}", plugin)).first(),
  ).toBeVisible();
  const enable = section.getByRole("switch", {
    name: zh.extensions.enableLabel.replace("{plugin}", plugin),
  });
  await enable.click();
  await expect(enable).toHaveAttribute("aria-checked", "true");
}

test("web tools: two providers → default provider per point → WebFetch in the agent form → approval card with the URL and three scopes", async ({
  page,
}) => {
  await signIn(page);

  // 1. Enable both fake web providers (each configured with a token)
  await page.goto("/zh/settings/extensions");
  await expect(page.locator('[data-template="SettingsPage"]')).toBeVisible();
  await enableWebProvider(page, "fake-web");
  await enableWebProvider(page, "fake-web-2");

  // 2. Default providers: two candidates per point and none stored → "not selected"; pick one
  const defaults = page.getByRole("region", { name: pd.title, exact: true });
  const search = defaults.getByRole("combobox", { name: pd.points.webSearch, exact: true });
  const fetch = defaults.getByRole("combobox", { name: pd.points.webFetch, exact: true });
  await expect(search).toHaveValue("");
  await expect(fetch).toHaveValue("");
  await expect(
    defaults.getByText(pd.noneHint.replace("{point}", pd.points.webFetch)),
  ).toBeVisible();
  await search.selectOption("fake-web-2");
  await expect(
    page.getByText(
      pd.saved.replace("{point}", pd.points.webSearch).replace("{extension}", "fake-web-2"),
    ),
  ).toBeVisible();
  await fetch.selectOption("fake-web");
  await expect(
    page.getByText(
      pd.saved.replace("{point}", pd.points.webFetch).replace("{extension}", "fake-web"),
    ),
  ).toBeVisible();
  // Stored: a reload reads them back
  await page.reload();
  await expect(search).toHaveValue("fake-web-2");
  await expect(fetch).toHaveValue("fake-web");
  await expect(defaults.getByText(pd.noneHint.replace("{point}", pd.points.webFetch))).toHaveCount(
    0,
  );

  // 3. The agent form lists both web tools, not checked by default; select WebFetch
  await page.goto("/zh/agents/new");
  await page
    .getByRole("textbox", { name: zh.agents.form.nameLabel, exact: true })
    .fill("Web agent");
  await page
    .getByRole("combobox", { name: zh.agents.form.modelLabel, exact: true })
    .selectOption("model-fake/fake-1");
  const webSearch = page.getByRole("checkbox", {
    name: zh.agents.form.builtin.WebSearch,
    exact: true,
  });
  const webFetch = page.getByRole("checkbox", {
    name: zh.agents.form.builtin.WebFetch,
    exact: true,
  });
  await expect(webSearch).not.toBeChecked();
  await expect(webFetch).not.toBeChecked();
  await webFetch.check();
  await page.getByRole("button", { name: zh.agents.form.submit }).click();
  await expect(page).toHaveURL(/\/zh\/agents$/);

  // 4. A WebFetch call asks first: the card shows the URL (a key argument) and one approve
  //    button per scope (once, this conversation, always)
  await startChat(page, "Web agent");
  const input = composer(page);
  const url = "https://example.com/docs/page";
  await input.fill(`tool:WebFetch:${JSON.stringify({ url, prompt: "What does it say?" })}`);
  await input.press("Enter");
  const approval = page.locator('[data-role="approval"]');
  await expect(approval).toHaveCount(1);
  await expect(approval.locator('[data-part="tool-key"]')).toHaveText("WebFetch");
  await expect(approval.getByText(url).first()).toBeVisible();
  for (const key of ["hitl.approve", "hitl.approveSession", "hitl.approveAlways"]) {
    await expect(approval.getByRole("button", { name: designZh(key), exact: true })).toBeVisible();
  }
  const tool = toolGroup(page, "WebFetch");
  await expect(tool).toHaveAttribute("data-tool-status", "pending");

  // 5. Approve once: the tool runs on the default provider (fake-web) and the run continues
  await approval.getByRole("button", { name: designZh("hitl.approve"), exact: true }).click();
  await expect(tool).toHaveAttribute("data-tool-status", "done");
  await expect(replies(page).last()).toHaveText(/Tool result:/);
});
