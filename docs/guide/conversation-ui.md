# The conversation page's right panel and extension UI

The middle of the conversation page is the conversation, with tool calls shown as one line each on a timeline (if the tool provided a display summary, that sentence is shown, such as "Update task list (4 items)"; expand to see the full input and output). On the right is a collapsible tab panel:

- Tabs built into the kernel: "Runs" (all tool calls of this conversation, with an alert mark when an action is pending approval) and "Context" (tokens used / context window, the agent and model, the connectors used, compaction records).
- Extension tabs: they appear automatically once the org enables an extension that has UI. For example, enabling `@capybara-hq/plugin-todo` adds a "Tasks" tab, which refreshes live every time the agent updates the list. An extension can also add org pages to the top bar's "Extensions" menu.

Extension UI comes in two tiers:

- **Rendered schema views**: the extension returns only structured blocks (lists, tables, charts, buttons, forms and so on), and the web app draws them with design-system components. The extension can't write styles or execute code. New views added in an upgrade don't need re-approval. See [`todo`](https://github.com/capybara-hq/plugins/tree/main/plugins/todo).
- **Embeds**: the extension's own page goes into a sandboxed iframe, for complex interactions such as boards and workflows. The page loads through the same-origin proxy `/plugin-ui/<plugin>/...`, can't read the session cookie, and gets only a token that is valid for that extension alone and expires in 5 minutes. Embeds are marked `(sensitive)` in `capybara extensions review` and load only after approval. See [`example-board`](https://github.com/capybara-hq/plugins/tree/main/plugins/example-board) (not published: pack it from a capybara-hq/plugins checkout, as example-counter in [Development](../development.md)): after installing, approving and enabling it, and enabling it in the org, open the org board from the top bar's "Extensions" menu, and the conversation gets an extra "Board" tab.

To write extension UI, see [.agents/skills/writing-extension-ui](../../.agents/skills/writing-extension-ui/SKILL.md).

## Projects in the composer and the header

A new conversation can bind one of its device's [projects](sandbox.md#projects). The composer's device menu has a 项目 / "Project" group under the devices: 自由模式 / "Free mode" (the default) and the projects of the chosen device that its current mode can read; the menu's label then reads `<device> · <project>`. Picking another device drops the project, and a device without projects (or one that does not support them) shows no group. The choice is sent with the first message and is fixed from then on, like the device.

The conversation header shows the bound project: its name and root, and once a run has read it, whether its `AGENTS.md` was loaded. When the project cannot be used (its directory is gone, the device's current mode cannot read it, reading it failed, or the device does not support projects) the header says so and that the conversation continues in free mode. The `/` menu lists the project's skills in their own group (see [Skills](skills.md)).

## HTML files: rendered in full

An HTML file in the right panel (one the agent delivered, or one sent as an attachment) is shown as a whole document: its scripts run, and styles, scripts, fonts and images load from the platform's CDN allowlist (by default `https://cdnjs.cloudflare.com`, `https://cdn.jsdelivr.net`, `https://unpkg.com`, `https://fonts.googleapis.com` and `https://fonts.gstatic.com`), so a report that draws its charts with a library from a CDN renders as its author saw it. The header switches between 渲染 / "Rendered" and 源码 / "Source" (the file as text). This built-in wins over extension previewers for HTML.

The document is served by the kernel at `/api/v1/html/<token>` (a token valid for 5 minutes, only for loading that document) with a sandboxing content security policy, and framed with the same sandbox: it runs in an opaque origin, so it cannot read the app's cookies or storage, call `/api`, script the page around it or navigate the app. It can reach nothing outside the allowlist (no `fetch`, XHR, WebSocket or beacon to any host, no images from other hosts); links open in a new, normal tab. HTML files are rendered alone: relative references to files next to them (`app.js`, `style.css`, `chart.png`) do not load, so a report should be one self-contained file (inline CSS and JS, libraries from a CDN, images as data URLs). Files over 20 MiB are not rendered; download them instead. The super admin edits the allowlist in the admin console (部署设置 / "Deployment settings" › 对外分享 / "External sharing": https origins only, no paths or wildcards); a change applies to the next document load.

## Sharing a file

Every file in the right panel has a 分享 / "Share" action for the conversation's owner (not for removed files). The dialog asks who can open the link and when it expires, then shows the link with Copy:

- **组织成员 / "Organization members"** (internal): members of the org open it after signing in; it may never expire.
- **任何拿到链接的人 / "Anyone with the link"** (external): no sign-in; the link always expires (1, 7 or 30 days, bounded by the platform maximum; 7 by default). Offered only when the super admin allows external sharing in the admin console and an org admin turns it on in 组织设置 / "Organization settings"; otherwise the option is disabled with the reason.

A link is a **snapshot** of the file as it is when the link is created: later versions appear only after 更新到最新版本 / "Update to latest" in the dialog (delivered files only), which keeps the same link. A shared file shows a 已分享 / "Shared" marker, and the dialog lists its active links (Copy, Update to latest, Revoke) and recent ones.

The link opens `/s/<code>`: a page with the file name, who shared it, the expiry and Download over the file rendered exactly as in the right panel (HTML as the sandboxed document above, other formats by the org's file previewers and the built-ins, a file card with Download when nothing can preview it). A revoked, expired or unknown link shows one "This link is invalid or has expired" page; an internal link opened without a session goes to sign-in and back. A link stops working at once when the creator loses access to the file (removed from the org, account disabled, agent deleted or no longer visible), when the conversation is deleted, or, for external links, when either switch is turned off (turning it back on revives links that have not expired).

Members find their links under the personal settings' 我的分享 / "My shares" (`/account/shares`); org admins see every link of the org under 组织设置 › 分享 / "Organization settings › Shares" (`/settings/shares`), with when each was last opened, and can revoke any. Every share, update, revoke and open is in the audit log.
