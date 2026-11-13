# Authoring: extension point context

<!-- generated:extension-point -->
- Name: `context` (a ref is `context@<major>`)
- Adds text to the model's context at run start in conversations of orgs that enable it.
- Providers: several
- Enabled per org: yes
- Brokered by the platform: yes (extensions use it only through `ctx`)
<!-- /generated -->

Contract: ContextProvider (`context.ts`)

Return the text the model should see at the start of a run, or null. The kernel calls every provider enabled in the org once per run, only in `chat` conversations (not evals or sub-agents), with the run's source, the trigger account and its org role, the conversation owner and the tool keys. A call is limited to 2 seconds and 32 KB of text and fails open: a timeout or error adds nothing and the run goes on. The text is recorded in the conversation log only when its hash changes.

See `extensions` for the rules every extension follows.
