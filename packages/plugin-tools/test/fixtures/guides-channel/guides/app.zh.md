# 创建应用

打开控制台创建应用。

::: mode webhook

事件发到 `{{webhookUrl}}`。

```json title="应用 manifest"
{ "name": "{{connectionName}}", "url": "{{webhookUrl}}" }
```

:::

```sh title="安装"
install --name {{connectionName}}
```

::check capybara:public-url 公网地址可访问
