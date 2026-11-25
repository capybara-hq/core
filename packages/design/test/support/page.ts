/**
 * Runs `fn` as if the page were inside a frame: `window.top` is another window. The design project
 * runs in a vm pool, where `window` is jsdom's real global and `top` cannot be spied, so this
 * reconfigures the jsdom instance Vitest exposes and puts it back afterwards.
 */
export function insideFrame<T>(fn: () => T): T {
  const jsdom = (globalThis as { jsdom?: { reconfigure(o: { windowTop: unknown }): void } }).jsdom;
  if (jsdom === undefined) throw new Error("the jsdom environment exposes no `jsdom` instance");
  jsdom.reconfigure({ windowTop: {} });
  try {
    return fn();
  } finally {
    jsdom.reconfigure({ windowTop: window });
  }
}
