# Authoring: extension point file-preview

<!-- generated:extension-point -->
- Name: `file-preview` (a ref is `file-preview@<major>`)
- Renders previews of files of given types: conversation files, shared files and skill files.
- Providers: several
- Enabled per org: yes
- Brokered by the platform: no
<!-- /generated -->

Contract: FilePreviewProvider (`file-preview.ts`)

Declare which file types you can preview and render them through schema views or an approved embed. Enabled per org.

`render` args are a union on `source`: `"conversation"` (org, account, conversation), `"share"` (org and share id; `file.id` is the share id; no account or conversation) or `"skill"` (a skill version's file on the skill page: org, account, `skillId`, `version` and `path`; `file.id` is `<skillId>@<version>/<path>`; no conversation). An embed previewer of a skill file gets an org token whose claims carry `skillFile: { skillId, version, path }` instead of `conversationId` / `fileId`; that token reaches every `embed` route of the extension, so an embed route must not treat an org caller without `conversationId` as entitled to conversation data, and should serve a `caller.skillFile` caller only that file. A previewer that needs the conversation declines any `source` other than `"conversation"` by throwing; the kernel reports the failure and the page (a share page, a skill page) falls to the next previewer. A share token is valid only for the `file.preview` slot, never for `/api`.

See `extensions` for the rules every extension follows.
