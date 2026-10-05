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
  it("curates named risks within scope without automatic retention or forced deletion", () => {
    const prompt = buildWorkspaceTestingPrompt([
      repository(),
      repository({ name: "frontend", changed: false, simplifyScope: [] }),
    ]);

    expect(prompt).toContain("name the plausible regression it detects and a behavior-preserving refactor it should survive");
    expect(prompt).toContain("uncertainty alone is not a reason to keep a test");
    expect(prompt).toContain("Preserve contractual, security, and data-integrity coverage");
    expect(prompt).not.toContain("Keep a test when its value is uncertain");
    expect(prompt).toContain("do not perform a whole-suite cleanup");
    expect(prompt).toContain("Do not force test churn or a deletion quota");
    expect(prompt).toContain('action "testing-complete"');
    expect(prompt).toContain("without mentioning workflow phases");
    expect(prompt).toContain("src/feature.ts (modified; changed lines: 4-8)");
    expect(prompt).not.toContain("### frontend");
  });
});
