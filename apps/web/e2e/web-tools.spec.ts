import { expect, type Page, test } from "@playwright/test";
import {
  composer,
  designZh,
  newAgent,
  openAgentSection,
  replies,
  saveSection,
  startChat,
  toolGroup,
  zh,
} from "./support/chat";
import { selectOption } from "./support/select";
import { signIn } from "./support/sign-in";

/**
 * Web tools (spec docs/superpowers/specs/2026-11-04-web-tools-design.md §3.3, §6): the org
 * enables two web providers (`fake-web`, `fake-web-2` of @capybara-hq/testing, loaded by
 * global-setup), picks the default provider of each point, an agent selects `WebFetch` in its
 * Tools section (not checked by default), and a call asks for approval with the URL and the three
 * scopes.
 */

const pd = zh.extensions.pointDefaults;

/**
 * Sets the org token of a fake web provider and switches it on: on the org 扩展 page its row opens a
 * Sheet with the org config form, and 保存并启用 saves the token and turns it on.
 */
async function enableWebProvider(page: Page, plugin: string) {
  const row = page
    .getByRole("row")
    .filter({ hasText: plugin })
    .filter({
      has: page.getByRole("switch", {
        name: zh.extensions.enableLabel.replace("{plugin}", plugin),
        exact: true,
      }),
    });
  await row.click();
  const sheet = page.getByRole("dialog", { name: plugin, exact: true });
  await sheet.getByLabel(/^token/).fill(`${plugin}-token`);
  await sheet
    .getByRole("button", {
      name: zh.extensions.saveAndEnableLabel.replace("{plugin}", plugin),
      exact: true,
    })
    .click();
  const enable = row.getByRole("switch", {
    name: zh.extensions.enableLabel.replace("{plugin}", plugin),
    exact: true,
  });
  await expect(enable).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("Escape");
  await expect(sheet).toBeHidden();
}

test("web tools: two providers → default provider per point → WebFetch in the agent's Tools → approval card with the URL and three scopes", async ({
  page,
}) => {
  await signIn(page);

  // 1. Enable both fake web providers (each configured with a token)
  await page.goto("/extensions");
  await expect(page.locator('[data-template="ListPage"]')).toBeVisible();
  await enableWebProvider(page, "fake-web");
  await enableWebProvider(page, "fake-web-2");

  // 2. Default providers: two candidates per point and none stored → "not selected"; pick one
  const defaults = page.getByRole("region", { name: pd.title, exact: true });
  const search = defaults.getByRole("combobox", { name: pd.points.webSearch, exact: true });
  const fetch = defaults.getByRole("combobox", { name: pd.points.webFetch, exact: true });
  await expect(search).toHaveAttribute("value", "");
  await expect(fetch).toHaveAttribute("value", "");
  await expect(
    defaults.getByText(pd.noneHint.replace("{point}", pd.points.webFetch)),
  ).toBeVisible();
  await selectOption(search, "fake-web-2");
  await expect(
    page.getByText(
      pd.saved.replace("{point}", pd.points.webSearch).replace("{extension}", "fake-web-2"),
    ),
  ).toBeVisible();
  await selectOption(fetch, "fake-web");
  await expect(
    page.getByText(
      pd.saved.replace("{point}", pd.points.webFetch).replace("{extension}", "fake-web"),
    ),
  ).toBeVisible();
  // Stored: a reload reads them back
  await page.reload();
  await expect(search).toHaveAttribute("value", "fake-web-2");
  await expect(fetch).toHaveAttribute("value", "fake-web");
  await expect(defaults.getByText(pd.noneHint.replace("{point}", pd.points.webFetch))).toHaveCount(
    0,
  );

  // 3. The agent's Tools section lists both web tools, not checked by default; select WebFetch
  await newAgent(page, "Web agent");
  await openAgentSection(page, "tools");
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
  await saveSection(page);

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
