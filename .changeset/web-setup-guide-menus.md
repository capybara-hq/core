---
"@capybara-hq/web": patch
---

A setup checklist instead of an empty composer, and a tidier account menu.

- **New conversation before setup:** without a model or an agent, `/chat` shows what is missing as a
  checklist (set up a model, create an agent, start a conversation) with the way to fix each,
  instead of a composer full of placeholders. Enterprise admins get a button to the extensions;
  others are told an enterprise admin configures models.
- **Account menu:** "Organization ▸" and "Language ▸" are submenus above sign-out; the theme switch
  sits right after the account in the sidebar's foot. Menus support submenus.
- **Auth pages:** the language and theme controls are right-aligned under the card, each at its
  own width.
