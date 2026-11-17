import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { newAgent } from "./support/chat";
import { mainNavLink } from "./support/nav";
import { selectOption } from "./support/select";
import { signIn } from "./support/sign-in";

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

const sentTo = (chatId: string) => im.sent.filter((s) => s.target.chatId === chatId);

test("IM binding: enable fake channel → create connection → sign in and confirm → conversation", async ({
  page,
  browser,
}) => {
  await signIn(page);

  // 1. The org's 扩展 page: fake-im is pending configuration (its switch is read-only); its row opens
  //    a Sheet with the org config form, and 保存并启用 saves the directory URL and switches it on
  await page.goto("/extensions");
  await expect(page.locator('[data-template="ListPage"]')).toBeVisible();
  const row = page.getByRole("row").filter({ hasText: "fake-im" });
  await row.click();
  const sheet = page.getByRole("dialog", { name: "fake-im", exact: true });
  await sheet.getByRole("textbox", { name: /^url/ }).fill(im.book("acme").url);
  await sheet
    .getByRole("button", { name: zh.extensions.saveAndEnableLabel.replace("{plugin}", "fake-im") })
    .click();
  const enable = row.getByRole("switch", {
    name: zh.extensions.enableLabel.replace("{plugin}", "fake-im"),
  });
  await expect(enable).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("Escape");

  // 2. 新建一个 agent（model-fake）
  await newAgent(page, "IM agent");

  // 3. 渠道（管理员可见的一级导航）→ 新建连接
  await (await mainNavLink(page, zh.nav.channels)).click();
  await expect(page).toHaveURL(/\/channels$/);
  await page.getByRole("link", { name: zh.channels.new }).click();
  await expect(page.locator('[data-template="FormPage"]')).toBeVisible();
  const f = zh.channels.form;
  await selectOption(
    page.getByRole("combobox", { name: new RegExp(`^${f.pluginLabel}`) }),
    "fake-im",
  );
  await page.getByRole("textbox", { name: new RegExp(`^${f.nameLabel}`) }).fill("E2E Bot");
  await page.getByRole("textbox", { name: /^platformUrl/ }).fill(im.url);
  await page.getByRole("textbox", { name: /^appId/ }).fill("cli_e2e");
  await page.getByLabel(/^appSecret/).fill("e2e-app-secret-1234");
  await selectOption(page.getByRole("combobox", { name: new RegExp(`^${f.agentLabel}`) }), {
    label: "IM agent",
  });
  await page.getByRole("button", { name: f.submit }).click();
  await expect(page).toHaveURL(/\/channels\/[^/]+$/);
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

  // 5. A signed-out browser signs in and returns to the server-rendered binding page.
  const context = await browser.newContext({ locale: "zh-CN" });
  const visitor = await context.newPage();
  await visitor.goto(bindUrl);
  await expect(visitor).toHaveURL(/\/login\?returnTo=/);
  await visitor.getByLabel(zh.login.loginLabel).fill(LOGIN);
  await visitor.getByLabel(zh.login.passwordLabel).fill(PASSWORD);
  let releaseScripts!: () => void;
  const scripts = new Promise<void>((resolve) => {
    releaseScripts = resolve;
  });
  let confirmationPosts = 0;
  visitor.on("request", (request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname.startsWith("/api/v1/bind/"))
      confirmationPosts++;
  });
  // Hold the new document's scripts so SSR controls cannot race their client handlers.
  await visitor.route("**/_next/static/**/*.js", async (route) => {
    await scripts;
    await route.continue();
  });
  const confirm = visitor.getByRole("button", { name: zh.bind.confirm });
  const cancel = visitor.getByRole("button", { name: zh.bind.cancel });
  try {
    await visitor.getByRole("button", { name: zh.login.submit, exact: true }).click();
    await expect(visitor).toHaveURL(/\/bind\/cap_bind_/);
    await expect(visitor.locator('[data-template="AuthPage"]')).toBeVisible();
    // Without an IM display name, the external account ID is the identity heading.
    await expect(visitor.getByRole("heading", { name: "u-e2e" })).toBeVisible();
    await expect(visitor.getByRole("note")).toContainText(zh.bind.warning);
    await expect(confirm).toBeDisabled();
    await expect(cancel).toBeDisabled();
    expect(confirmationPosts).toBe(0);
  } finally {
    releaseScripts();
    await visitor.unrouteAll({ behavior: "wait" });
  }
  await expect(confirm).toBeEnabled();
  await expect(cancel).toBeEnabled();
  expect(confirmationPosts).toBe(0);
  await confirm.click();
  await expect(visitor.getByText(zh.bind.doneTitle)).toBeVisible();
  expect(confirmationPosts).toBe(1);

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
  await visitor.goto("/account/identities");
  await expect(visitor.getByRole("row").filter({ hasText: "u-e2e" })).toBeVisible();
  await context.close();
});
