import type { Locator } from "@playwright/test";

/**
 * Picks an option of the design `Select` (a `combobox` button opening a `listbox`) the way a
 * person does; it replaces Playwright's `selectOption`, which only drives a native select. An
 * option is named by its value (`data-value`) or, as `{ label }`, by its text.
 */
export async function selectOption(combobox: Locator, option: string | { label: string }) {
  await combobox.click();
  const listbox = combobox.page().getByRole("listbox");
  const item =
    typeof option === "string"
      ? listbox.locator(`[role="option"][data-value="${option.replaceAll('"', '\\"')}"]`)
      : listbox.getByRole("option", { name: option.label, exact: true });
  await item.click();
}
