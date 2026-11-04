/**
 * The Claude Code tool-name map (phase B, spec §9.4): skills written for Claude Code name its tools
 * (`Bash`, `Read`, `Skill`, …). When a conversation's skills include one from a Claude Code plugin,
 * the run start writes this text into the `skills_catalog` snapshot (`toolMap`), and request
 * building renders it from the log, so a replay never depends on this constant. Model-visible:
 * English, fixed (Decision 15: not tailored to the agent's tools; it says "when it is in your
 * tools" instead). Changing it only affects snapshots written afterwards: a conversation's next
 * run writes a new snapshot announcing the new map, and old snapshots keep their text (phase C
 * changed the Task / Agent line, sub-agents spec §16.5; the tool-naming change shortened it to the
 * Claude Code names, spec 2026-10-29 §6; background Bash made TaskOutput and TaskStop available,
 * spec 2026-11-05 §4.4).
 */
export const CLAUDE_CODE_TOOL_MAP = [
  "Some skills in this conversation were written for Claude Code. Its tools Bash, Read, Write, Edit,",
  "Glob, Grep, Skill, AskUserQuestion, ToolSearch and Agent have the same names here, when they are",
  "in your tools. For the others:",
  "- MultiEdit -> several Edit calls",
  "- TodoWrite -> plugin__todo__write when it is in your tools; otherwise keep the task list in your replies",
  "- Task -> Agent; SendMessage to a sub-agent -> Agent with resume; model names haiku / sonnet / opus -> fast / standard / capable",
  "- TaskOutput -> TaskOutput, TaskStop -> TaskStop",
  "- Any other tool a skill names (for example WebFetch, WebSearch, NotebookEdit, EnterWorktree) -> not available unless one of your tools does the same job",
  // biome-ignore lint/suspicious/noTemplateCurlyInString: the literal Claude Code variable the model reads
  "The sandbox tools exist only when this agent has a sandbox; without them a skill's scripts cannot run. A path such as ${CLAUDE_PLUGIN_ROOT}/skills/<name>/... means /skills/<name>/... after Skill has copied that skill into the sandbox.",
].join("\n");
