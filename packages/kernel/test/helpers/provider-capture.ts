import type { ModelProvider, ModelRequest } from "@capybara-hq/plugin-sdk";
import { TITLE_PROMPT } from "../../src/conversations/titles.js";
import { COMPACTION_MARKER } from "../../src/runtime/context/compaction.js";
import { ProviderRegistry } from "../../src/runtime/providers.js";
import { WEB_FETCH_SYSTEM_PROMPT } from "../../src/tools/builtins/web/extract.js";

/**
 * Captures every request a model provider actually receives, by wrapping
 * `ProviderRegistry.prototype.resolve` (process-wide: `install()` in `beforeAll` before the kernel
 * starts, `restore()` in `afterAll`). Zero-drift tests compare `reconstructRequest` with these.
 */
export interface ProviderCapture {
  /**
   * Requests in the order they were sent, compaction, title and WebFetch extraction requests left
   * out (deep copies).
   */
  readonly sent: ModelRequest[];
  /** Compaction requests (their system carries the compaction marker). */
  readonly compactions: ModelRequest[];
  /** Conversation title requests (UI refresh B; their system is the title prompt). */
  readonly titles: ModelRequest[];
  /** `WebFetch` extraction requests (their system is the extraction prompt). */
  readonly webFetches: ModelRequest[];
  /** Empties every list. */
  reset(): void;
  /** Wraps `resolve`; from now on every provider request is recorded. */
  install(): void;
  /** Puts the original `resolve` back. */
  restore(): void;
}

export function captureProviderRequests(): ProviderCapture {
  const sent: ModelRequest[] = [];
  const compactions: ModelRequest[] = [];
  const titles: ModelRequest[] = [];
  const webFetches: ModelRequest[] = [];
  const originalResolve = ProviderRegistry.prototype.resolve;
  return {
    sent,
    compactions,
    titles,
    webFetches,
    reset() {
      sent.length = 0;
      compactions.length = 0;
      titles.length = 0;
      webFetches.length = 0;
    },
    install() {
      ProviderRegistry.prototype.resolve = async function (this: ProviderRegistry, ref) {
        const r = await originalResolve.call(this, ref);
        const inner = r.provider;
        const provider: ModelProvider = {
          listModels: () => inner.listModels(),
          stream(req, opts) {
            const copy = structuredClone(req);
            if (req.system.some((s) => s.text.includes(COMPACTION_MARKER))) compactions.push(copy);
            else if (req.system.some((s) => s.text === TITLE_PROMPT)) titles.push(copy);
            else if (req.system.some((s) => s.text === WEB_FETCH_SYSTEM_PROMPT)) {
              webFetches.push(copy);
            } else sent.push(copy);
            return inner.stream(req, opts);
          },
        };
        return { ...r, provider };
      };
    },
    restore() {
      ProviderRegistry.prototype.resolve = originalResolve;
    },
  };
}
