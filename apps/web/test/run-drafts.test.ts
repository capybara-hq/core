import { afterEach, describe, expect, it, vi } from "vitest";
import { apiFetch } from "../src/lib/api";
import { fetchRunDrafts } from "../src/lib/run-drafts";

vi.mock("../src/lib/api", () => ({ apiFetch: vi.fn() }));

describe("fetchRunDrafts", () => {
  const api = vi.mocked(apiFetch);
  afterEach(() => api.mockReset());

  it("reads the run's draft route and keeps only well-formed drafts", async () => {
    api.mockResolvedValueOnce({
      drafts: [
        { step: 0, text: "a", thinking: "b" },
        { step: "1", text: "x", thinking: "" },
        { step: 2, text: null, thinking: "" },
        { step: 3, text: "c" },
        null,
        "junk",
        { step: 4, text: "", thinking: "t" },
      ],
    });
    await expect(fetchRunDrafts("o 1", "c/1", "r1")).resolves.toEqual([
      { step: 0, text: "a", thinking: "b" },
      { step: 4, text: "", thinking: "t" },
    ]);
    expect(api).toHaveBeenCalledWith("/api/v1/orgs/o%201/conversations/c%2F1/runs/r1/draft");
  });

  it("an answer without a drafts list is no drafts", async () => {
    api.mockResolvedValueOnce({});
    await expect(fetchRunDrafts("o1", "c1", "r1")).resolves.toEqual([]);
    api.mockResolvedValueOnce(undefined);
    await expect(fetchRunDrafts("o1", "c1", "r1")).resolves.toEqual([]);
  });
});
