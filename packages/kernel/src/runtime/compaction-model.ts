import { type ModelInfo, type ParamValue, sanitizeParams } from "@capybara-hq/plugin-sdk";
import type { ModelRef } from "../agents/definition.js";
import { ApiError } from "../errors.js";
import type { CompactionSettings } from "../identity/settings.js";
import type { ModelPurposesService, PurposeTarget } from "../models/purposes.js";
import { compactionModelEligible, compactionSummaryCap } from "./context/compaction.js";
import type { ModelStepDeps } from "./model-call.js";
import type { BoundProvider } from "./providers.js";

/** The org's effective `compaction` mapping, or null when it is unconfigured there. */
export interface CompactionModelPort {
  target(orgId: string): Promise<PurposeTarget | null>;
}

/**
 * Wraps `ModelPurposesService.resolve(orgId, "compaction")` (compaction model spec §4.2):
 * `model.unconfigured` (unmapped, or a target the org cannot use) → null; any other error is
 * rethrown. A `ProviderListError` passes `resolve` with the mapping, so the summarizer choice
 * resolves the model again and falls back there. Reads PG each time (nothing cached): callers never
 * hold a transaction open around it, since the resolve may list a provider's models.
 */
export function compactionModelPort(
  purposes: Pick<ModelPurposesService, "resolve">,
): CompactionModelPort {
  return {
    async target(orgId) {
      try {
        return await purposes.resolve(orgId, "compaction");
      } catch (err) {
        if (err instanceof ApiError && err.code === "model.unconfigured") return null;
        throw err;
      }
    },
  };
}

/** The model that writes one compaction's summary (compaction model spec §3, §5.1). */
export interface Summarizer {
  /** The compaction model C, or the conversation model V (the fallback). */
  source: "compaction_model" | "conversation";
  /** The configured ref: what the hooks, the usage events and `compaction_summary.model` name. */
  ref: ModelRef;
  provider: BoundProvider;
  info: ModelInfo;
  /** The request parameters: C's mapping sanitized against `info.parameters`; `{}` for V. */
  params: Record<string, ParamValue>;
  /** The summary cap `Cmax` ({@link compactionSummaryCap}). */
  cap: number;
}

/** Why V summarizes although the purpose was looked up (§4.2 table). */
export type SummarizerFallback =
  /** No port, or no effective mapping the org can use. */
  | "unconfigured"
  /** The mapping passed `resolve` (a provider list error) but the registry cannot resolve C. */
  | "compaction_model_unavailable"
  /** C's window leaves no useful chunk (§4.3). */
  | "compaction_model_small";

/**
 * §4.2 / §4.3: C when mapped, resolvable and eligible; else V with the reason (logged at `warn` for
 * unavailable, `debug` for small, not at all for unconfigured; `context=Compaction`). Never throws
 * for C's failures; an error of the port other than unconfigured (a failed PG read) propagates, so
 * the compaction fails instead of silently summarizing on V.
 *
 * The cap is `min(setting, V max)` on V (today's) and `min(setting, C max, V max)` on C: a
 * large-output summarizer never writes a longer summary than V would (§5.1). Eligibility is
 * judged with C's cap and window against the settings' reserve.
 */
export async function chooseSummarizer(
  deps: Pick<ModelStepDeps, "compactionModel" | "registry" | "log">,
  orgId: string,
  conversation: { ref: ModelRef; provider: BoundProvider; info: ModelInfo },
  settings: Pick<CompactionSettings, "maxOutputTokens" | "reserveTokens">,
): Promise<{ summarizer: Summarizer; fallback?: SummarizerFallback }> {
  const onConversation = (
    fallback: SummarizerFallback,
  ): { summarizer: Summarizer; fallback: SummarizerFallback } => ({
    summarizer: {
      source: "conversation",
      ref: conversation.ref,
      provider: conversation.provider,
      info: conversation.info,
      params: {},
      cap: compactionSummaryCap(settings.maxOutputTokens, conversation.info.maxOutputTokens),
    },
    fallback,
  });
  if (deps.compactionModel === undefined) return onConversation("unconfigured");
  const target = await deps.compactionModel.target(orgId);
  if (target === null) return onConversation("unconfigured");

  let provider: BoundProvider;
  let info: ModelInfo;
  try {
    ({ provider, info } = await deps.registry.resolve(orgId, target.model));
  } catch (err) {
    deps.log.warn("compaction model unavailable; summarizing with the conversation model", {
      context: "Compaction",
      reason: "compaction_model_unavailable",
      model: target.model,
      err,
    });
    return onConversation("compaction_model_unavailable");
  }
  const cap = compactionSummaryCap(
    settings.maxOutputTokens,
    conversation.info.maxOutputTokens,
    info.maxOutputTokens,
  );
  if (!compactionModelEligible(info.contextWindow, cap, settings.reserveTokens)) {
    deps.log.debug?.("compaction model window too small; summarizing with the conversation model", {
      context: "Compaction",
      reason: "compaction_model_small",
      model: target.model,
      contextWindow: info.contextWindow,
    });
    return onConversation("compaction_model_small");
  }
  return {
    summarizer: {
      source: "compaction_model",
      ref: target.model,
      provider,
      info,
      // undeclared or unfitting values are dropped, as `ModelPurposesService.chat` does (§4.5)
      params: sanitizeParams(info.parameters, target.params).value,
      cap,
    },
  };
}
