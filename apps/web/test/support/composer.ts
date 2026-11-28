/**
 * Driving the composer's editor from a page test (composer inline tokens spec §2): the editor is a
 * Lexical content editable, which jsdom cannot type into, so text goes in through the design's
 * test drivers (`@capybara-hq/design/testing`) as keystrokes would; keys go to the text box as
 * DOM key events.
 */
import {
  backspaceInComposer,
  composerSegments,
  composerText,
  flushComposer,
  focusComposerEnd,
  typeInComposer,
} from "@capybara-hq/design/testing";
import { fireEvent, screen } from "@testing-library/react";

const NAME = /^(消息|Message)$/;

/** The composer's text box: a combobox while it hosts its menu, a text box otherwise. */
export function composerBox(): HTMLElement {
  return (screen.queryByRole("combobox", { name: NAME, hidden: true }) ??
    screen.getByRole("textbox", { name: NAME, hidden: true })) as HTMLElement;
}

/** The text box once it is drawn. */
export async function findComposerBox(): Promise<HTMLElement> {
  return (await screen.findByRole("combobox", { name: NAME, hidden: true })) as HTMLElement;
}

/** Types `text` at the caret (focusing the text box at its end first when it has no focus). */
export function typeComposer(text: string, box: HTMLElement = composerBox()): void {
  if (!box.contains(document.activeElement)) focusComposerEnd(box);
  typeInComposer(box, text);
}

/** The draft as the person reads it (tokens by their labels). */
export const draftText = (box: HTMLElement = composerBox()): string => composerText(box);

/** The draft's text runs and tokens. */
export const draftSegments = (box: HTMLElement = composerBox()) => composerSegments(box);

/** One key on the text box (↵, Esc, the arrows): the menu's keys come first. */
export function pressComposer(
  key: string,
  init: { shiftKey?: boolean; metaKey?: boolean; ctrlKey?: boolean } = {},
  box: HTMLElement = composerBox(),
): void {
  if (!box.contains(document.activeElement)) focusComposerEnd(box);
  fireEvent.keyDown(box, { key, ...init });
}

/** Types `text` and presses ↵. */
export function sendComposer(text = "", box: HTMLElement = composerBox()): void {
  if (text !== "") typeComposer(text, box);
  pressComposer("Enter", {}, box);
}

/** Backspace before the caret. */
export function backspaceComposer(box: HTMLElement = composerBox()): void {
  if (!box.contains(document.activeElement)) focusComposerEnd(box);
  backspaceInComposer(box);
}

/** A clipboard holding `data` (by type) and `files`, for `fireEvent.paste`. */
export function clipboard(data: Record<string, string> = {}, files: File[] = []) {
  const store: Record<string, string> = { ...data };
  return {
    files,
    items: files.map((f) => ({ kind: "file", type: f.type, getAsFile: () => f })),
    types: [...Object.keys(store), ...(files.length > 0 ? ["Files"] : [])],
    getData: (k: string) => store[k] ?? "",
    setData: (k: string, v: string) => {
      store[k] = v;
    },
  };
}

/** Pastes plain text (or files) into the text box. */
export function pasteComposer(
  text: string,
  files: File[] = [],
  box: HTMLElement = composerBox(),
): void {
  // the paste lands at the caret Lexical reads from the DOM: put it at the end first
  focusComposerEnd(box);
  fireEvent.paste(box, {
    clipboardData: clipboard(text === "" ? {} : { "text/plain": text }, files),
  });
  flushComposer(box);
}

/** The draft's inline tokens as drawn (each `role="img"` named "<kind>: <label>"). */
export const composerTokens = (box: HTMLElement = composerBox()): HTMLElement[] => [
  ...box.querySelectorAll<HTMLElement>('[data-part="inline-token"]'),
];
