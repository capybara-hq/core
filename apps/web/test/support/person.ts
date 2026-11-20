/** The avatar `src` inside the first person display of an element, null when it draws an initial. */
export function personAvatarSrc(el: HTMLElement): string | null {
  return el.querySelector('[data-part="person-name"] img')?.getAttribute("src") ?? null;
}

/** The initial a person display draws when it has no avatar image, null when it shows an image. */
export function personInitial(el: HTMLElement): string | null {
  const a = el.querySelector('[data-part="person-name"] [data-part="avatar"][data-kind="initial"]');
  return a?.textContent ?? null;
}
