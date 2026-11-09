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
    contextOnly: false,
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
  it("includes changed files and excludes unchanged repositories", () => {
    const prompt = buildWorkspaceSimplificationPrompt([
      repository(),
      repository({ name: "frontend", path: "/workspace/frontend", changed: false, simplifyScope: [] }),
    ]);

    expect(prompt).toContain("src/changed.ts");
    expect(prompt).toContain("src/new.ts");
    expect(prompt).not.toContain("/workspace/frontend");
  });
});
