import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { keys } from "../src/lib/query/keys";
import { refreshUiViews } from "../src/lib/query/ui";

/** A view query whose reads the test answers one by one, in order. */
function viewQuery() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const key = [...keys.org("o1").uiViews("c1", "tasks", "list"), "zh"];
  const answers: ((v: string) => void)[] = [];
  let reads = 0;
  const observer = new QueryObserver<string>(qc, {
    queryKey: key,
    queryFn: () => {
      reads += 1;
      return new Promise<string>((resolve) => answers.push(resolve));
    },
    staleTime: Infinity,
  });
  // an active view: something shows it
  const stop = observer.subscribe(() => {});
  return { qc, key, answers, reads: () => reads, data: () => qc.getQueryData<string>(key), stop };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

describe("refreshUiViews", () => {
  it("a refresh during a read it did not start reads again: that read may predate the change", async () => {
    const v = viewQuery();
    await settle();
    // the first read (or any other invalidation's) is in flight when the extension's view changes
    expect(v.reads()).toBe(1);
    refreshUiViews(v.qc, keys.org("o1").uiViews("c1", "tasks", "list"));
    await settle();
    // one read at a time: the refresh waits for the read in flight
    expect(v.reads()).toBe(1);
    v.answers[0]?.("before");
    await settle();
    // that read began before the change: one more read follows, its answer is the view
    expect(v.reads()).toBe(2);
    v.answers[1]?.("after");
    await settle();
    expect(v.reads()).toBe(2);
    expect(v.data()).toBe("after");
    v.stop();
  });

  it("refreshes during its own read coalesce into one more read", async () => {
    const v = viewQuery();
    await settle();
    v.answers[0]?.("first");
    await settle();
    refreshUiViews(v.qc, keys.org("o1").uiViews("c1"));
    await settle();
    expect(v.reads()).toBe(2);
    for (let i = 0; i < 5; i++) refreshUiViews(v.qc, keys.org("o1").uiViews("c1"));
    await settle();
    expect(v.reads()).toBe(2);
    v.answers[1]?.("second");
    await settle();
    expect(v.reads()).toBe(3);
    v.answers[2]?.("third");
    await settle();
    expect(v.reads()).toBe(3);
    expect(v.data()).toBe("third");
    v.stop();
  });
});
