---
"@capybara-hq/capybara": patch
"@capybara-hq/web": patch
---

Chat attachments accept mainstream office documents, archives and source files by extension
(`attachments.allowedExtensions`, about ninety defaults), because their content types disagree between
browsers and systems — an `html`, `py`, `ts` or legacy `doc` file could not be attached before. The
composer's picker offers the extensions and the refusal names them beside the media types.
