---
"@capybara-hq/design": patch
"@capybara-hq/capybara": patch
---

Mobile interaction model (#606): on compact, dialogs and danger confirmations are bottom sheets
(close or 取消 focused first, a fixed footer, typed names kept) and a Select opens a picker sheet
(searchable over ten options); toasts sit at the bottom, one at a time, and a queued toast's timer
starts when it is shown; a focused field scrolls above the keyboard and bottom sheets rise with it;
compact lists load the next page as their end comes into view (`onLoadMore`, `hasMore`,
`loadingMore`), with a retry row on error; a long press that opens an action sheet plays a light
haptic; pull to refresh on the inbox, the conversations page and the drawer's recents in the mobile
app only. On the iPhone Duo the strip pill carries the page's primary (else 新会话), 对话 opens the
conversations page, the avatar opens the account sheet (with 技能、连接器、设备…), sheets stay
inside the strip's inset and the drawer drops the pill's entries. New checks keep overlays and sheet
rows design primitives, `useNative` out of pages, Dialog footers flat and Load more rows out of
pages.
