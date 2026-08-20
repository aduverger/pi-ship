import { describe, expect, it } from "vitest";
import { withRelatedPullRequests } from "./related-prs.js";

describe("withRelatedPullRequests", () => {
  it("adds sibling links and is idempotent", () => {
    const links = new Map([
      ["api", "https://github.com/example/api/pull/1"],
      ["frontend", "https://github.com/example/frontend/pull/2"],
    ]);
    const first = withRelatedPullRequests("## Intent\n\nShip it", links, "api");
    const second = withRelatedPullRequests(first, links, "api");

    expect(second).toBe(first);
    expect(second).toContain("[frontend](https://github.com/example/frontend/pull/2)");
    expect(second).not.toContain("[api](https://github.com/example/api/pull/1)");
  });

  it("does not add a section for a single PR", () => {
    expect(withRelatedPullRequests("body", new Map([["api", "url"]]), "api")).toBe("body");
  });
});
