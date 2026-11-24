---
"@capybara-hq/capybara": patch
---

The web enables a plugin from one review page with 启用 and no input (the per-template steps and the
补充配置 page are gone). A connector that lacks its org input shows 待配置 with 配置 for org admins
(its 凭据 tab: the template's setup guide, the endpoint fields the template lets the org edit, the
credential or OAuth client; saving records the guide) and 待管理员配置 for members; extensions whose
config is invalid read the same way, and the agent page marks such connectors 待配置. The plugin
review shows template icons and the connectors an agent template needs.
The enable page lists what the package brings (its extension, skills, connector templates, agent
templates and dependencies), and a plugin with an extension is reviewed there before it comes on.
An installed plugin whose extension config is invalid reads 已启用 (the extensions page shows
待配置). A connector template that is on without a connector says so, with 创建连接器 for org
admins.
