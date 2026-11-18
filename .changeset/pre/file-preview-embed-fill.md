---
"@capybara-hq/design": patch
"@capybara-hq/web": patch
---

A file previewer embed (`file.preview`, such as the file-preview plugin's sheet, PDF and archive
viewers) fills the right panel below its header, frameless like the built-in previews, instead of
a 360 px framed iframe. `EmbedFrame` gains `fill`.
