import { cleanup, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { DesignProvider, Disclosure } from "../src/index";

afterEach(cleanup);

const wrap = (ui: React.ReactElement) => render(<DesignProvider locale="en">{ui}</DesignProvider>);

describe("Disclosure", () => {
  it("is closed by default, toggles on click and reports aria-expanded", async () => {
    wrap(
      <Disclosure summary="License">
        <p>MIT License</p>
      </Disclosure>,
    );
    const button = screen.getByRole("button", { name: /License/ });
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("MIT License")).toBeNull();
    await userEvent.click(button);
    expect(button.getAttribute("aria-expanded")).toBe("true");
    const body = screen.getByText("MIT License");
    // the button names the region it controls
    expect(button.getAttribute("aria-controls")).toBe(body.parentElement?.id);
    await userEvent.click(button);
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("MIT License")).toBeNull();
  });

  it("opens with defaultOpen and toggles from the keyboard", async () => {
    wrap(
      <Disclosure summary="Skills" defaultOpen>
        <span>body</span>
      </Disclosure>,
    );
    const button = screen.getByRole("button", { name: /Skills/ });
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("body")).toBeTruthy();
    button.focus();
    await userEvent.keyboard("{Enter}");
    expect(button.getAttribute("aria-expanded")).toBe("false");
    await userEvent.keyboard(" ");
    expect(button.getAttribute("aria-expanded")).toBe("true");
  });

  it("shows ▸ closed and ▾ open, hidden from screen readers", async () => {
    wrap(<Disclosure summary="More">x</Disclosure>);
    const button = screen.getByRole("button", { name: "More" });
    expect(button.textContent).toContain("▸");
    await userEvent.click(button);
    expect(button.textContent).toContain("▾");
  });
});
