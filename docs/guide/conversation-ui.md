# The conversation page's right panel and extension UI

The middle of the conversation page is the conversation, with tool calls shown as one line each on a timeline (if the tool provided a display summary, that sentence is shown, such as "Update task list (4 items)"; expand to see the full input and output). On the right is a collapsible tab panel:

- Tabs built into the kernel: "Runs" (all tool calls of this conversation, with an alert mark when an action is pending approval) and "Context" (tokens used / context window, the agent and model, the connectors used, compaction records).
- Extension tabs: they appear automatically once the org enables an extension that has UI. For example, enabling `@capybara-hq/plugin-todo` adds a "Tasks" tab, which refreshes live every time the agent updates the list. An extension can also add org pages to the top bar's "Extensions" menu.

Extension UI comes in two tiers:

- **Rendered schema views**: the extension returns only structured blocks (lists, tables, charts, buttons, forms and so on), and the web app draws them with design-system components. The extension can't write styles or execute code. New views added in an upgrade don't need re-approval. See [`todo`](https://github.com/capybara-hq/plugins/tree/main/plugins/todo).
- **Embeds**: the extension's own page goes into a sandboxed iframe, for complex interactions such as boards and workflows. The page loads through the same-origin proxy `/plugin-ui/<plugin>/...`, can't read the session cookie, and gets only a token that is valid for that extension alone and expires in 5 minutes. Embeds are marked `(sensitive)` in `capybara extensions review` and load only after approval. See [`example-board`](https://github.com/capybara-hq/plugins/tree/main/plugins/example-board) (not published: pack it from a capybara-hq/plugins checkout, as example-counter in [Development](../development.md)): after installing, approving and enabling it, and enabling it in the org, open the org board from the top bar's "Extensions" menu, and the conversation gets an extra "Board" tab.

To write extension UI, see [.agents/skills/writing-extension-ui](../../.agents/skills/writing-extension-ui/SKILL.md).
