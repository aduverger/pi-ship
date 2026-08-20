import { describe, expect, it } from "vitest";
import { buildWorkspaceSimplificationPrompt } from "./simplify.js";
import type { ShipRepositoryState } from "./types.js";

function repository(overrides: Partial<ShipRepositoryState> = {}): ShipRepositoryState {
  return {
    name: "api",
    path: "/workspace/api",
    githubRepository: "example/api",
    branch: "feature",
    baseBranch: "main",
    baseRef: "refs/remotes/origin/main",
    initialHead: "a",
    head: "a",
    baseSha: "b",
    changed: true,
    simplifyScope: [
      { path: "src/changed.ts", status: "modified", changedLines: [{ start: 4, end: 8 }] },
      { path: "src/new.ts", status: "added" },
    ],
    tests: [],
    pushed: false,
    ...overrides,
  };
}

describe("buildWorkspaceSimplificationPrompt", () => {
  it("limits edits to current changed lines and added files", () => {
    const prompt = buildWorkspaceSimplificationPrompt([
      repository(),
      repository({ name: "frontend", path: "/workspace/frontend", changed: false, simplifyScope: [] }),
    ]);

    expect(prompt).toContain("src/changed.ts (modified; changed lines: 4-8)");
    expect(prompt).toContain("src/new.ts (added; entire file is in scope)");
    expect(prompt).not.toContain("### frontend");
    expect(prompt).toContain("may read surrounding code and other selected repositories for context");
    expect(prompt).toContain("must not edit outside the listed files and ranges");
  });
});
