import { expect, type Locator, type Page, test } from "@playwright/test";
import { openInteractive } from "./reference-page";

/**
 * The composer editor's caret, deletion, IME and token centring (composer inline tokens spec §1,
 * §2), in Chromium and WebKit (the `webkit` project runs only this spec). Runs on the live
 * `/dev/ui/reference/composer-editor` blocks; each block's hidden probe shows the open trigger and
 * the number of sends.
 */
const block = (page: Page, id: string) => page.locator(`[data-ref-block="composer-editor-${id}"]`);
const editorOf = (b: Locator) => b.locator('[contenteditable="true"]');
const probeOf = (b: Locator) => b.locator('[data-probe="composer-editor"]');

async function open(page: Page) {
  await openInteractive(page, "/dev/ui/reference/composer-editor");
}

/** Puts the caret in the editor's `n`th text node (0-based) at `offset`. */
async function caretAt(editor: Locator, n: number, offset: number) {
  await editor.focus();
  await editor.evaluate(
    (root, [i, o]) => {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        // text inside a token is not the editor's text
        acceptNode: (t) =>
          t.parentElement?.closest("[data-lexical-decorator]")
            ? NodeFilter.FILTER_REJECT
            : NodeFilter.FILTER_ACCEPT,
      });
      let node: Node | null = walker.nextNode();
      for (let k = 0; k < (i as number) && node; k++) node = walker.nextNode();
      if (!node) throw new Error("no such text node");
      const sel = window.getSelection();
      sel?.removeAllRanges();
      const r = document.createRange();
      r.setStart(node, o as number);
      r.collapse(true);
      sel?.addRange(r);
    },
    [n, offset],
  );
}

/** The editor's text before the caret, each token as `[label]`. */
const beforeCaret = (editor: Locator) =>
  editor.evaluate((root) => {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return null;
    const r = document.createRange();
    r.setStart(root, 0);
    r.setEnd(sel.focusNode as Node, sel.focusOffset);
    const part = r.cloneContents();
    for (const t of part.querySelectorAll("[data-lexical-decorator]")) {
      const label = t.querySelector('[data-part="inline-token-label"]')?.textContent ?? "";
      t.replaceWith(`[${label}]`);
    }
    return part.textContent;
  });

const tokens = (b: Locator) => b.locator('[data-part="inline-token"]');
const isMac = process.platform === "darwin";

test("arrow keys step over a token", async ({ page }) => {
  await open(page);
  const b = block(page, "selected");
  const editor = editorOf(b);
  // the caret after the first text, right before the Slack token
  await caretAt(editor, 0, 2);
  await expect.poll(() => beforeCaret(editor)).toBe("给 ");
  await page.keyboard.press("ArrowRight");
  await expect.poll(() => beforeCaret(editor)).toBe("给 [Slack]");
  await page.keyboard.press("ArrowRight");
  await expect.poll(() => beforeCaret(editor)).toBe("给 [Slack] ");
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowLeft");
  await expect.poll(() => beforeCaret(editor)).toBe("给 ");
});

test("Shift+Arrow selects a token as a unit", async ({ page }) => {
  await open(page);
  const b = block(page, "refused");
  const editor = editorOf(b);
  await caretAt(editor, 0, 2);
  await page.keyboard.press("Shift+ArrowRight");
  // the selection runs from before the token to after it, never into it
  await expect.poll(() => beforeCaret(editor)).toBe("给 [Lark]");
  await expect(tokens(b).first()).toHaveAttribute("data-selected", "true");
  await page.keyboard.press("Shift+ArrowLeft");
  await expect.poll(() => beforeCaret(editor)).toBe("给 ");
  await expect(tokens(b).first()).not.toHaveAttribute("data-selected", "true");
});

test("click selects a token (accent outline)", async ({ page }) => {
  await open(page);
  const b = block(page, "tokens");
  const token = tokens(b).nth(1);
  await token.click();
  await expect(token).toHaveAttribute("data-selected", "true");
  const outline = await token.evaluate((e) => {
    const cs = getComputedStyle(e);
    const accent = getComputedStyle(document.documentElement).getPropertyValue("--cb-accent");
    const probe = document.createElement("span");
    probe.style.color = accent;
    document.body.append(probe);
    const want = getComputedStyle(probe).color;
    probe.remove();
    return { style: cs.outlineStyle, width: cs.outlineWidth, same: cs.outlineColor === want };
  });
  expect(outline).toEqual({ style: "solid", width: "1px", same: true });
});

test("Delete before a token removes it", async ({ page }) => {
  await open(page);
  const b = block(page, "selected");
  const editor = editorOf(b);
  await caretAt(editor, 0, 2);
  await page.keyboard.press("Delete");
  await expect(tokens(b)).toHaveCount(0);
  await expect(editor).toHaveText("给  发消息");
});

