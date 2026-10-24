import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { ORG_NAME, signIn } from "./support/sign-in";

/** 界面文案取自 zh 文案文件，避免与实现重复硬编码。 */
const zh = JSON.parse(
  readFileSync(new URL("../messages/zh.json", import.meta.url), "utf8"),
) as typeof import("../messages/zh.json");

const M = zh.members;
const fill = (s: string, vars: Record<string, string | number>) =>
  s.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k]));

test("成员页：管理员生成邀请链接 → 新用户凭链接注册加入 → 管理员把他改为访客", async ({
  page,
  browser,
}) => {
  await signIn(page);

  // 组织设置 → 二级导航「成员」
  await page.goto("/zh/settings/organization");
  await page.getByRole("link", { name: zh.connections.nav.members }).click();
  await expect(page).toHaveURL(/\/zh\/settings\/members$/);
  await expect(page.locator('[data-template="ListPage"]')).toBeVisible();

  // 生成邀请（成员、7 天）并取链接
  await page.getByRole("button", { name: M.invite }).click();
  const dialog = page.getByRole("dialog", { name: M.inviteDialog.title });
  await dialog.getByRole("combobox", { name: M.inviteDialog.role }).selectOption("member");
  await dialog.getByRole("button", { name: M.inviteDialog.create }).click();
  const link = await dialog.getByRole("textbox", { name: M.inviteDialog.link }).inputValue();
  expect(link).toMatch(/\/zh\/invite\/cap_inv_/);
  await dialog.getByRole("button", { name: M.inviteDialog.done }).click();
  await expect(dialog).toHaveCount(0);
  await expect(
    page.getByRole("cell", { name: new RegExp(`${M.invitations.status.pending}$`) }),
  ).toBeVisible();

  // 另一个浏览器上下文（没有登录）：打开链接 → 创建账号并加入 → 进入首页，当前组织就是 Acme
  const other = await browser.newContext();
  try {
    const guestPage = await other.newPage();
    await guestPage.goto(link);
    await expect(guestPage.getByText(fill(zh.invite.subtitle, { org: ORG_NAME }))).toBeVisible();
    await guestPage.getByRole("button", { name: zh.invite.signupToggle }).click();
    await guestPage.getByLabel(zh.invite.loginLabel).fill("invitee");
    await guestPage.getByLabel(zh.invite.passwordLabel).fill("invitee-password-123");
    await guestPage.getByLabel(zh.invite.displayNameLabel).fill("Invitee");
    await guestPage.getByRole("button", { name: zh.invite.signup }).click();
    await expect(guestPage).toHaveURL(/\/zh$/);
    await expect
      .poll(async () => {
        const me = await guestPage.request.get("/api/v1/me");
        return me.ok()
          ? ((await me.json()) as { memberships: { name: string; role: string }[] }).memberships
          : [];
      })
      .toEqual([expect.objectContaining({ name: ORG_NAME, role: "member" })]);

    // 链接只能用一次
    const reuse = await other.newPage();
    await reuse.goto(link);
    await expect(reuse.getByText(zh.invite.invalidTitle)).toBeVisible();
  } finally {
    await other.close();
  }

  // 管理员：邀请变成已接受，新成员出现在列表里；把他改为访客
  await page.reload();
  await expect(
    page.getByRole("cell", { name: new RegExp(`${M.invitations.status.accepted}$`) }),
  ).toBeVisible();
  const role = page
    .getByRole("row")
    .filter({ hasText: "Invitee" })
    .getByRole("combobox", { name: fill(M.roleOf, { name: "Invitee" }) });
  await expect(role).toHaveValue("member");
  await role.selectOption("guest");
  await expect(
    page.getByText(fill(M.roleChanged, { name: "Invitee", role: M.roles.guest })),
  ).toBeVisible();
  await page.reload();
  await expect(
    page
      .getByRole("row")
      .filter({ hasText: "Invitee" })
      .getByRole("combobox", { name: fill(M.roleOf, { name: "Invitee" }) }),
  ).toHaveValue("guest");
});
