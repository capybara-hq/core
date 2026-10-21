import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";

/** 界面文案取自 zh 文案文件，避免与实现重复硬编码。 */
const zh = JSON.parse(
  readFileSync(new URL("../messages/zh.json", import.meta.url), "utf8"),
) as typeof import("../messages/zh.json");

const LOGIN = "admin";
const PASSWORD = "correct-horse-battery";

/**
 * 假 IM 平台（测试工具包的源码，按路径加载，不作为 apps/web 的包依赖）。在 worker 进程里起：
 * 用例要调用它的 `push()` 推入站消息、读 `sent` 断言机器人发了什么，所以不能放在 global-setup 的进程里。
 */
const fakeChannelModule = fileURLToPath(
  new URL("../../../packages/testing/src/fake-channel.ts", import.meta.url),
);

type InboundEvent = Record<string, unknown>;
interface Sent {
  appId: string;
  target: { chatId: string };
  message: { text: string; cards?: { kind?: string; url?: string }[] };
}
/** 用到的 `startFakeChannelServer` 子集（类型在这里声明，不 import 测试工具包）。 */
interface FakeChannelServer {
  url: string;
  sent: Sent[];
  active(connectionId: string): unknown[];
  push(connectionId: string, event: InboundEvent): number;
  book(key: string): { url: string };
  finalText(s: Sent): string;
  stop(): Promise<void>;
}
interface FakeChannelModule {
  startFakeChannelServer(): Promise<FakeChannelServer>;
  fakeDm(messageId: string, externalId: string, text: string): InboundEvent;
}

let mod: FakeChannelModule;
let im: FakeChannelServer;

test.beforeAll(async () => {
  mod = (await import(fakeChannelModule)) as FakeChannelModule;
  im = await mod.startFakeChannelServer();
});
test.afterAll(async () => {
  await im?.stop();
});

/** 登录并选中组织 Acme（与其他用例共用一个内核：若尚未初始化则走初始化向导）。 */
async function signIn(page: Page) {
  await page.goto("/zh");
  const setupButton = page.getByRole("button", { name: zh.setup.submit });
  const loginButton = page.getByRole("button", { name: zh.login.submit, exact: true });
  await expect(setupButton.or(loginButton)).toBeVisible();
  if (await setupButton.isVisible()) {
    await page.getByLabel(zh.setup.loginLabel).fill(LOGIN);
    await page.getByLabel(zh.setup.passwordLabel).fill(PASSWORD);
    await page.getByLabel(zh.setup.displayNameLabel).fill("Admin");
    await page.getByLabel(zh.setup.orgNameLabel).fill("Acme");
    await page.getByRole("button", { name: zh.setup.submit }).click();
  } else {
    await page.getByLabel(zh.login.loginLabel).fill(LOGIN);
    await page.getByLabel(zh.login.passwordLabel).fill(PASSWORD);
    await page.getByRole("button", { name: zh.login.submit, exact: true }).click();
  }
  await expect(page).toHaveURL(/\/zh$/);
  await page.getByRole("combobox", { name: zh.home.currentOrg }).selectOption({ label: "Acme" });
}

const sentTo = (chatId: string) => im.sent.filter((s) => s.target.chatId === chatId);

