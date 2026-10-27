import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import {
  composer,
  createAgent,
  currentOrg,
  designZh,
  openConversation,
  replies,
  users,
  zh,
} from "./support/chat";
import { signIn } from "./support/sign-in";

/** Signs in, creates a fake-1 agent and an empty conversation, and opens it. */
async function openChat(page: Page, agentName: string) {
  await signIn(page);
  const orgId = await currentOrg(page);
  const agentId = await createAgent(page, orgId, agentName);
  await openConversation(page, orgId, agentId);
}

/** The draft's files (the composer's attachment strip). */
const draftFiles = (page: Page) => page.getByRole("group", { name: zh.chat.files });
const sendButton = (page: Page) =>
  page.getByRole("button", { name: designZh("composer.send"), exact: true });

/**
 * 测试工具包的媒体样本（按路径加载源码，与 global-setup 加载假服务一样，不作为 apps/web 的包依赖）。
 */
const mediaSamples = fileURLToPath(
  new URL("../../../packages/testing/src/media-samples.ts", import.meta.url),
);

async function redPng(): Promise<Buffer> {
  const { solidPngBase64 } = (await import(mediaSamples)) as {
    solidPngBase64: (rgb: [number, number, number], size?: number) => string;
  };
  return Buffer.from(solidPngBase64([255, 0, 0], 32), "base64");
}

test("上传 PNG（＋ 按钮）：进度后就绪、随消息发送；时间线显示缩略图，模型收到 image 块", async ({
  page,
}) => {
  await openChat(page, "Vision agent");
  const png = await redPng();
  // ＋ opens the hidden file input
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: designZh("composer.attach") }).click();
  await (await chooser).setFiles({ name: "red.png", mimeType: "image/png", buffer: png });
  const files = draftFiles(page);
  await expect(files.getByRole("img", { name: "red.png" })).toBeVisible();
  // 直传到 S3（跨源）并 finalize 后进度条消失、可以发送
  await expect(files.getByRole("progressbar")).toHaveCount(0);
  await expect(files.getByRole("alert")).toHaveCount(0);

  await composer(page).fill("media:");
  await expect(sendButton(page)).toBeEnabled();
  await composer(page).press("Enter");

  // 发送后输入框的文件清空；时间线里的用户消息显示缩略图，图片经 download 302 加载成功
  await expect(files).toHaveCount(0);
  const user = page.locator('[data-entry="user"]').filter({ hasText: "media:" });
  const thumb = user.getByRole("button", { name: "red.png" }).locator("img");
  await expect(thumb).toBeVisible();
  await expect(thumb).toHaveAttribute(
    "src",
    /\/api\/v1\/orgs\/[^/]+\/attachments\/[^/]+\/download$/,
  );
  await expect
    .poll(() => thumb.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth))
    .toBe(32);

  // model-fake 的 media: 指令回显它收到的媒体块：是 image 块且带着原字节（不是文字占位）
  await expect(replies(page).last()).toHaveText(
    new RegExp(`Media: image image/png ${png.length} bytes red\\.png`),
  );
});

test("拖入与粘贴文件：同样上传并随消息发送", async ({ page }) => {
  await openChat(page, "Drop agent");
  const text = "hello from a file";
  // Drag a file onto the composer
  await page.locator(".cb-file-drop").evaluate((el, body) => {
    const dt = new DataTransfer();
    dt.items.add(new File([body], "dropped.txt", { type: "text/plain" }));
    for (const type of ["dragenter", "dragover", "drop"]) {
      el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
    }
  }, text);
  const files = draftFiles(page);
  await expect(files.getByText("dropped.txt")).toBeVisible();
  // Paste a file into the textarea
  await composer(page).evaluate((el, body) => {
    const dt = new DataTransfer();
    dt.items.add(new File([body], "pasted.txt", { type: "text/plain" }));
    el.dispatchEvent(
      new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: dt }),
    );
  }, text);
  await expect(files.getByText("pasted.txt")).toBeVisible();
  await expect(files.getByRole("progressbar")).toHaveCount(0);
  await composer(page).fill("media:");
  await composer(page).press("Enter");
  await expect(users(page).filter({ hasText: "media:" })).toHaveCount(1);
  await expect(replies(page).last()).toHaveText(/dropped\.txt/);
  await expect(replies(page).last()).toHaveText(/pasted\.txt/);
});

test("前端拦下不允许的类型：显示与内核错误码一致的文案，不能发送，移除后恢复", async ({ page }) => {
  await openChat(page, "Files agent");
  await page.locator('input[type="file"]').setInputFiles({
    name: "a.zip",
    mimeType: "application/zip",
    buffer: Buffer.from("PK"),
  });
  const files = draftFiles(page);
  // 文案由内核 GET /attachments/limits 返回的类型拼出
  await expect(files.getByRole("alert")).toHaveText(
    zh.chat.fileTypeNotAllowed.replace(
      "{types}",
      "PNG / JPEG / GIF / WebP / PDF / TXT / Markdown / CSV",
    ),
  );
  await composer(page).fill("echo:hi");
  await expect(sendButton(page)).toBeDisabled();
  await files.getByRole("button", { name: "移除 a.zip" }).click();
  await expect(files).toHaveCount(0);
  await expect(sendButton(page)).toBeEnabled();
});
