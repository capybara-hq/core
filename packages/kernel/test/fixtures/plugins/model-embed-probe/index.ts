import {
  defineExtension,
  type EmbedRequest,
  MODEL_PROVIDER_EXTENSION_POINT_V2,
  type ModelStreamEvent,
} from "@capybara-hq/plugin-sdk";

/** What the probe saw and how it answers (shared with the test through globalThis). */
export interface EmbedProbeState {
  /** Each `embed` call's request, in call order. */
  calls: EmbedRequest[];
  /** Whether the call's signal was an AbortSignal (the extension's `ctx.signal`). */
  signals: boolean[];
  /** Answer with vectors of the wrong dimension (3). */
  wrongDimension: boolean;
}

export function embedProbe(): EmbedProbeState {
  const g = globalThis as { __embedProbe?: EmbedProbeState };
  g.__embedProbe ??= { calls: [], signals: [], wrongDimension: false };
  return g.__embedProbe;
}

/**
 * A model provider with one embedding model, `probe-embed` (dimensions 8 or 16, default 8; at most
 * 4 inputs per call), for `ctx.models` tests (spec B §5.4). Input `t<n>` embeds to a vector whose
 * first value is `n`, so a test can check the order; each call reports one input token per input.
 */
export default defineExtension({
  name: "model-embed-probe",
  version: "0.1.0",
  sdk: "^0.1.0-rc.0",
  provides: [MODEL_PROVIDER_EXTENSION_POINT_V2],
  setup(ctx) {
    ctx.provide(MODEL_PROVIDER_EXTENSION_POINT_V2, {
      async listModels() {
        return [
          {
            id: "probe-embed",
            displayName: "probe-embed",
            kind: "embedding",
            contextWindow: 512,
            maxOutputTokens: 1,
            capabilities: {
              tools: false,
              vision: false,
              reasoning: false,
              caching: false,
              midConversationSystem: false,
            },
            parameters: [],
            embedding: {
              dimensions: [8, 16],
              defaultDimensions: 8,
              maxInputTokens: 512,
              maxBatch: 4,
            },
          },
        ];
      },
      // biome-ignore lint/correctness/useYield: an embedding-only provider never streams
      async *stream(): AsyncIterable<ModelStreamEvent> {
        throw new Error("probe-embed does not chat");
      },
      async embed(req: EmbedRequest, opts: { signal: AbortSignal }) {
        const s = embedProbe();
        s.calls.push(structuredClone(req));
        s.signals.push(opts.signal instanceof AbortSignal);
        const dim = s.wrongDimension ? 3 : (req.dimensions ?? 8);
        return {
          vectors: req.input.map((t) => {
            const v = new Array<number>(dim).fill(0);
            v[0] = Number(t.replace(/^t/, "")) || 0;
            return v;
          }),
          usage: { inputTokens: req.input.length },
        };
      },
    });
  },
});
