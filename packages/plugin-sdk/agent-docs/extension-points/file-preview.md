# Authoring: extension point file-preview

<!-- generated:extension-point -->
- Name: `file-preview` (a ref is `file-preview@<major>`)
- Renders previews of files of given types in the conversation UI.
- Providers: several
- Enabled per org: yes
- Brokered by the platform: no
<!-- /generated -->

Contract: FilePreviewProvider (`file-preview.ts`)

Declare which file types you can preview and render them through schema views or an approved embed. Enabled per org.

`render` args are a union on `source`: `"conversation"` (org, account, conversation) or `"share"` (org and share id; `file.id` is the share id; no account or conversation). A previewer that needs the conversation declines `source: "share"` by throwing; the kernel reports the failure and the share page falls to the next previewer. A share token is valid only for the `file.preview` slot, never for `/api`.

See `extensions` for the rules every extension follows.
