/**
 * The Claude Code tool-name map (phase B, spec §9.4): skills written for Claude Code name its tools
 * (`Bash`, `Read`, `Skill`, …). When a conversation's skills include one from a Claude Code plugin,
 * the run start writes this text into the `skills_catalog` snapshot (`toolMap`), and request
 * building renders it from the log, so a replay never depends on this constant. Model-visible:
 * English, fixed (Decision 15: not tailored to the agent's tools; it says "when it is in your
 * tools" instead). Changing it only affects snapshots written afterwards.
 */
export const CLAUDE_CODE_TOOL_MAP = [
  "Some skills in this conversation were written for Claude Code and name its tools. Use these tools instead:",
  "- Bash -> sandbox_bash",
  "- Read -> sandbox_read; Write -> sandbox_write; Edit and MultiEdit -> sandbox_edit; Glob -> sandbox_glob; Grep -> sandbox_grep",
  '- Skill -> skill_load (a name such as "superpowers:brainstorming" also works)',
  "- TodoWrite -> todo__write when it is in your tools; otherwise keep the task list in your replies",
  "- AskUserQuestion -> ask_user",
  "- ToolSearch -> tool_search when it is in your tools",
  "- Task and Agent (sub-agents) -> not available: do the steps yourself, in order",
  "- Any other tool a skill names (for example WebFetch, WebSearch, NotebookEdit, EnterWorktree) -> not available unless one of your tools does the same job",
  // biome-ignore lint/suspicious/noTemplateCurlyInString: the literal Claude Code variable the model reads
  "The sandbox tools exist only when this agent has a sandbox; without them a skill's scripts cannot run. A path such as ${CLAUDE_PLUGIN_ROOT}/skills/<name>/... means /skills/<name>/... after skill_load has copied that skill into the sandbox.",
].join("\n");
