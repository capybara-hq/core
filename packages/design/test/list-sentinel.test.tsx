import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useListSentinel } from "../src/display/list-sentinel";
import {
  CardGrid,
  type Column,
  ConversationList,
  DataTable,
  DesignProvider,
  ObjectCard,
  ObjectList,
  ObjectRow,
} from "../src/index";
import { renderAtClass } from "./width";

// Infinite scroll on compact lists (mobile interaction model spec §3 "Infinite scroll", D6; design
// spec §6.17, §6.34, §6.6, §6.60): a list with more pages reads the next one as its end comes
// into view (an IntersectionObserver sentinel), shows a skeleton row while it loads and an inline
// retry row on a failure; from 600 up the list keeps its Load more button.

class FakeObserver {
  static all: FakeObserver[] = [];
  els = new Set<Element>();
  constructor(private readonly cb: IntersectionObserverCallback) {
    FakeObserver.all.push(this);
  }
  observe(el: Element) {
    this.els.add(el);
  }
  unobserve(el: Element) {
    this.els.delete(el);
  }
  disconnect() {
    this.els.clear();
  }
  show() {
    const targets = [...this.els];
    if (targets.length === 0) return;
    this.cb(
      targets.map((target) => ({ target, isIntersecting: true }) as IntersectionObserverEntry),
      this as unknown as IntersectionObserver,
    );
  }
}
/** The list's end comes into view: every live observer reports its targets. */
const scrollToEnd = () =>
  act(() => {
    for (const o of FakeObserver.all) o.show();
  });

const realMatchMedia = window.matchMedia;
beforeEach(() => {
  FakeObserver.all = [];
  vi.stubGlobal("IntersectionObserver", FakeObserver);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.matchMedia = realMatchMedia;
});

const zh = (ui: ReactElement) => render(<DesignProvider locale="zh">{ui}</DesignProvider>);

function Probe({
  onLoadMore,
  hasMore,
  loading,
}: {
  onLoadMore(): void;
  hasMore: boolean;
  loading: boolean;
}) {
  const ref = useListSentinel(onLoadMore, { hasMore, loading });
  return <div ref={ref} data-testid="sentinel" />;
}

describe("useListSentinel", () => {
  it("sentinel in view calls onLoadMore once", () => {
    const onLoadMore = vi.fn();
    render(<Probe onLoadMore={onLoadMore} hasMore loading={false} />);
    expect(onLoadMore).not.toHaveBeenCalled();
    scrollToEnd();
    scrollToEnd();
    expect(onLoadMore).toHaveBeenCalledTimes(1);
  });

  it("no call while loading or without more", () => {
    const onLoadMore = vi.fn();
    const { rerender } = render(<Probe onLoadMore={onLoadMore} hasMore loading />);
    scrollToEnd();
    rerender(<Probe onLoadMore={onLoadMore} hasMore={false} loading={false} />);
    scrollToEnd();
    expect(onLoadMore).not.toHaveBeenCalled();
    // The page arrived and there is more again: the next sight of the end asks once more.
    rerender(<Probe onLoadMore={onLoadMore} hasMore loading={false} />);
    scrollToEnd();
    expect(onLoadMore).toHaveBeenCalledTimes(1);
    rerender(<Probe onLoadMore={onLoadMore} hasMore loading />);
    rerender(<Probe onLoadMore={onLoadMore} hasMore loading={false} />);
    scrollToEnd();
    expect(onLoadMore).toHaveBeenCalledTimes(2);
  });

  it("calls the latest callback", () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = render(<Probe onLoadMore={first} hasMore loading={false} />);
    rerender(<Probe onLoadMore={second} hasMore loading={false} />);
    scrollToEnd();
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });
});

const rows = (n: number) =>
  Array.from({ length: n }, (_, i) => `插件 ${i}`).map((name) => (
    <ObjectRow key={name} mark={{ text: name }} name={name} href={`/p/${name}`} />
  ));

type More = {
  onLoadMore(): void;
  hasMore: boolean;
  loadingMore?: boolean;
  loadMoreError?: string | null;
};

const objectList = (more: More) => (
  <ObjectList label="插件" {...more}>
    {rows(3)}
  </ObjectList>
);
const cardGrid = (more: More) => (
  <CardGrid label="智能体" {...more}>
    {[0, 1, 2].map((i) => (
      <ObjectCard key={`a${i}`} title={`助手 ${i}`} href={`/a/${i}`} avatar={null} />
    ))}
  </CardGrid>
);
type Row = { id: string; name: string };
const columns: Column<Row>[] = [
  { key: "name", header: "名称", cell: (r) => r.name, compact: "title" },
];
const dataTable = (more: More) => (
  <DataTable<Row>
    label="账号"
    columns={columns}
    rows={[0, 1, 2].map((i) => ({ id: String(i), name: `账号 ${i}` }))}
    rowKey={(r) => r.id}
    {...more}
  />
);

const LISTS = [
  { name: "ObjectList", ui: objectList, card: ".cb-object-list" },
  { name: "CardGrid", ui: cardGrid, card: ".cb-card-grid" },
  { name: "DataTable", ui: dataTable, card: '[data-part="table-compact"]' },
] as const;

