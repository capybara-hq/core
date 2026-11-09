---
"@capybara-hq/web": patch
"@capybara-hq/capybara": patch
---

The admin console and the workspace manage client code. 平台设置 has 插件界面代码: one switch for all
plugin interface code and one per plugin with client code (its server side keeps running); a save
marks every cached client set stale. The admin extension detail shows 界面代码 (build, client API,
files and sizes, the current build's error reports) with 停用界面代码 / 恢复界面代码. 界面位置 lists
the replaceable slots with a select 内置 / candidates (an org shows whether it follows the platform
and can follow it again; members read the picks). 应用此插件的外观 (the admin plugin detail for the
platform, the extension's Sheet on /extensions for org admins) shows the dry run's changes in a
confirm dialog, then applies them. Permission reviews show 客户端代码 with the build's files and
sizes, and interface components as their own sensitive group. A refused apply says what to do at its level
(the orgs where the theme is off, or how to offer it), and the org-upload confirmation and the org
Sheet list the client build's files with sizes.
