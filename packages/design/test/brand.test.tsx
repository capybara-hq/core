import { act, cleanup, render, screen } from "@testing-library/react";
import type { CSSProperties } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { type Brand, brandArtStyle, cssUrlValue, DesignProvider, useBrandMark } from "../src/index";

afterEach(cleanup);

/**
 * Reads a `url("…")` value back the way a CSS parser does (CSS Syntax 3 §4.3.5 "consume a string
 * token" and §4.3.7 "consume an escaped code point"), returning the string inside, or throwing
 * when the value is not exactly one complete quoted url: an unescaped newline ends the string as a
 * bad string, and anything after the closing quote but `)` means the URL escaped its string.
 * jsdom's own parser (cssstyle) is checked separately below, but it re-serializes escapes lossily
 * (`\a y` comes back as `\ay`), so it cannot prove the exact round trip by itself.
 */
function readCssUrl(value: string): string {
  const prefix = 'url("';
  if (!value.startsWith(prefix)) throw new Error(`not a quoted url: ${value}`);
  let i = prefix.length;
  let out = "";
  for (;;) {
    if (i >= value.length) throw new Error("unterminated string");
    const c = value[i] as string;
    if (c === '"') {
      i++;
      break;
    }
    if (c === "\n" || c === "\r" || c === "\f") throw new Error("bad string: raw newline");
    if (c !== "\\") {
      out += c;
      i++;
      continue;
    }
    i++;
    const next = value[i];
    if (next === undefined) throw new Error("escape at end of input");
    if (next === "\n" || next === "\r" || next === "\f") throw new Error("escaped newline");
    const hex = /^[0-9a-fA-F]{1,6}/.exec(value.slice(i))?.[0];
    if (hex) {
      i += hex.length;
      if (value.slice(i, i + 2) === "\r\n") i += 2;
      else if (/^[ \t\n\r\f]/.test(value.slice(i))) i++;
      const cp = Number.parseInt(hex, 16);
      out +=
        cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)
          ? "�"
          : String.fromCodePoint(cp);
    } else {
      out += next;
      i++;
    }
  }
  if (value.slice(i) !== ")") throw new Error(`content after the string: ${value.slice(i)}`);
  return out;
}

/** Whether jsdom's CSS parser accepts the value as one `background-image` and nothing else. */
function jsdomAcceptsAsOneUrl(value: string): boolean {
  const el = document.createElement("div");
  el.style.cssText = `background-image: ${value}; color: blue`;
  return el.style.getPropertyValue("background-image") !== "" && el.style.color === "blue";
}

const NASTY = [
  'a"b',
  "a\\b",
  "a\nb",
  "a\r\nb",
  "tab\there",
  "\u0001\u001f\u007f",
  'x"); background: url("//evil.example/a.png',
  "trailing\\",
  "a\\22 b",
  "\\a  spaced",
  "/api/v1/themes/7c1f/2/assets/brand%2Fart.svg",
  "émoji 🐹 ok",
];

