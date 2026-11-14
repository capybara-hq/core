import { cleanup, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DeviceCodeCard } from "../src/components/DeviceCodeCard";
import { renderPage } from "./support/render";

/**
 * The `gh auth login --web` device-code card (auto mode spec §6, P-D13): the URL as an open link,
 * the one-time code in mono, and a copy button. The render test lives here because
 * `timeline.test.ts` runs in the node project; it asserts the entry the card is built from.
 */

afterEach(cleanup);

const URL = "https://github.com/login/device";
const CODE = "1A2B-C3D4";

describe("DeviceCodeCard", () => {
  it("renders the URL as an open link, the code in mono and a copy button", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    try {
      renderPage(<DeviceCodeCard url={URL} code={CODE} />);
      expect(screen.getByText("Sign in to GitHub")).toBeTruthy();
      // the URL is a link (target of the card's "open" action)
      const link = screen.getByRole("link", { name: URL });
      expect(link.getAttribute("href")).toBe(URL);
      // the code is mono (`<kbd>`), never plain prose
      const code = screen.getByText(CODE);
      expect(code.tagName).toBe("KBD");
      await userEvent.click(screen.getByRole("button", { name: "Copy code" }));
      expect(writeText).toHaveBeenCalledWith(CODE);
      expect(await screen.findByRole("button", { name: "Copied" })).toBeTruthy();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("without a clipboard the button says to copy by hand", async () => {
    vi.stubGlobal("navigator", { ...navigator, clipboard: undefined });
    try {
      renderPage(<DeviceCodeCard url={URL} code={CODE} />);
      await userEvent.click(screen.getByRole("button", { name: "Copy code" }));
      expect(
        await screen.findByRole("button", { name: "Select the code and copy it" }),
      ).toBeTruthy();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
