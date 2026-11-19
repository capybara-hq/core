import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AppShell,
  DesignProvider,
  FormPage,
  FormSection,
  Grid,
  InboxPage,
  LIST_DETAIL_FITS,
  ListDetail,
  type ListDetailProps,
  TracePage,
  WizardPage,
} from "../src/index";
import { css, parseCss } from "./css-rules";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

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

describe("ListDetail draws both forms, CSS picks one (first paint follows the window)", () => {
  it("renders the list, the detail pane, the back bar and the open flag in the server render", () => {
    const html = renderToString(
      <DesignProvider locale="zh">
        <ListDetail
          list={<p>THE LIST</p>}
          detail={<p>THE ITEM</p>}
          onBack={() => {}}
          listMin={320}
          detailMin={360}
          label="收件箱"
        />
      </DesignProvider>,
    );
    expect(html).toContain("THE LIST");
    expect(html).toContain("THE ITEM");
    expect(html).toContain('data-part="back-bar"');
    expect(html).toContain('data-open="true"');
    expect(html).toContain('data-fit="680"');
  });

  it("with nothing open the stack shows the list (open=false), two panes show the preview", () => {
    region({ preview: <p>DEFAULT ITEM</p> });
    expect(part("list-detail")?.getAttribute("data-open")).toBe("false");
    expect(screen.getByText("THE LIST")).toBeTruthy();
    expect(screen.getByText("DEFAULT ITEM")).toBeTruthy();
  });

  it("the back button is named by shell.back and calls onBack", async () => {
    const onBack = vi.fn();
    region({ detail: <p>THE ITEM</p>, onBack });
    await userEvent.click(screen.getByRole("button", { name: "返回" }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it("the back button reads Back in English", () => {
    region({ detail: <p>x</p> }, "en");
    expect(screen.getByRole("button", { name: "Back" })).toBeTruthy();
  });

  it("the stylesheet has the stack rules at each fit's threshold, one below the sum", () => {
    const sheet = css("templates.css");
    for (const fit of LIST_DETAIL_FITS) {
      expect(sheet).toContain(`@container cb-ld (max-width: ${fit - 1}px) {`);
      expect(sheet).toContain(
        `.cb-listdetail[data-fit="${fit}"][data-open="true"] > .cb-listdetail-list`,
      );
    }
    expect(sheet).toMatch(/\.cb-ld \{[^}]*container: cb-ld \/ inline-size;/);
  });

  it("refuses a fit the stylesheet has no rules for", () => {
    expect(() => region({ listMin: 300, detailMin: 300 })).toThrow(/no stylesheet rules/);
  });

  it("the list keeps its scroll position while an item covers it", () => {
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

  it("the footer sits under both panes", () => {
    region({ footer: <p>DECISIONS</p> });
    expect(part("list-detail-footer")?.textContent).toBe("DECISIONS");
  });
});

describe("inside the shell the open item is a pushed page", () => {
  it("registers back with the shell, hides the own bar on compact by CSS", async () => {
    const onBack = vi.fn();
    render(
      <DesignProvider locale="zh">
        <AppShell
          sidebar={SIDEBAR}
          status={{ context: "grant@acme:/", version: "0.1.0" }}
          pathname="/inbox"
          bottomNav={[{ id: "inbox", label: "收件箱", href: "/inbox", icon: "inbox" }]}
        >
          <ListDetail
            list={<p>L</p>}
            detail={<p>D</p>}
            onBack={onBack}
            listMin={320}
            detailMin={360}
            label="x"
          />
        </AppShell>
      </DesignProvider>,
    );
    const top = document.querySelector('[data-part="top-bar"]') as HTMLElement;
    expect(top.getAttribute("data-pushed")).toBe("true");
    await userEvent.click(within(top).getByRole("button", { name: "返回" }));
    expect(onBack).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[data-part="bottom-nav-slot"]')).toBeNull();
    expect(css("templates.css")).toMatch(
      /@media \(max-width: 599px\) \{\s*\.cb-shell \.cb-listdetail\[data-fit\] > \.cb-listdetail-detail > \.cb-listdetail-bar \{\s*display: none;/,
    );
  });
});

describe("the compact forms of the templates", () => {
  it("ActionRow stacks the primary on its own line; the compact CSS makes it sticky above the keyboard", () => {
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
    expect(part("action-secondary")?.textContent).toBe("放弃");
    expect(part("action-primary")?.textContent).toBe("保存");
    const rules = parseCss(css("templates.css")).filter((r) => r.at === "(max-width: 599px)");
    const decl = (selector: string, prop: string) =>
      rules.find((r) => r.selector === selector)?.decls[prop];
    expect(decl(".cb-actionrow", "position")).toBe("sticky");
    expect(decl(".cb-actionrow", "bottom")).toBe("0");
    expect(decl(".cb-actionrow", "padding")).toContain("var(--cb-keyboard-inset, 0px)");
    expect(decl(".cb-actionrow .cb-actionrow-frame", "flex-direction")).toBe("column");
    expect(
      decl(
        ".cb-actionrow .cb-actionrow-others > *, .cb-actionrow .cb-actionrow-primary > *",
        "height",
      ),
    ).toBe("40px");
    // on a tab root the bottom navigation pads the inset: the row adds only the keyboard
    const tabRoot = ".cb-shell-main:has(~ .cb-shell-bottomnav) .cb-actionrow";
    expect(decl(tabRoot, "padding-bottom")).not.toContain("inset-bottom");
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

const SIDEBAR = {
  context: {
    kind: "work" as const,
    org: { name: "Acme", initial: "A", slug: "acme", role: "所有者", menu: [] },
    primary: [{ id: "agents", label: "Agents", href: "/agents", icon: "agent" as const }],
    more: [],
  },
  newConversation: { href: "/" },
  activeNav: "agents",
  account: { name: "grant", menu: [] },
};

describe("InboxPage structure (spec §5.7: rail + content + inspector, decisions under the columns)", () => {
  it("draws the 320 rail, the content, the facts and the ActionRow under both panes", () => {
    render(
      <DesignProvider locale="zh">
        <InboxPage
          header={{ path: [{ label: "a" }], title: "收件箱" }}
          list={<p>L</p>}
          inspector={<p>FACTS</p>}
          actionRow={{ primary: { label: "批准", onSelect: () => {} } }}
          open
        >
          <p>CONTENT</p>
        </InboxPage>
      </DesignProvider>,
    );
    const frame = part("list-detail") as HTMLElement;
    expect(part("rail")?.textContent).toBe("L");
    expect(part("inbox-main")?.textContent).toBe("CONTENT");
    expect(part("inbox-facts")?.textContent).toBe("FACTS");
    // the decision row is the region's footer, a sibling of both panes
    expect(part("list-detail-footer")?.parentElement).toBe(frame);
    expect(part("list-detail-footer")?.querySelector('[data-part="action-row"]')).not.toBeNull();
    const sheet = css("templates.css");
    expect(sheet).toMatch(
      /@container cb-ld \(min-width: 1100px\) \{[^@]*grid-template-columns: minmax\(0, 1fr\) 400px;/,
    );
  });
});

describe('Grid columns="list-detail"', () => {
  it("is a ListDetail (fit 580) once it has an open state, else it stacks by its own frame", () => {
    const { container, rerender } = render(
      <DesignProvider locale="zh">
        <Grid columns="list-detail" divided open={false} onBack={() => {}} label="文件">
          <p>FILES</p>
          <p>EDITOR</p>
        </Grid>
      </DesignProvider>,
    );
    const region = container.querySelector('[data-columns="list-detail"]') as HTMLElement;
    expect(region.getAttribute("data-fit")).toBe("580");
    expect(region.getAttribute("data-open")).toBe("false");
    expect(region.getAttribute("data-divided")).toBe("true");
    rerender(
      <DesignProvider locale="zh">
        <Grid columns="list-detail" divided open onBack={() => {}} label="文件">
          <p>FILES</p>
          <p>EDITOR</p>
        </Grid>
      </DesignProvider>,
    );
    expect(region.getAttribute("data-open")).toBe("true");
    cleanup();
    const plain = render(
      <DesignProvider locale="zh">
        <Grid columns="list-detail">
          <p>A</p>
          <p>B</p>
        </Grid>
      </DesignProvider>,
    );
    expect(plain.container.querySelector(".cb-grid-frame > .cb-grid")).not.toBeNull();
    expect(css("controls.css")).toContain("@container cb-grid (max-width: 579px)");
  });
});

describe("TracePage on compact", () => {
  it("carries the open flag and a back button that calls onBack", async () => {
    const onBack = vi.fn();
    render(
      <DesignProvider locale="zh">
        <TracePage
          header={{ path: [{ label: "a" }], title: "轨迹" }}
          waterfall={<p>W</p>}
          detail={<p>D</p>}
          open
          onBack={onBack}
        />
      </DesignProvider>,
    );
    expect(document.querySelector(".cb-trace")?.getAttribute("data-open")).toBe("true");
    await userEvent.click(screen.getByRole("button", { name: "返回" }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });
});
