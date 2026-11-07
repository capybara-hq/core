import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { type ReactElement, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  Card,
  DesignProvider,
  Field,
  Input,
  Repeater,
  type RepeaterItem,
  ToastProvider,
} from "../src/index";

afterEach(cleanup);

const wrap = (ui: ReactElement, locale: "zh" | "en" = "en") =>
  render(
    <DesignProvider locale={locale}>
      <ToastProvider>{ui}</ToastProvider>
    </DesignProvider>,
  );

const card = (key: string, extra: Partial<RepeaterItem> = {}): RepeaterItem => ({
  key,
  title: key,
  subtitle: `https://${key}.example.com`,
  body: (
    <Field label={`Name ${key}`}>
      <Input defaultValue={key} />
    </Field>
  ),
  ...extra,
});

const base = {
  label: "Endpoints",
  addLabel: "Add endpoint",
  onAdd: () => {},
  onRemove: () => () => {},
};

/** A stateful host: add appends `e<n>`, remove drops the item and its restore puts it back. */
function Host(props: {
  initial: string[];
  presets?: { id: string; label: string; help?: string }[];
  onAdd?: (presetId?: string) => void;
  onMove?: boolean;
  min?: number;
  max?: number;
}) {
  const [keys, setKeys] = useState(props.initial);
  return (
    <Repeater
      label="Endpoints"
      addLabel="Add endpoint"
      items={keys.map((k) => card(k))}
      {...(props.presets ? { presets: props.presets } : {})}
      {...(props.min !== undefined ? { min: props.min } : {})}
      {...(props.max !== undefined ? { max: props.max } : {})}
      onAdd={(presetId) => {
        props.onAdd?.(presetId);
        setKeys((l) => [...l, presetId ?? `e${l.length + 1}`]);
      }}
      onRemove={(key) => {
        const before = keys;
        setKeys((l) => l.filter((k) => k !== key));
        return () => setKeys(before);
      }}
      {...(props.onMove
        ? {
            onMove: (key: string, to: number) =>
              setKeys((l) => {
                const rest = l.filter((k) => k !== key);
                rest.splice(to, 0, key);
                return rest;
              }),
          }
        : {})}
    />
  );
}

const order = () =>
  screen.getAllByRole("group").filter((g) => g.getAttribute("data-part") === "repeater-item");

