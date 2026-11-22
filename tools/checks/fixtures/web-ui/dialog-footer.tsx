import * as UI from "@capybara-hq/design";
import { Button, Dialog, LinkButton, Stack } from "@capybara-hq/design";
import * as React from "react";

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

export function Member({ open }: { open: boolean }) {
  return (
    <Dialog open={open} title="x" footer={<UI.Stack>wrapped</UI.Stack>}>
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
      <Dialog
        open={open}
        title="x"
        footer={
          <React.Fragment>
            <Button>ok</Button>
          </React.Fragment>
        }
      >
        body
      </Dialog>
      <Stack footer={<div>not a dialog</div>} />
    </>
  );
}
