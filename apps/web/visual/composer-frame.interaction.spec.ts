import { expect, type Locator, type Page, test } from "@playwright/test";
import { openInteractive } from "./reference-page";

/**
 * The composer frame's even inset and the place tray (spec §6.16.2, maintainer review
 * 2026-11-28), measured in the browser on the `/dev/ui/reference/composer` blocks: every corner
 * object sits space.2 (8) from both edges of the field it touches, the text starts 16 in, the
 * tray shows above the field, which overlaps it by radius.md (8), and on a phone send is 6 from
 * the pill's end and bottom edges (concentric with its round end).
 */
const block = (page: Page, id: string) => page.locator(`[data-ref-block="composer-${id}"]`);

async function box(l: Locator) {
  const b = await l.boundingBox();
  if (!b) throw new Error("no box");
  return { left: b.x, top: b.y, right: b.x + b.width, bottom: b.y + b.height };
}

/** The field's padding box: its border box less the 1px border. */
async function inner(field: Locator) {
  const b = await box(field);
  return { left: b.left + 1, top: b.top + 1, right: b.right - 1, bottom: b.bottom - 1 };
}

test("1280: the corner controls sit 8 from the field's edges and the text starts 16 in", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await openInteractive(page, "/dev/ui/reference/composer");
  const b = block(page, "place");
  const field = await inner(b.locator('[data-part="composer-field"]'));
  const attach = await box(b.getByRole("button", { name: "添加附件" }));
  const send = await box(b.locator('[data-part="send"]'));
  const editor = await box(b.locator('[data-part="composer-editor"]'));
  expect(attach.left - field.left).toBeCloseTo(8, 0);
  expect(field.bottom - attach.bottom).toBeCloseTo(8, 0);
  expect(field.right - send.right).toBeCloseTo(8, 0);
  expect(field.bottom - send.bottom).toBeCloseTo(8, 0);
  expect(editor.left - field.left).toBeCloseTo(16, 0);
  // the field's padding (8) and the text's own space.1 above it
  expect(editor.top - field.top).toBeCloseTo(12, 0);
});

test("1280: the tray sits above the field, overlapped by 8, its device picker 8 in", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await openInteractive(page, "/dev/ui/reference/composer");
  const b = block(page, "place");
  const tray = await box(b.locator('[data-part="composer-place"]'));
  const field = await box(b.locator('[data-part="composer-field"]'));
  const device = await box(
    b.locator('[data-part="composer-place-full"]').getByRole("button").first(),
  );
  // a sibling as wide as the field, above it; the field covers its lower 8
  expect(tray.left).toBeCloseTo(field.left, 0);
  expect(tray.right).toBeCloseTo(field.right, 0);
  expect(tray.bottom - field.top).toBeCloseTo(8, 0);
  // the device picker: 8 from the tray's start and top, and from the field's top edge
  expect(device.left - tray.left).toBeCloseTo(8, 0);
  expect(device.top - tray.top).toBeCloseTo(8, 0);
  expect(field.top - device.bottom).toBeCloseTo(8, 0);
});

test("1280: the attachment strip takes the field's top start corner", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await openInteractive(page, "/dev/ui/reference/composer");
  const b = block(page, "attachments");
  const field = await inner(b.locator('[data-part="composer-field"]'));
  const strip = await box(b.locator(".cb-attachment-strip"));
  expect(strip.left - field.left).toBeCloseTo(8, 0);
  expect(strip.top - field.top).toBeCloseTo(8, 0);
});

test("390: send is 6 from the pill's end and bottom edges", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openInteractive(page, "/dev/ui/reference/composer");
  const b = block(page, "compact-place");
  const pill = await box(b.locator('[data-part="composer-box"]'));
  const send = await box(b.locator('[data-part="send"]'));
  expect(pill.right - send.right).toBeCloseTo(6, 0);
  expect(pill.bottom - send.bottom).toBeCloseTo(6, 0);
  // no tray: the strip has no ground of its own on the chip row
  const ground = await b
    .locator('[data-part="composer-place"]')
    .evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(ground).toBe("rgba(0, 0, 0, 0)");
});
