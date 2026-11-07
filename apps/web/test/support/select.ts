import { screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";

type User = ReturnType<typeof userEvent.setup>;

/**
 * Drives the design `Select` (a `combobox` button opening a `listbox`) the way a person does:
 * the replacement for `user.selectOptions` on the native select it used to be.
 */
export async function openSelect(combobox: HTMLElement, user: User = userEvent.setup()) {
  if (combobox.getAttribute("aria-expanded") !== "true") await user.click(combobox);
  return screen.findByRole("listbox");
}

/** The option whose value (`data-value`) or label is `valueOrLabel`. */
export function optionOf(listbox: HTMLElement, valueOrLabel: string): HTMLElement {
  const options = within(listbox).getAllByRole("option");
  const found =
    options.find((o) => o.getAttribute("data-value") === valueOrLabel) ??
    options.find((o) => o.textContent === valueOrLabel);
  if (!found) throw new Error(`no option ${JSON.stringify(valueOrLabel)}`);
  return found;
}

/** Opens the select and picks the option by value or label. */
export async function pickOption(
  combobox: HTMLElement,
  valueOrLabel: string,
  user: User = userEvent.setup(),
) {
  const listbox = await openSelect(combobox, user);
  await user.click(optionOf(listbox, valueOrLabel));
}

/** The options' labels (it opens the list and closes it again with Escape). */
export async function optionLabels(combobox: HTMLElement, user: User = userEvent.setup()) {
  const listbox = await openSelect(combobox, user);
  const labels = within(listbox)
    .getAllByRole("option")
    .map((o) => o.textContent ?? "");
  await user.keyboard("{Escape}");
  return labels;
}

/** The options' values, `data-value` (it opens the list and closes it again with Escape). */
export async function optionValues(combobox: HTMLElement, user: User = userEvent.setup()) {
  const listbox = await openSelect(combobox, user);
  const values = within(listbox)
    .getAllByRole("option")
    .map((o) => o.getAttribute("data-value") ?? "");
  await user.keyboard("{Escape}");
  return values;
}

/**
 * The option labels the closed field carries (every label sits in it, only the current one shown,
 * so it is as wide as its widest option): for a first paint, where nothing is clicked.
 */
export function fieldOptionLabels(combobox: HTMLElement): string[] {
  return [...combobox.querySelectorAll(".cb-select-label:not([data-placeholder])")].map(
    (l) => l.textContent ?? "",
  );
}
