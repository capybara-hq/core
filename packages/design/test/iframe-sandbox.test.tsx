import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  DesignProvider,
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

const rendersIframe = /<iframe\b|createElement\(\s*["'`]iframe["'`]|jsx\(\s*["'`]iframe["'`]/;

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

  it.each([
    ["EmbedFrame", <EmbedFrame key="e" src="/plugin-ui/p/x" title="x" onMessage={() => {}} />],
    [
      "EmbedFrame fill",
      <EmbedFrame key="f" fill src="/plugin-ui/p/x" title="x" onMessage={() => {}} />,
    ],
    ["HtmlDocumentFrame", <HtmlDocumentFrame key="h" src="/api/v1/html/t" title="x.html" />],
  ])("%s renders a sandbox attribute without allow-same-origin", (_name, node) => {
    const sandbox = sandboxOf(node);
    expect(sandbox).not.toBeNull();
    expect((sandbox as string).trim()).not.toBe("");
    expect((sandbox as string).split(/\s+/)).not.toContain("allow-same-origin");
  });
});
