import {
  AGENT_TEMPLATE_INSTRUCTION_FILE_NAME_RE,
  AGENT_TEMPLATE_LIMITS,
} from "@capybara-hq/plugin-sdk";
import { describe, expect, it } from "vitest";
import {
  INSTRUCTION_FILE_LIMITS,
  INSTRUCTION_FILE_NAME_RE,
} from "../../src/agents/instruction-files.js";
import { PROFILE_LIMITS } from "../../src/agents/profile.js";

describe("agent template limits mirror the agent's", () => {
  it("quick actions and instruction files", () => {
    const L = AGENT_TEMPLATE_LIMITS;
    expect(L.quickActions).toBe(PROFILE_LIMITS.quickActions);
    expect(L.quickActionTitleChars).toBe(PROFILE_LIMITS.title);
    expect(L.quickActionBodyChars).toBe(PROFILE_LIMITS.body);
    expect(L.instructionFiles).toBe(INSTRUCTION_FILE_LIMITS.count);
    expect(L.instructionFilesChars).toBe(INSTRUCTION_FILE_LIMITS.joinedChars);
    expect(AGENT_TEMPLATE_INSTRUCTION_FILE_NAME_RE.source).toBe(INSTRUCTION_FILE_NAME_RE.source);
  });
});