describe("Repeater (spec §6.26)", () => {
  it("is a labelled group of item cards, each a group named by its title, with the subtitle", () => {
    wrap(<Repeater {...base} items={[card("deepseek"), card("qwen")]} />);
    const group = screen.getByRole("group", { name: "Endpoints" });
    expect(within(group).getByRole("list")).toBeTruthy();
    const item = screen.getByRole("group", { name: "deepseek" });
    expect(item.getAttribute("data-part")).toBe("repeater-item");
    expect(within(item).getByText("https://deepseek.example.com")).toBeTruthy();
    expect(within(item).getByRole("textbox", { name: "Name deepseek" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Remove deepseek" })).toBeTruthy();
  });

  it("without presets the footer is one add button; with presets a menu of presets plus Blank", async () => {
    const onAdd = vi.fn();
    wrap(<Repeater {...base} items={[]} onAdd={onAdd} />);
    await userEvent.click(screen.getByRole("button", { name: "Add endpoint" }));
    expect(onAdd).toHaveBeenCalledWith(undefined);
    cleanup();

    const onPreset = vi.fn();
    wrap(
      <Repeater
        {...base}
        items={[]}
        onAdd={onPreset}
        presets={[
          { id: "deepseek", label: "DeepSeek", help: "Official API" },
          { id: "qwen", label: "Qwen" },
        ]}
      />,
    );
    const trigger = screen.getByRole("button", { name: "Add endpoint" });
    expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
    await userEvent.click(trigger);
    const menu = await screen.findByRole("menu");
    const items = within(menu).getAllByRole("menuitem");
    expect(items.map((i) => i.textContent)).toEqual(["DeepSeekOfficial API", "Qwen", "Blank"]);
    await userEvent.click(within(menu).getByRole("menuitem", { name: /DeepSeek/ }));
    expect(onPreset).toHaveBeenCalledWith("deepseek");
    await userEvent.click(screen.getByRole("button", { name: "Add endpoint" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Blank" }));
    expect(onPreset).toHaveBeenLastCalledWith(undefined);
  });

  it("disables remove at min and add at max", () => {
    wrap(<Repeater {...base} items={[card("a")]} min={1} max={1} />);
    expect(screen.getByRole("button", { name: "Remove a" })).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: "Add endpoint" })).toHaveProperty("disabled", true);
    cleanup();
    wrap(<Repeater {...base} items={[card("a"), card("b")]} min={1} max={3} />);
    expect(screen.getByRole("button", { name: "Remove a" })).toHaveProperty("disabled", false);
    expect(screen.getByRole("button", { name: "Add endpoint" })).toHaveProperty("disabled", false);
  });

  it("shows the empty text when there are no items", () => {
    wrap(<Repeater {...base} items={[]} empty="No endpoints yet." />);
    expect(screen.getByText("No endpoints yet.")).toBeTruthy();
    expect(screen.queryByRole("list")).toBeNull();
  });

  it("removes at once and offers Undo in a toast that calls the restore", async () => {
    wrap(<Host initial={["a", "b"]} />);
    await userEvent.click(screen.getByRole("button", { name: "Remove a" }));
    expect(screen.queryByRole("group", { name: "a" })).toBeNull();
    expect(screen.getByText('Removed "a".')).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(screen.getByRole("group", { name: "a" })).toBeTruthy();
    expect(screen.queryByText('Removed "a".')).toBeNull();
  });

  it("moves with the up / down buttons and Alt+↑/↓ on a focused item, keeping focus", async () => {
    wrap(<Host initial={["a", "b", "c"]} onMove />);
    expect(screen.getByRole("button", { name: "Move a up" })).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: "Move c down" })).toHaveProperty("disabled", true);
    await userEvent.click(screen.getByRole("button", { name: "Move a down" }));
    expect(order().map((g) => g.getAttribute("aria-label"))).toEqual(["b", "a", "c"]);

    const input = screen.getByRole("textbox", { name: "Name c" });
    input.focus();
    fireEvent.keyDown(input, { key: "ArrowUp", altKey: true });
    expect(order().map((g) => g.getAttribute("aria-label"))).toEqual(["b", "c", "a"]);
    expect(document.activeElement).toBe(input);
    fireEvent.keyDown(input, { key: "ArrowDown", altKey: true });
    expect(order().map((g) => g.getAttribute("aria-label"))).toEqual(["b", "a", "c"]);
    // plain arrows are the field's own
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(order().map((g) => g.getAttribute("aria-label"))).toEqual(["b", "a", "c"]);
  });

  it("calls onMove with the target index for Alt+↑/↓", () => {
    const onMove = vi.fn();
    wrap(<Repeater {...base} items={[card("a"), card("b")]} onMove={onMove} />);
    const input = screen.getByRole("textbox", { name: "Name b" });
    fireEvent.keyDown(input, { key: "ArrowUp", altKey: true });
    expect(onMove).toHaveBeenCalledWith("b", 0);
    fireEvent.keyDown(input, { key: "ArrowDown", altKey: true });
    expect(onMove).toHaveBeenCalledTimes(1);
  });

  it("after add, focus moves to the new item's first field", async () => {
    wrap(<Host initial={["a"]} />);
    await userEvent.click(screen.getByRole("button", { name: "Add endpoint" }));
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Name e2" }));
  });

  it("after a preset add, focus moves to the new item's first field too", async () => {
    wrap(<Host initial={[]} presets={[{ id: "deepseek", label: "DeepSeek" }]} />);
    await userEvent.click(screen.getByRole("button", { name: "Add endpoint" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "DeepSeek" }));
    await act(async () => {});
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Name deepseek" }));
  });

  it("after a preset add, focus goes to the first empty required field", async () => {
    function Prefilled() {
      const [keys, setKeys] = useState<string[]>([]);
      return (
        <Repeater
          {...base}
          presets={[{ id: "ds", label: "DeepSeek" }]}
          items={keys.map((k) => ({
            key: k,
            title: k,
            body: (
              <>
                <Field label="Name" required>
                  <Input defaultValue="ds" />
                </Field>
                <Field label="Note">
                  <Input defaultValue="" />
                </Field>
                <Field label="Base URL" required>
                  <Input defaultValue="" />
                </Field>
              </>
            ),
          }))}
          onAdd={() => setKeys((l) => [...l, `k${l.length}`])}
        />
      );
    }
    wrap(<Prefilled />);
    await userEvent.click(screen.getByRole("button", { name: "Add endpoint" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "DeepSeek" }));
    await act(async () => {});
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: /^Base URL/ }));
  });

  it("disabled disables add, remove and move", () => {
    const onMove = vi.fn();
    wrap(<Repeater {...base} items={[card("a"), card("b")]} onMove={onMove} disabled />);
    for (const name of ["Add endpoint", "Remove a", "Move a down", "Move b up"]) {
      expect(screen.getByRole("button", { name })).toHaveProperty("disabled", true);
    }
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Name b" }), {
      key: "ArrowUp",
      altKey: true,
    });
    expect(onMove).not.toHaveBeenCalled();
  });

  it("a collapsible card toggles through onToggle and hides its body when collapsed", async () => {
    const onToggle = vi.fn();
    wrap(<Repeater {...base} items={[card("a", { collapsed: true })]} onToggle={onToggle} />);
    const toggle = screen.getByRole("button", { name: "Expand a" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("textbox")).toBeNull();
    await userEvent.click(toggle);
    expect(onToggle).toHaveBeenCalledWith("a");
  });

  it("marks an invalid item", () => {
    wrap(<Repeater {...base} items={[card("a", { invalid: true })]} />);
    expect(screen.getByRole("group", { name: "a" }).getAttribute("data-invalid")).toBe("true");
  });

  it("names untitled items by position and draws the rows variant without a card head", () => {
    const { container } = wrap(
      <Repeater
        {...base}
        variant="rows"
        items={[{ key: "x", body: <Input aria-label="Model ID" /> }]}
      />,
    );
    expect(screen.getByRole("group", { name: "Item 1" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Remove Item 1" })).toBeTruthy();
    expect(container.querySelector('[data-part="repeater-head"]')).toBeNull();
  });

  it("speaks Chinese", () => {
    wrap(<Repeater {...base} items={[card("a")]} onMove={() => {}} />, "zh");
    expect(screen.getByRole("button", { name: "移除 a" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "下移 a" })).toBeTruthy();
  });

  it("Alt+↑/↓ in a nested Repeater moves only the inner item, also at the inner list's edge", () => {
    const outerMove = vi.fn();
    const innerMove = vi.fn();
    const inner = (
      <Repeater
        {...base}
        label="Models"
        addLabel="Add model"
        variant="rows"
        items={[
          { key: "m1", title: "m1", body: <Input aria-label="Model m1" /> },
          { key: "m2", title: "m2", body: <Input aria-label="Model m2" /> },
        ]}
        onMove={innerMove}
      />
    );
    wrap(
      <Repeater
        {...base}
        items={[card("a"), { key: "b", title: "b", body: inner }]}
        onMove={outerMove}
      />,
    );
    const m2 = screen.getByRole("textbox", { name: "Model m2" });
    fireEvent.keyDown(m2, { key: "ArrowUp", altKey: true });
    expect(innerMove).toHaveBeenCalledWith("m2", 0);
    // the inner item cannot go further down: the key is still the inner list's, not the outer's
    fireEvent.keyDown(m2, { key: "ArrowDown", altKey: true });
    expect(innerMove).toHaveBeenCalledTimes(1);
    expect(outerMove).not.toHaveBeenCalled();
    // outside the inner list the outer item moves
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Name a" }), {
      key: "ArrowDown",
      altKey: true,
    });
    expect(outerMove).toHaveBeenCalledWith("a", 1);
  });

  it("names what it adds on the add button and keeps a nested list's add inside its item", () => {
    const inner = (
      <Repeater
        label="Models"
        addLabel="Add model"
        items={[{ key: "m1", title: "m1", body: <span>m1</span> }]}
        onAdd={() => {}}
        onRemove={() => () => {}}
      />
    );
    wrap(<Repeater {...base} items={[{ key: "a", title: "a", body: inner }]} />);
    const outer = screen.getByRole("group", { name: "Endpoints" });
    const nested = screen.getByRole("group", { name: "Models" });
    const addOuter = within(outer).getByRole("button", { name: "Add endpoint" });
    const addInner = within(nested).getByRole("button", { name: "Add model" });
    // the nested add sits in the parent item's body, the outer one in the outer list's footer
    const item = within(outer).getByRole("group", { name: "a" });
    expect(item.contains(addInner)).toBe(true);
    expect(item.contains(addOuter)).toBe(false);
    expect(addOuter.closest('[data-part="repeater-foot"]')?.parentElement).toBe(outer);
    expect(
      addInner.closest('[data-part="repeater-foot"]')?.closest('[data-part="repeater-body"]'),
    ).toBe(item.querySelector('[data-part="repeater-body"]'));
  });
});

