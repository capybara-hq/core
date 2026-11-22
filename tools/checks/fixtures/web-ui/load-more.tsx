import { Button, DataTable, LinkButton, ObjectList } from "@capybara-hq/design";
import { useTranslations } from "next-intl";
import { LoadMore } from "../../components/cursor-pages";

export function ByKey({ more }: { more(): void }) {
  const t = useTranslations("x");
  return (
    <>
      <ObjectList label="x" />
      <Button onClick={more}>{t("loadMore")}</Button>
    </>
  );
}

export function NestedKey({ more }: { more(): void }) {
  const t = useTranslations("x");
  return (
    <ObjectList label="x">
      <Button loading onClick={more}>
        {t("run.loadMore")}
      </Button>
    </ObjectList>
  );
}

export function Literal() {
  return <LinkButton href="/next">加载更多</LinkButton>;
}

export function EnglishLiteral() {
  return <Button>Load more</Button>;
}

export function Wrapper({ pages }: { pages: never }) {
  return <LoadMore pages={pages} label="more" />;
}

export function Fine({ more, t }: { more(): void; t(k: string): string }) {
  return (
    <>
      <DataTable label="x" columns={[]} rows={[]} rowKey={() => ""} onLoadMore={more} hasMore />
      <Button onClick={more}>{t("refresh")}</Button>
      <Button>{t("loadMoreHint.title")}</Button>
      <span>{t("loadMore")}</span>
    </>
  );
}
