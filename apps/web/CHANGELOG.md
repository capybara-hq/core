# @capybara-hq/web

## 0.2.0

### Minor Changes

- 7091609: The web app moves to a left sidebar with your conversations grouped by agent, a two-row page header, stat cards on list pages, and a status bar in the content area; refined E styling (softer lines, line icons, compact sizing, a proportional font for descriptions) in dark and light.
- 208aff4: The org extensions settings page lists the file previewers (`file-preview@1`) of enabled extensions, in the order the org tries them, with up / down and an enable switch. Embed previewers receive the file over the message bridge after `init`.
  
  The conversation page is rebuilt on the `ConversationPage` template: a title bar with the generated title and rename, tool calls grouped after Claude Code (titles, key arguments, shell descriptions, diffs, failures from exit codes, "View all" for archived output), thinking rows, run dividers (stopped, failed with Retry, compacted with the saved tokens, model fallback, extension policy), the approval, question and connect blocks, file outputs, and a composer that holds the agent, model and effort pickers. ↵ sends (interjects while a run is going), ⌘↵ / Ctrl+↵ queues (with the pending model and effort pick); queued messages show under the thread with copy, edit, delete, "Send now" and "Continue sending" after a pause. "New conversation", the Agents list and a sidebar group's ＋ open `/chat` (`?agent=`), and the conversation is created on the first send. The sidebar reloads when a title changes. `PlaygroundPage` is removed.
  
  The conversation's right area holds one thing at a time, kept in the URL hash (`#properties`, `#panel=<plugin>/<contribution>[/<item>]`, `#file=<id>`, `#output=<callId>`, `#subagent=<id>`): the properties panel (Context, the extensions' sections, Files, then Background tasks), an extension's right panel (a rendered view scrolled to an open target's item, or an embed), a file preview (extension previewers first, then the built-in image, text, Markdown and CSV / TSV previewers, else the file card with Download) a call's full archived output, or a sub-agent's record (Back returns to the properties panel when it was opened from there; an org agent's name links to the agent). Extension inline cards hang off their tool calls. Each extension block loads on its own (10 s) and fails alone with "Failed to load · Retry". The Run, Context and Artifacts tabs are gone.

### Patch Changes

- 9a5a340: Claude Code plugins import from git marketplaces with a translation report; agents can pin skills;
  `skill_load` accepts `<plugin>:<name>`. `parseSkillMd` returns the whole parsed frontmatter
  (`frontmatter`) next to the name, description and body.
  
  Git marketplaces read Claude Code's `.claude-plugin/marketplace.json` (entries with an overlay of
  their component fields and `strict`; npm, archive and command sources are listed as skipped) and
  single Claude plugin repositories. A Claude Code plugin from git goes through the one import review
  with `format: "claude-code"`, a five-group translation report (covered by `reviewHash`), connector
  templates for its remote MCP servers and no extension; every review carries the root LICENSE text
  and each skill's `suggestPinned`, and confirm takes `pinnedSuggestions`. Catalog versions record
  `sourceFormat`, `translation`, `licenseText` and `licenseTruncated`; `capybara plugins import`
  prints the report. The translator takes at most 100 distinct declared paths per component key
  and parses each JSON file once.
  
  Org installs and upgrades record each skill version's source format and pinned suggestion (an
  upgrade that leaves a skill unchanged updates its current version's flag); the org and agent
  skills lists return `plugin`, `sourceFormat`, `suggestPinned`, `entryBytes` and `tokenEstimate`.
  A connector template with personal static auth asks the installer for their own credential:
  install and upgrade planning answer 400 at `connectors.<id>.credential` instead of failing at the
  connector step, and the install wizard asks for it.
  
  Agent definitions take `skills.pinned` (at most 3 selected org skills or the agent's own skills,
  SKILL.md total at most 32 KB); a refused list is 400 `agent.pinned_invalid` with one detail per
  skill and reason.
  
  The `skills_catalog` snapshot records each skill's plugin, the pinned skills' bodies (read from
  storage at run start; a read failure fails the run with `storage.unavailable`) and, when a Claude
  Code skill is present, the tool-name map; `skill_load` resolves `<plugin>:<name>`.
  
  Requests render pinned skills (in the cached system segment, as mid-conversation notices and
  after compaction) and the tool-name map from the log; step replays report `pinned_changed` when a
  candidate pins other skills.
  
  The web import review shows a Claude Code plugin's translation report (five groups with localized
  reasons), its `repository` (display only), each skill's SKILL.md and the LICENSE text (collapsed),
  and "suggest pinned" checkboxes (expanded when the plugin has a SessionStart hook) sent as
  `pinnedSuggestions`; the catalog item shows the format, report and license (or that it was too
  long), and the marketplaces page lists the entries a refresh skipped with the reason (the first
  20 and how many more). Text with bidi or control characters gets a warning line.
  
  The agent page pins skills: selected skills each get a "pin" checkbox (a plugin's suggested skill
  is ticked when selected, a deselected skill is unpinned), with the token estimate, the count limit
  and an over-32 KB warning; `agent.pinned_invalid` shows one line per skill and reason. A reply that
  cannot read the agent's pinned skills, or whose pinned skills changed while it started, says so.
