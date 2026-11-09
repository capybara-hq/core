---
"@capybara-hq/web": patch
"@capybara-hq/capybara": patch
---

Client components render in the web. In list slots a `component` contribution renders in the same
place as a view (its slot's frame, anchors unchanged) once its module is registered, inside the
block's error boundary (a crash shows the failure line and is reported once and counted against the
plugin's crash budget), with the host context the plugin-client hooks read (`useView` reads the
component's server view with the slot's args only when asked). A component's right panel always
has its frame (title, close) with a loading or failure state; component panels are not offered in
safe mode or under the kill switch. The replaceable slots `shell.brand`, `conversation.empty` and
`conversation.composer.frame` render the kernel's winner or the built-in: the built-in in safe
mode, under the kill switch, and when the winner fails to load, throws or (composer frame) leaves
the composer's textarea out of its slot, also on its own re-render; while the winner loads the
built-in stays hidden for at most 1.5 s. A composer frame gets the framed composer as `builtin` and
its bare inputs as `children`. When the org's client set has a component for one of these slots,
the layout's shell read also prefetches the contributions, so the server renders the slot pending
(the frame's CSS reveals the built-in after 1.5 s) and a winner renders without a read.
`shell.overlay` renders in the decoration layer once one of its components is ready. The admin
console renders neither the overlay nor replacements.
