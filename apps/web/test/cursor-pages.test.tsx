import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import en from "../messages/en.json";
import { useCursorPages } from "../src/components/cursor-pages";
import { ApiClientError } from "../src/lib/api";

// useCursorPages, the one Load more of the cursor-paged lists (the audit logs, the dead outbox
// rows): later pages are appended, a first page with another identity starts over, and a failed
// page leaves the rows and reports the localized error.

type Page = { items: string[]; next: string | null };
const select = (p: Page) => ({ rows: p.items, next: p.next });

function setup(pages: Record<string, () => Promise<Page>>) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>
      <NextIntlClientProvider locale="en" messages={en}>
        {children}
      </NextIntlClientProvider>
    </QueryClientProvider>
  );
  const pageQuery = (after: string) => ({
    queryKey: ["pages", after],
    queryFn: () => (pages[after] as () => Promise<Page>)(),
  });
  return { wrapper, pageQuery };
}

describe("useCursorPages", () => {
  it("appends later pages, then starts over when the first page changes identity", async () => {
    const { wrapper, pageQuery } = setup({
      c1: async () => ({ items: ["b"], next: null }),
    });
    const first: Page = { items: ["a"], next: "c1" };
    const { result, rerender } = renderHook(
      ({ page }: { page: Page | undefined }) => useCursorPages(page, pageQuery, select),
      { wrapper, initialProps: { page: first } },
    );
    expect(result.current.rows).toEqual(["a"]);
    act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.rows).toEqual(["a", "b"]));
    expect(result.current.next).toBeNull();
    // the same first page (an unchanged refetch keeps its identity): the later pages stay
    rerender({ page: first });
    expect(result.current.rows).toEqual(["a", "b"]);
    // a changed first page: the later pages belonged to the old one
    rerender({ page: { items: ["a2"], next: "c1" } });
    expect(result.current.rows).toEqual(["a2"]);
    expect(result.current.next).toBe("c1");
    // no first page yet: nothing to show or load
    rerender({ page: undefined });
    expect(result.current).toMatchObject({ rows: [], next: null });
  });

  it("a failed page leaves the rows and gives the localized error until the next try", async () => {
    let fail = true;
    const { wrapper, pageQuery } = setup({
      c1: async () => {
        if (fail) throw new ApiClientError(500, "internal", "boom");
        return { items: ["b"], next: null };
      },
    });
    const first: Page = { items: ["a"], next: "c1" };
    const { result } = renderHook(() => useCursorPages(first, pageQuery, select), { wrapper });
    act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(result.current.rows).toEqual(["a"]);
    expect(result.current.error).toBe(en.errors.internal);
    fail = false;
    act(() => result.current.loadMore());
    expect(result.current.error).toBeNull();
    await waitFor(() => expect(result.current.rows).toEqual(["a", "b"]));
  });
});