test("假渠道：启用插件 → 建渠道连接 → IM 里未绑定的人收到绑定链接 → 登录后确认绑定 → 对话", async ({
  page,
  browser,
}) => {
  await signIn(page);

  // 1. 组织插件：先填组织级配置（通讯录地址），再启用；权限清单里工具与密钥被标为敏感
  await page.goto("/zh/settings/plugins");
  await expect(page.locator('[data-template="SettingsPage"]')).toBeVisible();
  const section = page.getByRole("region", { name: "fake-im", exact: true });
  const perms = section.getByRole("region", {
    name: zh.plugins.permissionsLabel.replace("{plugin}", "fake-im"),
  });
  await expect(perms.getByText("· post_announcement")).toBeVisible();
  await section.getByRole("textbox", { name: /^url/ }).fill(im.book("acme").url);
  await section
    .getByRole("button", { name: zh.plugins.saveLabel.replace("{plugin}", "fake-im") })
    .click();
  await expect(page.getByText(zh.plugins.configSaved.replace("{plugin}", "fake-im"))).toBeVisible();
  const enable = section.getByRole("switch", {
    name: zh.plugins.enableLabel.replace("{plugin}", "fake-im"),
  });
  await enable.click();
  await expect(enable).toHaveAttribute("aria-checked", "true");

  // 2. 新建一个 agent（model-fake）
  await page.goto("/zh/agents/new");
  await page.getByRole("textbox", { name: zh.agents.form.nameLabel, exact: true }).fill("IM agent");
  await page
    .getByRole("combobox", { name: zh.agents.form.modelLabel, exact: true })
    .selectOption("model-fake/fake-1");
  await page.getByRole("button", { name: zh.agents.form.submit }).click();
  await expect(page).toHaveURL(/\/zh\/agents$/);

  // 3. 渠道（管理员可见的一级导航）→ 新建连接
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("link", { name: zh.nav.channels })
    .click();
  await expect(page).toHaveURL(/\/zh\/channels$/);
  await page.getByRole("link", { name: zh.channels.new }).click();
  await expect(page.locator('[data-template="FormPage"]')).toBeVisible();
  const f = zh.channels.form;
  await page
    .getByRole("combobox", { name: new RegExp(`^${f.pluginLabel}`) })
    .selectOption("fake-im");
  await page.getByRole("textbox", { name: new RegExp(`^${f.nameLabel}`) }).fill("E2E Bot");
  await page.getByRole("textbox", { name: /^platformUrl/ }).fill(im.url);
  await page.getByRole("textbox", { name: /^appId/ }).fill("cli_e2e");
  await page.getByLabel(/^appSecret/).fill("e2e-app-secret-1234");
  await page
    .getByRole("combobox", { name: new RegExp(`^${f.agentLabel}`) })
    .selectOption({ label: "IM agent" });
  await page.getByRole("button", { name: f.submit }).click();
  await expect(page).toHaveURL(/\/zh\/channels\/[^/]+$/);
  await expect(page.locator('[data-template="DetailPage"]')).toBeVisible();
  const connId = new URL(page.url()).pathname.split("/").pop() as string;
  // 密钥不回显
  await expect(page.getByText("e2e-app-secret-1234")).toHaveCount(0);

  // 4. 长连接连上后，未绑定的人私聊机器人 → 收到绑定卡片（链接指向 Web 层的绑定确认页）
  await expect.poll(() => im.active(connId).length, { timeout: 30_000 }).toBeGreaterThan(0);
  expect(im.push(connId, mod.fakeDm("e2e-1", "u-e2e", "hello"))).toBe(1);
  await expect.poll(() => sentTo("dm-u-e2e").length, { timeout: 30_000 }).toBeGreaterThan(0);
  const card = sentTo("dm-u-e2e")[0]?.message.cards?.[0];
  expect(card?.kind).toBe("bind");
  const bindUrl = String(card?.url);
  expect(bindUrl).toMatch(/\/bind\/cap_bind_/);

  // 5. 没登录的浏览器打开链接 → 登录页（带回跳）→ 登录后回到确认页 → 确认绑定
  const context = await browser.newContext({ locale: "zh-CN" });
  const visitor = await context.newPage();
  await visitor.goto(bindUrl);
  await expect(visitor).toHaveURL(/\/login\?returnTo=/);
  await visitor.getByLabel(zh.login.loginLabel).fill(LOGIN);
  await visitor.getByLabel(zh.login.passwordLabel).fill(PASSWORD);
  await visitor.getByRole("button", { name: zh.login.submit, exact: true }).click();
  await expect(visitor).toHaveURL(/\/bind\/cap_bind_/);
  await expect(visitor.locator('[data-template="AuthPage"]')).toBeVisible();
  // IM 身份没有显示名时以账号 ID 作标题
  await expect(visitor.getByRole("heading", { name: "u-e2e" })).toBeVisible();
  await expect(visitor.getByRole("note")).toContainText(zh.bind.warning);
  await visitor.getByRole("button", { name: zh.bind.confirm }).click();
  await expect(visitor.getByText(zh.bind.doneTitle)).toBeVisible();

  // 6. 已绑定：私聊得到 agent 的回复
  const before = sentTo("dm-u-e2e").length;
  expect(im.push(connId, mod.fakeDm("e2e-2", "u-e2e", "echo:hello from IM"))).toBe(1);
  await expect
    .poll(
      () => {
        const reply = sentTo("dm-u-e2e")[before];
        return reply === undefined ? "" : im.finalText(reply);
      },
      { timeout: 60_000 },
    )
    .toBe("hello from IM");

  // 7. 个人设置里能看到这条已绑定的 IM 身份
  await visitor.goto("/zh/settings/identities");
  await expect(visitor.getByRole("row").filter({ hasText: "u-e2e" })).toBeVisible();
  await context.close();
});
