import { Stack, Text } from "@capybara-hq/design";

/** 表单 / 页面级错误：`role="alert"`，以 `✗` 开头（spec §2.4、§5.3）；`extra` 为附加的明细行。 */
export function FormError({ message, extra = [] }: { message: string; extra?: string[] }) {
  return (
    <div role="alert">
      <Stack gap={4}>
        <Text tone="fail">{`✗ ${message}`}</Text>
        {extra.map((m) => (
          <Text key={m} variant="small" tone="fail">
            {`✗ ${m}`}
          </Text>
        ))}
      </Stack>
    </div>
  );
}
