import { cleanup, fireEvent, screen } from "@testing-library/react";
import { type ComponentType, createElement, type ReactElement, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DESIGN_NAMES } from "../src/design.js";
import * as api from "../src/index.js";
import { renderWithFakeHost } from "../src/testing/index.js";

afterEach(cleanup);

const host = (el: ReactElement) => renderWithFakeHost(el, { slot: "org.page" });

describe("forwarded design components", () => {
  it("every design name is an export", () => {
    for (const name of DESIGN_NAMES) expect(api).toHaveProperty(name);
  });

  it("renders every name through the fake host without throwing", () => {
    for (const name of DESIGN_NAMES) {
      if (name === "ViewBlocks") continue;
      const C = (api as unknown as Record<string, ComponentType<Record<string, unknown>>>)[name];
      if (!C) throw new Error(`missing export ${name}`);
      const props: Record<string, unknown> = {
        title: "t",
        label: "l",
        header: { title: "t" },
        columns: [],
        rows: [],
        rowKey: () => "k",
        cards: [],
        options: [],
        value: name === "PrincipalPicker" ? [] : "",
        items: [],
        onChange: () => {},
        onMove: () => {},
        renderCard: () => null,
        open: false,
        onOpenChange: () => {},
        footer: null,
        actionRow: { primary: { label: "p", onSelect: () => {} } },
        nav: [],
        activeNav: "",
        id: "i",
        text: "x",
        name: "n",
        size: 16,
        avatarUrl: null,
        selected: false,
        onSelect: () => {},
        trigger: createElement("button", { type: "button" }, "go"),
        confirmName: "n",
        confirmLabel: "ok",
        onConfirm: () => {},
        description: "d",
      };
      host(createElement(C, props)).unmount();
    }
  });

  it("DataTable lists its rows and opens one", () => {
    const onOpen = vi.fn();
    host(
      <api.DataTable
        label="Items"
        columns={[{ key: "n", header: "Name", cell: (r: { n: string }) => r.n }]}
        rows={[{ n: "a" }, { n: "b" }]}
        rowKey={(r) => r.n}
        onOpen={onOpen}
      />,
    );
    fireEvent.click(screen.getByText("b"));
    expect(onOpen).toHaveBeenCalledWith({ n: "b" });
  });

  it("Tabs call onChange with the tab id", () => {
    const onChange = vi.fn();
    host(
      <api.Tabs
        label="v"
        value="a"
        onChange={onChange}
        items={[
          { id: "a", label: "A" },
          { id: "b", label: "B" },
        ]}
      />,
    );
    fireEvent.click(screen.getByRole("tab", { name: "B" }));
    expect(onChange).toHaveBeenCalledWith("b");
  });

  it("Dialog shows only while open and closes through onOpenChange", () => {
    const onOpenChange = vi.fn();
    const h = host(
      <api.Dialog open title="Edit" footer={<span>foot</span>} onOpenChange={onOpenChange}>
        body
      </api.Dialog>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    h.unmount();
    host(
      <api.Dialog open={false} title="Edit" footer={null} onOpenChange={onOpenChange}>
        body
      </api.Dialog>,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("Board moves a card through onMove, and canMove refuses", () => {
    const onMove = vi.fn();
    host(
      <api.Board
        columns={[
          { id: "todo", title: "Todo" },
          { id: "done", title: "Done" },
          { id: "locked", title: "Locked" },
        ]}
        cards={[{ id: "c1", columnId: "todo" }]}
        renderCard={(c) => <span>card {c.id}</span>}
        onMove={onMove}
        canMove={(_c, to) => to !== "locked"}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Move c1 to done" }));
    expect(onMove).toHaveBeenCalledWith("c1", "done", 0);
    expect(
      (screen.getByRole("button", { name: "Move c1 to locked" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("PrincipalPicker toggles ids", () => {
    function Probe() {
      const [v, setV] = useState<string[]>([]);
      return (
        <>
          <api.PrincipalPicker
            multiple
            value={v}
            onChange={setV}
            options={[
              { kind: "person", id: "u1", name: "Ann" },
              { kind: "agent", id: "a1", name: "Bot" },
            ]}
          />
          <output>{v.join(",")}</output>
        </>
      );
    }
    host(<Probe />);
    fireEvent.click(screen.getByText("Ann"));
    fireEvent.click(screen.getByText("Bot"));
    expect(screen.getByRole("status").textContent).toBe("u1,a1");
    fireEvent.click(screen.getByText("Ann"));
    expect(screen.getByRole("status").textContent).toBe("a1");
  });

  it("Input and Textarea carry value and onChange", () => {
    const a = vi.fn();
    const b = vi.fn();
    host(
      <>
        <api.Input aria-label="i" value="x" onChange={(e) => a(e.target.value)} />
        <api.Textarea aria-label="t" value="y" onChange={(e) => b(e.target.value)} />
      </>,
    );
    fireEvent.change(screen.getByLabelText("i"), { target: { value: "x2" } });
    fireEvent.change(screen.getByLabelText("t"), { target: { value: "y2" } });
    expect(a).toHaveBeenCalledWith("x2");
    expect(b).toHaveBeenCalledWith("y2");
  });
});
