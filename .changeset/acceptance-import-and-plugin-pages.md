---
"@capybara-hq/capybara": patch
"@capybara-hq/kernel": patch
"@capybara-hq/plugin-client": patch
---

A confirmed plugin import stops reading the staging it consumed (the error card that flashed before
the navigation landed); an extension component asks for its view after mount, not from its render;
extension pages draw no single-tab bar; the client API forwards the design system's `Select`, so a
client component offers a plugin's choices in the product's own dropdown rather than the browser's;
switching a plugin back on takes back the connector an earlier switch-off kept for agents instead
of creating a second one (which failed on the slug); a connector slug may equal an installed
extension's name (their tool keys stay apart, `mcp__` against `plugin__`), so a template whose
default slug is its plugin's name (slack, github) configures as it is; a default-off connector
template an admin switched on in the org asks for its input at install, as the install is what
creates its connector (before, the wizard hid the fields and the install refused).
