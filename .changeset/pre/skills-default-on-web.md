---
"@capybara-hq/capybara": minor
"@capybara-hq/web": minor
"@capybara-hq/kernel": patch
---

Skills are on by default in the web app: the agent page's 技能 section lists every skill on in the
org checked, and unticking one turns it off (`disabledSkills`); a plugin's group head turns the
whole plugin off, its later skills too. Pinning is gone (the 置顶 section, the pinned suggestions
of plugin import, the token estimates). The agent template editor edits `disallowedSkills` with the
same list and the skills a sub-agent loads first. The org 技能 page filters by plugin and its
detail says how many agents turned a skill off (`agentsOff` on the skill detail); switching off a
plugin with skills says every agent loses them; the admin agent pages show the off count.
