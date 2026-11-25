import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  DesignProvider,
  EMBED_ALLOW,
  EMBED_SANDBOX,
  EmbedFrame,
  HTML_DOCUMENT_SANDBOX,
  HtmlDocumentFrame,
} from "../src/index";

afterEach(cleanup);

/**
 * The mobile shell's origin gate hands `window.capybaraShell` to the profile origin's top document
 * only. A same-origin iframe could reach `window.top.capybaraShell`, so every iframe core renders
 * must be sandboxed without `allow-same-origin` (mobile app spec §5.3).
 */

/** Every design source file allowed to render an iframe; a new site fails the scan until listed here. */
const IFRAME_SITES = ["display/embed.tsx", "display/html-frame.tsx"];

const src = resolve(import.meta.dirname, "../src");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? sourceFiles(join(dir, e.name))
      : /\.(tsx?|jsx?)$/.test(e.name)
        ? [join(dir, e.name)]
        : [],
  );
}

const rendersIframe = /<iframe\b|(?:createElement|jsxs?|jsxDEV)\(\s*["'`]iframe["'`]/;

function sandboxOf(node: React.ReactElement): string | null {
  const { container } = render(<DesignProvider locale="en">{node}</DesignProvider>);
  const frames = container.querySelectorAll("iframe");
  expect(frames).toHaveLength(1);
  return (frames[0] as HTMLIFrameElement).getAttribute("sandbox");
}

describe("every iframe is sandboxed without same-origin", () => {
  it("renders iframes only in the listed design files", () => {
    const found = sourceFiles(src)
      .filter((f) => rendersIframe.test(readFileSync(f, "utf8")))
      .map((f) => relative(src, f).split("\\").join("/"))
      .sort();
    expect(found).toEqual(IFRAME_SITES);
  });

  it("keeps allow-same-origin out of the sandbox constants", () => {
    for (const flags of [EMBED_SANDBOX, HTML_DOCUMENT_SANDBOX]) {
      expect(flags.trim()).not.toBe("");
      expect(flags.split(/\s+/)).not.toContain("allow-same-origin");
    }
  });

  // Adding a site means adding a render case: every listed file must have one here.
  const RENDER_CASES: Record<string, [string, React.ReactElement][]> = {
    "display/embed.tsx": [
      ["EmbedFrame", <EmbedFrame key="e" src="/plugin-ui/p/x" title="x" onMessage={() => {}} />],
      [
        "EmbedFrame fill",
        <EmbedFrame key="f" fill src="/plugin-ui/p/x" title="x" onMessage={() => {}} />,
      ],
    ],
    "display/html-frame.tsx": [
      ["HtmlDocumentFrame", <HtmlDocumentFrame key="h" src="/api/v1/html/t" title="x.html" />],
    ],
  };

  it("has a render case for every listed site", () => {
    expect(Object.keys(RENDER_CASES).sort()).toEqual([...IFRAME_SITES].sort());
  });

  it.each(Object.values(RENDER_CASES).flat())(
    "%s renders a sandbox attribute without allow-same-origin",
    (_name, node) => {
      const sandbox = sandboxOf(node);
      expect(sandbox).not.toBeNull();
      expect((sandbox as string).trim()).not.toBe("");
      expect((sandbox as string).split(/\s+/)).not.toContain("allow-same-origin");
    },
  );
});

/**
 * Chrome's Local Network Access gates a request from a document in a more public address space
 * than its target behind a permission of the top-level origin. A subframe may ask for it only when
 * the permission is delegated to it; an embed's subresources open their own connections (an
 * opaque origin is its own network partition), so they can land in another address space than the
 * document that loaded them. EmbedFrame delegates exactly the local network features, nothing else.
 */
describe("EmbedFrame delegates local network access and nothing else", () => {
  it("allows only the local network features", () => {
    expect(EMBED_ALLOW.split(";").map((f) => f.trim())).toEqual([
      "local-network-access",
      "local-network",
      "loopback-network",
    ]);
  });

  it("renders the allow attribute", () => {
    const { container } = render(
      <DesignProvider locale="en">
        <EmbedFrame src="/plugin-ui/p/x" title="x" onMessage={() => {}} />
      </DesignProvider>,
    );
    expect(container.querySelector("iframe")?.getAttribute("allow")).toBe(EMBED_ALLOW);
  });

  it("gives the HTML document frame no delegated features", () => {
    const { container } = render(
      <DesignProvider locale="en">
        <HtmlDocumentFrame src="/api/v1/html/t" title="x.html" />
      </DesignProvider>,
    );
    expect(container.querySelector("iframe")?.getAttribute("allow")).toBeNull();
  });
});
