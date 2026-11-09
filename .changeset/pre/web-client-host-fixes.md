---
"@capybara-hq/web": patch
"@capybara-hq/capybara": patch
---

Client host fixes: a layout refresh no longer remounts the page after a client navigation from a
workspace page without client code into the admin console. A contribution's crash counts
once per document toward the crash budget, however many places draw it. A router push or Back
across the client-code boundary turns the old scope's plugin code off before the document load. A composer frame must render
the composer exactly once (two copies fall back to the built-in). The safe-mode cookie is
HttpOnly; the banner's exit loads the page with `?safe-ui=0`, which clears it. The admin extension detail's
client reports name the org (a deleted org says so) instead of its id. A focus request the composer
cannot take while a composer frame is pending waits for the reveal or the winner's composer. A client event whose seq
arrives after a higher one is still delivered once.
