import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DesignProvider,
  FormPage,
  FormSection,
  ListDetail,
  type ListDetailProps,
  WizardPage,
} from "../src/index";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const width = (w: number) =>
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(w);

function region(p: Partial<ListDetailProps> = {}, locale: "zh" | "en" = "zh") {
  const props: ListDetailProps = {
    list: <p>THE LIST</p>,
    detail: null,
    onBack: () => {},
    listMin: 320,
    detailMin: 360,
    label: "收件箱",
    ...p,
  };
  const ui = (q: ListDetailProps) => (
    <DesignProvider locale={locale}>
      <ListDetail {...q} />
    </DesignProvider>
  );
  const r = render(ui(props));
  return { ...r, again: (q: Partial<ListDetailProps>) => r.rerender(ui({ ...props, ...q })) };
}

const part = (p: string) => document.querySelector(`[data-part="${p}"]`) as HTMLElement | null;

describe("ListDetail, the stack form", () => {
  it("with nothing open the list is the page", () => {
    width(500);
    region();
    expect(part("list-detail")?.getAttribute("data-mode")).toBe("stack");
    expect(screen.getByText("THE LIST")).toBeTruthy();
    expect(part("detail-pane")).toBeNull();
    expect(screen.queryByRole("button", { name: "返回" })).toBeNull();
  });

  it("an open item replaces the list and gets a back button named by shell.back", async () => {
    width(500);
    const onBack = vi.fn();
    region({ detail: <p>THE ITEM</p>, onBack });
    expect(screen.getByText("THE ITEM")).toBeTruthy();
    expect(part("list-pane")?.hidden).toBe(true);
    await userEvent.click(screen.getByRole("button", { name: "返回" }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it("the back button reads Back in English", () => {
    width(500);
    region({ detail: <p>x</p> }, "en");
    expect(screen.getByRole("button", { name: "Back" })).toBeTruthy();
  });

  it("the list keeps its scroll position while an item covers it", () => {
    width(500);
    const r = region();
    const pane = part("list-pane") as HTMLElement;
    pane.scrollTop = 120;
    fireEvent.scroll(pane);
    r.again({ detail: <p>x</p> });
    // a browser drops the offset of a hidden element
    pane.scrollTop = 0;
    r.again({ detail: null });
    expect(pane.scrollTop).toBe(120);
  });
});

describe("ListDetail, two panes", () => {
  it("fits exactly at listMin + detailMin", () => {
    width(679);
    const r = region();
    expect(part("list-detail")?.getAttribute("data-mode")).toBe("stack");
    cleanup();
    width(680);
    r.unmount();
    region();
    expect(part("list-detail")?.getAttribute("data-mode")).toBe("two-pane");
  });

  it("shows both panes, no back button, the list column set from listMin", () => {
    width(1000);
    region({ detail: <p>THE ITEM</p> });
    expect(screen.getByText("THE LIST")).toBeTruthy();
    expect(screen.getByText("THE ITEM")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "返回" })).toBeNull();
    expect(part("list-detail")?.style.getPropertyValue("--cb-ld-list")).toBe("320px");
  });

  it("shows the preview while nothing is open", () => {
    width(1000);
    region({ preview: <p>DEFAULT ITEM</p> });
    expect(screen.getByText("DEFAULT ITEM")).toBeTruthy();
  });
});

describe("the compact forms of the templates", () => {
  const css = (f: string) => readFileSync(resolve(import.meta.dirname, "../src/styles", f), "utf8");

  it("ActionRow is sticky above the keyboard and stacks the primary on its own line", () => {
    render(
      <DesignProvider locale="zh">
        <FormPage
          header={{ path: [{ label: "a" }], title: "表单" }}
          actionRow={{
            cancel: { label: "放弃", onSelect: () => {} },
            primary: { label: "保存", onSelect: () => {} },
          }}
        >
          <FormSection id="s" title="s" description="d">
            x
          </FormSection>
        </FormPage>
      </DesignProvider>,
    );
    const row = part("action-row") as HTMLElement;
    expect(row.getAttribute("data-sticky")).toBe("true");
    expect(part("action-secondary")?.textContent).toBe("放弃");
    expect(part("action-primary")?.textContent).toBe("保存");
    const compact = css("templates.css").slice(css("templates.css").indexOf("ActionRow, compact"));
    expect(compact).toContain("position: sticky");
    expect(compact).toContain("var(--cb-keyboard-inset, 0px)");
    expect(compact).toContain("height: 40px");
  });

  it("WizardPage's compact step bar reads 2 / 4", () => {
    render(
      <DesignProvider locale="zh">
        <WizardPage
          header={{ path: [{ label: "a" }], title: "向导" }}
          steps={["一", "二", "三", "四"]}
          current={1}
          actionRow={{ primary: { label: "下一步", onSelect: () => {} } }}
        >
          x
        </WizardPage>
      </DesignProvider>,
    );
    expect(part("step-count")?.textContent).toBe("2 / 4");
  });
});
