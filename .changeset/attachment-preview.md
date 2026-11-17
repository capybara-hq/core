---
"@capybara-hq/kernel": patch
"@capybara-hq/capybara": patch
---

Files a person sends with a message join the conversation's files: `GET …/conversations/:id/files`
lists them with the delivered files, newest first, marked `origin: "uploaded"` (each delivered file
is `origin: "delivered"`), and the content, previewer, preview and embed-token routes accept their
ids. Only ready chat uploads bound to that conversation in that org count, read under the
conversation's access as before. Sending a message with files publishes `changed: files`. On the
web, a sent file opens in the right panel (images still zoom in the thread), its chip has a
download button, and uploaded files are marked 上传 / Uploaded in the file switchers.
