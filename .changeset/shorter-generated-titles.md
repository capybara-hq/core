---
"@capybara-hq/kernel": patch
---

Generated conversation titles are shorter: the title prompt asks for a short noun-phrase topic of
what the user asked (not the reply), and a generated title is capped at 48 display width (CJK counts
2), cut on a character boundary. Renames keep their 120-character limit.
