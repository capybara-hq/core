import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { DesignProvider, LinkCard, type LinkComponent, TextLink } from "../src/index";

afterEach(cleanup);

const Spy: LinkComponent = ({ href, children, ...rest }) => (
  <a href={`/spy${href}`} {...rest}>
    {children}
  </a>
);

describe("TextLink", () => {
  it("renders through the DesignProvider link, as a design part", () => {
    render(
      <DesignProvider locale="zh" link={Spy}>
        <TextLink href="/admin/orgs">管理组织</TextLink>
      </DesignProvider>,
    );
    const a = screen.getByRole("link", { name: "管理组织" });
    expect(a.getAttribute("href")).toBe("/spy/admin/orgs");
    expect(a.getAttribute("data-part")).toBe("text-link");
    expect(a.className).toContain("cb-text-link");
  });

  it("styles itself with theme tokens, never browser defaults", () => {
    const css = readFileSync(resolve(import.meta.dirname, "../src/styles/display.css"), "utf8");
    const rule = css.match(/\.cb-text-link \{([^}]*)\}/)?.[1] ?? "";
    expect(rule).toMatch(/color: var\(--cb-ink\);/);
    expect(rule).toMatch(/text-decoration-color: var\(--cb-line-strong\);/);
    expect(css).toMatch(/\.cb-text-link:visited \{[^}]*color: var\(--cb-ink\);/);
  });
});

describe("LinkCard", () => {
  it("title, description and one text link with a chevron", () => {
    render(
      <DesignProvider locale="zh">
        <LinkCard
          title="组织"
          description="创建与停用组织。"
          href="/admin/orgs"
          linkLabel="管理组织"
        />
      </DesignProvider>,
    );
    const card = document.querySelector('[data-part="link-card"]') as HTMLElement;
    expect(card.tagName).toBe("SECTION");
    expect(screen.getByRole("heading", { name: "组织" })).toBeTruthy();
    expect(screen.getByText("创建与停用组织。")).toBeTruthy();
    const link = screen.getByRole("link", { name: "管理组织" });
    expect(link.getAttribute("href")).toBe("/admin/orgs");
    expect(link.querySelector('[data-icon="chevron-right"]')).not.toBeNull();
  });
});