describe("cssUrlValue", () => {
  it("cssUrlValue escapes quote, backslash and newline", () => {
    expect(cssUrlValue('a"b')).toBe('url("a\\22 b")');
    expect(cssUrlValue("a\\b")).toBe('url("a\\5c b")');
    expect(cssUrlValue("a\nb")).toBe('url("a\\a b")');
    expect(cssUrlValue("a\rb")).toBe('url("a\\d b")');
    expect(cssUrlValue("a\fb")).toBe('url("a\\c b")');
    expect(cssUrlValue("\u0000\u0001\u001f\u007f")).toBe('url("\\0 \\1 \\1f \\7f ")');
    expect(cssUrlValue("/api/v1/themes/x/1/assets/a.svg")).toBe(
      'url("/api/v1/themes/x/1/assets/a.svg")',
    );
    for (const u of NASTY) {
      const v = cssUrlValue(u);
      // nothing but the escaped forms: no raw quote, newline or control character inside
      // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting their absence
      expect(v.slice(5, -2)).not.toMatch(/["\u0000-\u001f\u007f]/);
      expect(readCssUrl(v)).toBe(u);
      expect(jsdomAcceptsAsOneUrl(v)).toBe(true);
    }
    // NUL cannot survive CSS at all (a parser reads it as U+FFFD); it stays inside the string
    expect(readCssUrl(cssUrlValue("a\u0000b"))).toBe("a�b");
  });

  it("a lone surrogate becomes U+FFFD; a surrogate pair stays", () => {
    expect(cssUrlValue("a\uD800b")).toBe('url("a\uFFFDb")');
    expect(cssUrlValue("a\uDC00")).toBe('url("a\uFFFD")');
    expect(cssUrlValue("\uDC00\uD800")).toBe('url("\uFFFD\uFFFD")');
    expect(cssUrlValue("🐹")).toBe('url("🐹")');
    // well formed: survives a UTF-8 round trip unchanged
    const v = cssUrlValue("x\uDBFFy\uD83D");
    expect(new TextDecoder().decode(new TextEncoder().encode(v))).toBe(v);
  });

  it('a URL with ")" and ";" stays inside the string', () => {
    const u = "/a.svg); color: red; --y: (";
    const v = cssUrlValue(u);
    expect(v).toBe('url("/a.svg); color: red; --y: (")');
    expect(readCssUrl(v)).toBe(u);
    const el = document.createElement("div");
    el.style.cssText = `background-image: ${v}`;
    expect(el.style.color).toBe("");
    expect(el.style.getPropertyValue("--y")).toBe("");
    expect(el.style.getPropertyValue("background-image")).not.toBe("");
  });

  it("an unescaped value would break out (the check above is not vacuous)", () => {
    expect(() => readCssUrl('url("a"); color: red; ("")')).toThrow();
    expect(() => readCssUrl('url("a\nb")')).toThrow();
    expect(jsdomAcceptsAsOneUrl('url("a"b")')).toBe(false);
  });

  it("brandArtStyle sets only --cb-brand-art", () => {
    const style = brandArtStyle('/a"b.svg');
    expect(Object.keys(style)).toEqual(["--cb-brand-art"]);
    expect(style["--cb-brand-art"]).toBe(cssUrlValue('/a"b.svg'));
    const { container } = render(<div style={style as CSSProperties} />);
    const el = container.firstElementChild as HTMLElement;
    expect(el.style.length).toBe(1);
    expect(readCssUrl(el.style.getPropertyValue("--cb-brand-art"))).toBe('/a"b.svg');
  });
});

describe("useBrandMark", () => {
  const brandOf = (markUrl: string | null): Brand => ({
    markUrl,
    wordmark: null,
    illustrationUrl: null,
    decoration: "dither",
    productName: null,
  });

  let last: ReturnType<typeof useBrandMark> = null;
  const Probe = () => {
    last = useBrandMark();
    return <span data-testid="m">{last === null ? "none" : `${last.src}:${last.failed}`}</span>;
  };

  it("is null without a brand or without a mark", () => {
    const { unmount } = render(
      <DesignProvider locale="en">
        <Probe />
      </DesignProvider>,
    );
    expect(screen.getByTestId("m").textContent).toBe("none");
    unmount();
    render(
      <DesignProvider locale="en" brand={brandOf(null)}>
        <Probe />
      </DesignProvider>,
    );
    expect(screen.getByTestId("m").textContent).toBe("none");
  });

  it("an empty markUrl is no mark", () => {
    render(
      <DesignProvider locale="en" brand={brandOf("")}>
        <Probe />
      </DesignProvider>,
    );
    expect(screen.getByTestId("m").textContent).toBe("none");
  });

  it("a src that already failed in this mount stays failed (A, B, back to A)", () => {
    const { rerender } = render(
      <DesignProvider locale="en" brand={brandOf("/a.svg")}>
        <Probe />
      </DesignProvider>,
    );
    act(() => last?.onError());
    rerender(
      <DesignProvider locale="en" brand={brandOf("/b.svg")}>
        <Probe />
      </DesignProvider>,
    );
    act(() => last?.onError());
    expect(screen.getByTestId("m").textContent).toBe("/b.svg:true");
    rerender(
      <DesignProvider locale="en" brand={brandOf("/a.svg")}>
        <Probe />
      </DesignProvider>,
    );
    expect(screen.getByTestId("m").textContent).toBe("/a.svg:true");
  });

  it("onError marks the mark failed for this mount; a new src or a new mount starts fresh", () => {
    const { rerender, unmount } = render(
      <DesignProvider locale="en" brand={brandOf("/a.svg")}>
        <Probe />
      </DesignProvider>,
    );
    expect(screen.getByTestId("m").textContent).toBe("/a.svg:false");
    act(() => last?.onError());
    expect(screen.getByTestId("m").textContent).toBe("/a.svg:true");
    rerender(
      <DesignProvider locale="en" brand={brandOf("/b.svg")}>
        <Probe />
      </DesignProvider>,
    );
    expect(screen.getByTestId("m").textContent).toBe("/b.svg:false");
    unmount();
    render(
      <DesignProvider locale="en" brand={brandOf("/b.svg")}>
        <Probe />
      </DesignProvider>,
    );
    expect(screen.getByTestId("m").textContent).toBe("/b.svg:false");
  });
});
