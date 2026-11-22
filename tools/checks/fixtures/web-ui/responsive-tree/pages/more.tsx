import { Button, ObjectList } from "@capybara-hq/design";

export function Page({ more, t }: { more(): void; t(k: string): string }) {
  return (
    <>
      <ObjectList label="x" />
      <Button onClick={more}>{t("loadMore")}</Button>
    </>
  );
}
