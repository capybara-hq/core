---
"@capybara-hq/kernel": patch
"@capybara-hq/web": patch
"@capybara-hq/capybara": patch
"@capybara-hq/design": patch
---

The Platform tool takes conversation files where the web takes an upload: an agent avatar from a
generated image, skill and plugin packages, extension packages and skill versions, passed as
`file: { fileId }` (a device file is delivered with Deliver first). The card shows the file's name,
size, sha256 prefix and a thumbnail, and the bytes that run are the bytes the person confirmed.
Imports, uploads and anything else a person reviews on a web page pop up a link card to that page.
Two new platform-ops rules keep it that way: an exclusion may not cite an upload, and an operation
that sends the person to a web page links it or says why not (`noHandoff`).
