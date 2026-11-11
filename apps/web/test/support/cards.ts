import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

/** The ⋯ trigger's name in each UI locale (the design package's 更多操作). */
export const MORE = { zh: "更多操作", en: "More actions" } as const;

/**
 * A card's foot controls by accessible name, in order: its primary, a lone menu item drawn as a
 * button, the ⋯ trigger.
 */
export const footControls = (card: HTMLElement): string[] =>
  Array.from(
    card.querySelectorAll<HTMLElement>(
      '[data-part="object-card-foot"] button, [data-part="object-card-foot"] a',
    ),
  ).map((el) => el.getAttribute("aria-label") ?? el.textContent ?? "");

/** Opens a card's ⋯ menu and returns its items (the menu stays open). */
export async function openCardMenu(card: HTMLElement, more: string = MORE.en) {
  await userEvent.setup().click(within(card).getByRole("button", { name: more }));
  return screen.findAllByRole("menuitem");
}

/** A card's ⋯ menu items by label (opens the menu, reads it, closes it with Escape). */
export async function cardMenuLabels(card: HTMLElement, more: string = MORE.en) {
  const items = (await openCardMenu(card, more)).map((i) => i.textContent ?? "");
  await userEvent.setup().keyboard("{Escape}");
  return items;
}

/** The card named `name` in the card list named `list`. */
export async function findCard(list: string, name: string): Promise<HTMLElement> {
  const grid = await screen.findByRole("list", { name: list });
  const card = within(grid)
    .getAllByRole("listitem")
    .find((li) => within(li).queryByText(name, { exact: true }) !== null);
  if (card === undefined) throw new Error(`no card ${name}`);
  return card as HTMLElement;
}
