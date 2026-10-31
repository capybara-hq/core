import { AuthPage, ListPage, ConversationPage } from "@capybara-hq/design";

const head = { path: [{ label: "x" }], title: "x" };

export function A() {
  return <ListPage header={head}>x</ListPage>;
}
export function B() {
  return <ListPage header={{ path: [], title: "x" }}>x</ListPage>;
}
export function C() {
  return (
    <>
      <AuthPage title="x">x</AuthPage>
      <ConversationPage>x</ConversationPage>
    </>
  );
}
export default A;
