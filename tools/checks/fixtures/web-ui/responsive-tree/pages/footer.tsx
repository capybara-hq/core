import { Button, Dialog, Stack } from "@capybara-hq/design";

export function Page() {
  return (
    <Dialog
      open
      title="x"
      footer={
        <Stack direction="row">
          <Button>ok</Button>
        </Stack>
      }
    >
      body
    </Dialog>
  );
}