test("Backspace after a token removes it", async ({ page }) => {
  await open(page);
  const b = block(page, "refused");
  const editor = editorOf(b);
  // the caret at the start of the text after the Lark token
  await caretAt(editor, 1, 0);
  await page.keyboard.press("Backspace");
  await expect(tokens(b)).toHaveCount(0);
  await expect(editor).toHaveText("给  发消息");
});

test("word delete removes the previous token", async ({ page }) => {
  await open(page);
  const b = block(page, "skill");
  const editor = editorOf(b);
  // the caret right after the skill token
  await caretAt(editor, 0, 0);
  await page.keyboard.press(isMac ? "Alt+Backspace" : "Control+Backspace");
  await expect(tokens(b)).toHaveCount(0);
});

test("IME composition holds triggers and Enter", async ({ page, browserName }) => {
  await open(page);
  const b = block(page, "empty");
  const editor = editorOf(b);
  const probe = probeOf(b);
  await editor.click();
  await page.keyboard.type("ask ");
  const composing = async (text: string) => {
    if (browserName === "chromium") {
      const cdp = await page.context().newCDPSession(page);
      await cdp.send("Input.imeSetComposition", {
        text,
        selectionStart: text.length,
        selectionEnd: text.length,
      });
      return {
        commit: async () => {
          await cdp.send("Input.insertText", { text });
        },
      };
    }
    // WebKit has no IME driver: the composition events around a trusted insertion, then desktop
    // WebKit's commit (`insertFromComposition`, nothing left to insert: the text is in place)
    await editor.evaluate((el, data) => {
      el.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "" }));
      el.dispatchEvent(new CompositionEvent("compositionupdate", { bubbles: true, data }));
    }, text);
    await page.keyboard.insertText(text);
    return {
      commit: async () => {
        await editor.evaluate((el, data) => {
          el.dispatchEvent(
            new InputEvent("beforeinput", {
              bubbles: true,
              cancelable: true,
              inputType: "insertFromComposition",
              data: "",
            }),
          );
          el.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data }));
        }, text);
      },
    };
  };
  const ime = await composing("@");
  // the intermediate text opens nothing
  await expect(probe).toHaveAttribute("data-trigger", "null");
  // ↵ during the composition (an IME's confirm key) never sends
  await editor.evaluate((el) => {
    el.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        keyCode: 229,
        isComposing: true,
        bubbles: true,
      }),
    );
  });
  await expect(probe).toHaveAttribute("data-submits", "0");
  await ime.commit();
  // the committed `@` opens the menu as typed
  await expect
    .poll(async () => JSON.parse((await probe.getAttribute("data-trigger")) ?? "null"))
    .toEqual({ trigger: "@", query: "", atStart: false });
  // ↵ after the composition sends
  await page.keyboard.press("Enter");
  await expect(probe).toHaveAttribute("data-submits", "1");
});

test("full-width ＠ committed by an IME is not a trigger", async ({ page }) => {
  await open(page);
  const b = block(page, "empty");
  await editorOf(b).click();
  await page.keyboard.insertText("＠");
  await page.keyboard.type("sl");
  await expect(probeOf(b)).toHaveAttribute("data-trigger", "null");
});

for (const width of [1280, 390]) {
  test(`token centring at ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await open(page);
    const b = block(page, "selected");
    const centres = await editorOf(b).evaluate((root) => {
      const label = root.querySelector('[data-part="inline-token-label"]')?.firstChild;
      const text = root.querySelector("[data-lexical-text]")?.firstChild;
      if (!label || !text) throw new Error("no token or text");
      const mid = (n: Node) => {
        const r = document.createRange();
        r.selectNodeContents(n);
        const box = r.getBoundingClientRect();
        return box.top + box.height / 2;
      };
      return { label: mid(label), text: mid(text) };
    });
    expect(Math.abs(centres.label - centres.text)).toBeLessThanOrEqual(1);
  });
}

test("grows to 8 lines then scrolls", async ({ page }) => {
  await open(page);
  const b = block(page, "empty");
  const editor = editorOf(b);
  await editor.click();
  const line = await editor.evaluate((e) => Number.parseFloat(getComputedStyle(e).lineHeight));
  const empty = await editor.evaluate((e) => e.getBoundingClientRect().height);
  expect(empty).toBeCloseTo(line, 0);
  for (let i = 0; i < 4; i++) {
    await page.keyboard.type(`line ${i}`);
    await page.keyboard.press("Shift+Enter");
  }
  const four = await editor.evaluate((e) => e.getBoundingClientRect().height);
  expect(four).toBeCloseTo(5 * line, 0);
  for (let i = 4; i < 12; i++) {
    await page.keyboard.type(`line ${i}`);
    await page.keyboard.press("Shift+Enter");
  }
  const full = await editor.evaluate((e) => ({
    height: e.getBoundingClientRect().height,
    scrolls: e.scrollHeight > e.clientHeight,
  }));
  expect(full.height).toBeCloseTo(8 * line, 0);
  expect(full.scrolls).toBe(true);
  // nothing was sent by Shift+Enter
  await expect(probeOf(b)).toHaveAttribute("data-submits", "0");
});
