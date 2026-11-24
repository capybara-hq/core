import { cleanup, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { DesignProvider, Disclosure, DisclosureLink, DisclosureLinks } from "../src/index";

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

  it("shows a chevron icon, right closed and down open, hidden from screen readers", async () => {
    const r = wrap(<Disclosure summary="More">x</Disclosure>);
    const button = screen.getByRole("button", { name: "More" });
    const icon = () => button.querySelector('[data-part="icon"]');
    expect(icon()?.getAttribute("data-icon")).toBe("chevron-right");
    expect(icon()?.getAttribute("aria-hidden")).toBe("true");
    expect(button.textContent).not.toMatch(/[▸▾]/);
    await userEvent.click(button);
    expect(icon()?.getAttribute("data-icon")).toBe("chevron-down");
    r.unmount();
  });

  it("controlled: follows `open` and reports the summary's toggles", async () => {
    const seen: boolean[] = [];
    function Owner() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            force
          </button>
          <Disclosure
            summary="Params"
            open={open}
            onOpenChange={(o) => {
              seen.push(o);
              setOpen(o);
            }}
          >
            <span>fields</span>
          </Disclosure>
        </>
      );
    }
    wrap(<Owner />);
    const summary = screen.getByRole("button", { name: "Params" });
    expect(summary.getAttribute("aria-expanded")).toBe("false");
    // the owner opens it (e.g. an error inside)
    await userEvent.click(screen.getByRole("button", { name: "force" }));
    expect(summary.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("fields")).toBeTruthy();
    await userEvent.click(summary);
    expect(seen).toEqual([false]);
    expect(screen.queryByText("fields")).toBeNull();
  });
});

describe("DisclosureLinks", () => {
  it("draws inline toggles; one open at a time, its body under the row", async () => {
    wrap(
      <DisclosureLinks
        items={[
          { key: "desc", summary: "Full description", children: <p>Long text</p> },
          { key: "lic", summary: "License", children: <p>MIT License</p> },
        ]}
      />,
    );
    const desc = screen.getByRole("button", { name: /Full description/ });
    const lic = screen.getByRole("button", { name: /License/ });
    expect(screen.queryByText("Long text")).toBeNull();
    await userEvent.click(desc);
    expect(desc.getAttribute("aria-expanded")).toBe("true");
    expect(desc.getAttribute("aria-controls")).toBe(
      screen.getByText("Long text").parentElement?.id,
    );
    await userEvent.click(lic);
    expect(desc.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("Long text")).toBeNull();
    expect(screen.getByText("MIT License")).toBeTruthy();
    await userEvent.click(lic);
    expect(screen.queryByText("MIT License")).toBeNull();
  });
});

describe("DisclosureLink", () => {
  it("is one inline muted button with a chevron that calls its owner (no inline body)", async () => {
    let opened = 0;
    wrap(<DisclosureLink onSelect={() => opened++}>Full text</DisclosureLink>);
    const button = screen.getByRole("button", { name: "Full text" });
    expect(button.className).toContain("cb-disclosure-link");
    expect(button.getAttribute("aria-haspopup")).toBe("dialog");
    expect(button.querySelector("svg")).not.toBeNull();
    await userEvent.click(button);
    expect(opened).toBe(1);
  });
});
