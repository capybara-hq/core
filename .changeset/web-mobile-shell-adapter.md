---
"@capybara-hq/web": minor
---

Mobile shell capabilities in the web adapter: inside the mobile app the frame hands `nav@1` to the
design as the native tab bar and navigates on a tap, `menu@1`, `share@1` and `haptics@1` reach the
design as native handlers, and `chrome@1.ready` is called once the page has drawn. Sharing a file
link or a conversation link uses the system share sheet (or Web Share), else copies it.
