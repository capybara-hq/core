/**
 * Changes what the page itself reports (its URL, the frame it runs in) for one test. The web project
 * runs in a vm pool, where `window` is jsdom's real global: `location` and `top` cannot be stubbed or
 * spied, so tests reconfigure the jsdom instance Vitest exposes and put it back afterwards.
 */
type Jsdom = { reconfigure(options: { url?: string; windowTop?: unknown }): void };

function jsdom(): Jsdom {
  const j = (globalThis as { jsdom?: Jsdom }).jsdom;
  if (j === undefined) throw new Error("the jsdom environment exposes no `jsdom` instance");
  return j;
}

/** Runs `fn` with the page at `url` (for example `https:` to test what only a secure page does). */
export function withPageUrl<T>(url: string, fn: () => T): T {
  const before = window.location.href;
  jsdom().reconfigure({ url });
  try {
    return fn();
  } finally {
    jsdom().reconfigure({ url: before });
  }
}

/** Runs `fn` as if the page were inside a frame: `window.top` is another window. */
export function insideFrame<T>(fn: () => T): T {
  jsdom().reconfigure({ windowTop: {} });
  try {
    return fn();
  } finally {
    jsdom().reconfigure({ windowTop: window });
  }
}
