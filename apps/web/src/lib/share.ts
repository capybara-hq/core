import type { ShareCapabilityV1 } from "./shell";

/**
 * Shares a link: the shell's system sheet (`share@1`), else the browser's Web Share, else the
 * clipboard. A dismissed Web Share (`AbortError`) counts as shared and copies nothing. Call it
 * from an event handler (the share sheet and the clipboard need a user activation).
 */
export async function shareOrCopy(
  input: { title?: string; text?: string; url: string },
  deps: {
    share?: ShareCapabilityV1 | undefined;
    webShare?: Navigator["share"] | undefined;
    copy(text: string): Promise<void>;
  },
): Promise<"shared" | "copied"> {
  if (deps.share !== undefined) {
    await deps.share.share(input);
    return "shared";
  }
  if (deps.webShare !== undefined) {
    try {
      await deps.webShare(input);
      return "shared";
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") return "shared";
      // not shareable here (NotAllowedError, TypeError): fall back to the clipboard
    }
  }
  await deps.copy(input.url);
  return "copied";
}

/** The browser's Web Share, bound, or `undefined` where there is none. */
export function browserShare(): Navigator["share"] | undefined {
  return typeof navigator !== "undefined" && typeof navigator.share === "function"
    ? navigator.share.bind(navigator)
    : undefined;
}
