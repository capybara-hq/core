import { AuthPage, Button, Field, Input, Stack, Text } from "@capybara-hq/design";
import { useState } from "react";

/** T10 认证：登录（无 Shell）。 */
export function AuthTemplate() {
  const [login, setLogin] = useState("grant");
  const [password, setPassword] = useState("");
  return (
    <AuthPage
      title="登录"
      subtitle="示例组织"
      footer={
        <Text variant="small" tone="muted">
          忘记密码？请联系组织管理员。
        </Text>
      }
    >
      <Stack gap={16}>
        <Field label="账号">
          <Input value={login} autoComplete="username" onChange={(e) => setLogin(e.target.value)} />
        </Field>
        <Field label="密码">
          <Input
            type="password"
            value={password}
            autoComplete="current-password"
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>
        <Button variant="primary" size={36} shortcut="↵">
          登录
        </Button>
      </Stack>
    </AuthPage>
  );
}
