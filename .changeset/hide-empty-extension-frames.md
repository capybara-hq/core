---
"@capybara-hq/capybara": patch
"@capybara-hq/web": patch
"@capybara-hq/design": patch
---

A client component in `conversation.properties.section` that renders nothing (returns `null`)
no longer leaves an empty titled section: the host draws the section only while the component
renders a node, checked after every commit before paint. A component panel whose component
renders nothing shows the panel's empty state instead of a blank pane. Design: `PropertySection`
takes `hideWhenEmpty`, `RightPanel` takes `emptyText`.
