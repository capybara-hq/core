import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type ReactElement, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ComposerBox, DesignProvider, ModeMenu, type ModeMenuProps, nextMode } from "../src/index";
import { findNestedBoxes } from "../src/reference";

/**
 * The composer's mode menu (spec §6.16.3a): one button with the current profile's icon and label,
 * a menu with the profiles (described rows), the effort as segments under a hairline, a Shift+Tab
 * hint in its head; arrows, Enter and Escape work and focus returns to the button.
 */
const wrap = (ui: ReactElement) => render(<DesignProvider locale="en">{ui}</DesignProvider>);
afterEach(cleanup);

const MODES = [
  { id: "request", label: "Request approval", icon: "hand", description: "Asks you." },
  { id: "approve", label: "Approve for me", icon: "shield-check", description: "Review model." },
  { id: "full", label: "Full access", icon: "lock-open", description: "No asking." },
] as const;

function Harness(p: {
  onMode?: (id: string) => void;
  onEffort?: (id: string) => void;
  effort?: boolean;
  locked?: string;
  fullDisabled?: boolean;
}) {
  const [mode, setMode] = useState("approve");
  const [effort, setEffort] = useState("high");
  const props: ModeMenuProps = {
    label: "Permissions",
    hint: "⇧Tab to switch",
    modes: MODES.map((m) => ({
      ...m,
      checked: m.id === mode,
      ...(p.fullDisabled && m.id === "full"
        ? { disabled: true, tag: "Choose a device first" }
        : {}),
    })),
    onPickMode: (id) => {
      p.onMode?.(id);
      setMode(id);
    },
    ...(p.locked !== undefined ? { locked: p.locked } : {}),
    ...(p.effort !== false
      ? {
          effort: {
            label: "Effort",
            items: ["low", "medium", "high"].map((id) => ({
              id,
              label: id[0]?.toUpperCase() + id.slice(1),
              checked: id === effort,
            })),
            onPick: (id: string) => {
              p.onEffort?.(id);
              setEffort(id);
            },
          },
        }
      : {}),
  };
  return <ModeMenu {...props} />;
}

describe("ModeMenu", () => {
  it("shows the current profile on its button and lists the profiles, the hint and the effort", async () => {
    const user = userEvent.setup();
    wrap(<Harness />);
    const button = screen.getByRole("button", {
      name: "Permissions: Approve for me: Effort High",
    });
    expect(button.querySelector('[data-icon="shield-check"]')).not.toBeNull();
    await user.click(button);
    const menu = screen.getByRole("menu");
    expect(within(menu).getByText("⇧Tab to switch")).toBeTruthy();
    const modes = within(menu)
      .getAllByRole("menuitemradio")
      .filter((el) => el.getAttribute("data-part") === "menu-item");
    expect(modes.map((m) => m.getAttribute("aria-checked"))).toEqual(["false", "true", "false"]);
    // each profile is a described row: named by its label, described by its sentence
    expect(within(menu).getByRole("menuitemradio", { name: "Full access" })).toBeTruthy();
    const effort = within(menu).getByRole("group", { name: "Effort" });
    const segments = within(effort).getAllByRole("menuitemradio");
    expect(segments.map((s) => s.textContent)).toEqual(["Low", "Medium", "High"]);
    expect(segments[2]?.getAttribute("aria-checked")).toBe("true");
    // the effort sits under the scrolling profile list, always in view
    expect(menu.querySelector('[data-part="menu-list"] + .cb-cmenu-segments')).not.toBeNull();
    expect(findNestedBoxes(document.body)).toEqual([]);
  });

  it("picks a profile and closes; picks an effort and stays open", async () => {
    const user = userEvent.setup();
    const onMode = vi.fn();
    const onEffort = vi.fn();
    wrap(<Harness onMode={onMode} onEffort={onEffort} />);
    await user.click(screen.getByRole("button", { name: /^Permissions:/ }));
    await user.click(screen.getByRole("menuitemradio", { name: "Low" }));
    expect(onEffort).toHaveBeenCalledWith("low");
    expect(screen.getByRole("menu")).toBeTruthy();
    expect(screen.getByRole("menuitemradio", { name: "Low" }).getAttribute("aria-checked")).toBe(
      "true",
    );
    await user.click(screen.getByRole("menuitemradio", { name: "Request approval" }));
    expect(onMode).toHaveBeenCalledWith("request");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Permissions: Request approval: Effort Low" }),
    ).toBeTruthy();
  });

  it("works by keyboard: arrows, Enter, ←/→ in the effort, Escape returns focus", async () => {
    const user = userEvent.setup();
    const onMode = vi.fn();
    const onEffort = vi.fn();
    wrap(<Harness onMode={onMode} onEffort={onEffort} />);
    const button = screen.getByRole("button", { name: /^Permissions:/ });
    button.focus();
    await user.keyboard("{Enter}");
    expect(screen.getByRole("menu")).toBeTruthy();
    await user.keyboard("{ArrowDown}{ArrowDown}{ArrowDown}");
    // the three profiles, then the first effort segment
    expect(document.activeElement?.textContent).toBe("Low");
    await user.keyboard("{ArrowRight}");
    expect(document.activeElement?.textContent).toBe("Medium");
    await user.keyboard("{Enter}");
    expect(onEffort).toHaveBeenCalledWith("medium");
    await user.keyboard("{ArrowLeft}");
    expect(document.activeElement?.textContent).toBe("Low");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(button);
    // the menu opens on the first profile
    await user.keyboard("{Enter}{Enter}");
    expect(onMode).toHaveBeenCalledWith("request");
    expect(document.activeElement).toBe(screen.getByRole("button", { name: /^Permissions:/ }));
  });

  it("has no effort without efforts, and a disabled profile names why", async () => {
    const user = userEvent.setup();
    const onMode = vi.fn();
    wrap(<Harness effort={false} fullDisabled onMode={onMode} />);
    await user.click(screen.getByRole("button", { name: "Permissions: Approve for me" }));
    expect(screen.queryByRole("group", { name: "Effort" })).toBeNull();
    const full = screen.getByRole("menuitemradio", { name: /^Full access/ });
    expect(full.getAttribute("aria-disabled")).toBe("true");
    expect(within(full).getByText("Choose a device first")).toBeTruthy();
    await user.click(full);
    expect(onMode).not.toHaveBeenCalled();
  });

  it("locked: every profile is read-only with the reason as the note, the effort still works", async () => {
    const user = userEvent.setup();
    const onEffort = vi.fn();
    wrap(<Harness locked="Follows the main conversation" onEffort={onEffort} />);
    await user.click(screen.getByRole("button", { name: /^Permissions:/ }));
    const menu = screen.getByRole("menu");
    expect(within(menu).queryByText("⇧Tab to switch")).toBeNull();
    expect(within(menu).getByText("Follows the main conversation")).toBeTruthy();
    for (const name of ["Request approval", "Approve for me", "Full access"])
      expect(screen.getByRole("menuitemradio", { name }).getAttribute("aria-disabled")).toBe(
        "true",
      );
    await user.click(screen.getByRole("menuitemradio", { name: "Low" }));
    expect(onEffort).toHaveBeenCalledWith("low");
  });
});

