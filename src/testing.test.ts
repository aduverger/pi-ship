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
  it("defines durable test curation without imposing test churn", () => {
    const prompt = buildWorkspaceTestingPrompt([
      repository(),
      repository({ name: "frontend", changed: false, simplifyScope: [] }),
    ]);

    expect(prompt).toContain("plausible regression");
    expect(prompt).toContain("behavior-preserving refactor");
    expect(prompt).toContain("Keep a test when its value is uncertain");
    expect(prompt).toContain("Whole snapshots and golden files are appropriate");
    expect(prompt).toContain("do not perform a whole-suite cleanup");
    expect(prompt).toContain("Do not force test churn");
    expect(prompt).toContain('action "testing-complete"');
    expect(prompt).toContain("without mentioning workflow phases");
    expect(prompt).toContain("src/feature.ts (modified; changed lines: 4-8)");
    expect(prompt).not.toContain("### frontend");
  });
});
