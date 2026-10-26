import { expect, test } from "@playwright/test";
import { signIn } from "./support/sign-in";

/** 内核要求非安全方法带的 CSRF 头。 */
const CSRF = { "X-Capybara-Csrf": "1" };

/**
 * Embedded apps on the core fake `fake-embed` (embeds `panel` on an org page and `panel-conv` in the
 * conversation panel): the sidebar's Extensions group opens the page in a sandboxed iframe served through the
 * `/plugin-ui` proxy, the host's message bridge hands the iframe its token (`init`), the iframe
 * reads its claims with it through the proxy and its `toast` reaches the host; the token works only
 * on the extension's routes, never on `/api`.
 */
test("嵌入应用（假扩展 fake-embed）：「扩展」打开组织页面（沙箱 iframe、经消息桥拿令牌、经代理校验）；令牌不能调 /api；对话里有面板标签", async ({
  page,
}) => {
  await signIn(page);
  const me = await page.request.get("/api/v1/me");
  const orgId = ((await me.json()) as { currentOrgId: string }).currentOrgId;
  const base = `/api/v1/orgs/${orgId}`;
  const enable = await page.request.put(`${base}/extensions/fake-embed`, {
    headers: CSRF,
    data: { enabled: true },
  });
  expect(enable.status(), await enable.text()).toBe(200);

  // 经同源代理、用嵌入令牌调插件路由（令牌不能调内核 /api）
  const issued = await page.request.post(`${base}/ui/embeds/fake-embed/panel/token`, {
    headers: CSRF,
    data: {},
  });
  expect(issued.status(), await issued.text()).toBe(200);
  const { token, src } = (await issued.json()) as { token: string; src: string };
  expect(src).toBe("/plugin-ui/fake-embed/panel");
  const claims = await page.request.get("/plugin-ui/fake-embed/claims", {
    headers: { authorization: `Bearer ${token}` },
  });
  expect(claims.status(), await claims.text()).toBe(200);
  expect(await claims.json()).toMatchObject({ orgId, plugin: "fake-embed", contribution: "panel" });
  expect(claims.headers()["content-security-policy"]).toContain("frame-ancestors 'self'");
  expect(claims.headers()["set-cookie"]).toBeUndefined();
  const anonymous = await page.request.fetch("/plugin-ui/fake-embed/claims", {
    headers: { cookie: "" },
  });
  expect(anonymous.status()).toBe(401);
  const asApi = await page.request.fetch("/api/v1/me", {
    headers: { authorization: `Bearer ${token}`, cookie: "" },
  });
  expect(asApi.status()).toBe(401);

  // ---- sidebar Extensions → 面板 ----
  await page.goto("/zh");
  // The sidebar's Extensions group lists the page by its title
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("link", { name: "面板", exact: true })
    .click();
  await expect(page).toHaveURL(/\/zh\/p\/fake-embed\/panel$/);
  const iframe = page.locator('iframe[title="面板"]');
  await expect(iframe).toHaveAttribute("sandbox", "allow-scripts allow-forms");
  await expect(iframe).toHaveAttribute("src", src);
  const panel = page.frameLocator('iframe[title="面板"]');
  // 页面与脚本经代理加载；iframe 收到 init、带令牌经代理取 claims、插件校验通过
  await expect(panel.locator('body[data-ready="1"]')).toHaveCount(1);
  await expect(panel.locator("#status")).toHaveText(`panel ${orgId}`);
  // iframe 发来的提示由外层显示
  await expect(page.getByText("fake-embed ready")).toBeVisible();

  // ---- 对话右侧的面板标签（panel-conv） ----
  const agent = await page.request.post(`${base}/agents`, {
    headers: CSRF,
    data: {
      definition: {
        name: "Embedder",
        instructions: "Help with the panel.",
        model: { provider: "model-fake", model: "fake-1" },
        tools: [],
      },
      visibility: "private",
    },
  });
  expect(agent.status(), await agent.text()).toBe(201);
  const agentId = ((await agent.json()) as { agent: { id: string } }).agent.id;
  const conv = await page.request.post(`${base}/conversations`, {
    headers: CSRF,
    data: { agentId },
  });
  expect(conv.status(), await conv.text()).toBe(201);
  const convId = ((await conv.json()) as { conversation: { id: string } }).conversation.id;

  await page.goto(`/zh/chat/${convId}`);
  const side = page.getByRole("complementary");
  const tab = side.getByRole("tab", { name: "面板" });
  await expect(tab).toBeVisible();
  await tab.click();
  const convFrame = side.locator('iframe[title="面板"]');
  await expect(convFrame).toHaveAttribute("sandbox", "allow-scripts allow-forms");
  await expect(convFrame).toHaveAttribute("src", "/plugin-ui/fake-embed/panel-conv");
  // 对话嵌入的令牌带这个对话：claims 的 contribution 是 panel-conv
  await expect(side.frameLocator('iframe[title="面板"]').locator("#status")).toHaveText(
    `panel-conv ${orgId}`,
  );
});
