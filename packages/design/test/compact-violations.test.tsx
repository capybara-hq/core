import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  ActionRow,
  AppShell,
  DesignProvider,
  FormPage,
  FormSection,
  InboxPage,
  ListDetail,
} from "../src/index";
import { describeCompactViolation, findCompactViolations } from "../src/reference/index";
import { matchMediaFor } from "./width";

// The structural half of the compact rule set (mobile layout spec §11.3), red first: the rule set
// finds a hover-only control, an icon-only button without a name and a list-detail region without
// a back control, and finds nothing in the real components at the compact width.

const realMatchMedia = window.matchMedia;
afterEach(() => {
  cleanup();
  window.matchMedia = realMatchMedia;
});

const found = () => findCompactViolations(document.body).map(describeCompactViolation);

describe("findCompactViolations (the rule set itself, red first)", () => {
  it("finds a hover-only action, an unnamed icon-only button and a list-detail without back", () => {
    render(
      <div>
        <button type="button" data-hover-only="true">
          删除
        </button>
        <button type="button">
          <svg aria-hidden="true" />
        </button>
        <section data-part="list-detail" aria-label="收件箱">
          <div data-part="list-pane">L</div>
          <div data-part="detail-pane">D</div>
        </section>
      </div>,
    );
    const rules = findCompactViolations(document.body).map((v) => v.rule);
    expect(rules).toEqual(["hover-only", "unnamed-control", "list-detail-back"]);
    expect(found()[1]).toBe("unnamed-control: <button>");
  });

  it("the shell top bar's back counts only while it is pushed", () => {
    const shell = (pushed: boolean) => (
      <div className="cb-shell">
        <header data-part="top-bar" data-pushed={pushed ? "true" : "false"}>
          <button type="button" data-part="back" aria-label="返回" />
        </header>
        <section data-part="list-detail" aria-label="收件箱" />
      </div>
    );
    const r = render(shell(true));
    expect(findCompactViolations(document.body)).toEqual([]);
    r.rerender(shell(false));
    expect(findCompactViolations(document.body).map((v) => v.rule)).toEqual(["list-detail-back"]);
  });

  it("a name from aria-label, aria-labelledby, text or an image alt is a name; title alone is not", () => {
    render(
      <div>
        <button type="button" aria-label="关闭" />
        <span id="n">打开</span>
        <button type="button" aria-labelledby="n" />
        <button type="button">
          <span>更多</span>
        </button>
        <button type="button">
          <img alt="头像" src="x.png" />
        </button>
        <button type="button" title="只有提示" />
      </div>,
    );
    expect(found()).toEqual(["unnamed-control: <button>"]);
  });
});

const SIDEBAR = {
  context: {
    kind: "work" as const,
    org: { name: "Acme", initial: "A", slug: "acme", role: "所有者", menu: [] },
    primary: [{ id: "agents", label: "智能体", href: "/agents", icon: "agent" as const }],
    more: [],
  },
  newConversation: { href: "/" },
  activeNav: "agents",
  account: { name: "grant", menu: [] },
};

describe("the real components at the compact width have no violation", () => {
  it.each([382, 390])("a list-detail inbox and a form inside the shell at %i px", (width) => {
    window.matchMedia = matchMediaFor(width, 844).matchMedia;
    render(
      <DesignProvider locale="zh">
        <AppShell
          sidebar={SIDEBAR}
          status={{ context: "grant@acme:/", version: "0.1.0" }}
          pathname="/inbox"
          bottomNav={[
            { id: "inbox", label: "收件箱", href: "/inbox", icon: "inbox" },
            { id: "agents", label: "智能体", href: "/agents", icon: "agent" },
          ]}
        >
          <InboxPage
            header={{ path: [{ label: "收件箱" }], title: "收件箱" }}
            list={<p>L</p>}
            inspector={<p>FACTS</p>}
            actionRow={{ primary: { label: "批准", onSelect: () => {} } }}
            open
            onBack={() => {}}
          >
            <p>CONTENT</p>
          </InboxPage>
        </AppShell>
      </DesignProvider>,
    );
    expect(found()).toEqual([]);
  });

  it("a standalone list-detail, a form page and an action row", () => {
    window.matchMedia = matchMediaFor(390, 844).matchMedia;
    render(
      <DesignProvider locale="zh">
        <ListDetail
          list={<p>L</p>}
          detail={<p>D</p>}
          onBack={() => {}}
          listMin={320}
          detailMin={360}
          label="文件"
        />
        <FormPage
          header={{ path: [{ label: "智能体" }], title: "新建智能体" }}
          actionRow={{ primary: { label: "保存", onSelect: () => {} } }}
        >
          <FormSection id="basics" title="基本信息">
            <p>字段</p>
          </FormSection>
        </FormPage>
        <ActionRow primary={{ label: "保存", onSelect: () => {} }} />
      </DesignProvider>,
    );
    expect(found()).toEqual([]);
  });
});