/**
 * Nesting inside a box (spec §6.26): jsdom lays nothing out, so the indents are read from the
 * stylesheet's rules and the structure from the rendered DOM.
 */
const css = readFileSync(resolve(import.meta.dirname, "../src/styles/repeater.css"), "utf8");

/** The declarations of the rules whose selector list has `sel` (whitespace normalized), joined. */
function decls(sel: string): string {
  const out: string[] = [];
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const m of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = (m[1] ?? "").split(/,(?![^(]*\))/).map((x) => x.trim().replace(/\s+/g, " "));
    if (selectors.includes(sel)) out.push(m[2] ?? "");
  }
  return out.join("\n");
}

const ITEM =
  '.cb-repeater[data-variant="divided"] > .cb-repeater-list > .cb-repeater-li > .cb-repeater-item';
const LEAD = "calc(var(--cb-control-dense) + var(--cb-space-2))";

describe("Repeater nested inside a box (spec §6.26)", () => {
  it("indents a divided item's body by its head's leading controls, so fields start at the title", () => {
    expect(decls(`${ITEM} > .cb-repeater-body`)).toContain(
      "padding: var(--cb-space-2) 0 0 var(--cb-repeater-lead);",
    );
    expect(decls(ITEM)).toContain("--cb-repeater-lead: 0px;");
    expect(decls(`${ITEM}:has(> .cb-repeater-head > .cb-repeater-handle)`)).toContain(
      `--cb-repeater-lead: ${LEAD};`,
    );
    expect(decls(`${ITEM}:has(> .cb-repeater-head > [data-part="repeater-toggle"])`)).toContain(
      `--cb-repeater-lead: ${LEAD};`,
    );
    // the handle takes the same control.dense slot as the chevron, so one lead fits either
    expect(decls(`${ITEM} > .cb-repeater-head > .cb-repeater-handle`)).toContain(
      "width: var(--cb-control-dense);",
    );
    // the page-ground cards keep their own padding: the frame already nests
    expect(decls(".cb-repeater-body")).toContain("padding: var(--cb-space-3);");
  });

  it("draws a list nested in a divided item's body one level in, under a line guide", () => {
    const guide = decls('.cb-repeater[data-variant="divided"] .cb-repeater-body .cb-repeater');
    expect(guide).toContain("padding-left: var(--cb-space-2);");
    expect(guide).toContain("border-left: 1px solid var(--cb-line);");
    // no box inside the box: no border around items, no radius on the nested list
    expect(guide).not.toMatch(/border:|border-radius|border-top|border-right|border-bottom/);
  });

  it("puts the nested add button inside the guide, right of the outer add button", () => {
    const inner = (
      <Repeater
        label="Models"
        addLabel="Add model"
        items={[{ key: "m1", title: "m1", body: <span>m1</span> }]}
        onAdd={() => {}}
        onRemove={() => () => {}}
        onToggle={() => {}}
      />
    );
    wrap(
      <Card>
        <Repeater {...base} items={[{ key: "a", title: "a", body: inner }]} onToggle={() => {}} />
      </Card>,
    );
    const outer = screen.getByRole("group", { name: "Endpoints" });
    const nested = screen.getByRole("group", { name: "Models" });
    expect(outer.getAttribute("data-variant")).toBe("divided");
    expect(nested.getAttribute("data-variant")).toBe("divided");
    const addOuter = within(outer).getByRole("button", { name: "Add endpoint" });
    const addInner = within(nested).getByRole("button", { name: "Add model" });
    // the outer button sits on the outer list's left edge (its footer, no indent of its own) ...
    expect(addOuter.closest('[data-part="repeater-foot"]')?.parentElement).toBe(outer);
    // ... the nested one inside the nested list (the guide, padding-left space.2), which sits in
    // the item's body (padding-left one lead): space.2 + 1px + one lead to the right
    expect(addInner.closest('[data-part="repeater"]')).toBe(nested);
    const body = nested.parentElement?.closest('[data-part="repeater-body"]');
    expect(body?.parentElement?.querySelector('[data-part="repeater-toggle"]')).not.toBeNull();
    expect(
      nested.matches('.cb-repeater[data-variant="divided"] .cb-repeater-body .cb-repeater'),
    ).toBe(true);
    expect(
      outer.matches('.cb-repeater[data-variant="divided"] .cb-repeater-body .cb-repeater'),
    ).toBe(false);
  });
});