describe.each(LISTS)("$name on compact", ({ ui, card }) => {
  it("reads the next page as the end comes into view, never by a button", () => {
    const onLoadMore = vi.fn();
    const { container } = renderAtClass(390, ui({ onLoadMore, hasMore: true }));
    const end = container.querySelector('[data-part="list-end"]');
    expect(end).not.toBeNull();
    // The sentinel lives in the grouped card.
    expect(end?.closest(card)).not.toBeNull();
    expect(screen.queryByRole("button", { name: "加载更多" })).toBeNull();
    scrollToEnd();
    expect(onLoadMore).toHaveBeenCalledTimes(1);
  });

  it("a skeleton row in the card while the next page loads, and no call meanwhile", () => {
    const onLoadMore = vi.fn();
    const { container } = renderAtClass(390, ui({ onLoadMore, hasMore: true, loadingMore: true }));
    const skeleton = container.querySelector(`${card} [data-end="skeleton"]`);
    expect(skeleton).not.toBeNull();
    expect(screen.getByRole("status").textContent).toBe("正在加载");
    scrollToEnd();
    expect(onLoadMore).not.toHaveBeenCalled();
  });

  it("error shows an inline retry row", () => {
    const onLoadMore = vi.fn();
    const { container } = renderAtClass(
      390,
      ui({ onLoadMore, hasMore: true, loadMoreError: "网络错误" }),
    );
    const end = container.querySelector(`${card} [data-part="list-end"]`) as HTMLElement;
    expect(end.dataset.state).toBe("error");
    expect(end.textContent).toContain("网络错误");
    scrollToEnd();
    expect(onLoadMore).not.toHaveBeenCalled();
    fireEvent.click(within(end).getByRole("button", { name: "重试" }));
    expect(onLoadMore).toHaveBeenCalledTimes(1);
  });

  it("nothing at the end of the last page", () => {
    const { container } = renderAtClass(390, ui({ onLoadMore: vi.fn(), hasMore: false }));
    expect(container.querySelector('[data-part="list-end"]')).toBeNull();
  });
});

describe.each(LISTS)("$name from 600 up", ({ ui, card }) => {
  it("desktop keeps the page's own load-more", () => {
    const onLoadMore = vi.fn();
    const { container } = renderAtClass(1280, ui({ onLoadMore, hasMore: true }));
    expect(container.querySelector('[data-part="list-end"]')).toBeNull();
    scrollToEnd();
    expect(onLoadMore).not.toHaveBeenCalled();
    const button = screen.getByRole("button", { name: "加载更多" });
    // Below the list, never a row of it.
    expect(button.closest(card)).toBeNull();
    fireEvent.click(button);
    expect(onLoadMore).toHaveBeenCalledTimes(1);
  });

  it("the button waits while the page loads and shows a failure beside it", () => {
    const { container, rerender } = renderAtClass(
      1280,
      ui({ onLoadMore: vi.fn(), hasMore: true, loadingMore: true }),
    );
    expect(
      (screen.getByRole("button", { name: "加载更多" }) as HTMLButtonElement).getAttribute(
        "aria-busy",
      ),
    ).toBe("true");
    rerender(
      <DesignProvider locale="zh">
        {ui({ onLoadMore: vi.fn(), hasMore: true, loadMoreError: "网络错误" })}
      </DesignProvider>,
    );
    expect(container.querySelector('[data-part="list-more"]')?.textContent).toContain("网络错误");
  });

  it("no button on the last page or without onLoadMore", () => {
    renderAtClass(1280, ui({ onLoadMore: vi.fn(), hasMore: false }));
    expect(screen.queryByRole("button", { name: "加载更多" })).toBeNull();
  });
});

describe("ConversationList's end (on the shared sentinel)", () => {
  const items = [0, 1].map((i) => ({
    id: `c${i}`,
    title: `会话 ${i}`,
    startedAt: new Date("2026-11-20T08:00:00Z"),
    updatedAt: new Date("2026-11-20T08:00:00Z"),
    href: `/chat/c${i}`,
    agent: { name: "助手" },
    activity: null,
  }));

  it("asks for the next page once as the end nears, at every class", () => {
    const onMore = vi.fn();
    zh(
      <ConversationList label="会话" items={items} end={{ more: true, loading: false, onMore }} />,
    );
    scrollToEnd();
    scrollToEnd();
    expect(onMore).toHaveBeenCalledTimes(1);
  });

  it("no call while loading; a failure shows its message with Retry and no call", () => {
    const onMore = vi.fn();
    const { rerender, container } = zh(
      <ConversationList label="会话" items={items} end={{ more: true, loading: true, onMore }} />,
    );
    scrollToEnd();
    expect(onMore).not.toHaveBeenCalled();
    rerender(
      <DesignProvider locale="zh">
        <ConversationList
          label="会话"
          items={items}
          end={{ more: true, loading: false, error: "网络错误", onMore }}
        />
      </DesignProvider>,
    );
    scrollToEnd();
    expect(onMore).not.toHaveBeenCalled();
    const end = container.querySelector('[data-part="convlist-end"]') as HTMLElement;
    fireEvent.click(within(end).getByRole("button", { name: "重试" }));
    expect(onMore).toHaveBeenCalledTimes(1);
  });
});
