import { Stack, Text } from "@capybara-hq/design";

/** Form / page error: `role="alert"`, led by the `circle-x` icon (spec §2.4, §5.3); `extra` adds detail lines. */
export function FormError({ message, extra = [] }: { message: string; extra?: string[] }) {
  return (
    <div role="alert">
      <Stack gap={4}>
        <Text tone="fail" icon="circle-x">
          {message}
        </Text>
        {extra.map((m) => (
          <Text key={m} variant="small" tone="fail" icon="circle-x">
            {m}
          </Text>
        ))}
      </Stack>
    </div>
  );
}
