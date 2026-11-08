import { waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";

type User = ReturnType<typeof userEvent.setup>;

/**
 * Drives the design `Select` (a `combobox` button opening a `listbox`) the way a person does:
 * the replacement for `user.selectOptions` on the native select it used to be.
 *
 * The listbox and its options are found with selectors, not role queries: a role query computes
 * accessibility for every node it walks, and a time-zone select has about 420 options, which made
 * these helpers CPU-bound and slow under load.
 */
export async function openSelect(combobox: HTMLElement, user: User = userEvent.setup()) {
  if (combobox.getAttribute("aria-expanded") !== "true") await user.click(combobox);
  return waitFor(() => {
    const listbox = document.querySelector<HTMLElement>('[role="listbox"]');
    if (listbox === null) throw new Error("no open listbox");
    return listbox;
  });
}

/** The options of an open listbox. */
const optionsOf = (listbox: HTMLElement): HTMLElement[] => {
  const options = [...listbox.querySelectorAll<HTMLElement>('[role="option"]')];
  if (options.length === 0) throw new Error("the listbox has no options");
  return options;
};

/** The option whose value (`data-value`) or label is `valueOrLabel`. */
export function optionOf(listbox: HTMLElement, valueOrLabel: string): HTMLElement {
  const options = optionsOf(listbox);
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
  const labels = optionsOf(listbox).map((o) => o.textContent ?? "");
  await user.keyboard("{Escape}");
  return labels;
}

/** The options' values, `data-value` (it opens the list and closes it again with Escape). */
export async function optionValues(combobox: HTMLElement, user: User = userEvent.setup()) {
  const listbox = await openSelect(combobox, user);
  const values = optionsOf(listbox).map((o) => o.getAttribute("data-value") ?? "");
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