describe("nextMode", () => {
  const modes = MODES.map((m) => ({ ...m }));
  it("moves to the next choosable mode, wrapping and skipping disabled ones", () => {
    expect(nextMode({ modes: modes.map((m) => ({ ...m, checked: m.id === "approve" })) })).toBe(
      "full",
    );
    expect(nextMode({ modes: modes.map((m) => ({ ...m, checked: m.id === "full" })) })).toBe(
      "request",
    );
    expect(
      nextMode({
        modes: modes.map((m) => ({
          ...m,
          checked: m.id === "approve",
          disabled: m.id === "full",
        })),
      }),
    ).toBe("request");
    expect(
      nextMode({ modes: modes.map((m) => ({ ...m, checked: true })), locked: "x" }),
    ).toBeUndefined();
  });
});

describe("ComposerBox with a mode menu", () => {
  function Composer({ onMode = vi.fn() }: { onMode?: (id: string) => void }) {
    const [mode, setMode] = useState("approve");
    return (
      <ComposerBox
        value=""
        onChange={() => {}}
        placeholder="Message"
        onAttach={() => {}}
        pickers={{
          device: { label: "Device", value: "Laptop", groups: [], onPick: () => {} },
          permission: {
            label: "Permissions",
            value: "Approve for me",
            groups: [],
            onPick: () => {},
          },
          model: { label: "Model", value: "gpt-6", groups: [], onPick: () => {} },
          effort: { label: "Effort", value: "High", groups: [], onPick: () => {} },
        }}
        mode={{
          label: "Permissions",
          hint: "⇧Tab to switch",
          modes: MODES.map((m) => ({ ...m, checked: m.id === mode })),
          onPickMode: (id) => {
            onMode(id);
            setMode(id);
          },
          effort: {
            label: "Effort",
            items: [{ id: "high", label: "High", checked: true }],
            onPick: () => {},
          },
        }}
        send={{ mode: "send", onClick: () => {} }}
      />
    );
  }

  it("keeps device and a model · effort chip on the left and the mode button before send", () => {
    wrap(<Composer />);
    const pickers = document.querySelector('[data-part="composer-pickers"]') as HTMLElement;
    expect(
      within(pickers)
        .getAllByRole("button")
        .map((b) => b.getAttribute("aria-label")),
    ).toEqual(["Device: Laptop", "Model: gpt-6 · High"]);
    const bar = document.querySelector('[data-part="composer-bar"]') as HTMLElement;
    const parts = [...bar.querySelectorAll("[data-part]")].map((el) =>
      el.getAttribute("data-part"),
    );
    expect(parts.indexOf("composer-mode")).toBeGreaterThan(parts.indexOf("composer-pickers"));
    expect(parts.indexOf("composer-mode")).toBeLessThan(parts.indexOf("send"));
    expect(
      within(bar).getByRole("button", { name: "Permissions: Approve for me: Effort High" }),
    ).toBeTruthy();
  });

  it("Shift+Tab in the textarea moves to the next profile", () => {
    const onMode = vi.fn();
    wrap(<Composer onMode={onMode} />);
    const input = screen.getByRole("textbox");
    fireEvent.keyDown(input, { key: "Tab", shiftKey: true });
    expect(onMode).toHaveBeenLastCalledWith("full");
    fireEvent.keyDown(input, { key: "Tab", shiftKey: true });
    expect(onMode).toHaveBeenLastCalledWith("request");
    // Tab alone is focus navigation
    fireEvent.keyDown(input, { key: "Tab" });
    expect(onMode).toHaveBeenCalledTimes(2);
  });
});
