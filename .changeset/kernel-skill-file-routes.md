---
"@capybara-hq/kernel": patch
---

The kernel serves a skill version's files with the visibility of `GET /skills/:id` (`skills.read`):
`GET /skills/:id/files` lists them (`?version=`, default the current one),
`GET /skills/:id/files/content` serves one file's bytes, checked against the manifest (409
`skill.file_changed`; `?as=url` answers a short-lived presigned attachment URL instead, for a
native shell's Download), and `GET /skills/:id/files/previewers` with
`GET /skills/:id/files/previews/:plugin/:previewerId` list and render the `file-preview@1`
previewers that take a file (never for HTML or SVG files, which show as source only). The embed
token route also takes `{ skillId, version?, path }` for a skill file's embed previewer, and such
a token stops verifying once the caller's current role may no longer read skills. Deliver now
types `.sh` / `.bash` as `text/x-shellscript`, `.mjs` / `.cjs` as `text/javascript` and `.jsx` /
`.tsx` as `text/plain` (they were `application/octet-stream`); the model sees these types only in
new logs.