- 7f9627d: The web conversation page shows sub-agents (UI refresh B's components): the `agent` calls of a step
  as one sub-agent group with status, calls and duration (live from `subagent_progress`), a row that
  opens the child read-only in the right panel (`#subagent=<id>`; inbox and IM links with
  `?subagent=<id>` open it too) with its task, its own thread, Stop and a read-only status bar, a
  sub-agent's approvals and questions in the parent under its name (only the conversation's starter
  can act), a Background tasks section in the properties panel, and the total tokens with sub-agents
  in the Context section; trajectories link agent calls and parents both ways.
  
  The agent page has a Sub-agents section (the agent tool, general-purpose, plugin templates from the
  new `GET /agent-templates`, inline templates, allowlisted org agents with their warnings, and
  "Can be used as a sub-agent by other agents"); the import review and catalog item list agent
  templates; the purposes page explains the three sub-agent tiers; the admin console sets
  per-organization sub-agent limits.
  
  A sub-agent opened from the address bar must belong to the conversation; a sub-agent's question for
  someone else shows who it waits for; the plugin upgrade dialog lists agent template changes and an
  organization's catalog item lists the plugin's agent templates.
- 49c3156: The import review names the phase D translation codes (`command_imported`, `skill_manual_only`,
  `skill_forked`, `command_invalid`, `skill_shell_injection`, `skill_agent_unknown`,
  `skill_invocation_key_ignored`, `skill_file_reference`); the codes no
  longer emitted read as "not supported when this version was imported".
  
  Copy for the new error code `skill.not_invocable`.
  
  Skills in the conversation (phase D): `/` in an empty composer lists the agent's skills first
  (sorted, with the argument hint, the "manual" / "sub-agent" tags and the plugin's name, searchable
  by `<plugin>:<name>`), then the connector prompts. Picking one shows the skill chip; the text after it
  is the arguments (Backspace at the start or the chip's x removes it). A draft typed as
  `/name args` that names one of the agent's skills is sent as its invocation, anything else as
  text; ⌘↵ queues an invocation, and the queued bubble shows its chip. The bubble of an invocation
  shows the chip, the arguments and a "Skill instructions" disclosure with what was sent; a forked
  skill shows its sub-agent row and a "Report" disclosure; a plain message that waits for a forked
  skill's sub-agent says so. Retry repeats a failed invocation. A queue paused because its first
  message's author can no longer send, or its skill can no longer be used, says why. The agent page
  tags manual and sub-agent skills, does not let a manual skill be pinned, warns about a pinned
  skill that became manual, and names the `manual_only` refusal.
  
  Text typed while a message is still being sent is kept when the send returns (only what was sent
  is cleared). Below 1280 px the conversation page no longer draws its right panel beside the thread
  for a moment before it becomes a sheet (the page could scroll sideways until the page was ready).
  
  The ⌘K palette filters like the `/` menu: by prefix, then substring, of the label (and its hidden
  search text), then of the description; scattered letters ("nwcv") no longer match.
