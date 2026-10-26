import type { ModelProvider, ModelRequest } from "@capybara-hq/plugin-sdk";
import { COMPACTION_MARKER } from "../../src/runtime/context/compaction.js";
import { ProviderRegistry } from "../../src/runtime/providers.js";

/**
 * Captures every request a model provider actually receives, by wrapping
 * `ProviderRegistry.prototype.resolve` (process-wide: `install()` in `beforeAll` before the kernel
 * starts, `restore()` in `afterAll`). Zero-drift tests compare `reconstructRequest` with these.
 */
export interface ProviderCapture {
  /** Requests in the order they were sent, compaction requests left out (deep copies). */
  readonly sent: ModelRequest[];
  /** Compaction requests (their system carries the compaction marker). */
  readonly compactions: ModelRequest[];
  /** Empties both lists. */
  reset(): void;
  /** Wraps `resolve`; from now on every provider request is recorded. */
  install(): void;
  /** Puts the original `resolve` back. */
  restore(): void;
}

export function captureProviderRequests(): ProviderCapture {
  const sent: ModelRequest[] = [];
  const compactions: ModelRequest[] = [];
  const originalResolve = ProviderRegistry.prototype.resolve;
  return {
    sent,
    compactions,
    reset() {
      sent.length = 0;
      compactions.length = 0;
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
            else sent.push(copy);
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
