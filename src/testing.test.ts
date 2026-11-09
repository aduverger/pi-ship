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
  it("prunes before improving tests while allowing grounded protection within scope", () => {
    const prompt = buildWorkspaceTestingPrompt([
      repository(),
      repository({ name: "frontend", changed: false, simplifyScope: [] }),
    ]);

    expect(prompt).toContain("decide whether a test deserves to survive delivery before improving it");
    expect(prompt).toContain("Retain or add tests only when expectations come from real contracts, known failures, meaningful properties, or authoritative reference implementations");
    expect(prompt).toContain("Remove tests specific to one-off migrations or scripts");
    expect(prompt).toContain("test definitions in this pass, not parameterized cases or cumulative branch totals");
    expect(prompt).toContain("do not perform a whole-suite cleanup");
    expect(prompt).toContain("Do not force test churn or a deletion quota");
    expect(prompt).toContain('action "testing-complete"');
    expect(prompt).toContain("without mentioning workflow phases");
    expect(prompt).toContain("src/feature.ts (modified; changed lines: 4-8)");
    expect(prompt).not.toContain("### frontend");
  });
});
