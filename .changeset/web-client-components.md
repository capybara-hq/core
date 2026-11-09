---
"@capybara-hq/web": patch
"@capybara-hq/capybara": patch
---

Client components render in the web. In list slots a `component` contribution renders in the same
place as a view (its slot's frame, anchors unchanged) once its module is registered, inside the
block's error boundary (a crash shows the failure line and is reported once and counted against the
plugin's crash budget), with the host context the plugin-client hooks read (`useView` reads the
component's server view with the slot's args only when asked). The replaceable slots `shell.brand`,
`conversation.empty` and `conversation.composer.frame` render the kernel's winner or the built-in:
the built-in in safe mode, under the kill switch, before the host loads, and when the winner fails
to load, throws or (composer frame) leaves the composer's textarea out; while the winner loads the
built-in stays hidden for at most 1.5 s. `shell.overlay` renders in the decoration layer. The admin
console renders neither the overlay nor replacements.
