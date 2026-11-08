import { cleanup, fireEvent, render } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it } from "vitest";
import {
  CardGrid,
  CellTitle,
  DesignProvider,
  ItemList,
  ObjectCard,
  ObjectList,
  ObjectMark,
  ObjectRow,
  Sheet,
} from "../src/index";

// A plugin's declared icon as the mark of a thing that plugin brings (spec §6.17, maintainer
// decision 2026-11-08): an <img alt=""> contained on the tile, the initial without one or when it
// fails to load.

afterEach(cleanup);

const ICON = "/api/v1/orgs/o1/catalog/i1/icon?v=1.0.0";
const wrap = (ui: ReactElement) =>
  render(
    <DesignProvider
      locale="zh"
      link={({ href, children, ...rest }) => (
        <a href={href} {...rest}>
          {children}
        </a>
      )}
    >
      {ui}
    </DesignProvider>,
  );

/** The one mark image in `root`, asserted decorative. */
function markImage(root: ParentNode): HTMLImageElement {
  const img = root.querySelector<HTMLImageElement>('img[data-part="mark-image"]');
  expect(img).not.toBeNull();
  expect(img?.getAttribute("alt")).toBe("");
  expect(img?.getAttribute("src")).toBe(ICON);
  return img as HTMLImageElement;
}

describe("plugin marks", () => {
  it("ObjectRow: mark.image draws the icon in the 36 px mark, the initial when it fails", () => {
    const { container } = wrap(
      <ObjectList label="渠道">
        <ObjectRow mark={{ text: "slack bot", image: ICON }} name="slack bot" />
      </ObjectList>,
    );
    const mark = container.querySelector(".cb-object-mark") as HTMLElement;
    expect(mark.getAttribute("aria-hidden")).toBe("true");
    expect(mark.dataset.kind).toBe("image");
    fireEvent.error(markImage(mark));
    expect(mark.querySelector("img")).toBeNull();
    expect(mark.textContent).toBe("S");
  });

  it("ObjectRow: without an image the initial stays", () => {
    const { container } = wrap(
      <ObjectList label="渠道">
        <ObjectRow mark={{ text: "飞书", image: null }} name="飞书" />
      </ObjectList>,
    );
    const mark = container.querySelector(".cb-object-mark") as HTMLElement;
    expect(mark.querySelector("img")).toBeNull();
    expect(mark.textContent).toBe("飞");
  });

  it("ObjectCard: avatar { image } on the 40 px tile, the title's initial without one; state", () => {
    const { container } = wrap(
      <CardGrid label="渠道">
        <ObjectCard
          key="a"
          avatar={{ image: ICON }}
          title="support"
          href="/channels/a"
          state={{ label: "运行中", tone: "ok" }}
        />
        <ObjectCard key="b" avatar={{ image: null }} title="lark" href="/channels/b" />
      </CardGrid>,
    );
    const [a, b] = [...container.querySelectorAll<HTMLElement>('[data-part="object-card-avatar"]')];
    expect(a?.dataset.kind).toBe("image");
    fireEvent.error(markImage(a as HTMLElement));
    expect(a?.textContent).toBe("S");
    expect(b?.querySelector("img")).toBeNull();
    expect(b?.textContent).toBe("L");
    const state = container.querySelector<HTMLElement>('[data-part="object-card-state"]');
    expect(state?.textContent).toBe("运行中");
    expect(state?.dataset.tone).toBe("ok");
    // the state sits beside the link, never inside it
    expect(state?.closest("a")).toBeNull();
  });

  it("CellTitle: image on the initial tile, the initial when it fails", () => {
    const { container } = wrap(<CellTitle title="Slack" initial="S" image={ICON} />);
    const tile = container.querySelector(".cb-cell-initial") as HTMLElement;
    fireEvent.error(markImage(tile));
    expect(tile.textContent).toBe("S");
  });

  it("ItemList rows and the Sheet head take a mark; ObjectMark draws one on its own", () => {
    const { container } = wrap(
      <ItemList
        label="渠道"
        rows={[{ id: "a", mark: { text: "support", image: ICON }, title: "support" }]}
      />,
    );
    markImage(container);
    cleanup();
    const sheet = wrap(
      <Sheet open onOpenChange={() => {}} title="Slack" mark={{ text: "Slack" }}>
        <p>body</p>
      </Sheet>,
    );
    const head = sheet.baseElement.querySelector(".cb-sheet-head") as HTMLElement;
    expect(head.querySelector('[data-part="object-mark"]')?.textContent).toBe("S");
    cleanup();
    const solo = wrap(<ObjectMark text="model fake" image={ICON} size={40} />);
    const tile = solo.container.querySelector<HTMLElement>('[data-part="object-mark"]');
    expect(tile?.dataset.size).toBe("40");
    expect(tile?.getAttribute("aria-hidden")).toBe("true");
    fireEvent.error(markImage(tile as HTMLElement));
    expect(tile?.textContent).toBe("M");
  });
});
