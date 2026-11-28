import { describe, expect, it } from "vitest";
import {
  effectivePromptCacheSettings,
  PROMPT_CACHE_SETTINGS,
  PROMPT_CACHE_SETTINGS_PATCH,
} from "../../src/identity/settings.js";

describe("prompt cache settings", () => {
  it("defaults longTtl to false", () => {
    expect(PROMPT_CACHE_SETTINGS.parse({})).toEqual({ longTtl: false });
  });

  it("lets an org override win and follows the platform without one", () => {
    expect(effectivePromptCacheSettings({ longTtl: false }, { longTtl: true })).toEqual({
      longTtl: true,
    });
    expect(effectivePromptCacheSettings({ longTtl: true }, undefined)).toEqual({ longTtl: true });
    expect(effectivePromptCacheSettings({ longTtl: true }, {})).toEqual({ longTtl: true });
  });

  it("rejects a misspelled field in a patch", () => {
    expect(PROMPT_CACHE_SETTINGS_PATCH.safeParse({ longTTL: true }).success).toBe(false);
    expect(PROMPT_CACHE_SETTINGS_PATCH.safeParse({ longTtl: true }).success).toBe(true);
  });
});
