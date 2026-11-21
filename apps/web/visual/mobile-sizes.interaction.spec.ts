import { expect, test } from "@playwright/test";
import { findSmallTargets, findTallPadding } from "./mobile-sizes";

/**
 * The mobile size measurements are proven red here (tools/checks/README.md: a check fails on a
 * violating fixture): the desktop button and tab of before 2026-11-22 (28 high, 12 at the sides, a
 * 40 high tab padded 10) and a 28 px text field fail; the mobile sizes pass. Plain HTML, no
 * server: the measurements read only the boxes.
 */
const fixture = (body: string) => `<!doctype html>
<html><head><style>
  body { margin: 40px; font: 15px/20px sans-serif; }
  .cb-btn, .cb-tab, .cb-chip { display: inline-flex; align-items: center; box-sizing: border-box;
    border: 1px solid #888; background: none; font: inherit; margin: 30px; }
  .cb-input { display: flex; border: 1px solid #888; margin: 30px; width: 240px; }
  .cb-input input { border: 0; outline: 0; font: inherit; }
</style></head><body>${body}</body></html>`;

test.use({ viewport: { width: 480, height: 844 } });

test("the desktop sizes fail: small hit boxes and tall padding", async ({ page }) => {
  await page.setContent(
    fixture(`
      <button class="cb-btn" style="height: 28px; padding: 0 12px">开始会话</button>
      <button class="cb-btn" style="height: 44px; padding: 0 8px">开始会话</button>
      <button class="cb-tab" role="tab" style="height: 40px; padding: 0 10px">个人资料</button>
      <div class="cb-input"><input aria-label="名称" style="height: 26px; padding: 0 8px" /></div>
    `),
  );
  const small = await findSmallTargets(page);
  expect(small.out).toHaveLength(3);
  expect(small.out.join("\n")).toContain("28");
  expect(small.out.join("\n")).toContain("名称");
  const tall = await findTallPadding(page);
  expect(tall).toHaveLength(2);
  expect(tall.join("\n")).toContain("inline 8.0");
  expect(tall.join("\n")).toContain("个人资料");
});

test("the mobile sizes pass", async ({ page }) => {
  await page.setContent(
    fixture(`
      <button class="cb-btn" style="height: 44px; padding: 0 16px">开始会话</button>
      <button class="cb-btn cb-icon-btn" aria-label="更多操作" style="width: 44px; height: 44px; padding: 0"><svg width="16" height="16"></svg></button>
      <button class="cb-tab" role="tab" style="height: 44px; padding: 0 16px">个人资料</button>
      <button class="cb-chip" style="height: 44px; padding: 0 16px">全部 <span>12</span></button>
      <div class="cb-input"><input aria-label="名称" style="height: 42px; padding: 0 12px" /></div>
    `),
  );
  expect((await findSmallTargets(page)).out).toEqual([]);
  expect(await findTallPadding(page)).toEqual([]);
});
