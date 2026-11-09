import { describe, expect, it } from "vitest";
import { buildWorkspaceTestingPrompt } from "./testing.js";
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
      { path: "src/feature.ts", status: "modified", changedLines: [{ start: 4, end: 8 }] },
      { path: "src/feature.test.ts", status: "added" },
    ],
    tests: [],
    pushed: false,
    ...overrides,
  };
}

describe("buildWorkspaceTestingPrompt", () => {
  it("includes changed files and excludes unchanged repositories", () => {
    const prompt = buildWorkspaceTestingPrompt([
      repository(),
      repository({ name: "frontend", changed: false, simplifyScope: [] }),
    ]);

    expect(prompt).toContain("src/feature.ts");
    expect(prompt).toContain("src/feature.test.ts");
    expect(prompt).not.toContain("frontend");
  });
});
