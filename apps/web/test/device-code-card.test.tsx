import { cleanup, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DeviceCodeCard } from "../src/components/DeviceCodeCard";
import { renderPage } from "./support/render";

/**
 * The `gh auth login --web` device-code card (auto mode spec §6, P-D13): the URL as an open link,
 * the one-time code as a CopyField (the code line with its copy button). The render test lives here because
 * `timeline.test.ts` runs in the node project; it asserts the entry the card is built from.
 */

afterEach(cleanup);

const URL = "https://github.com/login/device";
const CODE = "1A2B-C3D4";

describe("DeviceCodeCard", () => {
  it("renders the URL as an open link, the code in a code line and a copy button", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    try {
      renderPage(<DeviceCodeCard url={URL} code={CODE} />);
      expect(screen.getByText("Sign in to GitHub")).toBeTruthy();
      // the URL is a link (target of the card's "open" action)
      const link = screen.getByRole("link", { name: URL });
      expect(link.getAttribute("href")).toBe(URL);
      // the code is in the code line (`<code>`), named by its label, never plain prose
      const field = screen.getByRole("group", { name: "One-time code" });
      expect(field.querySelector("code")?.textContent).toBe(CODE);
      await userEvent.click(screen.getByRole("button", { name: "Copy" }));
      expect(writeText).toHaveBeenCalledWith(CODE);
      expect(await screen.findByRole("button", { name: "Copied" })).toBeTruthy();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("without a clipboard the code is selected and a line says to copy it by hand", async () => {
    vi.stubGlobal("navigator", { ...navigator, clipboard: undefined });
    try {
      renderPage(<DeviceCodeCard url={URL} code={CODE} />);
      await userEvent.click(screen.getByRole("button", { name: "Copy" }));
      expect(await screen.findByText(/press Ctrl\+C/)).toBeTruthy();
      expect(window.getSelection()?.toString()).toBe(CODE);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
