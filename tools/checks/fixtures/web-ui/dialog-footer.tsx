import { Button, Dialog, LinkButton, Stack } from "@capybara-hq/design";

export function Wrapped({ open }: { open: boolean }) {
  return (
    <Dialog
      open={open}
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

export function Conditional({ open, done }: { open: boolean; done: boolean }) {
  return (
    <Dialog
      open={open}
      title="x"
      footer={done ? <Button>done</Button> : <div>wait</div>}
    >
      body
    </Dialog>
  );
}

export function Fine({ open, save }: { open: boolean; save: unknown }) {
  return (
    <>
      <Dialog
        open={open}
        title="x"
        footer={
          <>
            <Button>cancel</Button>
            <Button>ok</Button>
          </>
        }
      >
        body
      </Dialog>
      <Dialog open={open} title="x" footer={[<Button key="a">a</Button>, <Button key="b">b</Button>]}>
        body
      </Dialog>
      <Dialog open={open} title="x" footer={<LinkButton href="/x">open</LinkButton>}>
        body
      </Dialog>
      <Dialog open={open} title="x" footer={save}>
        body
      </Dialog>
      <Stack footer={<div>not a dialog</div>} />
    </>
  );
}
