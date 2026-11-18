---
"@capybara-hq/kernel": patch
---

`GenerateImage`'s result states facts: it counts only newly stored images as delivered, names the
earlier artifact for an image whose bytes were already delivered since the person last spoke (with
a line saying the usage is still billed), and its device line names the artifact that holds the
same bytes.

Its listed description no longer mentions reference images when the org's image model takes none
and the `reference_images` field is dropped.
