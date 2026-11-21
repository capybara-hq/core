---
"@capybara-hq/design": patch
"@capybara-hq/capybara": patch
---

Controls take the mobile sizes at the compact size class whatever the pointer, and on a touch
device at any width (`MOBILE_SIZE_QUERY`, exported beside `TOUCH_QUERY`): a narrowed desktop window
gets 44 px buttons, tabs and text fields with 16 px field text, as a phone does, instead of the
28 px desktop controls. A control with text pads wider than it is tall (buttons and chips 16 at the
sides, tabs 16, segments 16 filling a 44 high group with the selected ground drawn inset, field
text 12 from the border); icon buttons stay square. The touch component forms (large list rows,
the bottom sheet's touch form, drawer rows, floating buttons) follow the width too. The settings sub-nav on a phone fades at the edge it scrolls past and keeps the current item
in view. The system font stays touch only.
