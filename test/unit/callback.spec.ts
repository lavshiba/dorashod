import { describe, expect, it } from "vitest";
import { decodeCallback, encodeCallback } from "@/utils/callback";

describe("callback encoding", () => {
  it("roundtrips compact payload keys and values", () => {
    const encoded = encodeCallback("subcategory:view", {
      id: 12,
      categoryId: 34,
      type: "expense",
      page: 2,
      subpage: 1,
      source: "hidden"
    });

    expect(encoded.length).toBeLessThanOrEqual(64);
    expect(decodeCallback(encoded)).toEqual({
      a: "subcategory:view",
      id: "12",
      categoryId: "34",
      type: "expense",
      page: "2",
      subpage: "1",
      source: "hidden"
    });
  });

  it("drops query when it would overflow telegram callback size", () => {
    const encoded = encodeCallback("entry:edit", {
      id: 123,
      page: 4,
      source: "search",
      query: "очень длинный поисковый запрос который иначе не влез бы в callback data"
    });

    expect(encoded.length).toBeLessThanOrEqual(64);
    expect(decodeCallback(encoded)).toEqual({
      a: "entry:edit",
      id: "123",
      page: "4",
      source: "search"
    });
  });
});
