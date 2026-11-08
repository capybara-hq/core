# Create the app

Open the console and create an app.

::: mode webhook

Events go to `{{webhookUrl}}`.

```json title="App manifest"
{ "name": "{{connectionName}}", "url": "{{webhookUrl}}" }
```

:::

```sh title="Install"
install --name {{connectionName}}
```

::check capybara:public-url Public URL is reachable
